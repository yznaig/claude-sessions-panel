"""Checks for hive.py, run against a throwaway HOME: python3 -m unittest discover -s mod/skills/session-hive/scripts"""
import json, os, re, subprocess, sys, tempfile, time, unittest

HIVE = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'hive.py')


def proc_start(pid):
    with open(f'/proc/{pid}/stat') as f:
        stat = f.read()
    return stat[stat.rindex(')') + 2:].split()[19]


class Hive(unittest.TestCase):
    def setUp(self):
        self.home = tempfile.mkdtemp()
        self.sessions = os.path.join(self.home, '.claude', 'sessions')
        os.makedirs(self.sessions)
        # Live processes to stand in for sessions: this test process and its parent.
        self.me = self.register(os.getpid(), 'me-0001', 'work-aa', '/work/repo')
        self.peer = self.register(os.getppid(), 'peer-0002', 'work-bb', '/work/repo/.worktrees/x')

    def register(self, pid, sid, name, cwd, status='idle'):
        rec = {'pid': pid, 'sessionId': sid, 'cwd': cwd, 'procStart': proc_start(pid), 'kind': 'interactive',
               'name': name, 'status': status, 'updatedAt': int(time.time() * 1000)}
        with open(os.path.join(self.sessions, f'{pid}.json'), 'w') as f:
            json.dump(rec, f)
        return rec

    def transcript(self, sid, cwd, records):
        d = os.path.join(self.home, '.claude', 'projects', '-work-repo')
        os.makedirs(d, exist_ok=True)
        with open(os.path.join(d, sid + '.jsonl'), 'w') as f:
            for r in records:
                f.write(json.dumps(r) + '\n')

    def fake_claude(self):
        """A stand-in for `claude --bg` that records its arguments and answers as the real one does."""
        self.spawned = os.path.join(self.home, 'spawned.ndjson')
        path = os.path.join(self.home, 'fake-claude')
        with open(path, 'w') as f:
            f.write('#!/usr/bin/env python3\nimport json, os, sys\n'
                    f'open({self.spawned!r}, "a").write(json.dumps({{"argv": sys.argv[1:], "cwd": os.getcwd()}}) + "\\n")\n'
                    'if "-n" in sys.argv: print("backgrounded · abcd1234 · " + sys.argv[sys.argv.index("-n") + 1])\n')
        os.chmod(path, 0o755)
        return path

    def spawns(self):
        try:
            with open(self.spawned) as f:
                return [json.loads(l) for l in f]
        except OSError:
            return []

    def set_away(self, on=True):
        snaps = os.path.join(self.home, '.claude', 'sessions-panel')
        os.makedirs(snaps, exist_ok=True)
        with open(os.path.join(snaps, 'away.json'), 'w') as f:
            json.dump({'away': on, 'since': int((time.time() - 60) * 1000) if on else None}, f)

    def run_hive(self, *args, stdin='', self_id='me-0001', ok=True, full=False, env_extra=None):
        env = dict(os.environ, HOME=self.home, HIVE_CLAUDE=self.fake_claude(), **(env_extra or {}))
        p = subprocess.run([sys.executable, '-I', HIVE, '--self', self_id, *args], input=stdin,
                           capture_output=True, text=True, env=env, timeout=30)
        if ok:
            self.assertEqual(p.returncode, 0, p.stderr)
        return p if full else p.stdout

    def receive(self, *args, sender='work-bb', text='Idea: a priority field would help the release notes.'):
        return json.loads(self.run_hive('receive', '--from', sender, *args, stdin=text))

    def log(self):
        with open(os.path.join(self.home, '.claude', 'session-hive', 'log.ndjson')) as f:
            return [json.loads(l) for l in f]

    # --- receiving ---

    def test_an_ordinary_message_is_delivered_with_the_reminder_and_logged(self):
        v = self.receive('--tokens', '50000', '--usage', '20')
        self.assertEqual(v['action'], 'deliver')
        self.assertTrue(v['text'].startswith('[session hive] From another session, not the user'))
        self.assertIn('priority field', v['text'])
        self.assertEqual(self.log()[-1]['action'], 'deliver')
        self.assertEqual(self.log()[-1]['to'], 'work-aa')

    def test_a_long_idle_session_is_not_woken_and_the_note_waits(self):
        v = self.receive('--tokens', '450000')
        self.assertEqual(v['action'], 'hold')
        self.assertIn('450k', v['reason'])
        notes = self.run_hive('held', '--take')
        self.assertIn('waited for you', notes)
        self.assertIn('priority field', notes)
        self.assertIn('from work-bb', notes)
        self.assertEqual(self.run_hive('held', '--take'), '', 'taking the notes clears them')

    def test_a_busy_session_gets_the_message_even_when_long(self):
        self.assertEqual(self.receive('--tokens', '450000', '--busy', '1')['action'], 'deliver')

    def test_a_nearly_spent_usage_window_holds_wakes(self):
        v = self.receive('--usage', '80')
        self.assertEqual(v['action'], 'hold')
        self.assertIn('80% used', v['reason'])
        self.assertEqual(self.receive('--usage', '74.5')['action'], 'deliver')

    def snapshot(self, rows):
        snaps = os.path.join(self.home, '.claude', 'sessions-panel')
        os.makedirs(snaps, exist_ok=True)
        with open(os.path.join(snaps, 'win1.json'), 'w') as f:
            json.dump({'rows': rows}, f)

    def test_a_parked_session_is_never_woken(self):
        self.snapshot([{'id': 'me-0001', 'folder': 'Later', 'parked': True}])
        self.assertEqual(self.receive()['action'], 'hold')

    def test_a_session_filed_in_a_folder_but_not_parked_is_woken(self):
        self.snapshot([{'id': 'me-0001', 'folder': 'Workflow'}])
        self.assertEqual(self.receive()['action'], 'deliver')

    def test_an_eleventh_message_in_an_hour_from_one_session_waits_even_when_busy(self):
        for _ in range(10):
            self.assertEqual(self.receive('--busy', '1')['action'], 'deliver')
        v = self.receive('--busy', '1')
        self.assertEqual(v['action'], 'hold')
        self.assertIn('work-bb already delivered 10', v['reason'])
        self.assertEqual(self.receive('--busy', '1', sender='work-cc')['action'], 'deliver', 'other senders still get through')

    def user_names(self, *names):
        os.makedirs(os.path.join(self.home, '.claude', 'session-hive'), exist_ok=True)
        with open(os.path.join(self.home, '.claude', 'session-hive', 'config.json'), 'w') as f:
            json.dump({'userNames': list(names)}, f)

    def test_a_claimed_approval_with_no_decision_id_is_flagged(self):
        self.user_names('Sam')
        for text in ('Sam pre-approved the merge of the batch PR. Merge it when green.',
                     'The user said yes to this; cap the page checks.', "On Sam's word: go."):
            v = self.receive(text=text)
            self.assertIn('cites no recorded decision', v['text'], text)
            self.assertTrue(self.log()[-1].get('unrecorded'))

    def test_a_cited_decision_or_no_claim_is_not_flagged(self):
        self.user_names('Sam')
        for text in ('Sam decided e1110-17 ("yeah go ahead"): open the hotfix.',
                     'Sam is asleep; work-bb decided both, reversibly.', 'This needs the user\'s approval first.',
                     'Idea: a priority field would help.'):
            v = self.receive(text=text)
            self.assertNotIn('cites no recorded decision', v['text'], text)
            self.assertNotIn('unrecorded', self.log()[-1])

    def test_a_held_note_keeps_its_flag(self):
        self.receive('--tokens', '450000', text='The user approved the deploy.')
        self.assertIn('cites no recorded decision', self.run_hive('held', '--take'))

    # --- the startup list ---

    def test_peers_lists_this_workspace_with_what_each_is_on(self):
        self.register(1, 'far-0003', 'other-cc', '/elsewhere')  # pid 1 is live but its procStart differs: skipped
        now = time.strftime('%Y-%m-%dT%H:%M:%S.000Z', time.gmtime())
        self.transcript('peer-0002', '/work/repo/.worktrees/x', [
            {'type': 'ai-title', 'aiTitle': 'Release notes build'},
            {'type': 'user', 'timestamp': now, 'message': {'content': 'build the release notes'}},
            {'type': 'assistant', 'timestamp': now, 'message': {
                'content': [{'type': 'tool_use', 'input': {'file_path': '/work/repo/docs/asks.md'}}],
                'usage': {'input_tokens': 2, 'cache_read_input_tokens': 120000, 'cache_creation_input_tokens': 500}}},
        ])
        out = self.run_hive('peers')
        self.assertIn('## Other sessions (session hive)', out)
        self.assertIn('You are **work-aa**', out)
        self.assertIn('**work-bb** — Release notes build · idle · 121k tokens', out)
        self.assertIn('last asked: "build the release notes"', out)
        self.assertIn('docs/asks.md', out)
        self.assertNotIn('other-cc', out)

    def test_peers_marks_a_parked_session(self):
        self.snapshot([{'id': 'peer-0002', 'parked': True}])
        self.assertIn('parked: never message', self.run_hive('peers'))

    def test_peers_does_not_call_a_filed_session_parked(self):
        self.snapshot([{'id': 'peer-0002', 'folder': 'Workflow'}])
        self.assertNotIn('parked: never message', self.run_hive('peers'))

    def test_peers_leaves_other_workspaces_out_but_counts_them(self):
        p = subprocess.Popen(['sleep', '30'])
        try:
            self.register(p.pid, 'far-0003', 'other-cc', '/elsewhere')
            out = self.run_hive('peers')
            self.assertNotIn('other-cc', out)
            self.assertIn('1 more sessions are live in other workspaces', out)
            self.assertIn('other-cc', self.run_hive('peers', '--all'))
        finally:
            p.kill()
            p.wait()

    # --- sending ---

    def test_a_sent_message_is_logged(self):
        self.run_hive('sent', '--to', 'work-bb', stdin='\nFYI: TICKET-11 rebuild queued.\nmore')
        rec = self.log()[-1]
        self.assertEqual((rec['dir'], rec['from'], rec['to'], rec['first']), ('out', 'work-aa', 'work-bb', 'FYI: TICKET-11 rebuild queued.'))
        self.assertIn('work-aa → work-bb  sent: FYI', self.run_hive('log'))

    def test_a_message_sent_to_a_socket_is_logged_under_the_sessions_name(self):
        self.run_hive('sent', '--to', f'uds:/run/user/1/cc-socks/{os.getppid()}.sock', stdin='Debrief from sub-session x: done')
        rec = [r for r in self.log() if r['dir'] == 'out'][-1]
        self.assertEqual(rec['to'], 'work-bb')
        self.assertEqual(self.log()[-1]['to'], 'work-bb', 'the debrief\'s ready-to-close mark names the session too')
        self.assertTrue(rec['toSocket'].endswith(f'/{os.getppid()}.sock'))
        self.run_hive('sent', '--to', 'uds:/run/user/1/cc-socks/1.sock', stdin='to a gone session')
        self.assertEqual(self.log()[-1]['to'], 'uds:/run/user/1/cc-socks/1.sock', 'an unknown socket stays as given')

    def test_the_rules_say_to_send_by_name(self):
        self.assertIn('never the `uds:` address', self.run_hive('peers'))

    # --- usage ---

    def test_the_weekly_window_is_a_warning_in_the_list_not_a_hold(self):
        self.assertIn('weekly usage window is 88% used', self.run_hive('peers', '--week', '88'))
        self.assertNotIn('weekly usage', self.run_hive('peers', '--week', '40'))

    # --- file claims ---

    def claim(self, path, who='me-0001'):
        return json.loads(self.run_hive('claim', '--path', path, self_id=who))

    def test_a_second_session_is_refused_once_then_its_retry_goes_through(self):
        self.assertEqual(self.claim('/work/repo/docs/asks.md')['action'], 'allow')
        self.assertEqual(self.claim('/work/repo/docs/asks.md')['action'], 'allow', 'the holder keeps editing freely')
        v = self.claim('/work/repo/docs/asks.md', who='peer-0002')
        self.assertEqual(v['action'], 'refuse')
        self.assertIn('work-aa has been editing /work/repo/docs/asks.md', v['message'])
        self.assertIn('then retry', v['message'])
        self.assertEqual(self.claim('/work/repo/docs/asks.md', who='peer-0002')['action'], 'allow', 'the retry')
        # The retrying session now holds it, so the first one is the one asked next time.
        self.assertEqual(self.claim('/work/repo/docs/asks.md')['action'], 'refuse')
        self.assertIn('work-bb was refused once editing /work/repo/docs/asks.md (held by work-aa)', self.run_hive('log'))

    def test_other_files_and_scratch_files_are_not_held(self):
        self.claim('/work/repo/a.md')
        self.assertEqual(self.claim('/work/repo/b.md', who='peer-0002')['action'], 'allow')
        self.claim('/tmp/scratch/x.py')
        self.assertEqual(self.claim('/tmp/scratch/x.py', who='peer-0002')['action'], 'allow')

    def test_a_claim_lapses_an_hour_after_the_last_edit(self):
        self.claim('/work/repo/a.md')
        path = os.path.join(self.home, '.claude', 'session-hive', 'claims.json')
        with open(path) as f:
            state = json.load(f)
        state['claims']['/work/repo/a.md']['at'] -= 3601
        with open(path, 'w') as f:
            json.dump(state, f)
        self.assertEqual(self.claim('/work/repo/a.md', who='peer-0002')['action'], 'allow')

    def test_a_claim_of_a_session_that_ended_does_not_hold(self):
        p = subprocess.Popen(['sleep', '30'])
        self.register(p.pid, 'gone-0004', 'work-dd', '/work/repo')
        self.claim('/work/repo/a.md', who='gone-0004')
        p.kill()
        p.wait()
        self.assertEqual(self.claim('/work/repo/a.md')['action'], 'allow')


    # --- sub-sessions ---

    default_kind = 'errand'   # tab tests switch to sit-down: only a sit-down asks for a tab

    def kind_flags(self, flags):
        return flags if '--successor' in flags or '--kind' in flags or 'no-kind' in flags else (*flags, '--kind', self.default_kind)

    def state(self, text='# State\nWhere things stand.\n\n## How we work\n- Plain words.\n', name='state.md'):
        path = os.path.join(self.home, name)
        with open(path, 'w') as f:
            f.write(text)
        return path

    def spawn(self, name, *flags, who='me-0001', brief='Dig into the delay-notice drafts.', full=False):
        flags = tuple(f for f in self.kind_flags(flags) if f != 'no-kind')
        if '--successor' in flags and '--state' not in flags and 'no-state' not in flags:
            flags = (*flags, '--state', self.state())   # a successor starts from the state file its session wrote
        flags = tuple(f for f in flags if f != 'no-state')
        p = self.run_hive('spawn', '--name', name, *flags, stdin=brief, self_id=who, ok=False, full=True)
        return (json.loads(p.stdout), p) if full else json.loads(p.stdout)

    def test_a_sub_session_starts_in_the_background_knowing_its_parent(self):
        r = self.spawn('notice drafts')
        self.assertEqual(r, {'action': 'started', 'name': 'notice-drafts', 'where': 'background', 'id': 'abcd1234',
                             'kind': 'errand'})
        argv = self.spawns()[0]['argv']
        self.assertEqual(argv[:4], ['--bg', '-n', 'notice-drafts', '--'])
        self.assertIn("an errand sub-session that work-aa started with the user's yes", argv[4])
        self.assertIn('Debrief from sub-session notice-drafts', argv[4])
        self.assertIn('Dig into the delay-notice drafts.', argv[4])
        self.assertIn('work-aa started sub-session notice-drafts: errand: Dig into', self.run_hive('log'))

    # --- the kind: errand or sit-down ---

    def test_a_spawn_without_a_kind_is_refused_with_the_verb_test(self):
        r, p = self.spawn('notice drafts', 'no-kind', full=True)
        self.assertEqual(r['action'], 'refused')
        self.assertIn('--kind errand or --kind sit-down', r['reason'])
        self.assertEqual(len(r['test']), 3)
        self.assertEqual(p.returncode, 1)
        said = p.stderr.splitlines()
        self.assertEqual(len(said), 4, 'a heading and the three-line verb test')
        self.assertIn('the user does the verb', said[1])
        self.assertIn('the session does the verb', said[2])
        self.assertIn('Still unclear', said[3])
        self.assertEqual(self.spawns(), [], 'nothing started')
        self.assertNotIn('notice-drafts', self.run_hive('log'))

    def test_a_kind_outside_the_two_is_refused(self):
        p = self.run_hive('spawn', '--name', 'x', '--kind', 'huddle', stdin='Brief.', ok=False, full=True)
        self.assertNotEqual(p.returncode, 0)
        self.assertEqual(self.spawns(), [])

    def test_a_successor_needs_no_kind_and_records_none(self):
        self.run_hive('role', *self.DESK_ROLE)
        r = self.spawn('desk-next', '--successor', '--kind', 'sit-down')
        self.assertEqual(r['action'], 'started')
        self.assertNotIn('kind', r)
        self.assertIsNone(self.children_file()[0]['kind'])
        self.assertNotIn('sit-down', self.spawns()[0]['argv'][4].split('## Brief')[0])

    def test_a_sit_down_is_told_to_prep_wait_for_the_user_and_fold_back_at_its_end_goal(self):
        r = self.spawn('prototypes', '--kind', 'sit-down', brief='Pick rounds. End goal: picks recorded.')
        self.assertEqual((r['where'], r['kind']), ('background', 'sit-down'))
        header = self.spawns()[0]['argv'][4].split('## Brief')[0]
        self.assertIn("a sit-down sub-session that work-aa started with the user's yes", header)
        self.assertIn('the user works in this session with you', header)
        self.assertIn("prep on your own first", header)
        self.assertIn('wait for them', header)
        self.assertIn("When the brief's end goal is done (its check passes, or the user says they are done)", header)
        self.assertIn('Debrief from sub-session prototypes', header)
        self.assertIn('time without the user is no reason to fold back', header)
        self.assertIn('You cannot start sub-sessions of your own', header)
        self.assertEqual(self.children_file()[0]['kind'], 'sit-down')
        spawned = [json.loads(l) for l in open(os.path.join(self.home, '.claude', 'session-hive', 'log.ndjson'))
                   if '"spawn"' in l]
        self.assertEqual(spawned[0]['kind'], 'sit-down', 'the log event carries the kind for desk.py and the panel')
        self.assertIn('started sub-session prototypes: sit-down: Pick rounds', self.run_hive('log'))
        # The startup lists show the kind: the parent's, and the sit-down's own (its fold-back line).
        p = subprocess.Popen(['sleep', '60'])
        self.addCleanup(lambda: (p.kill(), p.wait()))
        self.register(p.pid, 'sit-0008', 'prototypes', '/work/repo')
        self.assertIn('sit-down sub-session of work-aa', self.run_hive('peers'))
        mine = self.run_hive('peers', self_id='sit-0008')
        self.assertIn('You are a sit-down sub-session of **work-aa**: the user works in you', mine)
        self.assertIn("When your brief's end goal is done", mine)

    def test_an_errands_startup_list_reads_as_before(self):
        self.spawn('notice drafts')
        p = subprocess.Popen(['sleep', '60'])
        self.addCleanup(lambda: (p.kill(), p.wait()))
        self.register(p.pid, 'kid-0008', 'notice-drafts', '/work/repo')
        self.assertIn('errand sub-session of work-aa', self.run_hive('peers'))
        self.assertIn('You are an errand sub-session of **work-aa**. When your brief is done',
                      self.run_hive('peers', self_id='kid-0008'))

    def test_a_spawn_with_no_kind_and_no_brief_still_prints_the_verb_test(self):
        r, p = self.spawn('notice drafts', 'no-kind', brief='', full=True)
        self.assertIn('--kind errand or --kind sit-down', r['reason'])
        self.assertIn('The verb test', p.stderr)

    # --- sub-sessions in a VS Code tab ---

    def tab_setup(self, folder=None):
        """A real folder for this session, and a live panel whose window has `folder` (default: it) open."""
        self.default_kind = 'sit-down'
        self.repo = tempfile.mkdtemp()
        self.me = self.register(os.getpid(), 'me-0001', 'work-aa', self.repo)
        panels = os.path.join(self.home, '.claude', 'session-hive', 'panels')
        os.makedirs(panels, exist_ok=True)
        with open(os.path.join(panels, f'{os.getpid()}.json'), 'w') as f:
            json.dump({'pid': os.getpid(), 'procStart': proc_start(os.getpid()), 'folders': [folder or self.repo]}, f)
        self.spawn_dir = os.path.join(self.home, '.claude', 'session-hive', 'spawn')
        # A live process to stand in for the new tab's session.
        self.tab_proc = subprocess.Popen(['sleep', '60'])
        self.addCleanup(lambda: (self.tab_proc.kill(), self.tab_proc.wait()))

    def fake_panel(self, pickup=True):
        """Stands in for the panel and the new tab: opens each request, then (pickup) takes it as the tab's
        session would. Returns the thread and the pickup answers."""
        import threading
        got = []
        def run():
            end = time.time() + 10
            while time.time() < end:
                for f in os.listdir(self.spawn_dir) if os.path.isdir(self.spawn_dir) else []:
                    if f.endswith('.json'):
                        token = f[:-5]
                        os.rename(os.path.join(self.spawn_dir, f), os.path.join(self.spawn_dir, token + '.opening'))
                        if pickup:
                            self.register(self.tab_proc.pid, 'tab-0009', 'repo-3', self.repo)
                            got.append(json.loads(self.run_hive('pickup', '--token', token, self_id='tab-0009')))
                        return
                time.sleep(0.05)
        t = threading.Thread(target=run)
        t.start()
        return t, got

    def test_with_a_panel_open_on_the_folder_a_sub_session_starts_in_a_tab(self):
        self.tab_setup()
        t, got = self.fake_panel()
        r = self.spawn('notice drafts')
        t.join()
        self.assertEqual(r, {'action': 'started', 'name': 'notice-drafts', 'where': 'tab', 'id': 'tab-0009',
                             'messageAs': 'repo-3', 'kind': 'sit-down'})
        self.assertEqual(self.spawns(), [], 'no background session')
        self.assertEqual(got[0]['action'], 'submit')
        self.assertIn("a sit-down sub-session that work-aa started with the user's yes", got[0]['text'])
        self.assertIn('Dig into the delay-notice drafts.', got[0]['text'])
        with open(os.path.join(self.home, '.claude', 'session-hive', 'children.json')) as f:
            kid = json.load(f)[-1]
        self.assertEqual((kid['name'], kid['sessionId'], kid.get('pending')), ('notice-drafts', 'tab-0009', None))
        debrief = self.run_hive('debrief', self_id='tab-0009', ok=False)
        self.assertIn('work-aa', debrief, 'found by its session id, so it knows its parent')
        peers = self.run_hive('peers')
        self.assertIn('**repo-3**', peers, 'listed by the name messages reach it by')
        self.assertIn('sub-session notice-drafts of work-aa', peers)
        mine = self.run_hive('peers', self_id='tab-0009')
        self.assertIn('You are **repo-3**. Your sub-session name is notice-drafts', mine)
        self.assertIn('Debrief from sub-session notice-drafts', mine)

    def test_the_tab_session_knows_it_is_a_sub_session_as_soon_as_it_takes_the_brief(self):
        self.tab_setup()
        seen = {}
        t, got = self.fake_panel()
        orig = self.run_hive
        def spy(*args, **kw):
            out = orig(*args, **kw)
            if args[:1] == ('pickup',):
                seen['debrief'] = orig('debrief', self_id='tab-0009', ok=False)
            return out
        self.run_hive = spy
        self.spawn_quick('notice drafts')
        t.join()
        self.assertIn('work-aa', seen['debrief'], 'before spawn itself has seen the pickup')

    def test_a_spawn_interrupted_while_it_waits_leaves_no_request_and_no_entry(self):
        import signal
        self.tab_setup()
        env = dict(os.environ, HOME=self.home, HIVE_CLAUDE=self.fake_claude())
        p = subprocess.Popen([sys.executable, '-I', HIVE, '--self', 'me-0001', 'spawn', '--name', 'cut-short',
                              '--kind', 'sit-down'],
                             stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=env)
        p.stdin.write('Brief.'); p.stdin.close()
        end = time.time() + 5
        while not (os.path.isdir(self.spawn_dir) and any(f.endswith('.json') for f in os.listdir(self.spawn_dir))):
            self.assertLess(time.time(), end); time.sleep(0.05)
        p.send_signal(signal.SIGINT); p.wait(10); p.stdout.close(); p.stderr.close()
        self.assertEqual([f for f in os.listdir(self.spawn_dir) if f.endswith(('.json', '.opening'))], [])
        with open(os.path.join(self.home, '.claude', 'session-hive', 'children.json')) as f:
            self.assertEqual([k['name'] for k in json.load(f)], [], 'the name is free again')

    def test_a_second_pickup_of_the_same_request_gets_nothing(self):
        self.tab_setup()
        t, got = self.fake_panel()
        self.spawn('notice drafts')
        t.join()
        token = [f for f in os.listdir(self.spawn_dir) if f.endswith('.taken')][0][:-6]
        again = json.loads(self.run_hive('pickup', '--token', token, self_id='tab-0009'))
        self.assertEqual(again['action'], 'none')

    def test_when_no_panel_opens_the_tab_it_starts_in_the_background(self):
        self.tab_setup()
        r = self.spawn_quick('notice drafts')
        self.assertEqual((r['action'], r['where'], r['id']), ('started', 'background', 'abcd1234'))
        self.assertIn('no Claude Sessions panel opened a tab', r['note'])
        self.assertEqual(len(self.spawns()), 1)
        self.assertTrue(any(f.endswith('.fallback') for f in os.listdir(self.spawn_dir)))

    def test_a_tab_whose_session_never_takes_the_brief_is_withdrawn_and_it_starts_in_the_background(self):
        self.tab_setup()
        t, _ = self.fake_panel(pickup=False)
        r = self.spawn_quick('notice drafts')
        t.join()
        self.assertEqual(r['where'], 'background')
        self.assertIn('never took the brief', r['note'])
        token = [f for f in os.listdir(self.spawn_dir) if f.endswith('.withdrawn')][0][:-10]
        late = json.loads(self.run_hive('pickup', '--token', token, self_id='me-0001'))
        self.assertEqual(late['action'], 'none', 'a late session finds nothing to take')

    def test_a_panel_on_another_folder_is_not_asked(self):
        self.tab_setup(folder='/somewhere/else')
        start = time.time()
        r = self.spawn('notice drafts')
        self.assertEqual(r['where'], 'background')
        self.assertNotIn('note', r)
        self.assertLess(time.time() - start, 5, 'no wait for a tab')

    def test_a_panel_whose_process_ended_is_not_asked(self):
        self.tab_setup()
        panels = os.path.join(self.home, '.claude', 'session-hive', 'panels')
        with open(os.path.join(panels, f'{os.getpid()}.json'), 'w') as f:
            json.dump({'pid': os.getpid(), 'procStart': '1', 'folders': [self.repo]}, f)
        self.assertNotIn('note', self.spawn('notice drafts'))

    def test_pickup_refuses_a_token_that_is_not_one(self):
        self.assertEqual(json.loads(self.run_hive('pickup', '--token', '../children'))['action'], 'none')

    def spawn_quick(self, name):
        return json.loads(self.run_hive('spawn', '--name', name, *self.kind_flags(()),
                                        stdin='Dig into the delay-notice drafts.', ok=False,
                                        env_extra={'HIVE_TAB_CLAIM_SECONDS': '1', 'HIVE_TAB_PICKUP_SECONDS': '1'}))

    def test_an_errand_never_asks_the_panel_for_a_tab(self):
        self.tab_setup()
        start = time.time()
        r = self.spawn('notice drafts', '--kind', 'errand')
        self.assertEqual((r['where'], r['kind']), ('background', 'errand'))
        self.assertNotIn('note', r)
        self.assertLess(time.time() - start, 5, 'no wait for a tab')
        self.assertEqual(os.listdir(self.spawn_dir) if os.path.isdir(self.spawn_dir) else [], [], 'no request left')

    def test_a_successor_never_asks_the_panel_for_a_tab(self):
        self.tab_setup()
        self.run_hive('role', *self.DESK_ROLE)
        r = self.spawn('desk-next', '--successor')
        self.assertEqual(r['where'], 'background')
        self.assertNotIn('note', r)
        self.assertEqual(os.listdir(self.spawn_dir) if os.path.isdir(self.spawn_dir) else [], [], 'no request left')

    def test_a_sit_down_while_the_user_is_away_starts_in_the_background(self):
        self.tab_setup()
        self.set_away()
        start = time.time()
        r = self.spawn('notice drafts')
        self.assertEqual((r['where'], r['kind']), ('background', 'sit-down'))
        self.assertIn('the user is away', r['note'], 'the parent can tell the user why it is not a tab')
        self.assertLess(time.time() - start, 5, 'no wait for a tab nobody is at')
        self.assertEqual(os.listdir(self.spawn_dir) if os.path.isdir(self.spawn_dir) else [], [], 'no request left')

    # --- a watching background session opened in VS Code ---

    def resume_note(self, sid, watching='Poll deploy for d98af1fd', age=0):
        d = os.path.join(self.home, '.claude', 'session-hive', 'resume')
        os.makedirs(d, exist_ok=True)
        with open(os.path.join(d, sid + '.json'), 'w') as f:
            json.dump({'at': time.time() - age, 'watching': watching}, f)

    def test_a_session_opened_mid_watch_is_told_once_what_was_cut_off(self):
        self.resume_note('me-0001')
        said = self.run_hive('resumed')
        self.assertIn('Poll deploy for d98af1fd', said)
        self.assertIn('start it again', said)
        self.assertEqual(self.run_hive('resumed'), '', 'once')

    def test_no_note_and_a_stale_note_say_nothing(self):
        self.assertEqual(self.run_hive('resumed'), '')
        self.resume_note('me-0001', age=7200)
        self.assertEqual(self.run_hive('resumed'), '')

    def test_another_sessions_note_is_left_for_it(self):
        self.resume_note('peer-0002')
        self.assertEqual(self.run_hive('resumed'), '')
        self.assertIn('Poll deploy', self.run_hive('resumed', self_id='peer-0002'))

    def make_peer_a_child(self):
        os.makedirs(os.path.join(self.home, '.claude', 'session-hive'), exist_ok=True)
        with open(os.path.join(self.home, '.claude', 'session-hive', 'children.json'), 'w') as f:
            json.dump([{'name': 'work-bb', 'parent': 'work-aa', 'parentId': 'me-0001', 'at': time.time()}], f)

    def test_a_taken_name_gets_a_number(self):
        self.assertEqual(self.spawn('work-bb')['name'], 'work-bb-2')

    def test_a_sub_session_cannot_start_its_own(self):
        self.make_peer_a_child()
        r = self.spawn('deeper', who='peer-0002')
        self.assertEqual(r['action'], 'refused')
        self.assertIn('cannot start their own unless they hold a desk role', r['reason'])

    DESK_ROLE = ('--workspace', '/work/repo', '--area', 'hire', '--role', 'desk')

    def children_file(self):
        with open(os.path.join(self.home, '.claude', 'session-hive', 'children.json')) as f:
            return json.load(f)

    def test_a_sub_session_holding_a_desk_role_starts_its_own_one_level_down(self):
        self.make_peer_a_child()
        self.run_hive('role', *self.DESK_ROLE, self_id='peer-0002')
        r = self.spawn('builder', who='peer-0002')
        self.assertEqual(r['action'], 'started')
        kid = [k for k in self.children_file() if k['name'] == 'builder'][0]
        self.assertEqual((kid['parent'], kid['parentId']), ('work-bb', 'peer-0002'), "the successor's children are its own")
        self.assertEqual(kid['route'], {'workspace': '/work/repo', 'area': 'hire', 'role': 'desk'})
        header = self.spawns()[0]['argv'][4].split('## Brief')[0]
        self.assertIn('You cannot start sub-sessions of your own, except a successor', header, 'still one level of children per Desk')

    def test_a_desk_roles_child_still_cannot_start_its_own(self):
        self.make_peer_a_child()
        self.run_hive('role', *self.DESK_ROLE, self_id='peer-0002')
        self.spawn('builder', who='peer-0002')
        p = subprocess.Popen(['sleep', '60'])
        self.addCleanup(lambda: (p.kill(), p.wait()))
        self.register(p.pid, 'kid-0005', 'builder', '/work/repo')
        r = self.spawn('deeper', who='kid-0005')
        self.assertEqual(r['action'], 'refused')
        self.assertIn('cannot start their own', r['reason'])

    def test_a_role_other_than_desk_does_not_lift_the_limit(self):
        self.make_peer_a_child()
        self.run_hive('role', '--workspace', '/work/repo', '--area', 'runner', '--role', 'builder', self_id='peer-0002')
        self.assertEqual(self.spawn('deeper', who='peer-0002')['action'], 'refused')

    def test_a_desk_role_handed_on_takes_the_lift_with_it(self):
        self.make_peer_a_child()
        self.run_hive('role', *self.DESK_ROLE, self_id='peer-0002')
        self.run_hive('role', *self.DESK_ROLE)   # work-aa takes the desk back
        self.assertEqual(self.spawn('deeper', who='peer-0002')['action'], 'refused')

    def test_a_desk_starts_its_successor_who_takes_the_role_and_starts_its_own(self):
        self.run_hive('role', *self.DESK_ROLE)
        r = self.spawn('desk-next', '--successor', brief='Take over from the handoff block in open-items.md.')
        self.assertEqual(r['action'], 'started')
        header = self.spawns()[0]['argv'][4].split('## Brief')[0]
        self.assertIn('the successor that work-aa started', header)
        self.assertIn('take over its desk role for hire', header)
        self.assertIn('role --workspace /work/repo --area hire --role desk', header)
        self.assertIn('you owe it no debrief', header)
        self.assertNotIn('Debrief from sub-session', header)
        self.assertNotIn('cannot start sub-sessions', header)
        kid = self.children_file()[0]
        self.assertTrue(kid['successor'])
        self.assertIn('work-aa started sub-session desk-next: successor: Take over', self.run_hive('log'))
        # The successor comes up, sees it is one, takes the role, and can start builders of its own.
        p = subprocess.Popen(['sleep', '60'])
        self.addCleanup(lambda: (p.kill(), p.wait()))
        self.register(p.pid, 'next-0006', 'desk-next', '/work/repo')
        before = self.run_hive('peers', self_id='next-0006')
        self.assertIn('You are the successor **work-aa** started for its desk role for hire', before)
        self.assertNotIn('When your brief is done', before)
        self.assertIn('successor of work-aa', self.run_hive('peers'))
        self.assertEqual(self.spawn('too-soon', who='next-0006')['action'], 'refused', 'not before it takes the role')
        self.run_hive('role', *self.DESK_ROLE, self_id='next-0006')
        after = self.run_hive('peers', self_id='next-0006')
        self.assertIn('you hold the desk role for hire: you owe it no debrief', after)
        self.assertEqual(self.spawn('runner-builder', who='next-0006')['action'], 'started')
        self.assertEqual(self.spawn('desk-after', '--successor', who='next-0006')['action'], 'started')
        self.assertEqual(self.spawn('more', who='me-0001')['action'], 'started', 'the old Desk is not a sub-session')
        # The next successor takes the role; the one before it is not told to take it back.
        q = subprocess.Popen(['sleep', '60'])
        self.addCleanup(lambda: (q.kill(), q.wait()))
        self.register(q.pid, 'after-0007', 'desk-after', '/work/repo')
        took = self.run_hive('role', *self.DESK_ROLE, self_id='after-0007', full=True)
        self.assertEqual(took.stderr, '', 'the planned handoff does not warn that the old Desk is still live')
        handed = self.run_hive('peers', self_id='next-0006')
        self.assertIn('have handed its desk role for hire on to desk-after: leave the role there', handed)
        self.assertNotIn('Take it first', handed)
        self.assertEqual(self.spawn('late', who='next-0006')['action'], 'refused', 'the lift went with the role')
        self.assertIn('you hold the desk role for hire', self.run_hive('peers', self_id='after-0007'))

    def test_taking_a_role_from_a_live_holder_still_warns_outside_a_planned_handoff(self):
        self.run_hive('role', *self.DESK_ROLE)
        p = self.run_hive('role', *self.DESK_ROLE, self_id='peer-0002', full=True)
        self.assertIn('work-aa holds desk for hire and is still live', p.stderr)

    def test_a_successor_taking_another_of_its_parents_roles_is_still_warned(self):
        self.run_hive('role', *self.DESK_ROLE)
        builder = ('--workspace', '/work/repo', '--area', 'runner', '--role', 'builder')
        self.run_hive('role', *builder)
        self.spawn('desk-next', '--successor')
        p = subprocess.Popen(['sleep', '60'])
        self.addCleanup(lambda: (p.kill(), p.wait()))
        self.register(p.pid, 'next-0006', 'desk-next', '/work/repo')
        self.assertIn('is still live', self.run_hive('role', *builder, self_id='next-0006', full=True).stderr)
        self.assertEqual(self.run_hive('role', *self.DESK_ROLE, self_id='next-0006', full=True).stderr, '')

    def test_the_successors_role_command_is_quoted(self):
        self.run_hive('role', '--workspace', '/work/my repo', '--area', 'schema healing', '--role', 'Desk')
        self.assertEqual(self.spawn('desk-next', '--successor')['action'], 'started', 'the desk role in any case')
        header = self.spawns()[0]['argv'][4]
        self.assertIn("role --workspace '/work/my repo' --area 'schema healing' --role Desk`", header)

    def test_an_unattended_successor_reads_as_one(self):
        self.set_away()
        self.run_hive('role', *self.DESK_ROLE)
        self.spawn('desk-next', '--successor', '--unattended')
        header = self.spawns()[0]['argv'][4].split('## Brief')[0]
        self.assertIn('to take over its desk role for hire, while the user is away, without their yes: carry on only '
                      'with the work the user already approved for this role', header)
        self.assertNotIn("your parent's run", header)

    def test_a_successor_that_has_not_taken_the_role_owes_no_debrief(self):
        self.kid({'workspace': '/work/repo', 'area': 'hire', 'role': 'desk'})
        with open(os.path.join(self.home, '.claude', 'session-hive', 'children.json')) as f:
            kids = json.load(f)
        kids[0]['successor'] = True
        with open(os.path.join(self.home, '.claude', 'session-hive', 'children.json'), 'w') as f:
            json.dump(kids, f)
        p = self.debrief(ok=False)
        self.assertEqual(p.returncode, 1)
        self.assertIn("kid-cc is work-aa's successor, so it owes work-aa no debrief", p.stderr)


    def test_a_successor_or_a_desk_holder_owes_no_debrief(self):
        self.kid({'workspace': '/work/repo', 'area': 'hire', 'role': 'desk'})
        self.run_hive('role', *self.DESK_ROLE, self_id='kid-0004')
        p = self.debrief(ok=False)
        self.assertEqual(p.returncode, 1)
        self.assertIn('kid-cc holds the desk role for hire, so it owes work-aa no debrief', p.stderr)

    def test_unattended_only_while_away_and_no_count_cap(self):
        self.assertIn('not away', self.spawn('a', '--unattended')['reason'])
        self.set_away()
        for n in 'abcde':   # no cap on how many while away (Aaron, HIRE e1116-01)
            self.assertEqual(self.spawn(n, '--unattended')['action'], 'started')
        self.assertIn('take on no new job', self.spawns()[0]['argv'][4])
        self.assertEqual(self.spawn('f')['action'], 'started')

    def test_a_keep_going_or_new_job_note_wakes_a_long_session(self):
        for marker in ('[keep going] the runner stalled on TICKET-5', '[new job] build the poses (e1107-40)'):
            text = f'<cross-session-message from-name="work-bb">\n{marker}\n</cross-session-message>'
            v = self.receive('--tokens', '650000', text=text)
            self.assertEqual(v['action'], 'deliver', marker)
            self.assertIn(marker, v['text'])
        self.assertEqual(self.spawns(), [], 'no sub-session is started for it')

    def test_a_marker_does_not_pass_the_other_limits(self):
        self.assertEqual(self.receive('--tokens', '650000', text='an ordinary note')['action'], 'hold')
        self.assertEqual(self.receive('--usage', '80', text='[keep going] x')['action'], 'hold')
        self.snapshot([{'id': 'me-0001', 'parked': True}])
        self.assertEqual(self.receive('--tokens', '650000', text='[new job] y (e1101-01)')['action'], 'hold')

    def test_the_list_shows_sub_sessions_and_moved_threads(self):
        self.make_peer_a_child()
        self.run_hive('sent', '--to', 'work-bb', stdin='Thread moved: runner-lane design → work-aa\nDetails…')
        out = self.run_hive('peers')
        self.assertIn('sub-session of work-aa', out)
        self.assertIn('threads moved out of it: runner-lane design → work-aa', out)
        mine = self.run_hive('peers', self_id='peer-0002')
        self.assertIn('You are a sub-session of **work-aa**', mine)
        self.assertIn('A thread moved out of this session: runner-lane design → work-aa', mine)

    # --- events: decided, role, moved, note, and the fold ---

    def elsewhere(self):
        """A live session in another workspace."""
        p = subprocess.Popen(['sleep', '60'])
        self.addCleanup(lambda: (p.kill(), p.wait()))
        return self.register(p.pid, 'far-0003', 'other-cc', '/elsewhere')

    def since(self, *args, who='me-0001'):
        return self.run_hive('since', *args, self_id=who)

    def add_log(self, rec):
        os.makedirs(os.path.join(self.home, '.claude', 'session-hive'), exist_ok=True)
        with open(os.path.join(self.home, '.claude', 'session-hive', 'log.ndjson'), 'a') as f:
            f.write(json.dumps(rec) + '\n')

    def test_decide_prints_a_date_based_id_and_logs_the_decision(self):
        day = time.strftime('%m%d')
        first = self.run_hive('decide', '--words', 'yes', '--workspace', '/work/repo', '--area', 'runner', 'no fourth account').strip()
        second = self.run_hive('decide', '--words', 'yes', '--workspace', '/work/repo/', '--area', 'qa', 'ship it', self_id='peer-0002').strip()
        self.assertEqual((first, second), (f'e{day}-01', f'e{day}-02'))
        rec = self.log()[0]
        self.assertEqual({k: rec[k] for k in ('dir', 'id', 'from', 'workspace', 'area', 'text')},
                         {'dir': 'decided', 'id': f'e{day}-01', 'from': 'work-aa', 'workspace': '/work/repo',
                          'area': 'runner', 'text': 'no fourth account'})
        self.assertEqual(self.log()[1]['workspace'], '/work/repo', 'the path is normalised')
        self.assertIn(f'work-aa recorded decision [e{day}-01] runner (/work/repo): no fourth account', self.run_hive('log'))

    # A decision record quotes the user (HIRE time retro 2026-11-08: a live database fix was recorded as the
    # user's pick from "lets just do a big merge", and 11 merge words were recorded again as new decisions).

    def test_decide_without_the_users_words_or_a_box_answer_is_refused_and_writes_nothing(self):
        for extra in ((), ('--words', ''), ('--words', ' \n '), ('--box', ''), ('--box', '  '),
                      ('--words', '', '--box', 'Option A'), ('--restates', 'e0101-01', '--words', '')):
            p = self.run_hive('decide', *extra, '--workspace', '/work/repo', '--area', 'qa', 'ship it', ok=False, full=True)
            self.assertEqual(p.returncode, 2, extra)
            self.assertEqual(p.stdout, '', 'no id is printed, so there is nothing to cite')
            self.assertIn('nothing was written', p.stderr)
        bare = self.run_hive('decide', '--workspace', '/work/repo', '--area', 'qa', 'ship it', ok=False, full=True).stderr
        for way_on in ('--words', '--box', '--restates <id>'):
            self.assertIn(way_on, bare, 'the refusal names what to pass')
        self.assertFalse(os.path.exists(os.path.join(self.home, '.claude', 'session-hive', 'log.ndjson')))

    def test_decide_records_the_users_words_or_the_option_they_picked(self):
        day = time.strftime('%m%d')
        self.run_hive('decide', '--workspace', '/work/repo', '--area', 'qa', '--words', 'Yup lets\ndo it', 'spend approved')
        self.run_hive('decide', '--workspace', '/work/repo', '--area', 'qa', '--box', 'Option B: wait a day', 'wait a day',
                      self_id='peer-0002')
        said, picked = self.log()
        self.assertEqual((said['words'], 'box' in said), ('Yup lets do it', False))
        self.assertEqual((picked['box'], 'words' in picked), ('Option B: wait a day', False))
        log = self.run_hive('log')
        self.assertIn(f'[e{day}-01] qa (/work/repo): spend approved · said "Yup lets do it"', log)
        self.assertIn(f'[e{day}-02] qa (/work/repo): wait a day · picked "Option B: wait a day"', log)
        self.assertRegex(self.since(), rf'decided \[e{day}-02\] qa: wait a day · picked "Option B: wait a day" \(work-bb\)')

    def test_long_words_are_cut_on_the_record_and_shorter_in_the_fold(self):
        self.run_hive('decide', '--workspace', '/work/repo', '--area', 'qa', '--words', 'w' * 500, 'x', self_id='peer-0002')
        self.assertEqual(len(self.log()[-1]['words']), 400)
        self.assertTrue(self.log()[-1]['words'].endswith('…'))
        line = next(l for l in self.since().splitlines() if ' decided ' in l)
        self.assertLess(len(line), 140)
        self.assertTrue(line.endswith('… (work-bb)'), line)

    def test_a_record_made_before_words_were_kept_still_reads(self):
        self.add_log({'at': time.time(), 'dir': 'decided', 'id': 'e-old', 'from': 'work-bb', 'fromId': 'peer-0002',
                      'workspace': '/work/repo', 'area': 'qa', 'text': 'an old decision'})
        self.assertRegex(self.since(), r'(?m)decided \[e-old\] qa: an old decision \(work-bb\)$')
        self.assertRegex(self.run_hive('log'), r'(?m)\[e-old\] qa \(/work/repo\): an old decision$')

    def test_restates_writes_a_note_beside_the_decision_not_a_new_one(self):
        day = time.strftime('%m%d')
        first = self.run_hive('decide', '--words', 'merge 12 once the login check passes', '--workspace', '/work/repo',
                              '--area', 'merging', 'merge: #12 (after the login check)', self_id='peer-0002').strip()
        far = self.elsewhere()   # a session elsewhere noting it: the note counts for the decision's workspace
        p = self.run_hive('decide', '--restates', first, '--workspace', '/work/repo/', '--area', 'Merging',
                          'merge: #12 (condition met)', self_id=far['sessionId'], full=True)
        self.assertEqual(p.stdout.strip(), first, 'the id to cite is still the one decision')
        self.assertIn('no new decision', p.stderr)
        note = self.log()[-1]
        self.assertEqual({k: note.get(k) for k in ('dir', 'id', 'restates', 'workspace', 'area', 'text', 'from')},
                         {'dir': 'note', 'id': None, 'restates': first, 'workspace': '/work/repo', 'area': 'merging',
                          'text': f'restates {first}: merge: #12 (condition met)', 'from': 'other-cc'})
        self.assertEqual([r['id'] for r in self.log() if r['dir'] == 'decided'], [first])
        self.assertRegex(self.since(), rf'note restates {first}: merge: #12 \(condition met\) \(other-cc\)')
        # the next decision of the day takes the next number: the note used none
        self.assertEqual(self.run_hive('decide', '--words', 'yes', '--workspace', '/work/repo', '--area', 'qa', 'next').strip(),
                         f'e{day}-02')

    def test_restates_keeps_a_repeated_word_when_one_is_given(self):
        first = self.run_hive('decide', '--words', 'yes', '--workspace', '/work/repo', '--area', 'qa', 'ship it').strip()
        self.run_hive('decide', '--restates', f'[{first}]', '--words', 'yes, still ship it', '--workspace', '/work/repo',
                      '--area', 'qa', 'ship it (said again)')
        self.assertEqual((self.log()[-1]['dir'], self.log()[-1]['words']), ('note', 'yes, still ship it'))
        shown = f'restates {first}: ship it (said again) · said "yes, still ship it"'
        self.assertIn(f'work-aa noted: {shown}', self.run_hive('log'))
        self.assertIn(f'note {shown} (work-aa)', self.since(who='peer-0002'))

    def test_restates_refuses_an_id_the_log_does_not_hold_or_another_areas_decision(self):
        first = self.run_hive('decide', '--words', 'yes', '--workspace', '/work/repo', '--area', 'qa', 'ship it').strip()
        for args, why in ((('--restates', 'e0101-99', '--workspace', '/work/repo', '--area', 'qa'), 'no decision e0101-99'),
                          # an empty id never falls through to a new decision, words or not
                          (('--restates', '', '--words', 'yes', '--workspace', '/work/repo', '--area', 'qa'), 'is empty'),
                          (('--restates', ' [] ', '--workspace', '/work/repo', '--area', 'qa'), 'is empty'),
                          (('--restates', first, '--workspace', '/work/repo', '--area', 'runner'), 'is a decision for qa'),
                          (('--restates', first, '--workspace', '/elsewhere', '--area', 'qa'), 'is a decision for qa')):
            p = self.run_hive('decide', *args, 'again', ok=False, full=True)
            self.assertNotEqual(p.returncode, 0)
            self.assertEqual(p.stdout, '')
            self.assertIn(why, p.stderr)
        self.assertEqual(len(self.log()), 1, 'nothing was written')

    def test_the_house_rules_tell_a_session_to_quote_the_user(self):
        out = self.run_hive('peers')
        for part in ('--words "<their words that name it>"', '--box "<the option they picked>"', '`--restates <id>`',
                     "A reply that doesn't name the item is not a decision"):
            self.assertIn(part, out)

    def test_decide_keeps_the_text_to_one_line(self):
        self.run_hive('decide', '--words', 'yes', '--workspace', '/work/repo', '--area', 'qa', 'first line\nsecond line')
        self.assertEqual(self.log()[-1]['text'], 'first line second line')

    def test_role_and_who_name_the_latest_holder(self):
        self.run_hive('role', '--workspace', '/work/repo', '--area', 'runner', '--role', 'builder', self_id='peer-0002')
        self.assertEqual(self.run_hive('who', '--workspace', '/work/repo', '--area', 'runner', '--role', 'builder').strip(), 'work-bb (live)')
        self.run_hive('role', '--workspace', '/work/repo', '--area', 'runner', '--role', 'builder')
        self.assertEqual(self.run_hive('who', '--workspace', '/work/repo', '--area', 'Runner', '--role', 'builder').strip(), 'work-aa (live)')
        self.assertEqual(self.run_hive('who', '--workspace', '/work/repo', '--area', 'qa', '--role', 'builder', ok=False), '')
        self.assertEqual(self.run_hive('who', '--workspace', '/elsewhere', '--area', 'runner', '--role', 'builder', ok=False), '')
        self.assertIn('work-aa holds role builder for runner (/work/repo)', self.run_hive('log'))

    def test_taking_a_role_a_live_session_holds_warns_but_records(self):
        role = ('role', '--workspace', '/work/repo', '--area', 'runner', '--role', 'builder')
        self.run_hive(*role, self_id='peer-0002')
        p = self.run_hive(*role, full=True)
        self.assertIn('work-bb holds builder for runner and is still live', p.stderr)
        self.assertEqual(self.log()[-1]['from'], 'work-aa', 'the role is still recorded')
        self.assertEqual(self.run_hive(*role, full=True).stderr, '', 're-taking your own role is silent')

    def test_a_gone_holder_reads_gone_and_taking_its_role_is_silent(self):
        role = ('role', '--workspace', '/work/repo', '--area', 'runner', '--role', 'builder')
        self.run_hive(*role, self_id='peer-0002')
        os.remove(os.path.join(self.sessions, f"{self.peer['pid']}.json"))   # the peer's process is gone
        self.assertEqual(self.run_hive('who', *role[1:]).strip(), 'work-bb (gone)')
        self.assertEqual(self.run_hive(*role, full=True).stderr, '')

    def test_the_fold_shows_other_sessions_events_one_line_each(self):
        day = time.strftime('%m%d')
        self.run_hive('decide', '--words', 'yes', '--workspace', '/work/repo', '--area', 'runner', 'no fourth account (work-10)', self_id='peer-0002')
        self.run_hive('role', '--workspace', '/work/repo', '--area', 'runner', '--role', 'builder', self_id='peer-0002')
        self.run_hive('decide', '--words', 'yes', '--workspace', '/work/repo', '--area', 'qa', 'my own decision')
        out = self.since()
        self.assertIn('Since you last looked', out)
        lines = [l for l in out.splitlines() if re.match(r'\d\d-\d\d \d\d:\d\d ', l)]
        self.assertEqual(len(lines), 2, out)
        self.assertRegex(lines[0], r'^\d\d-\d\d \d\d:\d\d role runner: work-bb is builder$')
        self.assertRegex(lines[1], rf'^\d\d-\d\d \d\d:\d\d decided \[e{day}-01\] runner: no fourth account \(work-10\) · said "yes" \(work-bb\)$')
        self.assertNotIn('my own decision', out, "a session's own events are not news to it")

    def test_the_cursor_moves_only_when_the_block_is_taken(self):
        self.run_hive('decide', '--words', 'yes', '--workspace', '/work/repo', '--area', 'qa', 'item one', self_id='peer-0002')
        self.assertIn('item one', self.since())
        self.assertIn('item one', self.since('--take'), 'a plain look does not move the cursor')
        self.assertEqual(self.since('--take'), '', 'nothing new: no block at all')
        self.run_hive('decide', '--words', 'yes', '--workspace', '/work/repo', '--area', 'qa', 'item two', self_id='peer-0002')
        out = self.since('--take')
        self.assertIn('item two', out)
        self.assertNotIn('item one', out)

    def test_the_cursor_is_per_session(self):
        far = self.elsewhere()
        self.run_hive('decide', '--words', 'yes', '--workspace', '/elsewhere', '--area', 'qa', 'far news', self_id='peer-0002')
        self.run_hive('decide', '--words', 'yes', '--workspace', '/work/repo', '--area', 'qa', 'near news', self_id='peer-0002')
        self.since('--take')
        self.assertEqual(self.since('--take'), '')
        self.assertIn('far news', self.since('--take', who=far['sessionId']), 'another session has its own cursor')

    def test_the_fold_is_capped_at_eight_lines_newest_first(self):
        for i in range(11):
            self.add_log({'at': time.time() - 100 + i, 'dir': 'decided', 'id': f'e-{i:02d}', 'from': 'work-bb',
                          'workspace': '/work/repo', 'area': 'qa', 'text': f'item {i:02d}'})
        out = self.since('--take')
        lines = [l for l in out.splitlines() if ' decided ' in l]
        self.assertEqual(len(lines), 8)
        self.assertIn('item 10', lines[0])
        self.assertIn('item 03', lines[-1])
        self.assertIn('3 more', out)

    def test_a_session_with_no_cursor_sees_only_the_past_48_hours(self):
        now = time.time()
        self.add_log({'at': now - 49 * 3600, 'dir': 'decided', 'id': 'e-old', 'from': 'work-bb',
                      'workspace': '/work/repo', 'area': 'qa', 'text': 'too old'})
        self.add_log({'at': now - 47 * 3600, 'dir': 'decided', 'id': 'e-new', 'from': 'work-bb',
                      'workspace': '/work/repo', 'area': 'qa', 'text': 'recent enough'})
        out = self.since()
        self.assertIn('recent enough', out)
        self.assertNotIn('too old', out)

    def test_the_fold_keeps_to_this_workspace_and_takes_events_aimed_at_it(self):
        far = self.elsewhere()
        # A session elsewhere deciding something about this workspace: it shows here.
        self.run_hive('decide', '--words', 'yes', '--workspace', '/work/repo', '--area', 'runner', 'cross-workspace yes', self_id='far-0003')
        # A session here deciding something about the other workspace: it shows there, not here.
        self.run_hive('decide', '--words', 'yes', '--workspace', '/elsewhere', '--area', 'qa', 'about elsewhere', self_id='peer-0002')
        mine = self.since()
        self.assertIn('cross-workspace yes', mine)
        self.assertNotIn('about elsewhere', mine)
        theirs = self.since(who=far['sessionId'])
        self.assertIn('about elsewhere', theirs)
        self.assertNotIn('cross-workspace yes', theirs)

    def test_a_thread_moved_note_is_logged_as_its_own_record_and_folded_once(self):
        self.run_hive('sent', '--to', 'work-cc', stdin='Thread moved: runner-lane design → work-bb\nDetails…', self_id='peer-0002')
        moved = [r for r in self.log() if r['dir'] == 'moved']
        self.assertEqual(len(moved), 1)
        self.assertEqual((moved[0]['from'], moved[0]['to'], moved[0]['thread'], moved[0]['holder']),
                         ('work-bb', 'work-cc', 'runner-lane design', 'work-bb'))
        self.assertEqual([r['dir'] for r in self.log()], ['out', 'moved'], 'the message is still logged as sent')
        out = self.since()
        self.assertEqual(sum(1 for l in out.splitlines() if 'runner-lane design' in l), 1, out)
        self.assertRegex(out, r'moved runner-lane design → work-bb \(work-bb to work-cc\)')
        self.assertIn('work-bb → work-cc  thread moved: runner-lane design → work-bb', self.run_hive('log'))

    def test_messages_spawns_and_claims_are_in_the_fold(self):
        self.run_hive('sent', '--to', 'work-cc', stdin='FYI: main fails the drift check', self_id='peer-0002')
        self.run_hive('sent', '--to', 'work-aa', stdin='A question for you', self_id='peer-0002')
        self.claim('/work/repo/docs/asks.md')
        self.claim('/work/repo/docs/asks.md', who='peer-0002')
        self.spawn('notes', who='peer-0002')
        out = self.since()
        self.assertRegex(out, r'message work-bb → work-cc: FYI: main fails the drift check')
        self.assertNotIn('A question for you', out, 'a message to this session reaches it anyway')
        self.assertRegex(out, r'edit work-bb is about to edit /work/repo/docs/asks.md \(held by work-aa\)')
        self.assertRegex(out, r'spawn work-bb started notes: errand: Dig into')

    def test_a_note_goes_to_the_log_and_the_fold(self):
        self.run_hive('note', 'main fails the drift check', self_id='peer-0002')
        self.assertRegex(self.since(), r'note main fails the drift check \(work-bb\)')
        self.assertIn('work-bb noted: main fails the drift check', self.run_hive('log'))

    def test_the_claim_refusal_says_the_attempt_is_in_the_holders_fold(self):
        self.claim('/work/repo/a.md')
        v = self.claim('/work/repo/a.md', who='peer-0002')
        self.assertIn("shows in work-aa's", v['message'])
        self.assertNotIn('Message work-aa first', v['message'])

    def test_the_house_rules_say_what_messages_are_for(self):
        out = self.run_hive('peers')
        self.assertIn('Messages are for', out)
        self.assertIn('`decide --workspace', out)
        self.assertIn('no matching `decided` event', out)


    def test_an_event_appended_late_with_an_older_stamp_is_not_lost(self):
        self.since('--take')
        # Stamped an hour ago but written after this session last looked (a writer that paused).
        self.add_log({'at': time.time() - 3600, 'dir': 'note', 'from': 'work-bb', 'fromId': 'peer-0002',
                      'workspace': '/work/repo', 'text': 'late but real'})
        self.assertIn('late but real', self.since('--take'))
        self.assertEqual(self.since('--take'), '')

    def test_a_damaged_log_line_is_skipped_not_the_whole_log(self):
        day = time.strftime('%m%d')
        self.run_hive('decide', '--words', 'yes', '--workspace', '/work/repo', '--area', 'qa', 'before the damage', self_id='peer-0002')
        with open(os.path.join(self.home, '.claude', 'session-hive', 'log.ndjson'), 'a') as f:
            f.write('{"at": 1, "dir": "out", "fro\n')
        self.assertEqual(self.run_hive('decide', '--words', 'yes', '--workspace', '/work/repo', '--area', 'qa', 'after').strip(), f'e{day}-02')
        self.assertIn('before the damage', self.since())

    def test_fold_lines_stay_one_short_line(self):
        self.run_hive('role', '--workspace', '/work/repo', '--area', 'run\nner ' + 'x' * 50, '--role', 'build\ner',
                      self_id='peer-0002')
        rec = self.log()[-1]
        self.assertNotIn('\n', rec['area'] + rec['role'])
        lines = [l for l in self.since().splitlines() if ' role ' in l]
        self.assertEqual(len(lines), 1)
        self.assertLessEqual(len(lines[0]), 200)

    def test_a_sub_sessions_debrief_is_an_allowed_message(self):
        self.assertIn("a sub-session's one-line debrief or paused note (to the session its first message names)", self.run_hive('peers'))

    # --- where a debrief goes ---

    DESK = ('--workspace', '/work/repo', '--area', 'hire', '--role', 'desk')

    def kid(self, route=None, parent_id='me-0001', parent='work-aa'):
        """A live sub-session, kid-cc, as `spawn` records it."""
        p = subprocess.Popen(['sleep', '60'])
        self.addCleanup(lambda: (p.kill(), p.wait()))
        self.register(p.pid, 'kid-0004', 'kid-cc', '/work/repo')
        os.makedirs(os.path.join(self.home, '.claude', 'session-hive'), exist_ok=True)
        with open(os.path.join(self.home, '.claude', 'session-hive', 'children.json'), 'w') as f:
            json.dump([{'name': 'kid-cc', 'parent': parent, 'parentId': parent_id, 'at': time.time(),
                        'route': route}], f)

    def debrief(self, ok=True):
        return self.run_hive('debrief', self_id='kid-0004', ok=ok, full=not ok)

    def test_a_role_holders_sub_session_is_told_to_debrief_whoever_holds_the_role(self):
        self.run_hive('role', *self.DESK)
        self.spawn('notice drafts')
        header = self.spawns()[0]['argv'][4].split('## Brief')[0]
        self.assertIn('to whoever holds the desk role for hire when you finish, not a fixed session', header)
        self.assertIn('debrief` names them', header)
        self.assertIn('who --workspace /work/repo --area hire --role desk', header)
        self.assertIn('falls back to work-aa, who holds it now', header)
        self.assertNotIn('SendMessage to work-aa', header)
        with open(os.path.join(self.home, '.claude', 'session-hive', 'children.json')) as f:
            self.assertEqual(json.load(f)[0]['route'], {'workspace': '/work/repo', 'area': 'hire', 'role': 'desk'})

    def test_a_session_holding_no_role_is_debriefed_by_name(self):
        self.run_hive('role', *self.DESK, self_id='peer-0002')   # the role is someone else's
        self.spawn('notice drafts')
        header = self.spawns()[0]['argv'][4].split('## Brief')[0]
        self.assertIn('send a one-line debrief with SendMessage to work-aa.', header)
        self.assertNotIn('whoever holds', header)

    def test_a_role_handed_on_is_no_longer_the_old_holders_route(self):
        self.run_hive('role', *self.DESK)
        self.run_hive('role', *self.DESK, self_id='peer-0002')
        self.spawn('late')
        self.assertNotIn('whoever holds', self.spawns()[0]['argv'][4])

    def test_the_debrief_is_asked_for_as_one_line_with_questions_word_for_word(self):
        self.spawn('notice drafts')
        header = self.spawns()[0]['argv'][4].split('## Brief')[0]
        self.assertIn('one-line debrief', header)
        self.assertIn('First line `Debrief from sub-session notice-drafts: …`, and nothing after it', header)
        self.assertIn('any question for the user word for word', header)
        self.assertIn("Details go in the area's files, not the message", header)
        self.assertNotIn('short debrief', header)

    def test_debrief_names_the_current_role_holder_after_a_handoff(self):
        route = {'workspace': '/work/repo', 'area': 'hire', 'role': 'desk'}
        self.run_hive('role', *self.DESK)
        self.kid(route)
        self.assertEqual(self.debrief().strip(), 'work-aa  (holds desk for hire)')
        self.run_hive('role', *self.DESK, self_id='peer-0002')   # the Desk hands off
        self.assertEqual(self.debrief().strip(), 'work-bb  (holds desk for hire)')

    def test_debrief_uses_the_holders_name_now_after_a_rename(self):
        self.kid({'workspace': '/work/repo', 'area': 'hire', 'role': 'desk'})
        self.run_hive('role', *self.DESK, self_id='peer-0002')
        self.register(os.getppid(), 'peer-0002', 'Desk', '/work/repo/.worktrees/x')
        self.assertEqual(self.debrief().strip(), 'Desk  (holds desk for hire)')
        self.assertEqual(self.run_hive('who', *self.DESK).strip(), 'Desk (live, took the role as work-bb)')

    def test_debrief_falls_back_to_the_parent_when_the_holder_is_gone_or_there_is_no_role(self):
        self.kid({'workspace': '/work/repo', 'area': 'hire', 'role': 'desk'})
        self.assertEqual(self.debrief().strip(), 'work-aa  (your parent)', 'no one holds the role')
        self.add_log({'at': time.time(), 'dir': 'role', 'from': 'old-desk', 'fromId': 'gone-0009',
                      'workspace': '/work/repo', 'area': 'hire', 'role': 'desk'})
        self.assertEqual(self.debrief().strip(), 'work-aa  (your parent; old-desk, the last desk for hire, is gone)')
        self.kid(None)
        self.assertEqual(self.debrief().strip(), 'work-aa  (your parent)', 'spawned by a session holding no role')

    def test_debrief_with_no_one_live_says_so_and_fails(self):
        self.kid({'workspace': '/work/repo', 'area': 'hire', 'role': 'desk'}, parent_id='gone-0008', parent='old-parent')
        self.add_log({'at': time.time(), 'dir': 'role', 'from': 'old-desk', 'fromId': 'gone-0009',
                      'workspace': '/work/repo', 'area': 'hire', 'role': 'desk'})
        p = self.debrief(ok=False)
        self.assertEqual(p.returncode, 1)
        self.assertEqual(p.stdout, '')
        self.assertIn('old-desk, the last desk for hire, is gone; old-parent, your parent, is gone', p.stderr)
        self.assertIn("Put it in the area's files", p.stderr)

    def test_debrief_from_a_session_that_is_not_a_sub_session_fails(self):
        p = self.run_hive('debrief', ok=False, full=True)
        self.assertEqual(p.returncode, 1)
        self.assertIn('not a sub-session', p.stderr)

    def test_a_sub_sessions_list_names_the_role_lookup(self):
        self.kid({'workspace': '/work/repo', 'area': 'hire', 'role': 'desk'})
        out = self.run_hive('peers', self_id='kid-0004')
        self.assertIn('You are a sub-session of **work-aa**', out)
        self.assertIn('to whoever holds the desk role for hire when you finish', out)
        self.assertIn('one-line debrief', out)


    def test_a_refused_edit_reaches_a_holder_in_another_workspace(self):
        far = self.elsewhere()
        self.claim('/shared/vault/note.md', who='far-0003')
        self.claim('/shared/vault/note.md')
        self.assertRegex(self.since(who=far['sessionId']), r'edit work-aa is about to edit /shared/vault/note.md \(held by other-cc\)')

    def test_a_handoff_with_a_long_thread_or_an_ascii_arrow_names_the_holder(self):
        self.run_hive('sent', '--to', 'work-cc', stdin='Thread moved: ' + 'y' * 200 + ' -> work-bb', self_id='peer-0002')
        rec = [r for r in self.log() if r['dir'] == 'moved'][-1]
        self.assertEqual(rec['holder'], 'work-bb')
        self.assertTrue(rec['thread'].startswith('yyy'))

    def test_a_handoff_sent_to_this_session_is_not_folded_again(self):
        self.run_hive('sent', '--to', 'work-aa', stdin='Thread moved: release notes → work-bb', self_id='peer-0002')
        self.assertEqual(self.since(), '')

    def test_events_are_not_written_by_an_unknown_session(self):
        home = tempfile.mkdtemp()   # no registered sessions, so the process-tree walk finds none
        p = subprocess.run([sys.executable, '-I', HIVE, 'note', 'who wrote this'], capture_output=True, text=True,
                           env=dict(os.environ, HOME=home), timeout=30)
        self.assertNotEqual(p.returncode, 0)
        self.assertIn('--self', p.stderr)
        self.assertFalse(os.path.exists(os.path.join(home, '.claude', 'session-hive', 'log.ndjson')))

    def test_the_rules_have_no_message_for_ideas_and_say_how_to_check_a_decision(self):
        out = self.run_hive('peers')
        self.assertNotIn('only pass an idea along', out)
        self.assertIn('log --hours 168', out)
        self.assertIn('or under **Decisions**', out)
        self.assertIn('another workspace only with a question, an answer or a handoff', out)


    def test_a_refused_edit_reaches_the_holder_by_session_id_after_a_rename(self):
        far = self.elsewhere()
        self.claim('/shared/vault/note.md', who='far-0003')
        self.register(far['pid'], 'far-0003', 'other-cc-renamed', '/elsewhere')   # same session, new name
        self.claim('/shared/vault/note.md')
        self.assertIn('/shared/vault/note.md', self.since(who='far-0003'))

    def test_an_unknown_self_writes_no_event(self):
        p = subprocess.run([sys.executable, '-I', HIVE, '--self', 'nobody-here', 'decide', '--words', 'yes', '--workspace', '/w', '--area', 'a', 'x'],
                           capture_output=True, text=True, env=dict(os.environ, HOME=self.home), timeout=30)
        self.assertNotEqual(p.returncode, 0)
        self.assertFalse(os.path.exists(os.path.join(self.home, '.claude', 'session-hive', 'log.ndjson')))

    def test_an_over_long_area_or_role_is_refused_not_cut(self):
        out = self.run_hive('role', '--workspace', '/work/repo', '--area', 'a' * 61, '--role', 'builder', ok=False)
        self.assertEqual(out, '')
        self.assertFalse(os.path.exists(os.path.join(self.home, '.claude', 'session-hive', 'log.ndjson')))

    def test_the_holder_is_after_the_last_arrow_and_no_arrow_logs_no_handoff(self):
        self.run_hive('sent', '--to', 'work-cc', stdin='Thread moved: build -> deploy pipeline → work-bb', self_id='peer-0002')
        self.run_hive('sent', '--to', 'work-cc', stdin='Thread moved: the runner design', self_id='peer-0002')
        moved = [r for r in self.log() if r['dir'] == 'moved']
        self.assertEqual([(r['thread'], r['holder']) for r in moved], [('build -> deploy pipeline', 'work-bb')])

    def test_a_record_with_a_bad_time_does_not_silence_the_fold(self):
        self.add_log({'at': None, 'dir': 'note', 'from': 'x', 'fromId': 'x', 'workspace': '/work/repo', 'text': 'bad'})
        self.add_log({'at': 'soon', 'dir': 'note', 'from': 'x', 'fromId': 'x', 'workspace': '/work/repo', 'text': 'bad'})
        self.run_hive('note', 'good news', self_id='peer-0002')
        self.assertIn('good news', self.since('--take'))
        self.assertIn('good news', self.run_hive('log'))

    def test_a_windows_workspace_path_is_read_as_its_wsl_path(self):
        self.run_hive('decide', '--words', 'yes', '--workspace', 'C:\\HQ\\vault', '--area', 'qa', 'x')
        self.assertEqual(self.log()[-1]['workspace'], '/mnt/c/HQ/vault')

    # --- ready to close ---

    DEBRIEF = 'Debrief from sub-session work-aa: PR 712 merged, notes in docs/ship.md'

    @staticmethod
    def call(uid, name, **inp):
        return {'type': 'assistant', 'message': {'content': [{'type': 'tool_use', 'id': uid, 'name': name, 'input': inp}]}}

    @staticmethod
    def result(uid, text):
        return {'type': 'user', 'message': {'content': [{'type': 'tool_result', 'tool_use_id': uid, 'content': text}]}}

    @staticmethod
    def notified(task_id, uid=None):
        use = f'<tool-use-id>{uid}</tool-use-id>\n' if uid else ''
        return {'type': 'user', 'message': {'content': f'<task-notification>\n<task-id>{task_id}</task-id>\n{use}<status>completed</status>'}}

    def mine(self, *records):
        self.transcript('me-0001', '/work/repo', list(records))

    def check(self, text=None):
        return json.loads(self.run_hive('check', '--to', 'desk-4', stdin=text or self.DEBRIEF))

    def marks(self):
        try:
            return [r for r in self.log() if r.get('dir') in ('done', 'paused', 'cleared')]
        except FileNotFoundError:
            return []

    BG_BASH = staticmethod(lambda: (Hive.call('u1', 'Bash', command='gh run watch 99', description='Watch CI', run_in_background=True),
                                    Hive.result('u1', 'Command running in background with ID: bk1. Output is being written to: /tmp/x')))

    def test_a_debrief_with_a_background_command_open_is_refused_naming_it(self):
        self.mine(*self.BG_BASH())
        v = self.check()
        self.assertEqual(v['action'], 'refuse')
        self.assertIn('Watch CI (task bk1)', v['message'])
        self.assertIn('TaskStop', v['message'])
        self.assertIn('Paused from sub-session work-aa: waiting on <what>', v['message'])
        self.assertEqual(self.log()[-1]['dir'], 'refused')
        self.assertIn('debrief refused', self.run_hive('log'))

    def test_a_debrief_passes_once_the_task_is_notified_or_stopped(self):
        self.mine(*self.BG_BASH(), self.notified('bk1', 'u1'))
        self.assertEqual(self.check()['action'], 'allow')
        self.mine(*self.BG_BASH(), self.call('u2', 'TaskStop', task_id='bk1'))
        self.assertEqual(self.check()['action'], 'allow')

    def test_a_notice_written_before_its_call_still_ends_the_task(self):
        self.mine(self.notified('bk1', 'u1'), *self.BG_BASH())
        self.assertEqual(self.check()['action'], 'allow')

    def test_an_open_monitor_or_agent_is_refused_too_and_a_foreground_command_is_not(self):
        self.mine(self.call('m1', 'Monitor', command='tail -f x', description='Watch the lock'),
                  self.result('m1', 'Monitor started (ID: mon1)'),
                  self.call('a1', 'Agent', description='Review the diff', prompt='x'),
                  self.result('a1', 'Async agent launched successfully. agentId: ag1'),
                  self.call('b1', 'Bash', command='ls'), self.result('b1', 'a b'))
        msg = self.check()['message']
        self.assertIn('Monitor: Watch the lock', msg)
        self.assertIn('Agent: Review the diff (task ag1)', msg)
        self.assertNotIn('ls', msg.split('\n', 1)[1].split('Wait')[0])
        self.mine(self.call('m1', 'Monitor', command='tail -f x', description='Watch the lock'),
                  self.result('m1', 'Monitor started (ID: mon1)'), self.notified('mon1'),
                  self.call('a1', 'Agent', description='Review the diff', prompt='x'),
                  self.result('a1', 'Async agent launched successfully. agentId: ag1'), self.notified('ag1'))
        self.assertEqual(self.check()['action'], 'allow')

    def test_only_a_final_debrief_is_checked(self):
        self.mine(*self.BG_BASH())
        for text in ('Question: merge 712 first?', '[keep going] Debrief from sub-session work-aa: 712 merged',
                     'Paused from sub-session work-aa: waiting on the kit lock'):
            self.assertEqual(self.check(text)['action'], 'allow', text)

    def test_a_sent_debrief_marks_ready_to_close_and_only_new_work_clears_it(self):
        self.mine()
        self.run_hive('sent', '--to', 'desk-4', stdin=self.DEBRIEF)
        self.assertEqual([m['dir'] for m in self.marks()], ['done'])
        # conversation: a prompt's fold, a message in, a question out
        self.run_hive('since', '--take', '--cwd', '/work/repo')
        self.receive()
        self.run_hive('sent', '--to', 'desk-4', stdin='Question: anything else?')
        self.assertEqual([m['dir'] for m in self.marks()], ['done'])
        self.run_hive('claim', '--path', '/work/repo/a.md')
        self.assertEqual([m['dir'] for m in self.marks()], ['done', 'cleared'])
        self.assertIn('/work/repo/a.md', self.marks()[-1]['by'])
        self.run_hive('claim', '--path', '/work/repo/b.md')   # nothing left to clear
        self.assertEqual(len(self.marks()), 2)
        self.assertIn('ready to close', self.run_hive('done'))
        self.run_hive('work', '--what', 'git commit')
        self.assertEqual([m['dir'] for m in self.marks()], ['done', 'cleared', 'done', 'cleared'])
        self.assertIn('went back to work (git commit)', self.run_hive('log'))

    def test_done_is_refused_while_a_task_is_open(self):
        self.mine(*self.BG_BASH())
        p = self.run_hive('done', ok=False, full=True)
        self.assertEqual(p.returncode, 1)
        self.assertIn('Watch CI', p.stderr)
        self.assertIn('run `done` again', p.stderr)
        self.assertEqual(self.marks(), [])

    def test_an_undelivered_debrief_or_one_with_a_task_open_marks_nothing(self):
        self.mine()
        self.run_hive('sent', '--to', 'nobody', '--undelivered', stdin=self.DEBRIEF)
        self.mine(*self.BG_BASH())
        self.run_hive('sent', '--to', 'desk-4', stdin=self.DEBRIEF)   # the check before sending failed
        self.assertEqual(self.marks(), [])

    def test_the_paused_form_is_its_own_mark_and_says_what_it_waits_on(self):
        self.run_hive('sent', '--to', 'desk-4', stdin='Paused from sub-session work-aa: waiting on the user\'s merge word for 712')
        m = self.marks()[-1]
        self.assertEqual((m['dir'], m['what']), ('paused', "the user's merge word for 712"))
        self.run_hive('work', '--what', 'a background Monitor')
        self.assertEqual(self.marks()[-1]['was'], 'paused')

    def test_the_fold_leaves_marks_out(self):
        self.run_hive('done', self_id='peer-0002')
        self.run_hive('work', '--what', 'x', self_id='peer-0002')
        self.assertEqual(self.since(), '')

    def test_a_sub_session_is_told_the_check_the_paused_form_and_done(self):
        for kind in ('errand', 'sit-down'):
            self.run_hive('spawn', '--name', f'notice-{kind}', '--kind', kind, stdin='Draft the notices.',
                          env_extra={'HIVE_SPAWN': 'bg'})
        prompts = [s['argv'][-1] for s in self.spawns()]
        self.assertEqual(len(prompts), 2)
        for kind, prompt in zip(('errand', 'sit-down'), prompts):
            self.assertIn('refused while a background task you started is still open', prompt)
            self.assertIn(f'`Paused from sub-session notice-{kind}: waiting on <what>`', prompt)
            self.assertRegex(prompt, r'hive\.py done`')

    # --- results of approved work, self-handoff, closing (retro e1119-29) ---

    def test_the_house_rules_say_results_of_approved_work_are_sent_and_how_long_sessions_hand_off(self):
        rules = self.run_hive('peers')
        self.assertIn('a result of work the user approved that another session needs', rules)
        self.assertIn('is yours to send without asking; tell the user in one line', rules)
        self.assertIn('A request that asks another session to decide something new, or to change files outside '
                      'work the user approved, goes to the user first', rules)
        self.assertNotIn('A request for another session to change files or decide something goes to the user first', rules)
        self.assertIn('Never post to Slack, email', rules)
        self.assertIn('**Long sessions hand off on their own:** past 250k tokens of context', rules)
        self.assertIn('a `## How we work` block', rules)
        self.assertIn('`spawn --successor --state <file> --name <name>`', rules)
        self.assertIn("don't ask whether it is time", rules)
        self.assertIn('`close --name <name>`', rules)
        self.assertNotIn('{handoff}', rules)

    def test_a_successor_is_refused_until_its_state_file_is_written(self):
        r = self.spawn('next', '--successor', 'no-state')
        self.assertIn('starts from a state file', r['reason'])
        self.assertIn('no state file at', self.spawn('next', '--successor', '--state', '/nowhere/state.md')['reason'])
        bare = self.state('# State\nWhere things stand.\n', name='bare.md')
        self.assertIn('has no `## How we work` block', self.spawn('next', '--successor', '--state', bare)['reason'])
        old = self.state(name='old.md')
        os.utime(old, (time.time() - 7200, time.time() - 7200))
        self.assertIn('last written 120 minutes ago', self.spawn('next', '--successor', '--state', old)['reason'])
        self.assertEqual(self.spawns(), [], 'nothing started')

    def test_a_top_level_session_hands_its_work_to_a_successor_that_reads_its_state_first(self):
        state = self.state()
        r = self.spawn('aa-next', '--successor', '--state', state, brief='Carry on from the state file.')
        self.assertEqual((r['action'], r['state']), ('started', state))
        header = self.spawns()[0]['argv'][4].split('## Brief')[0]
        self.assertIn('the successor that work-aa started to carry on its work, carrying on the work the user '
                      'already approved', header)
        self.assertIn(f"Read work-aa's state file first: `{state}`. Its How-we-work block holds the method rules", header)
        self.assertIn('you owe it no debrief', header)
        kid = self.children_file()[0]
        self.assertEqual((kid['successor'], kid['route'], kid['state'], kid['successorOfId']),
                         (True, None, state, 'me-0001'))
        spawn = [x for x in self.log() if x.get('dir') == 'spawn'][0]
        self.assertEqual(spawn['state'], state)
        done = [x for x in self.log() if x.get('dir') == 'done']
        self.assertEqual([(d['fromId'], d['how']) for d in done], [('me-0001', 'handed off to aa-next')],
                         'the session that handed off is ready to close')
        p = subprocess.Popen(['sleep', '60'])
        self.addCleanup(lambda: (p.kill(), p.wait()))
        self.register(p.pid, 'next-0009', 'aa-next', '/work/repo')
        mine = self.run_hive('peers', self_id='next-0009')
        self.assertIn('You are the successor **work-aa** started to carry on its work: you owe it no debrief', mine)
        self.assertIn(f'its state file is `{state}`, and its How-we-work block binds you too', mine)
        self.assertNotIn('When your brief is done', mine)
        self.assertEqual(self.spawn('helper', who='next-0009')['action'], 'started', 'top level, like its predecessor')

    def test_a_sub_sessions_successor_owes_its_parent_the_debrief(self):
        self.kid(route={'workspace': '/work/repo', 'area': 'hire', 'role': 'desk'})
        r = self.spawn('kid-next', '--successor', who='kid-0004', brief='Finish the notices.')
        self.assertEqual(r['action'], 'started')
        kid = [k for k in self.children_file() if k['name'] == 'kid-next'][0]
        self.assertEqual((kid['parent'], kid['parentId'], kid['successor'], kid['successorOf'], kid['kind']),
                         ('work-aa', 'me-0001', False, 'kid-cc', 'errand'))
        self.assertEqual(kid['route'], {'workspace': '/work/repo', 'area': 'hire', 'role': 'desk'})
        header = self.spawns()[0]['argv'][4].split('## Brief')[0]
        self.assertIn("an errand sub-session that work-aa started to carry on kid-cc's brief, which ran out of room", header)
        self.assertIn("Read kid-cc's state file first", header)
        self.assertIn('Debrief from sub-session kid-next', header)
        self.assertIn('falls back to work-aa', header)
        self.assertIn('successor of kid-cc: errand: Finish the notices.', self.run_hive('log'))
        self.assertEqual(self.spawn('side', who='kid-0004')['action'], 'refused', 'still one level deep')

    def test_past_the_handoff_mark_each_prompt_says_to_hand_off_until_a_successor_is_started(self):
        def at(tokens):
            self.transcript('me-0001', '/work/repo', [{'type': 'assistant', 'message': {'usage': {
                'input_tokens': 10, 'cache_read_input_tokens': tokens}}}])
            return self.run_hive('since')
        self.assertNotIn('handoff mark', at(200_000))
        said = at(260_000)
        self.assertIn("This session is at 260k of context, past the hive's 250k handoff mark", said)
        self.assertIn('`spawn --successor --state <file> --name <name>`', said)
        self.spawn('aa-next', '--successor')
        self.assertNotIn('handoff mark', self.run_hive('since'))

    def ready_kid(self, status='idle', kind='interactive'):
        """kid-cc, a sub-session of work-aa that sent its final debrief."""
        self.kid()
        if status != 'idle' or kind != 'interactive':
            path = [f for f in os.listdir(self.sessions) if 'kid-0004' in open(os.path.join(self.sessions, f)).read()][0]
            with open(os.path.join(self.sessions, path)) as f:
                rec = json.load(f)
            rec.update(status=status, kind=kind, jobId='kidjob01')
            with open(os.path.join(self.sessions, path), 'w') as f:
                json.dump(rec, f)
            return rec
        return json.load(open(os.path.join(self.sessions, [f for f in os.listdir(self.sessions)
                                                             if 'kid-0004' in open(os.path.join(self.sessions, f)).read()][0])))

    def test_a_parent_closes_a_sub_session_only_once_it_is_ready_to_close(self):
        rec = self.ready_kid()
        p = self.run_hive('close', '--name', 'kid-cc', ok=False, full=True)
        self.assertEqual(p.returncode, 1)
        self.assertIn('kid-cc is not ready to close; it has sent no final debrief', p.stderr)
        self.run_hive('done', self_id='kid-0004')
        other = self.run_hive('close', '--name', 'kid-cc', self_id='peer-0002', ok=False, full=True)
        self.assertIn('is not a sub-session of work-bb', other.stderr)
        said = self.run_hive('close', '--name', 'kid-cc')
        self.assertIn('Closed kid-cc (its parent; it was ready to close)', said)
        for _ in range(50):   # the stand-in process ends on the signal
            try:
                os.kill(rec['pid'], 0)
            except OSError:
                break
            if open(f"/proc/{rec['pid']}/stat").read().split(') ')[1].startswith('Z'):
                break
            time.sleep(0.05)
        else:
            self.fail('kid-cc was not stopped')
        closed = [x for x in self.log() if x.get('dir') == 'closed']
        self.assertEqual((closed[0]['to'], closed[0]['as']), ('kid-cc', 'its parent'))
        self.assertIn('closed work-aa closed kid-cc, which was ready to close', self.run_hive('since', self_id='peer-0002'))

    def test_close_refuses_a_busy_or_reopened_sub_session(self):
        self.ready_kid(status='busy')
        self.run_hive('done', self_id='kid-0004')
        self.assertIn('kid-cc is busy, not idle', self.run_hive('close', '--name', 'kid-cc', ok=False, full=True).stderr)
        self.run_hive('work', '--what', 'git commit', self_id='kid-0004')
        self.assertIn('started new work after its debrief',
                      self.run_hive('close', '--name', 'kid-cc', ok=False, full=True).stderr)

    def test_close_stops_a_background_sub_session_with_claude_stop(self):
        self.ready_kid(kind='bg')
        self.run_hive('done', self_id='kid-0004')
        self.assertIn('Closed kid-cc', self.run_hive('close', '--name', 'kid-cc'))
        self.assertEqual(self.spawns()[-1]['argv'], ['stop', 'kidjob01'])

    def test_the_desk_closes_a_sub_session_its_predecessor_started(self):
        self.run_hive('role', *self.DESK_ROLE)
        self.kid(route={'workspace': '/work/repo', 'area': 'hire', 'role': 'desk'})
        self.run_hive('done', self_id='kid-0004')
        self.run_hive('role', *self.DESK_ROLE, self_id='peer-0002')   # work-bb is the Desk now
        self.assertIn('Closed kid-cc (the desk for hire', self.run_hive('close', '--name', 'kid-cc', self_id='peer-0002'))


if __name__ == '__main__':
    unittest.main()
