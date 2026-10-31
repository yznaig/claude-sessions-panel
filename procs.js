// Session processes on this machine: is a pid still the session's, stop it, and is it running a
// background command. Linux only (it reads /proc); elsewhere nothing is ever stopped.
'use strict';
const fs = require('fs');

// Field 22 of /proc/<pid>/stat: the process start time in clock ticks, which Claude Code records
// as procStart. A pid that has been reused by another process has a different one.
function procStartOf(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
  } catch { return null; }
}

// This machine and pid namespace, in the form Claude Code writes as pidDomain.
let domain;
function localDomain() {
  if (domain === undefined) {
    try { domain = `linux:${fs.readFileSync('/etc/machine-id', 'utf8').trim()}:${fs.readlinkSync('/proc/self/ns/pid')}`; }
    catch { domain = null; }
  }
  return domain;
}

// A registry record whose process this machine can see and stop.
function isHere(rec) {
  if (process.platform !== 'linux' || !rec || !rec.pid || !rec.procStart) return false;
  return !rec.pidDomain || rec.pidDomain === localDomain();
}

// Sends SIGTERM to the session's process, after checking the pid is still that process.
// Claude Code ends its MCP helpers on the way out. Returns whether it sent the signal.
function stop(rec) {
  if (!isHere(rec)) return false;
  if (String(procStartOf(rec.pid)) !== String(rec.procStart)) return false;
  try { process.kill(rec.pid, 'SIGTERM'); return true; } catch { return false; }
}

// A background command (run_in_background, Monitor) is a shell child of the session started from
// Claude Code's shell snapshot. MCP helpers are children too, but not started that way. One pass over
// the process table for all the given pids: the ones with such a child.
function withBackgroundCommand(pids) {
  const found = new Set();
  if (!pids.size) return found;
  let entries = [];
  try { entries = fs.readdirSync('/proc'); } catch { return found; }
  for (const e of entries) {
    if (!/^\d+$/.test(e)) continue;
    try {
      const stat = fs.readFileSync(`/proc/${e}/stat`, 'utf8');
      const ppid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
      if (!pids.has(ppid) || found.has(ppid)) continue;
      if (fs.readFileSync(`/proc/${e}/cmdline`, 'utf8').includes('.claude/shell-snapshots/')) found.add(ppid);
    } catch { /* gone meanwhile */ }
  }
  return found;
}

module.exports = { procStartOf, isHere, stop, withBackgroundCommand };
