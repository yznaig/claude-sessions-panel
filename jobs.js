// Background sessions Claude Code's daemon retired: a `claude --bg` session left at its prompt for an hour
// is retired, whatever it was doing ("bg retire <id>: idle-prompt, idle 60m" while it waits on your
// answer; "settled, idle 61m" when its turn ended and it waits on something you don't see: its
// sub-sessions, a lock, a timer). Its process ends, so it leaves the registry, but nobody closed it: the
// conversation resumes when you open it. Read from ~/.claude*/jobs/<first 8 of the session id>/state.json,
// which the daemon keeps for every background job: `blocked` (it asked you something) or `done` (it was
// idle) once retired; `stopped` after `claude stop` (the panel's close, the hive's close), which ended it
// on purpose.
// Retired no longer once the conversation went on: opened since (in VS Code, or `claude attach`), the job
// file still says blocked or done but a turn is stamped after the job's last update; continued as a new
// background job (`claude --bg --resume` forks it under a new id, and the new transcript's derived-from
// record names it). Not kept when you interrupted its last turn (Esc).
//
//   parkedJob(sessionId) -> { job, state: 'blocked' | 'done', needs } while that job sits retired, else null
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const DIRS_TTL_MS = 60e3;
// A turn this long after the job's last update means someone carried on the conversation.
const MOVED_ON_MS = 60e3;
const TAIL_BYTES = 64 * 1024;
// A transcript's derived-from record sits in its first few lines.
const HEAD_BYTES = 16 * 1024;
// A job dir with no readable state.json after this is not a job being written: it forks nothing.
const UNREADABLE_MS = 60e3;
const RETIRED = new Set(['blocked', 'done']);
const INTERRUPTED = '[Request interrupted by user';
let dirs = { home: '', at: 0, list: [] };
const cache = new Map(); // state.json path -> { mtimeMs, tMtime (its transcript), gen, s, value }

function configDirs() {
  const home = os.homedir();
  const now = Date.now();
  if (dirs.home !== home || now - dirs.at > DIRS_TTL_MS) {
    let list = [];
    try { list = fs.readdirSync(home).filter(d => d.startsWith('.claude')).map(d => path.join(home, d, 'jobs')); } catch { /* none */ }
    dirs = { home, at: now, list };
  }
  return dirs.list;
}

// How the transcript ends: the newest `timestamp` among its last lines (retirement adds only unstamped
// ones), and whether its last turn is one you interrupted.
function tailOf(transcript) {
  let fd;
  try {
    fd = fs.openSync(transcript, 'r');
    const size = fs.fstatSync(fd).size;
    const n = Math.min(size, TAIL_BYTES);
    const buf = Buffer.alloc(n);
    fs.readSync(fd, buf, 0, n, size - n);
    const text = buf.toString('utf8');
    const re = /"timestamp":\s*"([^"]+)"/g;
    let latest = 0, m;
    while ((m = re.exec(text))) { const t = Date.parse(m[1]); if (t > latest) latest = t; }
    return { latest, interrupted: lastTurnInterrupted(text) };
  } catch { return { latest: 0, interrupted: false }; } finally { if (fd !== undefined) fs.closeSync(fd); }
}

function lastTurnInterrupted(text) {
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!/"type":\s*"(user|assistant)"/.test(lines[i])) continue;
    let r;
    try { r = JSON.parse(lines[i]); } catch { continue; }
    if (!r || (r.type !== 'user' && r.type !== 'assistant') || r.isSidechain || r.isMeta) continue;
    if (r.type === 'assistant') return false;
    const c = r.message && r.message.content;
    const said = typeof c === 'string' ? c : Array.isArray(c) ? c.filter(b => b && b.type === 'text').map(b => b.text).join(' ') : '';
    return said.startsWith(INTERRUPTED);
  }
  return false;
}

// ---- sessions carried on as a new background job ----------------------------------------------------
// Every job dir is read once: its transcript's derived-from record names the sessions it forked from.
// A config's jobs folder is listed again only when it changed (a new job dir).
const forks = { home: '', listed: new Map(), seen: new Map(), ids: new Set(), gen: 0 };

function forkedFrom(transcript) {
  let fd;
  try {
    fd = fs.openSync(transcript, 'r');
    const buf = Buffer.alloc(HEAD_BYTES);
    const n = fs.readSync(fd, buf, 0, HEAD_BYTES, 0);
    const lines = buf.slice(0, n).toString('utf8').split('\n');
    if (n === HEAD_BYTES) lines.pop(); // cut mid-line
    for (const line of lines) {
      if (line.includes('"derived-from"')) {
        let r;
        try { r = JSON.parse(line); } catch { continue; }
        if (!r || r.type !== 'derived-from') continue;
        return (Array.isArray(r.sessions) ? r.sessions : []).filter(x => x && x.via === 'fork' && typeof x.id === 'string').map(x => x.id);
      }
      if (/"type":\s*"(user|assistant)"/.test(line)) return []; // the conversation began: there is none
    }
    return n === HEAD_BYTES ? [] : null; // not yet written
  } catch { return null; } finally { if (fd !== undefined) fs.closeSync(fd); }
}

function forkedIds() {
  const home = os.homedir();
  if (forks.home !== home) Object.assign(forks, { home, listed: new Map(), seen: new Map(), ids: new Set(), gen: forks.gen + 1 });
  for (const d of configDirs()) {
    let m;
    try { m = fs.statSync(d).mtimeMs; } catch { continue; }
    if (forks.listed.get(d) === m) continue;
    forks.listed.set(d, m);
    let names = [];
    try { names = fs.readdirSync(d); } catch { /* gone */ }
    for (const name of names) { const p = path.join(d, name); if (!forks.seen.has(p)) forks.seen.set(p, null); }
  }
  for (const [dir, ids] of forks.seen) {
    if (ids) continue;
    let s = null;
    try { s = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8')); } catch { /* half-written or none */ }
    let found = null;
    if (s && typeof s === 'object' && typeof s.linkScanPath === 'string') found = forkedFrom(s.linkScanPath);
    if (!found) {
      let age = 0;
      try { age = Date.now() - fs.statSync(dir).mtimeMs; } catch { /* gone */ }
      if (age < UNREADABLE_MS || (s && typeof s.linkScanPath === 'string' && fs.existsSync(s.linkScanPath))) continue;
      found = [];
    }
    forks.seen.set(dir, found);
    for (const id of found) if (!forks.ids.has(id)) { forks.ids.add(id); forks.gen++; }
  }
  return forks.ids;
}

function transcriptMtime(s) {
  try { return fs.statSync(s.linkScanPath).mtimeMs; } catch { return 0; }
}

function retired(s, sessionId, forked) {
  if (!RETIRED.has(s.state) || s.sessionId !== sessionId || forked.has(sessionId)) return false;
  const at = Date.parse(s.updatedAt || '');
  if (typeof s.linkScanPath !== 'string') return true;
  const t = tailOf(s.linkScanPath);
  return !t.interrupted && !(at && t.latest > at + MOVED_ON_MS);
}

function read(file, sessionId, forked) {
  let st;
  try { st = fs.statSync(file); } catch { cache.delete(file); return null; }
  const hit = cache.get(file);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.gen === forks.gen && hit.tMtime === transcriptMtime(hit.s)) return hit.value;
  let s;
  try { s = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* half-written: try again next look */ return null; }
  if (!s || typeof s !== 'object') return null;
  const value = retired(s, sessionId, forked)
    ? { job: path.basename(path.dirname(file)), state: s.state, needs: s.state === 'blocked' && typeof s.needs === 'string' ? s.needs : '' }
    : null;
  cache.set(file, { mtimeMs: st.mtimeMs, tMtime: transcriptMtime(s), gen: forks.gen, s, value });
  return value;
}

function parkedJob(sessionId) {
  if (typeof sessionId !== 'string' || sessionId.length < 8) return null;
  const short = sessionId.slice(0, 8);
  const forked = forkedIds();
  for (const d of configDirs()) {
    const found = read(path.join(d, short, 'state.json'), sessionId, forked);
    if (found) return found;
  }
  return null;
}

// A running background session stopped mid-turn on a permission prompt or a question: what the daemon
// says it needs, and whether it is waiting alone. `alone` is false when anything else is in flight (a
// helper agent it started, a background command), since stopping it would cut that off; also false when
// the record says nothing about what is in flight. Read fresh: it is asked once, on a click.
//   waitingOn(sessionId) -> { needs, alone } or null
function waitingOn(sessionId) {
  if (typeof sessionId !== 'string' || sessionId.length < 8) return null;
  for (const d of configDirs()) {
    let s;
    try { s = JSON.parse(fs.readFileSync(path.join(d, sessionId.slice(0, 8), 'state.json'), 'utf8')); } catch { continue; }
    if (!s || typeof s !== 'object' || s.sessionId !== sessionId) continue;
    const f = s.inFlight;
    const alone = !!f && typeof f === 'object' && !(f.tasks > 0) && !(f.queued > 0);
    return { needs: typeof s.needs === 'string' ? s.needs : '', alone };
  }
  return null;
}

module.exports = { parkedJob, waitingOn };
