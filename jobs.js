// Background sessions Claude Code parked: a `claude --bg` session that waited on your answer for an
// hour is retired by Claude Code's daemon ("bg retire <id>: idle-prompt, idle 60m"). Its process
// ends, so it leaves the registry, but its job is still blocked on you and the conversation resumes
// when you open it. Read from ~/.claude*/jobs/<first 8 of the session id>/state.json, which the
// daemon keeps for every background job. Opened since (in VS Code, or `claude attach`), the job file
// still says blocked, but the conversation has moved on: a turn stamped after the job blocked.
//
//   parkedJob(sessionId) -> { job, needs } while that job is still waiting on you, else null
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const DIRS_TTL_MS = 60e3;
// A turn this long after the job's last update means someone carried on the conversation.
const MOVED_ON_MS = 60e3;
const TAIL_BYTES = 64 * 1024;
let dirs = { home: '', at: 0, list: [] };
const cache = new Map(); // state.json path -> { mtimeMs, tMtime (its transcript), s, value }

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

// The newest `timestamp` among the transcript's last lines (retirement adds only unstamped ones).
function lastTurnAt(transcript) {
  let fd;
  try {
    fd = fs.openSync(transcript, 'r');
    const size = fs.fstatSync(fd).size;
    const n = Math.min(size, TAIL_BYTES);
    const buf = Buffer.alloc(n);
    fs.readSync(fd, buf, 0, n, size - n);
    const re = /"timestamp":\s*"([^"]+)"/g;
    let latest = 0, m;
    const text = buf.toString('utf8');
    while ((m = re.exec(text))) { const t = Date.parse(m[1]); if (t > latest) latest = t; }
    return latest;
  } catch { return 0; } finally { if (fd !== undefined) fs.closeSync(fd); }
}

function movedOn(s) {
  const t = s.linkScanPath;
  const at = Date.parse(s.updatedAt || '');
  if (typeof t !== 'string' || !at) return false;
  return lastTurnAt(t) > at + MOVED_ON_MS;
}

function transcriptMtime(s) {
  try { return fs.statSync(s.linkScanPath).mtimeMs; } catch { return 0; }
}

function read(file, sessionId) {
  let st;
  try { st = fs.statSync(file); } catch { cache.delete(file); return null; }
  const hit = cache.get(file);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.tMtime === transcriptMtime(hit.s)) return hit.value;
  let s;
  try { s = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* half-written: try again next look */ return null; }
  if (!s || typeof s !== 'object') return null;
  const value = s.state === 'blocked' && s.sessionId === sessionId && !movedOn(s)
    ? { job: path.basename(path.dirname(file)), needs: typeof s.needs === 'string' ? s.needs : '' } : null;
  cache.set(file, { mtimeMs: st.mtimeMs, tMtime: transcriptMtime(s), s, value });
  return value;
}

function parkedJob(sessionId) {
  if (typeof sessionId !== 'string' || sessionId.length < 8) return null;
  const short = sessionId.slice(0, 8);
  for (const d of configDirs()) {
    const found = read(path.join(d, short, 'state.json'), sessionId);
    if (found) return found;
  }
  return null;
}

module.exports = { parkedJob };
