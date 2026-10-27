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

const DISMISSED_KEY = 'claudeSessions.dismissed';
const AUTO_CLOSED_KEY = 'claudeSessions.autoClosed';
// Without the session-trail mod nothing says when you left a closed session: move it after this.
const NO_TRAIL_CLOSE_MS = 2 * 60e3;
const SHOW_ALL_KEY = 'claudeSessions.showAllWindows';
// The sessions the panel lists, saved so they come back after VS Code restarts.
const OPEN_KEY = 'claudeSessions.open';
// A session of this window's folder that stops while VS Code keeps running was ended on purpose and
// leaves the saved list after this long; when VS Code itself closes, the panel is gone well before.
const ENDED_GRACE_MS = 30e3;
// The one-time rebuild after upgrading to 0.6.0 takes stopped sessions active within this window.
const UPGRADE_WINDOW_MS = 12 * 3600e3;
// Your folders: their names in tab order, and the folder each filed session is in, with a copy of
// its row so it shows even when it is not running. Shared by every window.
const FOLDERS_KEY = 'claudeSessions.folders';
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

// ---- transcripts: titles and "good to close" -------------------------------
//
// Titles. The registry keeps a placeholder name ("command-hq-89") for a session
// Claude names on its own; the real title is written into the session's
// transcript. Same rule as the Claude extension's session list: the latest title
// you set (custom-title) wins, else the latest generated one (ai-title).
//
// Closed. When a session's latest turn ran the anything-left skill and its final
// reply opens with "Good to close", the session is done: the panel shows it as
// closed and moves it to Removed once you switch away from it.
//
// Reply. The text of the latest turn after its last tool call: the reply a ready
// session is waiting for you to read. Its length and its numbered items (replies
// number only the decisions they ask of you) give the time it will take you.
//
// Each transcript is read once, then only the bytes added since.

const transcriptCache = new Map(); // sessionId -> entry
const FRESH = { offset: 0, tail: '', custom: null, ai: null, checking: false, closed: false, closedAt: 0, reply: '' };

// Your time for a reply: reading at WORDS_PER_MIN, plus MIN_PER_DECISION for each numbered item.
const WORDS_PER_MIN = 230;
const MIN_PER_DECISION = 0.75;
function replyCost(text) {
  const words = (text.match(/\S+/g) || []).length;
  const prose = text.replace(/```[\s\S]*?```/g, ' ');
  const decisions = (prose.match(/^\d{1,2}[.)]\s/gm) || []).length;
  return { words, decisions, minutes: words / WORDS_PER_MIN + decisions * MIN_PER_DECISION };
}
const CLOSE_SKILL = 'anything-left';
const CLOSE_REPLY = /^[\s*_>#]*good to close\b/i;

function transcriptFor(rec) {
  const projects = path.join(os.homedir(), '.claude', 'projects');
  const direct = path.join(projects, String(rec.cwd || '').replace(/[^a-zA-Z0-9]/g, '-'), rec.sessionId + '.jsonl');
  if (fs.existsSync(direct)) return direct;
  try {
    for (const d of fs.readdirSync(projects)) {
      const p = path.join(projects, d, rec.sessionId + '.jsonl');
      if (fs.existsSync(p)) return p;
    }
  } catch { /* no projects dir */ }
  return null;
}

function blocksOf(r) {
  const c = r && r.message && r.message.content;
  if (typeof c === 'string') return [{ type: 'text', text: c }];
  return Array.isArray(c) ? c : [];
}

function scanLine(entry, line) {
  const isUser = line.indexOf('"type":"user"') >= 0;
  const isAssistant = line.indexOf('"type":"assistant"') >= 0;
  if (line.indexOf('-title"') < 0 && !isUser && !isAssistant) return;
  if (isUser && line.indexOf('"tool_result"') >= 0) return;           // tool output, not a prompt
  if (isAssistant && !entry.checking && line.indexOf(CLOSE_SKILL) < 0 && line.indexOf('"type":"text"') < 0) {
    // Not text: only a tool call matters, which makes the text before it interim.
    if (line.indexOf('"type":"tool_use"') >= 0 && line.indexOf('"isSidechain":true') < 0) entry.reply = '';
    return;
  }
  let r;
  try { r = JSON.parse(line); } catch { return; }
  if (r.type === 'custom-title' && r.customTitle) { entry.custom = r.customTitle; return; }
  if (r.type === 'ai-title' && r.aiTitle) { entry.ai = r.aiTitle; return; }
  if (r.isSidechain) return;                                            // a subagent's own transcript rows
  const blocks = blocksOf(r);
  if (r.type === 'user') {
    if (r.isMeta) return;
    const texts = blocks.filter(b => b && b.type === 'text').map(b => String(b.text || '').trim()).filter(Boolean);
    const text = texts.join(' ');
    // A prompt can arrive as several blocks (an IDE note first, then the words): any block
    // of the person's own, or a slash command, makes it theirs.
    const typed = texts.some(t => !t.startsWith('<') || t.indexOf('<command-name>') >= 0);
    if (!typed) return;                                                 // a reminder or notice, not the person
    entry.checking = text.indexOf('<command-name>/' + CLOSE_SKILL) >= 0;
    entry.closed = false;
    entry.closedAt = 0;
    entry.reply = '';
    return;
  }
  if (r.type === 'assistant') {
    for (const b of blocks) {
      if (b && b.type === 'tool_use' && b.name === 'Skill' && b.input && String(b.input.skill || '') === CLOSE_SKILL) entry.checking = true;
      if (b && b.type === 'tool_use') entry.reply = '';
      if (b && b.type === 'text' && b.text) entry.reply += (entry.reply ? '\n\n' : '') + b.text;
    }
    if (!entry.checking) return;
    const text = blocks.filter(b => b && b.type === 'text').map(b => b.text || '').join('\n').trim();
    if (!text) return;
    entry.closed = CLOSE_REPLY.test(text);                              // the turn's last words decide
    entry.closedAt = entry.closed ? (Date.parse(r.timestamp) || Date.now()) : 0;
  }
}

function readTranscript(rec) {
  let entry = transcriptCache.get(rec.sessionId);
  if (!entry || !entry.file) {
    entry = { file: transcriptFor(rec), ...FRESH };
    transcriptCache.set(rec.sessionId, entry);
  }
  if (!entry.file) return entry;
  let size;
  try { size = fs.statSync(entry.file).size; } catch { entry.file = null; return entry; }
  if (size < entry.offset) Object.assign(entry, FRESH); // rewritten
  if (size > entry.offset) {
    let fd;
    try {
      fd = fs.openSync(entry.file, 'r');
      const buf = Buffer.alloc(size - entry.offset);
      fs.readSync(fd, buf, 0, buf.length, entry.offset);
      const text = entry.tail + buf.toString('utf8');
      const cut = text.lastIndexOf('\n');
      if (cut >= 0) for (const line of text.slice(0, cut).split('\n')) scanLine(entry, line);
      entry.tail = cut < 0 ? text : text.slice(cut + 1); // a line still being written
      entry.offset = size;
    } catch { /* try again next pass */ } finally { if (fd !== undefined) fs.closeSync(fd); }
  }
  return entry;
}

function displayName(rec) {
  const t = readTranscript(rec);
  return t.custom || t.ai || rec.name || String(rec.sessionId).slice(0, 8);
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
  // `carried`: what carry() returned in the copy this one replaces, on a panel reload.
  constructor(context, carried) {
    this.context = context;
    this.prevStatus = new Map(carried ? carried.prevStatus : []);   // sessionId -> last seen status
    this.attention = new Map(carried ? carried.attention : []);     // sessionId -> 'ready' | 'waiting'
    this.autoClosed = new Set(context.globalState.get(AUTO_CLOSED_KEY, [])); // "<id>:<closedAt>" already moved once
    this.firstLoad = !carried;
    this.sessions = [];

    // The Removed list does not outlive VS Code: keep only removals of sessions still running.
    // A panel reload is not a restart, so it keeps them all.
    // Saved as [id, removedAt]; versions before 0.7.0 saved bare ids, counted as removed now.
    const live = readRegistry();
    const liveIds = new Set(live.map(r => r.sessionId));
    const removed = context.globalState.get(DISMISSED_KEY, []);
    const started = Date.now();
    this.dismissed = new Map();     // sessionId -> when it was removed
    for (const x of removed) {
      const [id, at] = Array.isArray(x) ? x : [x, started];
      if (carried || liveIds.has(id)) this.dismissed.set(id, at || started);
    }
    if (this.dismissed.size !== removed.length || removed.some(x => !Array.isArray(x))) void this.saveDismissed();

    // The listed sessions come back after a restart as "not running" rows; a click reopens one.
    this.known = new Map(carried ? carried.known : []); // sessionId -> { id, cwd, name, since, startedAt }, as last seen
    this.kept = new Map();        // sessionId -> entry: what the saved list holds
    this.liveIds = liveIds;       // live at the last refresh
    this.liveThisRun = new Set(carried ? carried.liveThisRun : []); // seen running since VS Code started
    this.goneAt = new Map(carried ? carried.goneAt : []); // sessionId -> when a session of this window was first seen stopped
    let open = context.globalState.get(OPEN_KEY);
    if (!Array.isArray(open)) open = this.listedBeforeUpgrade(new Set(removed.map(x => (Array.isArray(x) ? x[0] : x))));
    for (const e of open) if (e && e.id) { this.known.set(e.id, e); this.kept.set(e.id, e); }
    this.loadFolders();
  }

  // ---- folders ----
  // Read fresh before each use: another window may have changed them.
  loadFolders() {
    const f = this.context.globalState.get(FOLDERS_KEY) || {};
    this.folders = (Array.isArray(f.names) ? f.names : []).filter(n => typeof n === 'string' && n);
    const filed = (Array.isArray(f.filed) ? f.filed : []).filter(x => Array.isArray(x) && x[1] && x[1].entry && this.folders.includes(x[1].folder));
    this.filed = new Map(filed);  // sessionId -> { folder, entry }
  }
  saveFolders() { return this.context.globalState.update(FOLDERS_KEY, { names: this.folders, filed: [...this.filed] }); }
  folderOf(id) { const f = this.filed.get(id); return f ? f.folder : ''; }

  // Move a session to a folder, or to Main with ''.
  moveTo(id, folder) {
    this.loadFolders();
    const was = this.filed.get(id);
    if (folder) {
      const entry = this.known.get(id) || (was && was.entry);
      if (!entry || !this.folders.includes(folder)) return;
      this.filed.set(id, { folder, entry });
    } else {
      if (!was) return;
      this.filed.delete(id);
      this.toMain(id, was.entry);
    }
    void this.saveFolders();
  }

  // A stopped session coming out of a folder joins Main's saved list as a "not running" row, even
  // one that ended while VS Code ran, which Main would otherwise drop.
  toMain(id, entry) {
    if (this.liveIds.has(id) || this.dismissed.has(id)) return;
    const e = this.known.get(id) || entry;
    this.known.set(id, e);
    this.liveThisRun.delete(id);
    this.goneAt.delete(id);
    this.kept.set(id, e);
    void this.saveKept();
  }

  addFolder(name) {
    this.loadFolders();
    if (this.folders.includes(name)) return;
    this.folders.push(name);
    void this.saveFolders();
  }
  renameFolder(from, to) {
    this.loadFolders();
    const i = this.folders.indexOf(from);
    if (i < 0 || this.folders.includes(to)) return;
    this.folders[i] = to;
    for (const f of this.filed.values()) if (f.folder === from) f.folder = to;
    void this.saveFolders();
  }
  // Its sessions go back to Main.
  deleteFolder(name) {
    this.loadFolders();
    this.folders = this.folders.filter(n => n !== name);
    for (const [id, f] of [...this.filed]) if (f.folder === name) { this.filed.delete(id); this.toMain(id, f.entry); }
    void this.saveFolders();
  }

  // Keep each running filed session's copy current, and let go of filed sessions that closed.
  keepFiled(regs, now) {
    let changed = false;
    for (const r of regs) {
      const f = this.filed.get(r.sessionId);
      if (!f) continue;
      const e = this.entryOf(r, now);
      if (e.name !== f.entry.name || e.cwd !== f.entry.cwd || e.since - f.entry.since > 10 * 60e3) { f.entry = e; changed = true; }
    }
    for (const [id, f] of [...this.filed]) {
      if (this.liveIds.has(id) || !readTranscript({ sessionId: id, cwd: f.entry.cwd }).closed) continue;
      this.filed.delete(id); changed = true;
    }
    if (changed) void this.saveFolders();
  }

  // The in-memory state a panel reload hands to the next copy (the rest is in globalState).
  carry() {
    return {
      prevStatus: [...this.prevStatus], attention: [...this.attention], known: [...this.known],
      liveThisRun: [...this.liveThisRun], goneAt: [...this.goneAt],
    };
  }

  // First run after an upgrade: nothing saved yet, so rebuild the list from the records stopped
  // sessions leave in the registry, the ones the panel was showing (recent, not removed, not closed).
  listedBeforeUpgrade(removed) {
    const now = Date.now();
    const out = [];
    for (const r of readRegistry(true)) {
      const e = this.entryOf(r, now);
      if (removed.has(e.id) || now - e.since > UPGRADE_WINDOW_MS || readTranscript(r).closed) continue;
      out.push(e);
    }
    return out;
  }

  entryOf(r, now) {
    const since = r.statusUpdatedAt || r.updatedAt || r.startedAt || now;
    return { id: r.sessionId, cwd: r.cwd || '', name: displayName(r), since, startedAt: r.startedAt || since };
  }

  // Removed sessions leave the Removed list this long after they were removed. They stay hidden;
  // new activity still brings one back.
  clearRemovedAfter() { return (cfg().get('removedClearHours') || 12) * 3600e3; }
  removedExpired(id, now) { return now - (this.dismissed.get(id) || now) > this.clearRemovedAfter(); }

  saveDismissed() { return this.context.globalState.update(DISMISSED_KEY, [...this.dismissed]); }

  saveKept() {
    const value = [...this.kept.values()].sort((a, b) => (a.id < b.id ? -1 : 1));
    return this.context.globalState.update(OPEN_KEY, value);
  }

  // Whether a session's folder is this window's (a window with no folder owns none).
  ownedHere(cwd) {
    const folders = (vscode.workspace.workspaceFolders || []).map(f => f.uri.fsPath.replace(/\/$/, ''));
    return !!cwd && folders.some(f => cwd === f || cwd.startsWith(f + '/'));
  }

  // Stopped while this window kept running: ended on purpose, so not shown as "not running".
  endedHere(id, cwd) { return this.liveThisRun.has(id) && !this.liveIds.has(id) && this.ownedHere(cwd); }

  // Rebuild the saved list. Running sessions the panel lists are saved as they are now. A stopped
  // session of this window's folder stays until removed, closed, or ended while VS Code ran.
  // Another window's stopped sessions are that window's to drop: the saved copy is followed.
  keep(regs, now) {
    const stored = new Map((this.context.globalState.get(OPEN_KEY) || []).filter(e => e && e.id).map(e => [e.id, e]));
    const next = new Map();
    this.liveIds = new Set(regs.map(r => r.sessionId));
    for (const r of regs) {
      const e = this.entryOf(r, now);
      const status = r.status || 'idle';
      this.known.set(e.id, e);
      this.liveThisRun.add(e.id);
      this.goneAt.delete(e.id);
      if (!this.dismissed.has(e.id) && !(status === 'idle' && readTranscript(r).closed)) next.set(e.id, e);
    }
    const carry = (id, e) => {
      if (this.liveIds.has(id) || this.dismissed.has(id)) return;
      if (this.endedHere(id, e.cwd)) {
        if (!this.goneAt.has(id)) this.goneAt.set(id, now);
        if (now - this.goneAt.get(id) > ENDED_GRACE_MS) return;
      }
      if (readTranscript({ sessionId: id, cwd: e.cwd }).closed) return;
      if (!this.liveThisRun.has(id)) this.known.set(id, e);
      next.set(id, e);
    };
    for (const [id, e] of this.kept) if (this.ownedHere(e.cwd)) carry(id, e);
    for (const [id, e] of stored) if (!this.ownedHere(e.cwd)) carry(id, e);
    this.kept = next;
    const sorted = m => JSON.stringify([...m.values()].sort((a, b) => (a.id < b.id ? -1 : 1)));
    if (sorted(next) !== sorted(stored)) void this.saveKept();
  }

  refresh() {
    const regs = readRegistry();
    const trail = readTrail();
    const now = Date.now();
    this.loadFolders();
    // The most recent time each window's folder showed some session: a switch made by
    // the panel's own click does not always record the old session as hidden, but it
    // always records the new one as shown.
    const lastShownIn = cwd => {
      let latest = 0;
      for (const s of regs) {
        const tr = trail.get(s.sessionId);
        if (tr && sameWindow(s.cwd, cwd) && tr.shownAt > latest) latest = tr.shownAt;
      }
      return latest;
    };
    const seen = new Set();
    for (const r of regs) {
      const id = r.sessionId;
      seen.add(id);
      const status = r.status || 'idle';
      const prev = this.prevStatus.get(id);
      const t = readTranscript(r);
      if (status === 'idle' && t.closed) {
        // anything-left said "Good to close": done, not waiting on you.
        this.attention.delete(id);
        this.prevStatus.set(id, status);
        const key = `${id}:${t.closedAt}`;
        if (!this.autoClosed.has(key)) {
          const seenShown = trail.get(id);
          // Left it: VS Code hid it after the close, or another session in its window
          // has been shown since both the close and its own last showing.
          const leftIt = seenShown
            ? (!seenShown.shown && seenShown.hiddenAt >= t.closedAt) ||
              lastShownIn(r.cwd) > Math.max(t.closedAt, seenShown.shownAt)
            : now - t.closedAt > NO_TRAIL_CLOSE_MS;
          if (leftIt) { this.dismiss(id); this.markAutoClosed(key); }
        }
        continue;
      }
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
        if (!this.folderOf(id)) playSound('ready'); // a filed session's ready is a quiet dot on its tab
      }
      this.prevStatus.set(id, status);
    }
    for (const id of [...this.prevStatus.keys()]) {
      if (!seen.has(id)) { this.prevStatus.delete(id); this.attention.delete(id); }
    }
    this.firstLoad = false;
    this.sessions = regs;
    this.keep(regs, now);
    this.keepFiled(regs, now);
  }

  markAutoClosed(key) {
    this.autoClosed.add(key);
    const keep = [...this.autoClosed].slice(-300);
    this.autoClosed = new Set(keep);
    void this.context.globalState.update(AUTO_CLOSED_KEY, keep);
  }

  undismiss(id) {
    if (!this.dismissed.delete(id)) return;
    void this.saveDismissed();
    const e = this.known.get(id);
    if (e && !this.liveIds.has(id)) { this.kept.set(id, e); void this.saveKept(); }
  }
  // Removing a session also takes it out of its folder; brought back, it returns to Main.
  dismiss(id) {
    this.dismissed.set(id, Date.now()); this.attention.delete(id); void this.saveDismissed();
    if (this.kept.delete(id)) void this.saveKept();
    this.loadFolders();
    if (this.filed.delete(id)) void this.saveFolders();
  }
  restore(id) { this.undismiss(id); }
  ack(id) { this.attention.delete(id); }

  inThisWindow(cwd) {
    const folders = (vscode.workspace.workspaceFolders || []).map(f => f.uri.fsPath);
    if (!folders.length || !cwd) return true;
    return folders.some(f => cwd === f || cwd.startsWith(f.replace(/\/$/, '') + '/'));
  }

  offlineRow(e, dismissed) {
    return {
      id: e.id, pid: null, name: displayName({ sessionId: e.id, cwd: e.cwd, name: e.name }), cwd: e.cwd,
      repo: path.basename(e.cwd) || '?', status: 'offline', attention: null, dismissed,
      waitingFor: '', since: e.since, startedAt: e.startedAt || e.since, closed: false, folder: this.folderOf(e.id),
    };
  }

  view(showAll) {
    const now = Date.now();
    const rows = [];
    for (const e of this.known.values()) {
      if (this.liveIds.has(e.id) || this.endedHere(e.id, e.cwd)) continue;
      const dismissed = this.dismissed.has(e.id);
      if (!dismissed && !this.kept.has(e.id)) continue;
      if (dismissed && this.removedExpired(e.id, now)) continue;
      if (!showAll && !this.inThisWindow(e.cwd)) continue;
      rows.push(this.offlineRow(e, dismissed));
    }
    for (const r of this.sessions) {
      const id = r.sessionId;
      const status = r.status || 'idle';
      const attention = this.attention.get(id) || null;
      const dismissed = this.dismissed.has(id);
      if (!showAll && !this.inThisWindow(r.cwd)) continue;
      const since = r.statusUpdatedAt || r.updatedAt || r.startedAt || now;
      if (dismissed && this.removedExpired(id, now)) continue;
      rows.push({
        id, pid: r.pid, name: displayName(r), cwd: r.cwd || '',
        repo: path.basename(r.cwd || '') || '?', status, attention, dismissed,
        waitingFor: r.waitingFor || '', since, startedAt: r.startedAt || since,
        closed: status === 'idle' && readTranscript(r).closed, folder: this.folderOf(id),
        cost: attention === 'ready' ? replyCost(readTranscript(r).reply) : null,
      });
    }
    // Filed sessions no list above holds (ended here, or another window's): shown from the folder's copy.
    const listed = new Set(rows.map(x => x.id));
    for (const [id, f] of this.filed) {
      if (listed.has(id) || this.liveIds.has(id) || this.dismissed.has(id)) continue;
      if (!showAll && !this.inThisWindow(f.entry.cwd)) continue;
      rows.push(this.offlineRow(f.entry, false));
    }
    const rank = x => x.attention === 'waiting' ? 0 : x.attention === 'ready' ? 1 : x.status === 'busy' ? 2 : x.closed ? 4 : 3;
    // Ready sessions: the one that takes least of your time first.
    const minutes = x => (x.cost ? x.cost.minutes : 0);
    rows.sort((a, b) => rank(a) - rank(b) || minutes(a) - minutes(b) || b.since - a.since);
    return rows;
  }
}

// ---- webview ----------------------------------------------------------------

class Provider {
  constructor(context, tracker, rootUri, carried) {
    this.context = context;
    this.tracker = tracker;
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
    const t = this.tracker;
    t.loadFolders();
    return vscode.window.showInputBox({
      title, value, prompt: 'Folder name',
      validateInput: v => {
        const n = v.trim();
        if (!n) return 'Give the folder a name';
        if (n.length > 40) return 'Keep it under 40 characters';
        if (/^main$/i.test(n)) return 'Main is the list of sessions not in any folder';
        if (n !== value && t.folders.some(f => f.toLowerCase() === n.toLowerCase())) return 'There is already a folder by that name';
        return null;
      },
    }).then(v => (v === undefined ? undefined : v.trim()));
  }

  async onFolderMessage(m) {
    const t = this.tracker;
    switch (m.type) {
      case 'showFolder': this.showFolder(m.folder); break;
      case 'move': t.moveTo(m.id, m.folder || ''); break;
      case 'newFolder': {
        const name = await this.askFolderName(m.id ? 'New folder for this session' : 'New folder');
        if (!name) return;
        t.addFolder(name);
        if (m.id) t.moveTo(m.id, name); else this.showFolder(name);
        break;
      }
      case 'renameFolder': {
        const name = await this.askFolderName(`Rename folder "${m.folder}"`, m.folder);
        if (!name || name === m.folder) return;
        t.renameFolder(m.folder, name);
        if (this.viewFolder === m.folder) this.showFolder(name);
        break;
      }
      case 'deleteFolder': {
        t.loadFolders();
        const n = [...t.filed.values()].filter(f => f.folder === m.folder).length;
        const ok = await vscode.window.showWarningMessage(
          `Delete the folder "${m.folder}"?`,
          { modal: true, detail: n ? `Its ${n} session${n === 1 ? '' : 's'} go${n === 1 ? 'es' : ''} back to Main.` : 'It is empty.' },
          'Delete');
        if (ok !== 'Delete') return;
        t.deleteFolder(m.folder);
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
    const t = this.tracker;
    switch (m.type) {
      case 'focus': {
        t.ack(m.id);
        try { await openSession(m.id); }
        catch (e) { vscode.window.showWarningMessage(`Claude Sessions: could not focus session (${e.message}).`); }
        break;
      }
      case 'ack': t.ack(m.id); break;
      case 'dismiss': t.dismiss(m.id); break;
      case 'restore': t.restore(m.id); break;
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
    const rows = this.tracker.view(this.showAll);
    const live = rows.filter(r => !r.dismissed);
    writeSnapshot(live, this.showAll);
    // A filed session counts only when it needs you; its ready shows as a dot on its folder's tab.
    const needing = live.filter(r => r.attention === 'waiting' || (r.attention && !r.folder)).length;
    const folders = this.tracker.folders;
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

// Whether two session folders belong to the same VS Code window: both inside this
// window's workspace, or, for another window's sessions, the same folder.
function sameWindow(a, b) {
  const folders = (vscode.workspace.workspaceFolders || []).map(f => f.uri.fsPath.replace(/\/$/, ''));
  const inHere = c => !!c && folders.some(f => c === f || c.startsWith(f + '/'));
  if (inHere(a) || inHere(b)) return inHere(a) && inHere(b);
  return !!a && a === b;
}

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
  constructor(tracker) { this.tracker = tracker; this.walk = null; }

  // This window's live sessions that VS Code has shown, most recently shown first.
  ordered() {
    this.tracker.refresh();
    const live = new Map(this.tracker.sessions.map(s => [s.sessionId, s]));
    const trail = readTrail();
    const rows = [];
    for (const [id, t] of trail) {
      const s = live.get(id);
      if (!s || !this.tracker.inThisWindow(s.cwd || t.cwd)) continue;
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
  const tracker = new Tracker(context, host.carried);
  const provider = new Provider(context, tracker, vscode.Uri.file(host.root), host.carried);
  const history = new History(tracker);
  subs.push({ dispose: () => provider.detach() });

  let timer = null;
  const tick = () => { tracker.refresh(); provider.push(); };
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
      return { ...tracker.carry(), showDismissed: provider.showDismissed };
    },
  };
}

module.exports = { start };
