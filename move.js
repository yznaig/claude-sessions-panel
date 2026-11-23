// A background session can be opened here only if its transcript sits in the project folder of one of
// this window's folders: Claude Code's extension looks for a conversation only there, and starts a
// blank new one otherwise. A session that moved into a git worktree keeps its transcript in the
// worktree's project folder, so a plain hand-over (stop, then open) would stop it and open nothing
// (focus-next-1123 and runner-glossary-1123, 11-23). Such a session is moved in first: stopped,
// resumed in the background from the window's folder (`claude --bg --resume` forks it under a new id
// whose transcript sits in that folder's project folder), and opened once that copy has replied
// (decision e1123-25). The pieces core.js's handOver puts together:
//
//   openFrom(folders, sessionId)  -> the window folder whose project folder holds its transcript, or null
//   homeFolder(folders, cwd)      -> the window folder to move a session working in `cwd` into
//   resumeArgs(sessionId, job, transcript, prompt) -> `claude` arguments that resume it as it was started
//   resumeEnv(job)                -> the environment for that call
//   movedNote(...) / backNote(...) -> the prompt the copy is started with
//   backgrounded(output)          -> the new job id `claude --bg` printed, or null
//   settled(rec, transcript)      -> whether the copy has answered the note (idle after a reply, or waiting on you)
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { worktreeRepo } = require('./window');

const MARK = '[claude sessions panel] moved';
// Claude Code names a project folder after the path, cut at 200 characters plus a hash when longer.
const LONG = 200;
const projects = () => path.join(os.homedir(), '.claude', 'projects');
const folderName = f => f.replace(/\/$/, '').replace(/[^a-zA-Z0-9]/g, '-');

function projectDirs(folder) {
  const name = folderName(folder);
  if (name.length <= LONG) return [path.join(projects(), name)];
  try { return fs.readdirSync(projects()).filter(d => d.startsWith(name.slice(0, LONG))).map(d => path.join(projects(), d)); } catch { return []; }
}

function openFrom(folders, sessionId) {
  return folders.find(f => projectDirs(f).some(d => fs.existsSync(path.join(d, sessionId + '.jsonl')))) || null;
}

function transcriptIn(folder, sessionId) {
  return projectDirs(folder).map(d => path.join(d, sessionId + '.jsonl')).find(p => fs.existsSync(p)) || null;
}

function homeFolder(folders, cwd) {
  const fs_ = folders.map(f => f.replace(/\/$/, ''));
  const under = p => fs_.find(f => p === f || p.startsWith(f + '/'));
  return (cwd && (under(cwd) || (worktreeRepo(cwd) && under(worktreeRepo(cwd))))) || fs_[0];
}

// The daemon's record of a job: `respawnFlags` (its name, model), `providerEnv`.
function jobState(sessionId) {
  let dirs = [];
  try { dirs = fs.readdirSync(os.homedir()).filter(d => d.startsWith('.claude')); } catch { /* none */ }
  for (const d of dirs) {
    try {
      const s = JSON.parse(fs.readFileSync(path.join(os.homedir(), d, 'jobs', sessionId.slice(0, 8), 'state.json'), 'utf8'));
      if (s && s.sessionId === sessionId) return s;
    } catch { /* not this config */ }
  }
  return {};
}

// The flags it was started with, its name, and the permission mode its transcript last recorded.
function resumeArgs(sessionId, job, transcript, prompt) {
  const flags = (Array.isArray(job.respawnFlags) ? job.respawnFlags : []).map(String);
  if (!flags.includes('-n') && !flags.includes('--name') && typeof job.name === 'string' && job.name) flags.push('-n', job.name);
  if (!flags.includes('--permission-mode') && transcript) {
    let mode = null;
    try {
      for (const m of fs.readFileSync(transcript, 'utf8').matchAll(/"permissionMode":\s*"([^"]+)"/g)) mode = m[1];
    } catch { /* none recorded */ }
    if (mode) flags.push('--permission-mode', mode);
  }
  return ['--bg', '--resume', sessionId, ...flags, '--', prompt];
}

function resumeEnv(job) {
  const env = { ...process.env };
  for (const [k, v] of Object.entries(job.providerEnv || {})) if (typeof v === 'string' && !k.startsWith('CLAUDE_') && !(k in env)) env[k] = v;
  return env;
}

function movedNote({ name, from, to, watching, waiting }) {
  return [
    `${MARK} The Claude Sessions panel moved this session (${name}) so the user can open it in VS Code: it was working in ${from}, and Claude Code's VS Code panel can only open a session whose folder is the window's (${to}). You carry on as a resumed copy under a new session id, started from ${to}.`,
    `Your files are still in ${from}: keep working there (cd into it for every command).`,
    watching ? `Moving stopped the background command you were watching (${watching}). Don't start it again now; you'll be told to once the user opens you.` : '',
    waiting ? `You were waiting on the user (${waiting}). Don't ask now; you'll be told to ask again once the user opens you.` : '',
    'If you held a session-hive role, take it again under your new id.',
    'Now reply in two lines: greet the user again and say what you were doing or waiting on. Start nothing else; the user is opening you.',
  ].filter(Boolean).join('\n\n');
}

function backNote({ name, to }) {
  return `${MARK} back: The Claude Sessions panel tried to move this session (${name}) into ${to} so the user could open it in VS Code, and that failed, so it was resumed where it was, under a new session id. Nothing else changed: carry on with what you were doing.`;
}

function backgrounded(out) {
  const m = /backgrounded\s*·\s*([A-Za-z0-9-]+)/.exec(String(out || ''));
  return m ? m[1] : null;
}

// The copy has answered the note: its last turn after the note ended (idle, with a reply after it), or
// it is waiting on you. Read from the transcript's tail.
function settled(rec, transcript) {
  if (!rec || !transcript || (rec.status !== 'idle' && rec.status !== 'waiting')) return false;
  let text = '';
  try {
    const fd = fs.openSync(transcript, 'r');
    try {
      const size = fs.fstatSync(fd).size, n = Math.min(size, 256 * 1024);
      const buf = Buffer.alloc(n);
      fs.readSync(fd, buf, 0, n, size - n);
      text = buf.toString('utf8');
    } finally { fs.closeSync(fd); }
  } catch { return false; }
  const at = text.lastIndexOf(MARK);
  if (at < 0) return false;
  return rec.status === 'waiting' || /"type":\s*"assistant"/.test(text.slice(text.indexOf('\n', at)));
}

module.exports = { MARK, openFrom, transcriptIn, homeFolder, jobState, resumeArgs, resumeEnv, movedNote, backNote, backgrounded, settled };
