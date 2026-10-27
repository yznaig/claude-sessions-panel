// Claude Sessions — a bottom-panel view over Claude Code's live session registry.
// Reads ~/.claude/sessions/<pid>.json (written by Claude Code itself), derives
// running / ready / waiting per session, plays a sound on transitions, and
// focuses a session through the Claude Code extension's open command.
// extension.js loads this file and can swap in a newer installed copy without a window
// reload (Reload Panel): start() takes what the old copy handed over in `carried`.
'use strict';
const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');

const SHOW_ALL_KEY = 'claudeSessions.showAllWindows';
// The tab each window shows: a folder's name, or '' for Main (the unfiled sessions).
const VIEW_FOLDER_KEY = 'claudeSessions.viewFolder';

function cfg() { return vscode.workspace.getConfiguration('claudeSessions'); }
function sessionsDir() { return cfg().get('sessionsDir') || path.join(os.homedir(), '.claude', 'sessions'); }

// ---- registry ---------------------------------------------------------------

function procStartOf(pid) {
  // Linux only: field 22 of /proc/<pid>/stat is the process start time in clock ticks,
  // which is what Claude Code records as procStart. Guards against pid reuse.
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const after = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    return after[19];
  } catch { return null; }
}

function pidAlive(rec) {
  try { process.kill(rec.pid, 0); } catch (e) { if (e.code !== 'EPERM') return false; }
  if (rec.procStart && process.platform === 'linux') {
    const start = procStartOf(rec.pid);
    if (start !== null && String(start) !== String(rec.procStart)) return false;
  }
  return true;
}

// Live sessions only, or with `ended` the records left behind by processes that have stopped.
function readRegistry(ended) {
  const dir = sessionsDir();
  let files = [];
  try { files = fs.readdirSync(dir).filter(f => f.endsWith('.json')); } catch { return []; }
  const byId = new Map();
  for (const f of files) {
    let rec;
    try { rec = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { continue; }
    if (!rec || !rec.sessionId || !rec.pid) continue;
    if (pidAlive(rec) === !!ended) continue;
    const prev = byId.get(rec.sessionId);
    if (!prev || (rec.startedAt || 0) > (prev.startedAt || 0)) byId.set(rec.sessionId, rec);
  }
  return [...byId.values()];
}

const transcripts = require('./transcript');
const { displayName } = transcripts;
const { SessionList } = require('./sessions');
const { windowScope } = require('./window');

// ---- sound ------------------------------------------------------------------

let extensionRoot = __dirname;
const BUNDLED = ['chatUserActionRequired', 'success', 'taskCompleted', 'requestSent', 'responseReceived1', 'quickFixes', 'warning', 'terminalBell'];
const BUNDLED_HINT = {
  chatUserActionRequired: "VS Code: chat needs your action", success: 'VS Code: success',
  taskCompleted: 'VS Code: task completed', requestSent: 'VS Code: request sent', responseReceived1: 'VS Code: response received',
  quickFixes: 'VS Code: quick fixes available', warning: 'VS Code: warning', terminalBell: 'VS Code: terminal bell',
};

function isWsl() { return process.platform === 'linux' && fs.existsSync('/mnt/c/Windows/System32/cmd.exe'); }

// A setting value is either a bundled name or a file path. Returns an absolute path on this side.
function resolveSound(value) {
  if (!value) return null;
  const v = String(value).trim();
  if (/^[A-Za-z0-9_-]+$/.test(v)) {
    const p = path.join(extensionRoot, 'media', 'sounds', v + '.wav');
    return fs.existsSync(p) ? p : null;
  }
  return v;
}

const wslPathCache = new Map();
function toWindowsPath(p) {
  // Windows-style paths (C:\..., \\server\...) pass through; WSL paths go through wslpath -w once.
  if (/^[A-Za-z]:\\|^\\\\/.test(p)) return p;
  if (wslPathCache.has(p)) return wslPathCache.get(p);
  let w = p;
  try { w = require('child_process').execFileSync('wslpath', ['-w', p], { encoding: 'utf8' }).trim(); } catch { /* keep */ }
  wslPathCache.set(p, w);
  return w;
}

function playFile(file) {
  try {
    const opts = { detached: true, stdio: 'ignore' };
    if (isWsl()) {
      // WSL: route through cmd.exe with the script base64-encoded, cwd on the Windows side.
      const win = toWindowsPath(file);
      const ps = `(New-Object Media.SoundPlayer '${win.replace(/'/g, "''")}').PlaySync()`;
      const enc = Buffer.from(ps, 'utf16le').toString('base64');
      spawn('/mnt/c/Windows/System32/cmd.exe', ['/c', `powershell.exe -NoProfile -NonInteractive -EncodedCommand ${enc}`], { ...opts, cwd: '/mnt/c' }).unref();
    } else if (process.platform === 'win32') {
      spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `(New-Object Media.SoundPlayer '${file.replace(/'/g, "''")}').PlaySync()`], opts).unref();
    } else if (process.platform === 'darwin') {
      spawn('afplay', [file], opts).unref();
    } else {
      spawn('paplay', [file], opts).unref();
    }
  } catch { /* sound is best-effort */ }
}

let lastSoundAt = 0;
function playSound(kind, force) {
  if (!force && !cfg().get('sound.enabled')) return;
  const file = resolveSound(cfg().get(kind === 'ready' ? 'sound.ready' : 'sound.waiting'));
  if (!file) return;
  const now = Date.now();
  if (!force && now - lastSoundAt < 1500) return; // several sessions flipping at once = one sound
  lastSoundAt = now;
  playFile(file);
}

async function pickSound(kind) {
  const key = kind === 'ready' ? 'sound.ready' : 'sound.waiting';
  const current = cfg().get(key);
  const items = BUNDLED.map(n => ({ label: n, description: BUNDLED_HINT[n] || '', detail: n === current ? 'current' : undefined, value: n }));
  items.push({ label: '$(folder) Browse for a .wav file…', value: '__browse__' });
  const qp = vscode.window.createQuickPick();
  qp.title = `Claude Sessions: ${kind === 'ready' ? 'response ready' : 'needs an answer'} sound — arrow keys preview`;
  qp.items = items;
  qp.activeItems = items.filter(i => i.value === current);
  let previewTimer = null;
  qp.onDidChangeActive(active => {
    const it = active[0];
    if (!it || it.value === '__browse__') return;
    if (previewTimer) clearTimeout(previewTimer);
    previewTimer = setTimeout(() => { const f = resolveSound(it.value); if (f) playFile(f); }, 120);
  });
  const chosen = await new Promise(resolve => {
    qp.onDidAccept(() => { resolve(qp.selectedItems[0]); qp.hide(); });
    qp.onDidHide(() => { resolve(undefined); qp.dispose(); });
    qp.show();
  });
  if (!chosen) return;
  let value = chosen.value;
  if (value === '__browse__') {
    const picked = await vscode.window.showOpenDialog({ canSelectMany: false, filters: { 'Wave audio': ['wav'] }, title: 'Pick a .wav' });
    if (!picked || !picked[0]) return;
    value = picked[0].fsPath;
    playFile(value);
  }
  await cfg().update(key, value, vscode.ConfigurationTarget.Global);
  vscode.window.setStatusBarMessage(`Claude Sessions: ${kind} sound set to ${chosen.value === '__browse__' ? path.basename(value) : value}`, 3000);
}

// ---- webview ----------------------------------------------------------------

class Provider {
  constructor(context, list, rootUri, carried) {
    this.context = context;
    this.list = list;
    this.rootUri = rootUri;
    this.view = null;
    this.listeners = [];
    this.showAll = context.globalState.get(SHOW_ALL_KEY, false);
    this.showDismissed = !!(carried && carried.showDismissed);
    this.viewFolder = context.workspaceState.get(VIEW_FOLDER_KEY, '');
  }

  showFolder(name) {
    this.viewFolder = name || '';
    void this.context.workspaceState.update(VIEW_FOLDER_KEY, this.viewFolder);
  }

  // VS Code's input box: webviews cannot open prompts of their own.
  askFolderName(title, value) {
    const list = this.list;
    return vscode.window.showInputBox({
      title, value, prompt: 'Folder name',
      validateInput: v => {
        const n = v.trim();
        if (!n) return 'Give the folder a name';
        if (n.length > 40) return 'Keep it under 40 characters';
        if (/^main$/i.test(n)) return 'Main is the list of sessions not in any folder';
        // Read on each keystroke: another window may add a folder while the box is open.
        if (n !== value && list.folderNames.some(f => f.toLowerCase() === n.toLowerCase())) return 'There is already a folder by that name';
        return null;
      },
    }).then(v => (v === undefined ? undefined : v.trim()));
  }

  async onFolderMessage(m) {
    const list = this.list;
    switch (m.type) {
      case 'showFolder': this.showFolder(m.folder); break;
      case 'move': list.act({ type: 'move', id: m.id, folder: m.folder || '' }); break;
      case 'newFolder': {
        const name = await this.askFolderName(m.id ? 'New folder for this session' : 'New folder');
        if (!name) return;
        list.act({ type: 'addFolder', name });
        if (m.id) list.act({ type: 'move', id: m.id, folder: name }); else this.showFolder(name);
        break;
      }
      case 'renameFolder': {
        const name = await this.askFolderName(`Rename folder "${m.folder}"`, m.folder);
        if (!name || name === m.folder) return;
        list.act({ type: 'renameFolder', name: m.folder, to: name });
        if (this.viewFolder === m.folder) this.showFolder(name);
        break;
      }
      case 'deleteFolder': {
        const n = list.filedIn(m.folder);
        const ok = await vscode.window.showWarningMessage(
          `Delete the folder "${m.folder}"?`,
          { modal: true, detail: n ? `Its ${n} session${n === 1 ? '' : 's'} go${n === 1 ? 'es' : ''} back to Main.` : 'It is empty.' },
          'Delete');
        if (ok !== 'Delete') return;
        list.act({ type: 'deleteFolder', name: m.folder });
        if (this.viewFolder === m.folder) this.showFolder('');
        break;
      }
    }
  }

  // Called by extension.js with the panel's view, when VS Code first shows it or after a reload.
  resolveWebviewView(view) {
    this.detach();
    this.view = view;
    view.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.rootUri, 'media')] };
    view.webview.html = html(view.webview, this.rootUri);
    this.listeners.push(
      view.webview.onDidReceiveMessage(m => this.onMessage(m)),
      view.onDidChangeVisibility(() => this.push()),
    );
    this.push();
  }

  detach() {
    for (const l of this.listeners) l.dispose();
    this.listeners = [];
  }

  async onMessage(m) {
    const list = this.list;
    switch (m.type) {
      case 'focus': {
        list.act({ type: 'ack', id: m.id });
        try { await openSession(m.id); }
        catch (e) { vscode.window.showWarningMessage(`Claude Sessions: could not focus session (${e.message}).`); }
        break;
      }
      case 'ack': case 'mark': case 'dismiss': case 'restore': list.act({ type: m.type, id: m.id }); break;
      case 'toggleAll': this.toggleAll(); return;
      case 'toggleDismissed': this.showDismissed = !this.showDismissed; break;
      case 'ready': break;
      case 'showFolder': case 'move': case 'newFolder': case 'renameFolder': case 'deleteFolder':
        await this.onFolderMessage(m); break;
    }
    this.push();
  }

  toggleAll() {
    this.showAll = !this.showAll;
    void this.context.globalState.update(SHOW_ALL_KEY, this.showAll);
    this.push();
  }

  push() {
    // Folders first: reading them loads the latest copy, so the tabs and the rows' filing agree.
    const folders = this.list.folderNames;
    const rows = this.list.rows(this.showAll);
    const live = rows.filter(r => !r.dismissed);
    writeSnapshot(live, this.showAll);
    // A filed session counts only when it needs you; its ready shows as a dot on its folder's tab.
    const needing = live.filter(r => r.attention === 'waiting' || (r.attention && !r.folder)).length;
    if (this.viewFolder && !folders.includes(this.viewFolder)) this.showFolder('');
    if (this.view) {
      this.view.badge = needing ? { value: needing, tooltip: `${needing} Claude session${needing === 1 ? '' : 's'} need${needing === 1 ? 's' : ''} you` } : undefined;
      void this.view.webview.postMessage({
        type: 'state', rows, showAll: this.showAll, showDismissed: this.showDismissed,
        folders, viewFolder: this.viewFolder,
        soundOn: !!cfg().get('sound.enabled'), now: Date.now(),
        window: (vscode.workspace.workspaceFolders || []).map(f => path.basename(f.uri.fsPath)).join(', ') || 'no folder',
      });
    }
  }
}

// Opens a session where Claude Code's "Preferred Location" setting says: the chat sidebar when it
// is "sidebar", unless the session already has its own tab, which is then revealed. Without the
// programmatic flag, editor.open always opens a tab for a session not on screen (every restored
// "not running" row) and switches that setting to tabs as a side effect.
const OPEN_COMMAND = 'claude-vscode.editor.open';
function openSession(id) {
  const cmd = cfg().get('focusCommand') || OPEN_COMMAND;
  if (cmd !== OPEN_COMMAND) return vscode.commands.executeCommand(cmd, id);
  return vscode.commands.executeCommand(cmd, id, undefined, undefined, undefined, undefined, { programmatic: 'honor-preferred-location' });
}

// ---- snapshot for the sessions skill -------------------------------------------
//
// The rows this window's panel shows, written to ~/.claude/sessions-panel/<window>.json each
// time they change, so a Claude session can read "the sessions in my panel" (the companion
// plugin's sessions skill). One file per window, keyed by its folders.

function snapshotDir() { return path.join(os.homedir(), '.claude', 'sessions-panel'); }
let lastSnapshot = '';
function writeSnapshot(rows, showAll) {
  const folders = (vscode.workspace.workspaceFolders || []).map(f => f.uri.fsPath);
  const body = {
    folders, showAll,
    rows: rows.map(r => ({
      id: r.id, name: r.name, cwd: r.cwd,
      state: r.attention || (r.closed ? 'closed' : r.status === 'offline' ? 'not running' : r.status),
      ...(r.folder ? { folder: r.folder } : {}),
    })),
  };
  const text = JSON.stringify(body);
  if (text === lastSnapshot) return;
  lastSnapshot = text;
  const key = crypto.createHash('sha1').update(folders.join('\n') || 'no-folder').digest('hex').slice(0, 12);
  const file = path.join(snapshotDir(), key + '.json');
  try {
    fs.mkdirSync(snapshotDir(), { recursive: true });
    fs.writeFileSync(file + '.tmp', JSON.stringify({ ...body, updatedAt: Date.now() }, null, 1));
    fs.renameSync(file + '.tmp', file);
  } catch { /* the skill falls back to the live registry */ }
}

function html(webview, rootUri) {
  const nonce = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
  const script = webview.asWebviewUri(vscode.Uri.joinPath(rootUri, 'media', 'panel.js'));
  const style = webview.asWebviewUri(vscode.Uri.joinPath(rootUri, 'media', 'panel.css'));
  return `<!DOCTYPE html><html><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<link rel="stylesheet" href="${style}"><title>Claude Sessions</title></head>
<body><div id="bar"></div><div id="list"></div><div id="dismissed"></div>
<script nonce="${nonce}" src="${script}"></script></body></html>`;
}

// ---- session history (Alt+Q / Alt+Shift+Q) ------------------------------------
//
// The session-trail mod writes ~/.claude/session-trail/<id>.json each time VS Code
// shows or hides a session. Going back walks a snapshot of this window's live
// sessions, most recently shown first. The walk continues while you are still on
// the session it last took you to; look at any other session and the next press
// starts a fresh walk from there, so one press always means "the one before this".

function trailDir() { return path.join(os.homedir(), '.claude', 'session-trail'); }

function readTrail() {
  const out = new Map();
  let files = [];
  try { files = fs.readdirSync(trailDir()).filter(f => f.endsWith('.json')); } catch { return out; }
  for (const f of files) {
    try {
      const t = JSON.parse(fs.readFileSync(path.join(trailDir(), f), 'utf8'));
      if (t && t.sessionId && t.shownAt) out.set(t.sessionId, t);
    } catch { /* half-written: skip this pass */ }
  }
  return out;
}

class History {
  constructor(look, list, scope) { this.look = look; this.list = list; this.scope = scope; this.walk = null; }

  // This window's live sessions that VS Code has shown, most recently shown first.
  ordered() {
    this.look();
    const live = new Map(this.list.running().map(s => [s.sessionId, s]));
    const trail = readTrail();
    const rows = [];
    for (const [id, t] of trail) {
      const s = live.get(id);
      if (!s || !this.scope.shows(s.cwd || t.cwd)) continue;
      rows.push({ id, name: displayName(s), shown: !!t.shown, shownAt: t.shownAt });
    }
    rows.sort((a, b) => b.shownAt - a.shownAt);
    return rows;
  }

  current(rows) {
    const shown = rows.filter(r => r.shown);
    return shown.length ? shown[0].id : null;
  }

  async step(dir) {
    const rows = this.ordered();
    const cur = this.current(rows);
    const walking = this.walk && cur !== null && this.walk.list[this.walk.at]?.id === cur;
    if (!walking) {
      if (dir > 0) { vscode.window.setStatusBarMessage('Claude Sessions: no later session in this walk', 2500); return; }
      const list = cur ? [rows.find(r => r.id === cur), ...rows.filter(r => r.id !== cur)] : rows;
      this.walk = { list, at: cur ? 0 : -1 };
    }
    const next = this.walk.at + (dir < 0 ? 1 : -1);
    if (next < 0 || next >= this.walk.list.length) {
      vscode.window.setStatusBarMessage(`Claude Sessions: no ${dir < 0 ? 'earlier' : 'later'} session`, 2500);
      return;
    }
    this.walk.at = next;
    const target = this.walk.list[next];
    try {
      await openSession(target.id);
      vscode.window.setStatusBarMessage(`Claude: ${target.name}  (${next + 1}/${this.walk.list.length})`, 2500);
    } catch (e) {
      vscode.window.showWarningMessage(`Claude Sessions: could not open that session (${e.message}).`);
    }
  }
}

// ---- aside on a highlight (Alt+A) ----------------------------------------------
//
// Select text in a Claude reply and press Alt+A. VS Code's copy command copies a
// focused webview's selection, so the panel copies it (putting your clipboard back
// afterwards) and drops it in the inbox of the session this window shows. The
// side-fork mod in that session picks it up and opens an aside on it.

function sideForkInbox(sessionId) {
  return path.join(os.homedir(), '.claude', 'side-fork', 'inbox', sessionId + '.json');
}

async function askAside(history) {
  const rows = history.ordered();
  const cur = history.current(rows);
  if (!cur) {
    vscode.window.showWarningMessage('Claude Sessions: no Claude session is on screen in this window yet. Show one (sessions need the session-trail and side-fork mods loaded), then try again.');
    return;
  }
  const clip = vscode.env.clipboard;
  const before = await clip.readText();
  const sentinel = `⁣claude-sessions-${Date.now()}`;
  let selected = '';
  try {
    await clip.writeText(sentinel);
    await vscode.commands.executeCommand('editor.action.clipboardCopyAction');
    await new Promise(r => setTimeout(r, 150));
    selected = await clip.readText();
  } finally {
    await clip.writeText(before);
  }
  if (!selected || selected === sentinel || !selected.trim()) {
    vscode.window.setStatusBarMessage('Claude Sessions: select some text in a Claude reply first', 3000);
    return;
  }
  const file = sideForkInbox(cur);
  const req = { id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, text: selected.slice(0, 4000), at: Date.now() };
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file + '.tmp', JSON.stringify(req));
    fs.renameSync(file + '.tmp', file);
  } catch (e) {
    vscode.window.showWarningMessage(`Claude Sessions: could not hand the highlight to the session (${e.message}).`);
    return;
  }
  const shown = selected.replace(/\s+/g, ' ').trim();
  vscode.window.setStatusBarMessage(`Aside: "${shown.length > 50 ? shown.slice(0, 49) + '…' : shown}"`, 3000);
}

// ---- start ------------------------------------------------------------------

// host: { context, root (this copy's folder), view (the panel's view, if VS Code has shown it), carried }.
// Returns { attach(view), stop() }; stop() undoes everything start did and returns the state to carry.
function start(host) {
  const { context } = host;
  extensionRoot = host.root;
  const subs = [];
  const scope = windowScope(() => (vscode.workspace.workspaceFolders || []).map(f => f.uri.fsPath));
  const list = new SessionList({
    store: context.globalState, transcripts, scope, now: () => Date.now(),
    removedClearMs: () => (cfg().get('removedClearHours') || 12) * 3600e3,
    live: readRegistry(), ended: () => readRegistry(true),
  }, host.carried);
  // A look at the registry and the trail; plays the sounds the changes call for.
  const look = () => { for (const kind of list.observe(readRegistry(), readTrail())) playSound(kind); };
  const provider = new Provider(context, list, vscode.Uri.file(host.root), host.carried);
  const history = new History(look, list, scope);
  subs.push({ dispose: () => provider.detach() });

  let timer = null;
  const tick = () => { look(); provider.push(); };
  const schedule = () => { if (timer) clearTimeout(timer); timer = setTimeout(tick, 150); };

  tick();
  let watcher = null;
  try { watcher = fs.watch(sessionsDir(), { persistent: false }, schedule); } catch { /* dir may not exist yet */ }
  let trailWatcher = null; // a session shown or hidden: closed sessions leave at once
  try { fs.mkdirSync(trailDir(), { recursive: true }); trailWatcher = fs.watch(trailDir(), { persistent: false }, schedule); } catch { /* no watch: the poll covers it */ }
  const poll = setInterval(tick, 5000); // fallback: pid deaths and missed events
  subs.push({ dispose: () => { if (watcher) watcher.close(); if (trailWatcher) trailWatcher.close(); clearInterval(poll); if (timer) clearTimeout(timer); } });
  subs.push(vscode.workspace.onDidChangeConfiguration(e => { if (e.affectsConfiguration('claudeSessions')) tick(); }));

  subs.push(
    vscode.commands.registerCommand('claudeSessions.refresh', tick),
    vscode.commands.registerCommand('claudeSessions.toggleAllWindows', () => provider.toggleAll()),
    vscode.commands.registerCommand('claudeSessions.toggleSound', async () => {
      const on = !cfg().get('sound.enabled');
      await cfg().update('sound.enabled', on, vscode.ConfigurationTarget.Global);
      vscode.window.setStatusBarMessage(`Claude Sessions: sounds ${on ? 'on' : 'off'}`, 2500);
      provider.push();
    }),
    vscode.commands.registerCommand('claudeSessions.testSounds', () => {
      playSound('ready', true);
      setTimeout(() => playSound('waiting', true), 1800);
    }),
    vscode.commands.registerCommand('claudeSessions.pickReadySound', () => pickSound('ready')),
    vscode.commands.registerCommand('claudeSessions.pickWaitingSound', () => pickSound('waiting')),
    vscode.commands.registerCommand('claudeSessions.goBack', () => history.step(-1)),
    vscode.commands.registerCommand('claudeSessions.goForward', () => history.step(1)),
    vscode.commands.registerCommand('claudeSessions.askAside', () => askAside(history)),
  );

  if (host.view) provider.resolveWebviewView(host.view);
  return {
    attach: view => provider.resolveWebviewView(view),
    stop() {
      for (const s of subs.splice(0)) { try { s.dispose(); } catch { /* keep going */ } }
      return { ...list.handOver(), showDismissed: provider.showDismissed };
    },
  };
}

module.exports = { start };
