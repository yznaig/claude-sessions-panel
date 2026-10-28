// Test harness: runs the panel's real code (core.js and what it loads) against a fake VS Code,
// a temporary home folder, real stand-in session processes, and a clock the test moves by hand.
// Tests drive it the way VS Code and the webview do (messages in, refresh command) and read what
// the panel shows (posted rows, the badge, sounds, the snapshot file), so they don't depend on how
// the panel is built inside.
'use strict';
const Module = require('module');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');

const ROOT = path.resolve(__dirname, '..');

// ---- one fake vscode, re-pointed at each harness ----
let current = null;
const vscodeStub = {
  workspace: {
    get workspaceFolders() { return current.folders.length ? current.folders.map(f => ({ uri: { fsPath: f } })) : undefined; },
    getConfiguration: () => ({ get: k => current.config[k], update: async (k, v) => { current.config[k] = v; } }),
    onDidChangeConfiguration: () => ({ dispose() {} }),
  },
  window: {
    showInputBox: async o => {
      const answer = current.answers.shift();
      if (answer === undefined) return undefined;
      const err = o.validateInput && o.validateInput(answer);
      if (err) { current.refused.push(err); return undefined; }
      return answer;
    },
    showWarningMessage: async (msg, ...rest) => {
      if (!rest.some(x => x && x.modal)) return undefined;
      current.asked.push(msg);
      return current.confirm;
    },
    showErrorMessage: () => {},
    setStatusBarMessage() {},
    createQuickPick() { throw new Error('not in tests'); },
  },
  commands: {
    registerCommand: (name, fn) => { current.commands.set(name, fn); return { dispose() {} }; },
    executeCommand: async (...args) => { current.executed.push(args); },
  },
  Uri: { file: p => ({ fsPath: p }), joinPath: (u, ...a) => ({ fsPath: path.join(u.fsPath, ...a) }) },
  ConfigurationTarget: { Global: 1 },
  env: { clipboard: { readText: async () => '', writeText: async () => {} } },
};
const load = Module._load;
Module._load = function (req, ...rest) { return req === 'vscode' ? vscodeStub : load.call(this, req, ...rest); };

// ---- clock, home folder, sounds: patched once, re-pointed per harness ----
const realNow = Date.now;
Date.now = () => (current ? current.now : realNow());
const realHome = os.homedir;
os.homedir = () => (current ? current.home : realHome());
const realSpawn = cp.spawn;
cp.spawn = (cmd, args, opts) => {
  if (!current) return realSpawn(cmd, args, opts);
  // A sound: on WSL a cmd.exe call with a base64 PowerShell script, elsewhere a player with the file.
  let text = [cmd, ...(args || [])].join(' ');
  const enc = /-EncodedCommand (\S+)/.exec(text);
  if (enc) text += Buffer.from(enc[1], 'base64').toString('utf16le');
  current.sounds.push(/ready\.wav/.test(text) ? 'ready' : /waiting\.wav/.test(text) ? 'waiting' : text);
  return { unref() {} };
};
const realExecFileSync = cp.execFileSync;
cp.execFileSync = (cmd, args, opts) => (cmd === 'wslpath' ? args[args.length - 1] : realExecFileSync(cmd, args, opts));

function memento() {
  const m = new Map();
  return {
    get: (k, d) => (m.has(k) ? JSON.parse(JSON.stringify(m.get(k))) : d),
    update: (k, v) => { if (v === undefined) m.delete(k); else m.set(k, JSON.parse(JSON.stringify(v))); return Promise.resolve(); },
    keys: () => [...m.keys()],
  };
}

const procStart = pid => {
  const s = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
  return s.slice(s.lastIndexOf(')') + 2).split(' ')[19];
};

// Transcript lines, as Claude Code writes them.
const J = o => JSON.stringify(o);
const lines = {
  user: t => J({ type: 'user', isSidechain: false, message: { role: 'user', content: t } }),
  text: t => J({ type: 'assistant', isSidechain: false, message: { content: [{ type: 'text', text: t }] } }),
  tool: (name = 'Bash', input = { command: 'ls' }) => J({ type: 'assistant', isSidechain: false, message: { content: [{ type: 'tool_use', name, input }] } }),
  result: () => J({ type: 'user', isSidechain: false, message: { content: [{ type: 'tool_result', content: 'ok' }] } }),
  side: t => J({ type: 'assistant', isSidechain: true, message: { content: [{ type: 'text', text: t }] } }),
  aiTitle: t => J({ type: 'ai-title', aiTitle: t }),
  customTitle: t => J({ type: 'custom-title', customTitle: t }),
  skill: name => J({ type: 'assistant', isSidechain: false, message: { content: [{ type: 'tool_use', name: 'Skill', input: { skill: name } }] } }),
  stamped: (t, at) => J({ type: 'assistant', isSidechain: false, timestamp: new Date(at).toISOString(), message: { content: [{ type: 'text', text: t }] } }),
  // Lines as Claude Code writes them in full, for search: where, when, and how the session was started.
  said: (t, { cwd, at, entry = 'claude-vscode', uuid } = {}) => J({ type: 'user', isSidechain: false, cwd, entrypoint: entry, uuid, timestamp: at && new Date(at).toISOString(), message: { role: 'user', content: t } }),
  replied: (t, { cwd, at } = {}) => J({ type: 'assistant', isSidechain: false, cwd, timestamp: at && new Date(at).toISOString(), message: { content: [{ type: 'text', text: t }] } }),
  edited: file => J({ type: 'assistant', isSidechain: false, message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: file } }] } }),
};
const words = n => Array.from({ length: n }, (_, i) => 'w' + i).join(' ');

let counter = 0;
const kids = new Set();
// A background-command session is its own process group, so its shell child goes with it.
const kill = k => { try { if (k.group) process.kill(-k.pid, 'SIGKILL'); else k.kill(); } catch { /* gone */ } };
process.on('exit', () => { for (const k of kids) kill(k); });

class Harness {
  constructor(opts = {}) {
    this.home = fs.mkdtempSync(path.join(os.tmpdir(), 'csp-test-'));
    this.proj = path.join(this.home, 'proj');
    this.other = path.join(this.home, 'elsewhere');
    for (const d of ['.claude/sessions', '.claude/projects', 'proj', 'elsewhere']) fs.mkdirSync(path.join(this.home, d), { recursive: true });
    // The session-trail mod at work (some session was shown once), unless the test says it isn't installed.
    if (!opts.noTrail) {
      fs.mkdirSync(path.join(this.home, '.claude/session-trail'), { recursive: true });
      fs.writeFileSync(path.join(this.home, '.claude/session-trail/long-gone.json'), J({ sessionId: 'long-gone', cwd: this.proj, shown: false, shownAt: 1, hiddenAt: 2 }));
    }
    this.folders = opts.noFolder ? [] : [this.proj];
    this.now = opts.now || 1_800_000_000_000;
    this.config = {
      sessionsDir: path.join(this.home, '.claude/sessions'), removedClearHours: 12, autoCloseHours: 4,
      'sound.enabled': true, 'sound.ready': path.join(this.home, 'ready.wav'), 'sound.waiting': path.join(this.home, 'waiting.wav'),
      focusCommand: 'claude-vscode.editor.open',
      searchFolders: [path.join(this.home, '.claude/projects')],
      askCommand: path.join(this.home, 'fake-claude'),
    };
    // A stand-in for `claude -p`: records its arguments and what it was sent, prints this.askReply.
    this.askReply = { answer: null, sources: [] };
    this.askExit = 0;
    fs.writeFileSync(this.config.askCommand, `#!/usr/bin/env node
const fs = require('fs'); const dir = ${J(this.home)};
let input = ''; process.stdin.on('data', d => input += d).on('end', () => {
  fs.writeFileSync(dir + '/ask-input.txt', input); fs.writeFileSync(dir + '/ask-args.json', JSON.stringify(process.argv.slice(2)));
  const reply = JSON.parse(fs.readFileSync(dir + '/ask-reply.json', 'utf8'));
  process.stdout.write(JSON.stringify({ type: 'result', is_error: reply.exit !== 0, result: JSON.stringify(reply.body) }));
  process.exit(reply.exit);
});
`, { mode: 0o755 });
    this.globalState = memento();
    this.workspaceState = memento();
    this.answers = [];
    this.refused = [];
    this.asked = [];
    this.confirm = 'Delete';
    this.sounds = [];
    this.executed = [];
    this.commands = new Map();
    this.posted = [];
    this.app = null;
    this.kids = [];
    this.prefix = 's' + (++counter) + '-';
    current = this;
  }

  id(name) { return this.prefix + name; }
  // Long enough for a signal the panel sent to land.
  pause(ms = 300) { return new Promise(r => setTimeout(r, ms)); }
  advance(ms) { this.now += ms; }

  // A running session: a real process (so the panel's liveness check passes) and its registry file.
  // `background`: the session has a background command running (a shell child, as Claude Code starts
  // one). `entrypoint`, `pidDomain`, `procStart` override what the registry record says.
  // `ignoresStop`: the process ignores SIGTERM.
  session(name, { status = 'idle', cwd = this.proj, regName, transcript, background, ignoresStop, entrypoint = 'claude-vscode', pidDomain, procStart: ps } = {}) {
    const id = this.id(name);
    if (transcript) this.transcript(name, transcript, cwd);
    const k = background
      ? realSpawn('sh', ['-c', 'sh -c "sleep 600; : .claude/shell-snapshots/snapshot-bash.sh" & wait'], { stdio: 'ignore', detached: true })
      : ignoresStop ? realSpawn('sh', ['-c', 'trap "" TERM; sleep 600 & wait; wait'], { stdio: 'ignore', detached: true })
        : realSpawn('sleep', ['600'], { stdio: 'ignore' });
    k.group = !!(background || ignoresStop);
    kids.add(k);
    this.kids.push(k);
    const exited = new Promise(res => k.once('exit', () => { kids.delete(k); res(); }));
    const file = path.join(this.config.sessionsDir, k.pid + '.json');
    const rec = {
      pid: k.pid, sessionId: id, cwd, name: regName !== undefined ? regName : name, status, startedAt: this.now, statusUpdatedAt: this.now,
      procStart: ps !== undefined ? ps : procStart(k.pid), entrypoint, kind: 'interactive', ...(pidDomain ? { pidDomain } : {}),
    };
    const write = () => fs.writeFileSync(file, J(rec));
    write();
    const h = this;
    return {
      id, rec, pid: k.pid,
      set(st, extra = {}) { Object.assign(rec, { status: st, statusUpdatedAt: h.now }, extra); write(); },
      // Ends the process and waits until it is gone, as when the session is closed.
      end() { kill(k); return exited; },
      // Resolves once the process has gone, whoever stopped it; fails if it is still running after 3 s.
      gone: () => Promise.race([exited, new Promise((_, no) => setTimeout(() => no(new Error(`${id} still running`)), 3000).unref())]),
      // Read from the process table: a process the panel just stopped is gone (or a zombie) at once.
      alive() {
        try { return fs.readFileSync(`/proc/${k.pid}/stat`, 'utf8').slice(fs.readFileSync(`/proc/${k.pid}/stat`, 'utf8').lastIndexOf(')') + 2)[0] !== 'Z'; }
        catch { return false; }
      },
    };
  }

  // This machine's process domain, as Claude Code writes it in the registry.
  get pidDomain() {
    return `linux:${fs.readFileSync('/etc/machine-id', 'utf8').trim()}:${fs.readlinkSync('/proc/self/ns/pid')}`;
  }

  // A registry record left by a process that has stopped (what Claude Code leaves behind).
  deadRecord(name, { cwd = this.proj, status = 'idle', at = this.now } = {}) {
    const id = this.id(name);
    fs.writeFileSync(path.join(this.config.sessionsDir, `dead-${id}.json`),
      J({ pid: 2 ** 22 - 7, sessionId: id, cwd, name, status, startedAt: at, statusUpdatedAt: at, procStart: '1' }));
    return id;
  }

  // Appends to a session's transcript, stamped with the test clock.
  transcript(name, ls, cwd = this.proj) {
    const dir = path.join(this.home, '.claude/projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'));
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, this.id(name) + '.jsonl');
    fs.appendFileSync(file, ls.join('\n') + '\n');
    fs.utimesSync(file, this.now / 1000, this.now / 1000);
  }

  // A subagent of the session writing its own transcript, stamped with the test clock.
  subagentWrite(name, cwd = this.proj) {
    const dir = path.join(this.home, '.claude/projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'), this.id(name), 'subagents');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'agent-x.jsonl');
    fs.appendFileSync(file, lines.text('working') + '\n');
    fs.utimesSync(file, this.now / 1000, this.now / 1000);
  }

  trail(name, t) {
    const dir = path.join(this.home, '.claude/session-trail');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, this.id(name) + '.json'), J({ sessionId: this.id(name), cwd: this.proj, shown: false, shownAt: 0, hiddenAt: 0, ...t }));
  }

  // Load a fresh copy of the panel's code, as VS Code does on start and Reload Panel does.
  freshCore() {
    for (const k of Object.keys(require.cache)) if (k.startsWith(ROOT + path.sep) && !k.startsWith(path.join(ROOT, 'test') + path.sep)) delete require.cache[k];
    return require(path.join(ROOT, 'core.js'));
  }

  view() {
    const h = this;
    return {
      badge: undefined,
      webview: {
        options: {}, html: '', cspSource: '', asWebviewUri: u => u,
        onDidReceiveMessage: f => { h.onMessage = f; return { dispose() {} }; },
        postMessage: m => { h.posted.push(m); return Promise.resolve(); },
      },
      onDidChangeVisibility: () => ({ dispose() {} }),
    };
  }

  start(carried = null) {
    current = this;
    this.commands.clear();
    this.panel = this.view();
    this.app = this.freshCore().start({
      context: { globalState: this.globalState, workspaceState: this.workspaceState, extensionPath: ROOT },
      root: ROOT, view: this.panel, carried,
    });
    return this;
  }
  stop() { const c = this.app.stop(); this.app = null; return c; }
  // VS Code restarting: in-memory state is gone, saved state and running sessions stay.
  restart() { this.stop(); return this.start(null); }
  // Reload Panel: the new copy gets the old one's hand-over.
  reload() { return this.start(this.stop()); }

  refresh() { this.commands.get('claudeSessions.refresh')(); return this; }
  async send(m) { await this.onMessage(m); return this; }

  get state() { return this.posted.filter(m => m.type === 'state').at(-1); }
  get results() { return this.posted.filter(m => m.type === 'results').at(-1); }
  get answer() { return this.posted.filter(m => m.type === 'answer').at(-1); }
  // Search as the panel's box does; returns the result titles in order.
  async search(q, all = true) {
    await this.send({ type: 'search', q, all });
    return this.results.results.map(r => r.title);
  }
  async ask(q) {
    fs.writeFileSync(path.join(this.home, 'ask-reply.json'), J({ body: this.askReply, exit: this.askExit }));
    await this.send({ type: 'ask', q, all: true });
    return this.answer;
  }
  get askInput() { return fs.readFileSync(path.join(this.home, 'ask-input.txt'), 'utf8'); }
  get askArgs() { return JSON.parse(fs.readFileSync(path.join(this.home, 'ask-args.json'), 'utf8')); }
  get rows() { return this.state.rows; }
  get badge() { return this.panel.badge ? this.panel.badge.value : 0; }
  row(name) { return this.rows.find(r => r.id === this.id(name)); }
  order() { return this.rows.filter(r => !r.dismissed).map(r => r.id.slice(this.prefix.length)); }
  takeSounds() { const s = this.sounds; this.sounds = []; return s; }
  snapshot() {
    const dir = path.join(this.home, '.claude/sessions-panel');
    const f = fs.readdirSync(dir).filter(x => x.endsWith('.json'))[0];
    return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
  }

  async cleanup() {
    if (this.app) this.stop();
    for (const k of this.kids) { kill(k); kids.delete(k); }
    current = null;
  }
}

module.exports = { Harness, lines, words };
