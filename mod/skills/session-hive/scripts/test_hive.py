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
                    'print("backgrounded · abcd1234 · " + sys.argv[sys.argv.index("-n") + 1])\n')
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

    def run_hive(self, *args, stdin='', self_id='me-0001', ok=True):
        env = dict(os.environ, HOME=self.home, HIVE_CLAUDE=self.fake_claude())
        p = subprocess.run([sys.executable, '-I', HIVE, '--self', self_id, *args], input=stdin,
                           capture_output=True, text=True, env=env, timeout=30)
        if ok:
            self.assertEqual(p.returncode, 0, p.stderr)
        return p.stdout

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

    def spawn(self, name, *flags, who='me-0001', brief='Dig into the delay-notice drafts.'):
        return json.loads(self.run_hive('spawn', '--name', name, *flags, stdin=brief, self_id=who, ok=False))

    def test_a_sub_session_starts_in_the_background_knowing_its_parent(self):
        r = self.spawn('notice drafts')
        self.assertEqual(r, {'action': 'started', 'name': 'notice-drafts', 'id': 'abcd1234'})
        argv = self.spawns()[0]['argv']
        self.assertEqual(argv[:4], ['--bg', '-n', 'notice-drafts', '--'])
        self.assertIn("a sub-session that work-aa started with the user's yes", argv[4])
        self.assertIn('Debrief from sub-session notice-drafts', argv[4])
        self.assertIn('Dig into the delay-notice drafts.', argv[4])
        self.assertIn('work-aa started sub-session notice-drafts', self.run_hive('log'))

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
        self.assertIn('cannot start their own', r['reason'])

    def test_unattended_only_while_away_and_two_per_stretch_away(self):
        self.assertIn('not away', self.spawn('a', '--unattended')['reason'])
        self.set_away()
        self.assertEqual(self.spawn('a', '--unattended')['action'], 'started')
        self.assertEqual(self.spawn('b', '--unattended')['action'], 'started')
        r = self.spawn('c', '--unattended')
        self.assertEqual(r['action'], 'refused')
        self.assertIn('already started 2', r['reason'])
        self.assertIn('take on no new job', self.spawns()[0]['argv'][4])
        self.assertEqual(self.spawn('d')['action'], 'started', "with the user's yes the cap does not apply")

    def test_a_keep_going_note_to_a_long_session_starts_a_sub_session_while_away(self):
        self.set_away()
        text = '<cross-session-message from-name="work-bb">\n[keep going] the runner stalled on TICKET-5\n</cross-session-message>'
        v = self.receive('--tokens', '450000', text=text)
        self.assertEqual(v['action'], 'hold')
        self.assertIn('started work-aa-cont', v['reason'])
        self.assertIn('the runner stalled', self.spawns()[0]['argv'][4])
        self.assertIn('digest me-0001', self.spawns()[0]['argv'][4])

    def test_no_sub_session_without_the_marker_or_while_the_user_is_here(self):
        self.receive('--tokens', '450000', text='[keep going] but the moon is off')
        self.set_away()
        self.receive('--tokens', '450000', text='an ordinary note')
        self.assertEqual(self.spawns(), [])

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
        first = self.run_hive('decide', '--workspace', '/work/repo', '--area', 'runner', 'no fourth account').strip()
        second = self.run_hive('decide', '--workspace', '/work/repo/', '--area', 'qa', 'ship it', self_id='peer-0002').strip()
        self.assertEqual((first, second), (f'e{day}-01', f'e{day}-02'))
        rec = self.log()[0]
        self.assertEqual({k: rec[k] for k in ('dir', 'id', 'from', 'workspace', 'area', 'text')},
                         {'dir': 'decided', 'id': f'e{day}-01', 'from': 'work-aa', 'workspace': '/work/repo',
                          'area': 'runner', 'text': 'no fourth account'})
        self.assertEqual(self.log()[1]['workspace'], '/work/repo', 'the path is normalised')
        self.assertIn(f'work-aa recorded decision [e{day}-01] runner (/work/repo): no fourth account', self.run_hive('log'))

    def test_decide_keeps_the_text_to_one_line(self):
        self.run_hive('decide', '--workspace', '/work/repo', '--area', 'qa', 'first line\nsecond line')
        self.assertEqual(self.log()[-1]['text'], 'first line second line')

    def test_role_and_who_name_the_latest_holder(self):
        self.run_hive('role', '--workspace', '/work/repo', '--area', 'runner', '--role', 'builder', self_id='peer-0002')
        self.assertEqual(self.run_hive('who', '--workspace', '/work/repo', '--area', 'runner', '--role', 'builder').strip(), 'work-bb')
        self.run_hive('role', '--workspace', '/work/repo', '--area', 'runner', '--role', 'builder')
        self.assertEqual(self.run_hive('who', '--workspace', '/work/repo', '--area', 'Runner', '--role', 'builder').strip(), 'work-aa')
        self.assertEqual(self.run_hive('who', '--workspace', '/work/repo', '--area', 'qa', '--role', 'builder', ok=False), '')
        self.assertEqual(self.run_hive('who', '--workspace', '/elsewhere', '--area', 'runner', '--role', 'builder', ok=False), '')
        self.assertIn('work-aa holds role builder for runner (/work/repo)', self.run_hive('log'))

    def test_the_fold_shows_other_sessions_events_one_line_each(self):
        day = time.strftime('%m%d')
        self.run_hive('decide', '--workspace', '/work/repo', '--area', 'runner', 'no fourth account (work-10)', self_id='peer-0002')
        self.run_hive('role', '--workspace', '/work/repo', '--area', 'runner', '--role', 'builder', self_id='peer-0002')
        self.run_hive('decide', '--workspace', '/work/repo', '--area', 'qa', 'my own decision')
        out = self.since()
        self.assertIn('Since you last looked', out)
        lines = [l for l in out.splitlines() if re.match(r'\d\d-\d\d \d\d:\d\d ', l)]
        self.assertEqual(len(lines), 2, out)
        self.assertRegex(lines[0], r'^\d\d-\d\d \d\d:\d\d role runner: work-bb is builder$')
        self.assertRegex(lines[1], rf'^\d\d-\d\d \d\d:\d\d decided \[e{day}-01\] runner: no fourth account \(work-10\) \(work-bb\)$')
        self.assertNotIn('my own decision', out, "a session's own events are not news to it")

    def test_the_cursor_moves_only_when_the_block_is_taken(self):
        self.run_hive('decide', '--workspace', '/work/repo', '--area', 'qa', 'item one', self_id='peer-0002')
        self.assertIn('item one', self.since())
        self.assertIn('item one', self.since('--take'), 'a plain look does not move the cursor')
        self.assertEqual(self.since('--take'), '', 'nothing new: no block at all')
        self.run_hive('decide', '--workspace', '/work/repo', '--area', 'qa', 'item two', self_id='peer-0002')
        out = self.since('--take')
        self.assertIn('item two', out)
        self.assertNotIn('item one', out)

    def test_the_cursor_is_per_session(self):
        far = self.elsewhere()
        self.run_hive('decide', '--workspace', '/elsewhere', '--area', 'qa', 'far news', self_id='peer-0002')
        self.run_hive('decide', '--workspace', '/work/repo', '--area', 'qa', 'near news', self_id='peer-0002')
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
        self.run_hive('decide', '--workspace', '/work/repo', '--area', 'runner', 'cross-workspace yes', self_id='far-0003')
        # A session here deciding something about the other workspace: it shows there, not here.
        self.run_hive('decide', '--workspace', '/elsewhere', '--area', 'qa', 'about elsewhere', self_id='peer-0002')
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
        self.assertRegex(out, r'spawn work-bb started notes: Dig into')

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
        self.run_hive('decide', '--workspace', '/work/repo', '--area', 'qa', 'before the damage', self_id='peer-0002')
        with open(os.path.join(self.home, '.claude', 'session-hive', 'log.ndjson'), 'a') as f:
            f.write('{"at": 1, "dir": "out", "fro\n')
        self.assertEqual(self.run_hive('decide', '--workspace', '/work/repo', '--area', 'qa', 'after').strip(), f'e{day}-02')
        self.assertIn('before the damage', self.since())

    def test_fold_lines_stay_one_short_line(self):
        self.run_hive('role', '--workspace', '/work/repo', '--area', 'run\nner ' + 'x' * 300, '--role', 'build\ner',
                      self_id='peer-0002')
        rec = self.log()[-1]
        self.assertNotIn('\n', rec['area'] + rec['role'])
        self.assertLessEqual(len(rec['area']), 60)
        lines = [l for l in self.since().splitlines() if ' role ' in l]
        self.assertEqual(len(lines), 1)
        self.assertLessEqual(len(lines[0]), 200)

    def test_a_sub_sessions_debrief_is_an_allowed_message(self):
        self.assertIn('a sub-session\'s debrief to its parent', self.run_hive('peers'))


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


if __name__ == '__main__':
    unittest.main()
