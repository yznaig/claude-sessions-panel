// Claude Code transcripts: the session's title, whether its last turn was a "Good to close",
// and the reply it is waiting on you to read, with what that reply will cost you.
// Reads ~/.claude/projects/<folder>/<session id>.jsonl; each file once, then only what was added.
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

// ---- transcripts: titles and "good to close" -------------------------------
//
// Titles. The registry keeps a placeholder name ("myapp-89") for a session
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
// Turn. When the latest turn began: your last prompt, or the last message another session sent it.
//
// Watching. The background commands (run_in_background, Monitor) started and not yet reported
// finished by a task notification: what a session done with its turn is waiting on.
//
// Each transcript is read once, then only the bytes added since.

const transcriptCache = new Map(); // sessionId -> entry
const FRESH = { offset: 0, tail: '', custom: null, ai: null, checking: false, closed: false, closedAt: 0, reply: '', pending: null, turnAt: 0 };

// Your time for a reply: reading at WORDS_PER_MIN, plus MIN_PER_DECISION for each numbered item.
const WORDS_PER_MIN = 230;
const MIN_PER_DECISION = 0.75;
function replyCost(text) {
  const words = (text.match(/\S+/g) || []).length;
  const prose = text.replace(/```[\s\S]*?```/g, ' ');
  const decisions = (prose.match(/^\d{1,2}[.)]\s/gm) || []).length;
  const readMinutes = words / WORDS_PER_MIN, decideMinutes = decisions * MIN_PER_DECISION;
  return { words, decisions, readMinutes, decideMinutes, minutes: readMinutes + decideMinutes };
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

// Background commands still running, by tool call id -> the command's description.
const pendingOf = entry => entry.pending || (entry.pending = new Map());
const BACKGROUND_STARTED = /^(Command running in background|Monitor started)/;
const isBackground = b => b && b.type === 'tool_use' && b.input &&
  (b.name === 'Monitor' || (b.name === 'Bash' && b.input.run_in_background === true));

// A tool result for a background command that did not start (refused, failed): not pending.
function dropUnstarted(entry, line) {
  if (!entry.pending || !entry.pending.size) return;
  const ids = [...entry.pending.keys()].filter(id => line.indexOf(id) >= 0);
  if (!ids.length) return;
  let r;
  try { r = JSON.parse(line); } catch { return; }
  for (const b of blocksOf(r)) {
    if (!b || b.type !== 'tool_result' || !entry.pending.has(b.tool_use_id)) continue;
    const c = b.content;
    const text = typeof c === 'string' ? c : Array.isArray(c) ? c.map(x => (x && x.text) || '').join('') : '';
    if (!BACKGROUND_STARTED.test(text)) entry.pending.delete(b.tool_use_id);
  }
}

function scanLine(entry, line) {
  const isUser = line.indexOf('"type":"user"') >= 0;
  const isAssistant = line.indexOf('"type":"assistant"') >= 0;
  if (line.indexOf('-title"') < 0 && !isUser && !isAssistant) return;
  if (isUser && line.indexOf('"tool_result"') >= 0) { dropUnstarted(entry, line); return; } // tool output, not a prompt
  const launch = isAssistant && (line.indexOf('"run_in_background":true') >= 0 || line.indexOf('"name":"Monitor"') >= 0);
  if (isAssistant && !launch && !entry.checking && line.indexOf(CLOSE_SKILL) < 0 && line.indexOf('"type":"text"') < 0) {
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
    // Another session's message starts a turn too (Claude Code records it as a meta line).
    if (r.isMeta) { if (r.origin && r.origin.kind === 'peer') entry.turnAt = Date.parse(r.timestamp) || entry.turnAt; return; }
    const texts = blocks.filter(b => b && b.type === 'text').map(b => String(b.text || '').trim()).filter(Boolean);
    const text = texts.join(' ');
    // A background command finished (or failed, or was stopped).
    for (const m of text.matchAll(/<task-notification>[\s\S]*?<\/task-notification>/g)) {
      const id = /<tool-use-id>([^<]+)<\/tool-use-id>/.exec(m[0]);
      if (id && /<status>[^<]+<\/status>/.test(m[0]) && entry.pending) entry.pending.delete(id[1]);
    }
    // A prompt can arrive as several blocks (an IDE note first, then the words): any block
    // of the person's own, or a slash command, makes it theirs.
    const typed = texts.some(t => !t.startsWith('<') || t.indexOf('<command-name>') >= 0);
    if (!typed) return;                                                 // a reminder or notice, not the person
    entry.turnAt = Date.parse(r.timestamp) || entry.turnAt;
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
      if (isBackground(b) && b.id) pendingOf(entry).set(b.id, String(b.input.description || '').trim());
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

// When the session last wrote anything: its transcript, or a subagent's (<id>/subagents/), which
// keeps writing while the session itself sits idle. 0 when there is no transcript.
function lastWrite(rec) {
  const entry = readTranscript(rec);
  if (!entry.file) return 0;
  let latest = 0;
  const mtime = f => { try { latest = Math.max(latest, fs.statSync(f).mtimeMs); } catch { /* gone */ } };
  mtime(entry.file);
  const subs = path.join(path.dirname(entry.file), String(rec.sessionId), 'subagents');
  try { for (const f of fs.readdirSync(subs)) mtime(path.join(subs, f)); } catch { /* none */ }
  return latest;
}

// What a watching session waits on: the latest background command still running, '' if unknown.
function watchingFor(rec) {
  const p = readTranscript(rec).pending;
  return p && p.size ? [...p.values()].at(-1) : '';
}

function displayName(rec) {
  const t = readTranscript(rec);
  return t.custom || t.ai || rec.name || String(rec.sessionId).slice(0, 8);
}

module.exports = { readTranscript, displayName, replyCost, lastWrite, watchingFor };
