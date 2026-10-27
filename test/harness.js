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
    showWarningMessage: async (msg, ...rest) => (rest.some(x => x && x.modal) ? current.confirm : undefined),
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
};
const words = n => Array.from({ length: n }, (_, i) => 'w' + i).join(' ');

let counter = 0;
const kids = new Set();
process.on('exit', () => { for (const k of kids) { try { k.kill(); } catch { /* gone */ } } });

class Harness {
  constructor(opts = {}) {
    this.home = fs.mkdtempSync(path.join(os.tmpdir(), 'csp-test-'));
    this.proj = path.join(this.home, 'proj');
    this.other = path.join(this.home, 'elsewhere');
    for (const d of ['.claude/sessions', '.claude/projects', 'proj', 'elsewhere']) fs.mkdirSync(path.join(this.home, d), { recursive: true });
    this.folders = opts.noFolder ? [] : [this.proj];
    this.now = opts.now || 1_800_000_000_000;
    this.config = {
      sessionsDir: path.join(this.home, '.claude/sessions'), removedClearHours: 12,
      'sound.enabled': true, 'sound.ready': path.join(this.home, 'ready.wav'), 'sound.waiting': path.join(this.home, 'waiting.wav'),
      focusCommand: 'claude-vscode.editor.open',
    };
    this.globalState = memento();
    this.workspaceState = memento();
    this.answers = [];
    this.refused = [];
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
  advance(ms) { this.now += ms; }

  // A running session: a real process (so the panel's liveness check passes) and its registry file.
  session(name, { status = 'idle', cwd = this.proj, regName, transcript } = {}) {
    const id = this.id(name);
    if (transcript) this.transcript(name, transcript, cwd);
    const k = realSpawn('sleep', ['600'], { stdio: 'ignore' });
    kids.add(k);
    this.kids.push(k);
    const file = path.join(this.config.sessionsDir, k.pid + '.json');
    const rec = { pid: k.pid, sessionId: id, cwd, name: regName !== undefined ? regName : name, status, startedAt: this.now, statusUpdatedAt: this.now, procStart: procStart(k.pid) };
    const write = () => fs.writeFileSync(file, J(rec));
    write();
    const h = this;
    return {
      id, rec,
      set(st, extra = {}) { Object.assign(rec, { status: st, statusUpdatedAt: h.now }, extra); write(); },
      // Ends the process and waits until it is gone, as when the session is closed.
      end() { return new Promise(res => { k.once('exit', () => { kids.delete(k); res(); }); k.kill(); }); },
    };
  }

  // A registry record left by a process that has stopped (what Claude Code leaves behind).
  deadRecord(name, { cwd = this.proj, status = 'idle', at = this.now } = {}) {
    const id = this.id(name);
    fs.writeFileSync(path.join(this.config.sessionsDir, `dead-${id}.json`),
      J({ pid: 2 ** 22 - 7, sessionId: id, cwd, name, status, startedAt: at, statusUpdatedAt: at, procStart: '1' }));
    return id;
  }

  transcript(name, ls, cwd = this.proj) {
    const dir = path.join(this.home, '.claude/projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'));
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, this.id(name) + '.jsonl'), ls.join('\n') + '\n');
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

  get state() { return this.posted[this.posted.length - 1]; }
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
    for (const k of this.kids) { try { k.kill(); } catch { /* gone */ } kids.delete(k); }
    current = null;
  }
}

module.exports = { Harness, lines, words };
