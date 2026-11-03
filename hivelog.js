// The session-hive mod's log (~/.claude/session-hive/log.ndjson), as the panel needs it:
// - whom a session reported to since a given time, counting only the Desk (by name, or the session
//   holding the desk role) and the session that started it (children.json). A ready session that
//   reported there is answered there, so the panel shows it apart from replies waiting for you.
// - the role a session took (area and role, like runner/builder), for its automatic dot color.
// The log is read once, then only what was added.
//
//   const hive = new HiveLog(hiveDir)
//   hive.reportedTo(sessionId, sinceMs) -> the Desk or parent it reported to at or after sinceMs, or null
//   hive.roleOf(sessionId) -> { area, role } it last took, or null
'use strict';
const fs = require('fs');
const path = require('path');

const KEEP = 20; // messages remembered per session: only the latest turn's matter

class HiveLog {
  constructor(dir) {
    this.dir = dir;
    this.reset();
    this.parents = new Map(); // sub-session name -> the session that started it
    this.kidsStamp = null;
  }
  reset() {
    this.offset = 0;
    this.tail = '';
    this.sent = new Map();  // session id -> [{ at, to, from }], oldest first
    this.desks = new Map(); // workspace + area -> who holds the desk role there
    this.roles = new Map(); // session id -> { area, role } it last took
  }

  refresh() {
    const file = path.join(this.dir, 'log.ndjson');
    let size = 0;
    try { size = fs.statSync(file).size; } catch { /* no hive yet */ }
    if (size < this.offset) this.reset(); // rewritten
    if (size > this.offset) {
      let fd;
      try {
        fd = fs.openSync(file, 'r');
        const buf = Buffer.alloc(size - this.offset);
        fs.readSync(fd, buf, 0, buf.length, this.offset);
        const text = this.tail + buf.toString('utf8');
        const cut = text.lastIndexOf('\n');
        if (cut >= 0) for (const line of text.slice(0, cut).split('\n')) this.take(line);
        this.tail = cut < 0 ? text : text.slice(cut + 1); // a line still being written
        this.offset = size;
      } catch { /* try again next look */ } finally { if (fd !== undefined) fs.closeSync(fd); }
    }
    const kids = path.join(this.dir, 'children.json');
    let stamp = null;
    try { const st = fs.statSync(kids); stamp = st.mtimeMs + ':' + st.size; } catch { /* none */ }
    if (stamp !== this.kidsStamp) {
      this.kidsStamp = stamp;
      this.parents = new Map();
      try { for (const k of JSON.parse(fs.readFileSync(kids, 'utf8'))) if (k && k.name && k.parent) this.parents.set(k.name, k.parent); } catch { /* none */ }
    }
  }

  take(line) {
    if (line.indexOf('"out"') < 0 && line.indexOf('"role"') < 0) return;
    let r;
    try { r = JSON.parse(line); } catch { return; }
    if (r.dir === 'out' && r.fromId && r.to) {
      const list = this.sent.get(r.fromId) || [];
      list.push({ at: (r.at || 0) * 1000, to: String(r.to), from: String(r.from || '') });
      if (list.length > KEEP) list.shift();
      this.sent.set(r.fromId, list);
    } else if (r.dir === 'role' && r.from) {
      if (r.fromId) this.roles.set(r.fromId, { area: String(r.area || ''), role: String(r.role || '') });
      const key = (r.workspace || '') + '\0' + (r.area || '');
      if (r.role === 'desk') this.desks.set(key, String(r.from));
      else if (this.desks.get(key) === r.from) this.desks.delete(key);
    }
  }

  reportedTo(sessionId, since) {
    if (!since) return null; // no turn start known: can't tell which reports are this turn's
    this.refresh();
    const list = this.sent.get(sessionId);
    if (!list) return null;
    const desks = new Set(this.desks.values());
    for (let i = list.length - 1; i >= 0 && list[i].at >= since; i--) {
      const m = list[i];
      if (/^desk$/i.test(m.to) || desks.has(m.to) || this.parents.get(m.from) === m.to) return m.to;
    }
    return null;
  }

  roleOf(sessionId) {
    this.refresh();
    return this.roles.get(sessionId) || null;
  }
}

module.exports = { HiveLog };
