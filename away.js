// The moon: whether you are away (a long stretch, or overnight), kept in one file every session on
// the machine can read without the panel open:
//
//   ~/.claude/sessions-panel/away.json
//   { "away": true, "since": 1793000000000, "sinceIso": "2026-10-26T23:40:00.000Z",
//     "changedAt": 1793000000000, "how": "moon" }
//
// `since` is when it went on (null when off). `how` says what last changed it: "moon" (the button)
// or "clicked a session" (you came back and opened one, which turns it off). No file means not away.
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

function awayFile() { return path.join(os.homedir(), '.claude', 'sessions-panel', 'away.json'); }

function readAway() {
  try {
    const a = JSON.parse(fs.readFileSync(awayFile(), 'utf8'));
    return { away: !!a.away, since: a.away ? a.since || null : null };
  } catch { return { away: false, since: null }; }
}

function writeAway(away, how) {
  const now = Date.now();
  const body = { away, since: away ? now : null, sinceIso: away ? new Date(now).toISOString() : null, changedAt: now, how };
  const file = awayFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file + '.tmp', JSON.stringify(body, null, 1) + '\n');
  fs.renameSync(file + '.tmp', file);
}

module.exports = { awayFile, readAway, writeAway };
