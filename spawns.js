// Sub-sessions that open as Claude Code tabs. The session hive's `spawn` writes a request to
// ~/.claude/session-hive/spawn/<token>.json; the panel of the window whose first folder is the request's
// folder takes it (renames it to <token>.opening, so one window wins) and opens a new Claude Code tab
// with "[hive:<token>]" in its prompt box. The new session's companion mod sees the tag and submits
// the brief. Each panel keeps ~/.claude/session-hive/panels/<pid>.json while it runs, so `spawn`
// knows whether any window can take the request or should start in the background at once.
// No VS Code here: core.js opens the tab.
'use strict';
const fs = require('fs');
const path = require('path');

const TOKEN = /^[0-9a-f]{8,32}$/;
const MAX_AGE_MS = 60e3; // an older request has been given up on by `spawn`

function hiveDir(home) { return path.join(home, '.claude', 'session-hive'); }

// This panel's entry: its extension host's pid (with start time, so a reused pid doesn't count) and
// the window's folders. Returns a function that removes it.
function announcePanel(home, pid, procStart, folders) {
  const dir = path.join(hiveDir(home), 'panels');
  const file = path.join(dir, `${pid}.json`);
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file + '.tmp', JSON.stringify({ pid, procStart, folders, at: Date.now() }) + '\n');
    fs.renameSync(file + '.tmp', file);
  } catch { /* no entry: spawn starts in the background */ }
  return () => { try { fs.unlinkSync(file); } catch { /* gone already */ } };
}

// Requests this window should open: its first folder is theirs and they are fresh. Each one returned
// has been renamed to .opening, so no other window opens it too. Returns [{ token, name }].
function takeRequests(home, folders, now) {
  const dir = path.join(hiveDir(home), 'spawn');
  const first = (folders[0] || '').replace(/\/+$/, '');
  if (!first) return [];
  let names;
  try { names = fs.readdirSync(dir); } catch { return []; }
  const out = [];
  for (const f of names) {
    if (!f.endsWith('.json')) continue;
    const token = f.slice(0, -5);
    if (!TOKEN.test(token)) continue;
    let req;
    try { req = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { continue; }
    if (!req || String(req.cwd || '').replace(/\/+$/, '') !== first) continue;
    if (!(now - (req.at || 0) * 1000 < MAX_AGE_MS)) continue;
    try { fs.renameSync(path.join(dir, f), path.join(dir, token + '.opening')); } catch { continue; } // another window won
    out.push({ token, name: String(req.name || 'sub-session') });
  }
  return out;
}

// What the new tab's prompt box holds until its session takes the brief.
function tagText(req) { return `Starting sub-session ${req.name}… [hive:${req.token}]`; }

// A background session opened here while watching a command: stopping it ended the command. The note
// waits in ~/.claude/session-hive/resume/<session id>.json until the session starts here, when the
// companion mod hands it to the session (`hive.py resumed`). Returns a function that takes it back.
function leaveResumeNote(home, sessionId, watching) {
  const dir = path.join(hiveDir(home), 'resume');
  const file = path.join(dir, `${sessionId}.json`);
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file + '.tmp', JSON.stringify({ at: Date.now() / 1000, watching: watching || '' }) + '\n');
    fs.renameSync(file + '.tmp', file);
  } catch { /* no note: the session still opens */ }
  return () => { try { fs.unlinkSync(file); } catch { /* gone already */ } };
}

module.exports = { announcePanel, takeRequests, tagText, hiveDir, leaveResumeNote };
