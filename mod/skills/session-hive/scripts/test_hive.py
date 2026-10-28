"""Checks for hive.py, run against a throwaway HOME: python3 -m unittest discover -s mod/skills/session-hive/scripts"""
import json, os, subprocess, sys, tempfile, time, unittest

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

    def run_hive(self, *args, stdin='', self_id='me-0001'):
        env = dict(os.environ, HOME=self.home)
        p = subprocess.run([sys.executable, '-I', HIVE, '--self', self_id, *args], input=stdin,
                           capture_output=True, text=True, env=env, timeout=30)
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

    def test_a_parked_session_is_never_woken(self):
        snaps = os.path.join(self.home, '.claude', 'sessions-panel')
        os.makedirs(snaps)
        with open(os.path.join(snaps, 'win1.json'), 'w') as f:
            json.dump({'rows': [{'id': 'me-0001', 'folder': 'Later'}]}, f)
        self.assertEqual(self.receive()['action'], 'hold')

    def test_a_fourth_message_in_an_hour_from_one_session_waits_even_when_busy(self):
        for _ in range(3):
            self.assertEqual(self.receive('--busy', '1')['action'], 'deliver')
        v = self.receive('--busy', '1')
        self.assertEqual(v['action'], 'hold')
        self.assertIn('work-bb already delivered 3', v['reason'])
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
        snaps = os.path.join(self.home, '.claude', 'sessions-panel')
        os.makedirs(snaps)
        with open(os.path.join(snaps, 'win1.json'), 'w') as f:
            json.dump({'rows': [{'id': 'peer-0002', 'folder': 'Later'}]}, f)
        self.assertIn('parked: never message', self.run_hive('peers'))

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


if __name__ == '__main__':
    unittest.main()
