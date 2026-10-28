// Search over every Claude Code session on this machine: titles, what you said, Claude's final
// replies, and the files each session touched.
//
//   const index = new SearchIndex({ roots, cacheFile, now })
//   await index.update()                    reads what changed since the last update (a little at a time)
//   index.search(query, { shows, limit })  -> ranked results with a snippet
//   index.progress                          -> { done, total } while the first build runs
//   askPrompt(query, results) / readAnswer(text, results)   the Ask Claude request and its reply
//
// Each transcript is read once, then only the bytes added since; the index is saved to `cacheFile`
// so the next start only reads what changed. Tool output is left out: it is most of a transcript's
// size and most of the noise. No VS Code here.
'use strict';
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { performance } = require('perf_hooks');

const FORMAT = 1; // bump when what is kept per session changes, so saved indexes are rebuilt
const HEADLESS = new Set(['sdk-cli', 'sdk-ts', 'sdk-py', 'sdk']);
const NOISE = ['<ide_opened_file>', '<ide_selection>', '<command-name>', '<command-message>', '<local-command',
  '<system-reminder>', '<task-notification>', '<bash-stdout>', '<bash-stderr>', '<bash-input>',
  'This session is being continued from a previous conversation', 'Caveat: The messages below'];
const PATH_KEYS = ['file_path', 'path', 'notebook_path'];
// Sessions run in a session's scratchpad (probes, tests): not worth finding.
const THROWAWAY = /^\/tmp\/claude-\d+\/|\/scratchpad(\/|$)/;
const KEEP = { prompt: 4000, reply: 3000, prompts: 60000, replies: 80000, files: 60 };
// How much each place a word turns up counts, and how many times it can count there.
const WEIGHT = { title: [8, 3], you: [3, 10], file: [2, 5], claude: [1, 10] };
const SLICE_MS = 12;
const SLOW_ROOT_MS = 120e3;
const SAVE_MS = 30e3; // work in slices this long, so the editor stays responsive during the first build

const clean = t => String(t || '')
  .replace(/<(system-reminder|ide_selection|ide_opened_file)>[\s\S]*?<\/\1>/g, '')
  .replace(/<\/?pasted_content[^>]*>/g, '').trim();

function humanText(r) {
  if (r.isMeta || r.isSidechain) return null;
  const c = r.message && r.message.content;
  let parts;
  if (typeof c === 'string') parts = [c];
  else if (Array.isArray(c)) {
    if (c.some(b => b && b.type === 'tool_result')) return null;
    parts = c.filter(b => b && b.type === 'text').map(b => b.text || '');
  } else return null;
  const text = clean(parts.join('\n'));
  if (!text || NOISE.some(n => text.startsWith(n))) return null;
  return text;
}

// Keeps a list of texts under a total size, dropping the oldest.
function pushCapped(list, text, each, total) {
  list.push(text.slice(0, each));
  let size = list.reduce((n, t) => n + t.length, 0);
  while (size > total && list.length > 1) size -= list.shift().length;
}

function fresh(file) {
  return {
    file, id: path.basename(file, '.jsonl'), offset: 0, tail: '', mtime: 0,
    title: '', ai: '', cwd: '', entry: '', start: 0, end: 0, turns: 0, firstUuid: null,
    prompts: [], replies: [], reply: '', files: {},
  };
}

// One transcript line into the session's entry.
function scan(s, line) {
  const user = line.indexOf('"type":"user"') >= 0;
  const assistant = line.indexOf('"type":"assistant"') >= 0;
  if (!user && !assistant && line.indexOf('-title"') < 0) return;
  if (user && line.indexOf('"tool_result"') >= 0) return; // tool output
  let r;
  try { r = JSON.parse(line); } catch { return; }
  if (r.type === 'custom-title' && r.customTitle) { s.title = r.customTitle; return; }
  if (r.type === 'ai-title' && r.aiTitle) { s.ai = r.aiTitle; return; }
  if (r.type !== 'user' && r.type !== 'assistant') return;
  if (r.isSidechain) return;
  const at = Date.parse(r.timestamp) || 0;
  if (at) { s.start = s.start || at; s.end = Math.max(s.end, at); }
  s.cwd = s.cwd || r.cwd || '';
  s.entry = s.entry || r.entrypoint || '';
  if (r.type === 'user') {
    const text = humanText(r);
    if (!text) return;
    if (s.reply) { pushCapped(s.replies, s.reply, KEEP.reply, KEEP.replies); s.reply = ''; }
    s.turns += 1;
    if (!s.firstUuid) s.firstUuid = r.uuid || null;
    pushCapped(s.prompts, text, KEEP.prompt, KEEP.prompts);
    return;
  }
  const blocks = Array.isArray(r.message && r.message.content) ? r.message.content : [];
  for (const b of blocks) {
    if (!b) continue;
    if (b.type === 'tool_use') {
      s.reply = ''; // text before a tool call was interim; the turn's final reply comes after the last one
      const input = b.input || {};
      for (const k of PATH_KEYS) if (typeof input[k] === 'string' && input[k]) s.files[input[k]] = (s.files[input[k]] || 0) + 1;
    } else if (b.type === 'text' && b.text) s.reply += (s.reply ? '\n\n' : '') + b.text;
  }
}

// Words a question is made of but a session is not found by.
const COMMON = new Set(('the and for are but not you your yours our ours was were has have had did does doing done ' +
  'what when where which who whom whose why how that this these those there here then than them they their ' +
  'with from into onto about over under again also just like some any all can could would should will shall ' +
  'its it\'s been being get got let make made say said tell told know think want need one ones way thing things ' +
  'session sessions claude decide decided talk talked mention mentioned remember').split(' '));

// The words and "quoted phrases" of a query, lowercased, without common words (unless that is all
// there is).
function termsOf(q) {
  const phrases = [...String(q).matchAll(/"([^"]+)"/g)].map(m => m[1].trim().toLowerCase()).filter(Boolean);
  const rest = String(q).replace(/"[^"]*"/g, ' ');
  const words = (rest.match(/[\p{L}\p{N}_./'-]{3,}/gu) || []).map(w => w.toLowerCase());
  const telling = words.filter(w => !COMMON.has(w));
  return [...new Set([...phrases, ...(telling.length || phrases.length ? telling : words)])];
}

function count(hay, t) {
  let n = 0;
  for (let i = hay.indexOf(t); i >= 0; i = hay.indexOf(t, i + t.length)) n++;
  return n;
}

const SNIPPET = 200;
// The passage that best shows why a session matched: the one holding the most of the terms.
function snippetOf(s, terms) {
  const units = [];
  if (s.titleText) units.push(['title', s.titleText]);
  for (const t of s.prompts) units.push(['you', t]);
  for (const t of s.allReplies) units.push(['claude', t]);
  for (const f of Object.keys(s.files)) units.push(['file', f]);
  let best = null;
  for (const [where, text] of units) {
    const low = text.toLowerCase();
    const hits = terms.filter(t => low.includes(t)).length;
    if (hits && (!best || hits > best.hits)) best = { where, text, low, hits };
  }
  if (!best) return null;
  const first = Math.min(...terms.map(t => best.low.indexOf(t)).filter(i => i >= 0));
  const from = Math.max(0, first - 60);
  let snippet = best.text.slice(from, from + SNIPPET).replace(/\s+/g, ' ');
  const lead = from > 0 ? '…' : '';
  snippet = lead + snippet + (from + SNIPPET < best.text.length ? '…' : '');
  const low = snippet.toLowerCase();
  const marks = [];
  for (const t of terms) for (let i = low.indexOf(t); i >= 0; i = low.indexOf(t, i + t.length)) marks.push([i, i + t.length]);
  marks.sort((a, b) => a[0] - b[0]);
  return { where: best.where === 'claude' ? 'Claude' : best.where, snippet, marks };
}

class SearchIndex {
  constructor({ roots, cacheFile, now }) {
    this.roots = roots;
    this.cacheFile = cacheFile;
    this.now = now;
    this.byFile = new Map();
    this.progress = { done: 0, total: 0 };
    this.running = null;
    this.slowRoots = new Map(); // root -> { at, files }, for folders across the WSL boundary
    this.saveTimer = null;
    try {
      const saved = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
      if (saved.format === FORMAT) for (const s of saved.sessions) this.byFile.set(s.file, s);
    } catch { /* first start, or an old format: built from scratch */ }
  }

  // Every transcript with its size and time: [{ file, size, mtime }]. A folder across the WSL
  // boundary (/mnt/...) is slow to list, so it is looked at again only every SLOW_ROOT_MS.
  async files() {
    const out = [];
    for (const root of this.roots()) {
      const slow = root.startsWith('/mnt/');
      const kept = this.slowRoots.get(root);
      if (slow && kept && performance.now() - kept.at < SLOW_ROOT_MS) { out.push(...kept.files); continue; }
      const found = [];
      let dirs = [];
      try { dirs = (await fsp.readdir(root, { withFileTypes: true })).filter(d => d.isDirectory()); } catch { continue; }
      for (const d of dirs) {
        let names = [];
        try { names = await fsp.readdir(path.join(root, d.name)); } catch { continue; }
        // Only <project>/<id>.jsonl: subagents live a level down, in <id>/subagents/.
        const jsonl = names.filter(n => n.endsWith('.jsonl')).map(n => path.join(root, d.name, n));
        const stats = await Promise.all(jsonl.map(f => fsp.stat(f).then(st => ({ file: f, size: st.size, mtime: st.mtimeMs }), () => null)));
        found.push(...stats.filter(Boolean));
      }
      if (slow) this.slowRoots.set(root, { at: performance.now(), files: found });
      out.push(...found);
    }
    return out;
  }

  // Reads whatever changed since the last update. Calls made while one runs share it.
  update() {
    if (!this.running) this.running = this.build().finally(() => { this.running = null; });
    return this.running;
  }

  async build() {
    const files = await this.files();
    const present = new Set(files.map(x => x.file));
    let changed = 0;
    for (const f of [...this.byFile.keys()]) if (!present.has(f)) { this.byFile.delete(f); changed++; }
    const todo = [];
    for (const { file: f, size, mtime } of files) {
      const s = this.byFile.get(f);
      if (!s || size !== s.offset || mtime !== s.mtime) todo.push([f, { size, mtimeMs: mtime }]);
    }
    this.progress = { done: 0, total: todo.length };
    let slice = performance.now();
    for (const [f, st] of todo) {
      let s = this.byFile.get(f);
      if (!s || st.size < s.offset) s = fresh(f); // new, or rewritten
      try {
        const fh = await fsp.open(f, 'r');
        try {
          const CHUNK = 4 << 20;
          while (s.offset < st.size) {
            const buf = Buffer.alloc(Math.min(CHUNK, st.size - s.offset));
            const { bytesRead } = await fh.read(buf, 0, buf.length, s.offset);
            if (!bytesRead) break;
            const text = s.tail + buf.toString('utf8', 0, bytesRead);
            const cut = text.lastIndexOf('\n');
            const lines = cut >= 0 ? text.slice(0, cut).split('\n') : [];
            s.tail = cut >= 0 ? text.slice(cut + 1) : text;
            s.offset += bytesRead;
            for (const line of lines) {
              scan(s, line);
              if (performance.now() - slice > SLICE_MS) { await new Promise(r => setImmediate(r)); slice = performance.now(); }
            }
          }
        } finally { await fh.close(); }
      } catch { continue; }
      s.mtime = st.mtimeMs;
      delete s.low; // the lowercased copy is rebuilt on the next search
      this.byFile.set(f, s);
      changed++;
      this.progress.done += 1;
    }
    if (!changed) return;
    // Saving the whole index takes ~100 ms: at once after a big build, else at most every SAVE_MS.
    if (changed > 20 || !fs.existsSync(this.cacheFile)) this.save();
    else if (!this.saveTimer) { this.saveTimer = setTimeout(() => this.save(), SAVE_MS); this.saveTimer.unref(); }
  }

  // Writes any unsaved change now (the panel stopping).
  flush() { if (this.saveTimer) this.save(); }

  save() {
    if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = null; }
    try {
      fs.mkdirSync(path.dirname(this.cacheFile), { recursive: true });
      const sessions = [...this.byFile.values()].map(({ low, titleText, allReplies, ...s }) => s);
      fs.writeFileSync(this.cacheFile + '.tmp', JSON.stringify({ format: FORMAT, sessions }));
      fs.renameSync(this.cacheFile + '.tmp', this.cacheFile);
    } catch { /* kept in memory; rebuilt next start */ }
  }

  // The sessions worth searching: one per id (the longest copy across config folders), a fork shown
  // as the copy that went furthest, no headless runs or throwaway folders.
  sessions() {
    const byId = new Map();
    for (const s of this.byFile.values()) {
      if (!s.turns || HEADLESS.has(s.entry) || THROWAWAY.test(s.cwd)) continue;
      const prev = byId.get(s.id);
      if (!prev || s.turns > prev.turns) byId.set(s.id, s);
    }
    const byFirst = new Map();
    const out = [];
    for (const s of byId.values()) {
      if (!s.firstUuid) { out.push(s); continue; }
      const prev = byFirst.get(s.firstUuid);
      const last = x => x.end || x.mtime;
      if (!prev || last(s) > last(prev) || (last(s) === last(prev) && s.turns > prev.turns)) byFirst.set(s.firstUuid, s);
    }
    return out.concat([...byFirst.values()]);
  }

  // Ranked results for a query. `shows(cwd)` limits them to some folders (this window).
  search(query, { shows = () => true, limit = 30 } = {}) {
    const terms = termsOf(query);
    if (!terms.length) return [];
    const now = this.now();
    const scored = [];
    for (const s of this.sessions()) {
      if (!shows(s.cwd)) continue;
      if (!s.low) {
        s.titleText = s.title || s.ai || '';
        s.allReplies = s.reply ? [...s.replies, s.reply] : s.replies;
        s.low = {
          title: s.titleText.toLowerCase(), you: s.prompts.join('\n').toLowerCase(),
          file: Object.keys(s.files).join('\n').toLowerCase(), claude: s.allReplies.join('\n').toLowerCase(),
        };
      }
      let score = 0, matched = 0;
      for (const t of terms) {
        let here = 0;
        for (const [field, [w, cap]] of Object.entries(WEIGHT)) here += w * Math.min(count(s.low[field], t), cap);
        if (here) { matched += 1; score += here * (t.includes(' ') ? 1.5 : 1); }
      }
      if (!score) continue;
      score *= (matched / terms.length) ** 2;                         // every word beats one word often
      const days = Math.max(0, now - (s.end || s.mtime)) / 86400e3;
      score *= 1 + 0.5 * Math.exp(-days / 14);                       // recent first, when close
      scored.push({ s, score });
    }
    scored.sort((a, b) => b.score - a.score || (b.s.end || b.s.mtime) - (a.s.end || a.s.mtime));
    return scored.slice(0, limit).map(({ s, score }) => ({
      id: s.id, title: s.titleText || s.prompts[0] && s.prompts[0].slice(0, 80) || s.id.slice(0, 8),
      cwd: s.cwd, repo: path.basename(s.cwd || '') || '?', end: s.end || s.mtime, turns: s.turns,
      score: Math.round(score * 10) / 10, ...snippetOf(s, terms),
    }));
  }

  // The most recently active sessions, for Ask Claude when few match the words.
  recent(limit, shows = () => true) {
    return this.sessions().filter(s => shows(s.cwd)).sort((a, b) => (b.end || b.mtime) - (a.end || a.mtime)).slice(0, limit)
      .map(s => ({ id: s.id, title: s.title || s.ai || (s.prompts[0] || '').slice(0, 80) || s.id.slice(0, 8), cwd: s.cwd, repo: path.basename(s.cwd || '') || '?', end: s.end || s.mtime, turns: s.turns }));
  }

  // What Ask Claude reads for one result: its title, first prompt, and the passages that matched.
  excerpt(id, terms, budget = 1500) {
    const s = this.sessions().find(x => x.id === id);
    if (!s) return '';
    const parts = [`First message: ${(s.prompts[0] || '').slice(0, 300)}`];
    // The passages holding the most of the words, each cut around where they cluster.
    const units = [];
    const consider = (who, text) => {
      const low = text.toLowerCase();
      let best = null;
      for (let at = 0; at < low.length; at += 300) {
        const win = low.slice(Math.max(0, at - 300), at + 600);
        const hits = terms.filter(t => win.includes(t)).length;
        if (hits && (!best || hits > best.hits)) best = { hits, from: Math.max(0, at - 300) };
      }
      if (best) units.push({ who, hits: best.hits, piece: text.slice(best.from, best.from + 600).replace(/\s+/g, ' ') });
    };
    for (const t of s.prompts) consider('You', t);
    for (const t of (s.reply ? [...s.replies, s.reply] : s.replies)) consider('Claude', t);
    units.sort((a, b) => b.hits - a.hits);
    let left = budget;
    for (const u of units) {
      if (left <= 0) break;
      parts.push(`${u.who}: …${u.piece}…`);
      left -= u.piece.length;
    }
    return parts.join('\n');
  }
}

// ---- Ask Claude -----------------------------------------------------------------------------

function askPrompt(query, results, index) {
  const terms = termsOf(query);
  const blocks = results.map((r, i) =>
    `[${i + 1}] "${r.title}" (${r.repo}, last active ${new Date(r.end).toISOString().slice(0, 10)})\n${index.excerpt(r.id, terms)}`);
  return [
    'You help someone find something in their own past Claude Code sessions.',
    `Their question: ${query}`,
    '',
    'Excerpts from the sessions that best match it, numbered:',
    '',
    blocks.join('\n\n'),
    '',
    'Answer from these excerpts only. Reply with JSON and nothing else:',
    '{"answer": "<the answer in at most three short sentences, plain words>", "sources": [{"session": <number>, "quote": "<the exact words from that excerpt that show it, under 200 characters>"}]}',
    'If the excerpts do not answer it, reply {"answer": null, "sources": []}. Never guess.',
  ].join('\n');
}

// Claude's reply into { state, text, sources }, keeping only sources that are real results.
function readAnswer(text, results) {
  let body;
  try {
    const m = String(text).match(/\{[\s\S]*\}/);
    body = JSON.parse(m ? m[0] : text);
  } catch { return { state: 'error', text: 'Claude answered in a form the panel could not read.', sources: [] }; }
  if (!body || !body.answer) return { state: 'none', text: '', sources: [] };
  const sources = (Array.isArray(body.sources) ? body.sources : [])
    .map(x => ({ r: results[Number(x && x.session) - 1], quote: String((x && x.quote) || '').slice(0, 300) }))
    .filter(x => x.r);
  // One entry per session, its quotes together.
  const byId = new Map();
  for (const { r, quote } of sources) {
    const e = byId.get(r.id) || { id: r.id, title: r.title, repo: r.repo, cwd: r.cwd, quotes: [] };
    if (quote) e.quotes.push(quote);
    byId.set(r.id, e);
  }
  return { state: 'done', text: String(body.answer), sources: [...byId.values()].map(({ quotes, ...e }) => ({ ...e, quote: quotes.join(' … ') })) };
}

module.exports = { SearchIndex, askPrompt, readAnswer, termsOf };
