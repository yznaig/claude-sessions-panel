// Claude Sessions — a bottom-panel view over Claude Code's live session registry.
// Reads ~/.claude/sessions/<pid>.json (written by Claude Code itself), derives
// running / ready / waiting per session, plays a sound on transitions, and
// focuses a session through the Claude Code extension's open command.
'use strict';
const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const DISMISSED_KEY = 'claudeSessions.dismissed';
const SHOW_ALL_KEY = 'claudeSessions.showAllWindows';

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

function readRegistry() {
  const dir = sessionsDir();
  let files = [];
  try { files = fs.readdirSync(dir).filter(f => f.endsWith('.json')); } catch { return []; }
  const byId = new Map();
  for (const f of files) {
    let rec;
    try { rec = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { continue; }
    if (!rec || !rec.sessionId || !rec.pid) continue;
    if (!pidAlive(rec)) continue;
    const prev = byId.get(rec.sessionId);
    if (!prev || (rec.startedAt || 0) > (prev.startedAt || 0)) byId.set(rec.sessionId, rec);
  }
  return [...byId.values()];
}

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

// ---- tracker ----------------------------------------------------------------

class Tracker {
  constructor(context) {
    this.context = context;
    this.prevStatus = new Map();   // sessionId -> last seen status
    this.attention = new Map();    // sessionId -> 'ready' | 'waiting'
    this.dismissed = new Set(context.globalState.get(DISMISSED_KEY, []));
    this.firstLoad = true;
    this.sessions = [];
  }

  saveDismissed() { return this.context.globalState.update(DISMISSED_KEY, [...this.dismissed]); }

  refresh() {
    const regs = readRegistry();
    const seen = new Set();
    for (const r of regs) {
      const id = r.sessionId;
      seen.add(id);
      const status = r.status || 'idle';
      const prev = this.prevStatus.get(id);
      if (status === 'busy') {
        this.attention.delete(id);
        if (prev !== undefined && prev !== 'busy') this.undismiss(id);
      } else if (status === 'waiting') {
        if (this.attention.get(id) !== 'waiting') {
          this.attention.set(id, 'waiting');
          this.undismiss(id);
          if (!this.firstLoad) playSound('waiting');
        }
      } else if (status === 'idle' && prev === 'busy') {
        this.attention.set(id, 'ready');
        this.undismiss(id);
        playSound('ready');
      }
      this.prevStatus.set(id, status);
    }
    for (const id of [...this.prevStatus.keys()]) {
      if (!seen.has(id)) { this.prevStatus.delete(id); this.attention.delete(id); }
    }
    this.firstLoad = false;
    this.sessions = regs;
  }

  undismiss(id) { if (this.dismissed.delete(id)) void this.saveDismissed(); }
  dismiss(id) { this.dismissed.add(id); this.attention.delete(id); void this.saveDismissed(); }
  restore(id) { this.undismiss(id); }
  ack(id) { this.attention.delete(id); }

  inThisWindow(cwd) {
    const folders = (vscode.workspace.workspaceFolders || []).map(f => f.uri.fsPath);
    if (!folders.length || !cwd) return true;
    return folders.some(f => cwd === f || cwd.startsWith(f.replace(/\/$/, '') + '/'));
  }

  view(showAll) {
    const now = Date.now();
    const hideAfter = (cfg().get('idleHideHours') || 12) * 3600e3;
    const rows = [];
    for (const r of this.sessions) {
      const id = r.sessionId;
      const status = r.status || 'idle';
      const attention = this.attention.get(id) || null;
      const dismissed = this.dismissed.has(id);
      if (!showAll && !this.inThisWindow(r.cwd)) continue;
      const since = r.statusUpdatedAt || r.updatedAt || r.startedAt || now;
      if (!dismissed && !attention && status === 'idle' && now - since > hideAfter) continue;
      rows.push({
        id, pid: r.pid, name: r.name || id.slice(0, 8), cwd: r.cwd || '',
        repo: path.basename(r.cwd || '') || '?', status, attention, dismissed,
        waitingFor: r.waitingFor || '', since, startedAt: r.startedAt || since,
      });
    }
    const rank = x => x.attention === 'waiting' ? 0 : x.attention === 'ready' ? 1 : x.status === 'busy' ? 2 : 3;
    rows.sort((a, b) => rank(a) - rank(b) || b.since - a.since);
    return rows;
  }
}

// ---- webview ----------------------------------------------------------------

class Provider {
  constructor(context, tracker) {
    this.context = context;
    this.tracker = tracker;
    this.view = null;
    this.showAll = context.globalState.get(SHOW_ALL_KEY, false);
    this.showDismissed = false;
  }

  resolveWebviewView(view) {
    this.view = view;
    view.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')] };
    view.webview.html = html(view.webview, this.context);
    view.webview.onDidReceiveMessage(m => this.onMessage(m));
    view.onDidChangeVisibility(() => this.push());
    this.push();
  }

  async onMessage(m) {
    const t = this.tracker;
    switch (m.type) {
      case 'focus': {
        t.ack(m.id);
        const cmd = cfg().get('focusCommand') || 'claude-vscode.editor.open';
        try { await vscode.commands.executeCommand(cmd, m.id); }
        catch (e) { vscode.window.showWarningMessage(`Claude Sessions: could not focus session (${e.message}).`); }
        break;
      }
      case 'ack': t.ack(m.id); break;
      case 'dismiss': t.dismiss(m.id); break;
      case 'restore': t.restore(m.id); break;
      case 'toggleAll': this.toggleAll(); return;
      case 'toggleDismissed': this.showDismissed = !this.showDismissed; break;
      case 'ready': break;
    }
    this.push();
  }

  toggleAll() {
    this.showAll = !this.showAll;
    void this.context.globalState.update(SHOW_ALL_KEY, this.showAll);
    this.push();
  }

  push() {
    const rows = this.tracker.view(this.showAll);
    const live = rows.filter(r => !r.dismissed);
    const needing = live.filter(r => r.attention).length;
    if (this.view) {
      this.view.badge = needing ? { value: needing, tooltip: `${needing} Claude session${needing === 1 ? '' : 's'} need${needing === 1 ? 's' : ''} you` } : undefined;
      void this.view.webview.postMessage({
        type: 'state', rows, showAll: this.showAll, showDismissed: this.showDismissed,
        soundOn: !!cfg().get('sound.enabled'), now: Date.now(),
        window: (vscode.workspace.workspaceFolders || []).map(f => path.basename(f.uri.fsPath)).join(', ') || 'no folder',
      });
    }
  }
}

function html(webview, context) {
  const nonce = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
  const script = webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'media', 'panel.js'));
  const style = webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'media', 'panel.css'));
  return `<!DOCTYPE html><html><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<link rel="stylesheet" href="${style}"><title>Claude Sessions</title></head>
<body><div id="bar"></div><div id="list"></div><div id="dismissed"></div>
<script nonce="${nonce}" src="${script}"></script></body></html>`;
}

// ---- activation -------------------------------------------------------------

function activate(context) {
  extensionRoot = context.extensionPath || __dirname;
  const tracker = new Tracker(context);
  const provider = new Provider(context, tracker);
  context.subscriptions.push(vscode.window.registerWebviewViewProvider('claudeSessions.view', provider, { webviewOptions: { retainContextWhenHidden: true } }));

  let timer = null;
  const tick = () => { tracker.refresh(); provider.push(); };
  const schedule = () => { if (timer) clearTimeout(timer); timer = setTimeout(tick, 150); };

  tick();
  let watcher = null;
  try { watcher = fs.watch(sessionsDir(), { persistent: false }, schedule); } catch { /* dir may not exist yet */ }
  const poll = setInterval(tick, 5000); // fallback: pid deaths and missed events
  context.subscriptions.push({ dispose: () => { if (watcher) watcher.close(); clearInterval(poll); if (timer) clearTimeout(timer); } });
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(e => { if (e.affectsConfiguration('claudeSessions')) tick(); }));

  context.subscriptions.push(
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
  );
}

function deactivate() {}
module.exports = { activate, deactivate };
