// The session list: which Claude sessions the panel lists, and how each one stands (running,
// ready, needs you, closed, removed, filed in a folder, not running since a restart).
//
//   const list = new SessionList({ store, transcripts, scope, now, removedClearMs, live, ended }, carried)
//   list.observe(registry, trail) -> sounds to play ('ready' | 'waiting')
//   list.act({ type, id, folder, name, to })   ack | mark | dismiss | restore | move | addFolder | renameFolder | deleteFolder
//   list.rows(showAll) -> the rows to show, in order
//   list.handOver() -> what a Reload Panel passes to the next copy as `carried`
//
// It touches no VS Code and no files itself. `store` is VS Code's globalState (get/update, shared by
// every window); `transcripts` reads Claude Code's transcripts (transcript.js); `scope` says which
// sessions are this window's (window.js); `now` is the clock. Each saved concern has one owner below:
// Removed, Saved (the list that survives a restart), Folders, and the auto-closed record.
'use strict';
const path = require('path');

const KEYS = {
  removed: 'claudeSessions.dismissed',
  autoClosed: 'claudeSessions.autoClosed',
  saved: 'claudeSessions.open',
  folders: 'claudeSessions.folders',
};
// A session of this window's folder that stops while VS Code keeps running was ended on purpose and
// leaves the saved list after this long; when VS Code itself closes, the panel is gone well before.
const ENDED_GRACE_MS = 30e3;
// Without the session-trail mod nothing says when you left a closed session: move it after this.
const NO_TRAIL_CLOSE_MS = 2 * 60e3;
// The one-time rebuild after upgrading to 0.6.0 takes stopped sessions active within this window.
const UPGRADE_WINDOW_MS = 12 * 3600e3;
// A filed session's saved copy is rewritten when its title or folder changes, or it is this stale.
const FILED_COPY_STALE_MS = 10 * 60e3;

const byId = (a, b) => (a.id < b.id ? -1 : 1);

// ---- Removed: sessions you took off the list, and when -------------------------------------
// It does not outlive VS Code: on a restart only removals of sessions still running are kept.
// Saved as [id, removedAt]; versions before 0.7.0 saved bare ids, counted as removed now.
class Removed {
  constructor(store, { liveIds, carried, now }) {
    this.store = store;
    const saved = store.get(KEYS.removed, []);
    this.at = new Map();
    for (const x of saved) {
      const [id, at] = Array.isArray(x) ? x : [x, now];
      if (carried || liveIds.has(id)) this.at.set(id, at || now);
    }
    if (this.at.size !== saved.length || saved.some(x => !Array.isArray(x))) this.save();
  }
  has(id) { return this.at.has(id); }
  add(id, now) { this.at.set(id, now); this.save(); }
  delete(id) { if (!this.at.delete(id)) return false; this.save(); return true; }
  // Gone from the Removed list; still hidden until new activity brings it back.
  expired(id, now, clearMs) { return now - (this.at.get(id) || now) > clearMs; }
  save() { void this.store.update(KEYS.removed, [...this.at]); }
}

// ---- Saved: the list that comes back after a restart, as "not running" rows -----------------
// `known` is every session's last-seen copy; `listed` is what the saved list holds. A stopped session
// of this window stays listed until removed, closed, or ended while VS Code ran; another window's
// stopped sessions follow that window's saved copy.
class Saved {
  constructor(store, scope, carried, upgrade) {
    this.store = store;
    this.scope = scope;
    this.known = new Map(carried ? carried.known : []);   // id -> { id, cwd, name, since, startedAt }
    this.ranHere = new Set(carried ? carried.liveThisRun : []); // seen running since VS Code started
    this.goneAt = new Map(carried ? carried.goneAt : []);  // id -> when this window's session was first seen stopped
    this.listed = new Map();
    let saved = store.get(KEYS.saved);
    if (!Array.isArray(saved)) saved = upgrade();
    for (const e of saved) if (e && e.id) { this.known.set(e.id, e); this.listed.set(e.id, e); }
  }
  entry(id) { return this.known.get(id); }
  // Stopped while this window kept running: ended on purpose, so not shown as "not running".
  endedHere(id, cwd, liveIds) { return this.ranHere.has(id) && !liveIds.has(id) && this.scope.owns(cwd); }

  // Rebuild after a look at the registry. `live`: [{ entry, keep }] for each running session.
  rebuild({ live, liveIds, isRemoved, isClosed, now }) {
    const stored = new Map((this.store.get(KEYS.saved) || []).filter(e => e && e.id).map(e => [e.id, e]));
    const next = new Map();
    for (const { entry, keep } of live) {
      this.known.set(entry.id, entry);
      this.ranHere.add(entry.id);
      this.goneAt.delete(entry.id);
      if (keep) next.set(entry.id, entry);
    }
    const carry = (id, e) => {
      if (liveIds.has(id) || isRemoved(id)) return;
      if (this.endedHere(id, e.cwd, liveIds)) {
        if (!this.goneAt.has(id)) this.goneAt.set(id, now);
        if (now - this.goneAt.get(id) > ENDED_GRACE_MS) return;
      }
      if (isClosed(id, e.cwd)) return;
      if (!this.ranHere.has(id)) this.known.set(id, e);
      next.set(id, e);
    };
    for (const [id, e] of this.listed) if (this.scope.owns(e.cwd)) carry(id, e);
    for (const [id, e] of stored) if (!this.scope.owns(e.cwd)) carry(id, e);
    this.listed = next;
    const text = m => JSON.stringify([...m.values()].sort(byId));
    if (text(next) !== text(stored)) this.save();
  }
  // Put a stopped session (back) on the saved list.
  list(id, liveIds) {
    const e = this.known.get(id);
    if (e && !liveIds.has(id)) { this.listed.set(id, e); this.save(); }
  }
  // A stopped session coming out of a folder: listed even if it ended while VS Code ran, which
  // would otherwise drop it.
  adopt(id, entry) {
    const e = this.known.get(id) || entry;
    this.known.set(id, e);
    this.ranHere.delete(id);
    this.goneAt.delete(id);
    this.listed.set(id, e);
    this.save();
  }
  drop(id) { if (this.listed.delete(id)) this.save(); }
  save() { void this.store.update(KEYS.saved, [...this.listed.values()].sort(byId)); }
  handOver() { return { known: [...this.known], liveThisRun: [...this.ranHere], goneAt: [...this.goneAt] }; }
}

// ---- Folders: your folders and the sessions filed in them ------------------------------------
// Shared by every window, so read fresh before each use. Each filed session keeps a copy of its row,
// so it shows even when no window lists it.
class Folders {
  constructor(store) { this.store = store; this.load(); }
  load() {
    const f = this.store.get(KEYS.folders) || {};
    this.names = (Array.isArray(f.names) ? f.names : []).filter(n => typeof n === 'string' && n);
    const filed = (Array.isArray(f.filed) ? f.filed : []).filter(x => Array.isArray(x) && x[1] && x[1].entry && this.names.includes(x[1].folder));
    this.filed = new Map(filed); // id -> { folder, entry }
  }
  save() { void this.store.update(KEYS.folders, { names: this.names, filed: [...this.filed] }); }
  of(id) { const f = this.filed.get(id); return f ? f.folder : ''; }
  count(name) { this.load(); return [...this.filed.values()].filter(f => f.folder === name).length; }
  add(name) { this.load(); if (this.names.includes(name)) return; this.names.push(name); this.save(); }
  rename(from, to) {
    this.load();
    const i = this.names.indexOf(from);
    if (i < 0 || this.names.includes(to)) return;
    this.names[i] = to;
    for (const f of this.filed.values()) if (f.folder === from) f.folder = to;
    this.save();
  }
  // Returns the sessions it held, as [id, entry].
  remove(name) {
    this.load();
    this.names = this.names.filter(n => n !== name);
    const out = [];
    for (const [id, f] of [...this.filed]) if (f.folder === name) { this.filed.delete(id); out.push([id, f.entry]); }
    this.save();
    return out;
  }
  file(id, folder, entry) {
    this.load();
    if (!entry || !this.names.includes(folder)) return;
    this.filed.set(id, { folder, entry });
    this.save();
  }
  // Returns the session's copy if it was filed.
  unfile(id) {
    this.load();
    const f = this.filed.get(id);
    if (!f) return null;
    this.filed.delete(id);
    this.save();
    return f.entry;
  }
  // Keep running filed sessions' copies current, and let go of filed sessions that closed.
  track(live, liveIds, isClosed) {
    let changed = false;
    for (const e of live) {
      const f = this.filed.get(e.id);
      if (!f) continue;
      if (e.name !== f.entry.name || e.cwd !== f.entry.cwd || e.since - f.entry.since > FILED_COPY_STALE_MS) { f.entry = e; changed = true; }
    }
    for (const [id, f] of [...this.filed]) {
      if (liveIds.has(id) || !isClosed(id, f.entry.cwd)) continue;
      this.filed.delete(id); changed = true;
    }
    if (changed) this.save();
  }
}

// ---- the list ---------------------------------------------------------------------------------

class SessionList {
  constructor({ store, transcripts, scope, now, removedClearMs, live, ended }, carried) {
    this.store = store;
    this.transcripts = transcripts;
    this.scope = scope;
    this.now = now;
    this.removedClearMs = removedClearMs;
    this.firstLoad = !carried;
    this.prevStatus = new Map(carried ? carried.prevStatus : []); // id -> last seen status
    this.attention = new Map(carried ? carried.attention : []);   // id -> 'ready' | 'waiting'
    this.autoClosed = new Set(store.get(KEYS.autoClosed, []));      // "<id>:<closedAt>" already moved once
    this.regs = [];
    this.liveIds = new Set(live.map(r => r.sessionId));
    const at = now();
    // Every removal on record, before Removed trims the ones a restart lets go.
    const everRemoved = new Set(store.get(KEYS.removed, []).map(x => (Array.isArray(x) ? x[0] : x)));
    this.removed = new Removed(store, { liveIds: this.liveIds, carried, now: at });
    // First run after an upgrade: rebuild the saved list from the records stopped sessions leave in
    // the registry, the ones the panel was showing (recent, not removed, not closed).
    const upgrade = () => {
      const old = everRemoved;
      return ended().map(r => this.entryOf(r, at))
        .filter(e => !old.has(e.id) && at - e.since <= UPGRADE_WINDOW_MS && !this.closedAt(e.id, e.cwd));
    };
    this.saved = new Saved(store, scope, carried, upgrade);
    this.folders = new Folders(store);
  }

  get folderNames() { this.folders.load(); return this.folders.names; }
  filedIn(name) { return this.folders.count(name); }
  running() { return this.regs; }

  handOver() {
    return { prevStatus: [...this.prevStatus], attention: [...this.attention], ...this.saved.handOver() };
  }

  entryOf(r, now) {
    const since = r.statusUpdatedAt || r.updatedAt || r.startedAt || now;
    return { id: r.sessionId, cwd: r.cwd || '', name: this.transcripts.displayName(r), since, startedAt: r.startedAt || since };
  }
  closedAt(id, cwd) { return this.transcripts.readTranscript({ sessionId: id, cwd }).closed; }

  // A look at the registry (running sessions) and the trail (what VS Code shows).
  observe(regs, trail) {
    const now = this.now();
    const sounds = [];
    this.folders.load();
    // The most recent time each window's folder showed some session: a switch made by the panel's
    // own click does not always record the old session as hidden, but it always records the new one.
    const lastShownIn = cwd => {
      let latest = 0;
      for (const s of regs) {
        const tr = trail.get(s.sessionId);
        if (tr && this.scope.sameWindow(s.cwd, cwd) && tr.shownAt > latest) latest = tr.shownAt;
      }
      return latest;
    };
    const seen = new Set();
    for (const r of regs) {
      const id = r.sessionId;
      seen.add(id);
      const status = r.status || 'idle';
      const prev = this.prevStatus.get(id);
      const t = this.transcripts.readTranscript(r);
      if (status === 'idle' && t.closed) {
        // anything-left said "Good to close": done, not waiting on you.
        this.attention.delete(id);
        this.prevStatus.set(id, status);
        const key = `${id}:${t.closedAt}`;
        if (!this.autoClosed.has(key)) {
          const shown = trail.get(id);
          // Left it: VS Code hid it after the close, or another session in its window has been
          // shown since both the close and its own last showing.
          const leftIt = shown
            ? (!shown.shown && shown.hiddenAt >= t.closedAt) || lastShownIn(r.cwd) > Math.max(t.closedAt, shown.shownAt)
            : now - t.closedAt > NO_TRAIL_CLOSE_MS;
          if (leftIt) { this.dismiss(id); this.markAutoClosed(key); }
        }
        continue;
      }
      if (status === 'busy') {
        this.attention.delete(id);
        if (prev !== undefined && prev !== 'busy') this.restore(id);
      } else if (status === 'waiting') {
        if (this.attention.get(id) !== 'waiting') {
          this.attention.set(id, 'waiting');
          this.restore(id);
          if (!this.firstLoad) sounds.push('waiting');
        }
      } else if (status === 'idle' && prev === 'busy') {
        this.attention.set(id, 'ready');
        this.restore(id);
        if (!this.folders.of(id)) sounds.push('ready'); // a filed session's ready is a quiet dot on its tab
      }
      this.prevStatus.set(id, status);
    }
    for (const id of [...this.prevStatus.keys()]) {
      if (!seen.has(id)) { this.prevStatus.delete(id); this.attention.delete(id); }
    }
    this.firstLoad = false;
    this.regs = regs;
    this.liveIds = new Set(regs.map(r => r.sessionId));
    const isClosed = (id, cwd) => this.closedAt(id, cwd);
    const live = regs.map(r => ({
      entry: this.entryOf(r, now),
      keep: !this.removed.has(r.sessionId) && !((r.status || 'idle') === 'idle' && this.transcripts.readTranscript(r).closed),
    }));
    this.saved.rebuild({ live, liveIds: this.liveIds, isRemoved: id => this.removed.has(id), isClosed, now });
    this.folders.track(live.map(x => x.entry), this.liveIds, isClosed);
    return sounds;
  }

  markAutoClosed(key) {
    this.autoClosed.add(key);
    const keep = [...this.autoClosed].slice(-300);
    this.autoClosed = new Set(keep);
    void this.store.update(KEYS.autoClosed, keep);
  }

  // Removing a session also takes it out of its folder; brought back, it returns to Main.
  dismiss(id) {
    this.removed.add(id, this.now());
    this.attention.delete(id);
    this.saved.drop(id);
    this.folders.unfile(id);
  }
  restore(id) { if (this.removed.delete(id)) this.saved.list(id, this.liveIds); }

  // A stopped session coming out of a folder joins the saved list (see Saved.adopt).
  toMain(id, entry) {
    if (this.liveIds.has(id) || this.removed.has(id)) return;
    this.saved.adopt(id, entry);
  }

  act(a) {
    switch (a.type) {
      case 'ack': this.attention.delete(a.id); break;
      // The star: mark an idle running session green to come back to it, or clear that mark.
      case 'mark': {
        if (!this.liveIds.has(a.id)) break;
        const reg = this.regs.find(r => r.sessionId === a.id);
        if (reg && reg.status === 'busy') break; // running: it turns green by itself when the turn ends
        const now = this.attention.get(a.id);
        if (now === 'ready') this.attention.delete(a.id);
        else if (!now) this.attention.set(a.id, 'ready');
        break;
      }
      case 'dismiss': this.dismiss(a.id); break;
      case 'restore': this.restore(a.id); break;
      case 'move': {
        if (a.folder) {
          this.folders.load();
          const was = this.folders.filed.get(a.id);
          this.folders.file(a.id, a.folder, this.saved.entry(a.id) || (was && was.entry));
        } else {
          const entry = this.folders.unfile(a.id);
          if (entry) this.toMain(a.id, entry);
        }
        break;
      }
      case 'addFolder': this.folders.add(a.name); break;
      case 'renameFolder': this.folders.rename(a.name, a.to); break;
      case 'deleteFolder': for (const [id, entry] of this.folders.remove(a.name)) this.toMain(id, entry); break;
    }
  }

  offlineRow(e, dismissed) {
    return {
      id: e.id, pid: null, name: this.transcripts.displayName({ sessionId: e.id, cwd: e.cwd, name: e.name }), cwd: e.cwd,
      repo: path.basename(e.cwd) || '?', status: 'offline', attention: null, dismissed,
      waitingFor: '', since: e.since, startedAt: e.startedAt || e.since, closed: false, folder: this.folders.of(e.id),
    };
  }

  rows(showAll) {
    const now = this.now();
    const clearMs = this.removedClearMs();
    const shown = cwd => showAll || this.scope.shows(cwd);
    const rows = [];
    // Stopped sessions: on the saved list or in Removed.
    for (const e of this.saved.known.values()) {
      if (this.liveIds.has(e.id) || this.saved.endedHere(e.id, e.cwd, this.liveIds)) continue;
      const dismissed = this.removed.has(e.id);
      if (!dismissed && !this.saved.listed.has(e.id)) continue;
      if (dismissed && this.removed.expired(e.id, now, clearMs)) continue;
      if (!shown(e.cwd)) continue;
      rows.push(this.offlineRow(e, dismissed));
    }
    // Running sessions.
    for (const r of this.regs) {
      const id = r.sessionId;
      const status = r.status || 'idle';
      const attention = this.attention.get(id) || null;
      const dismissed = this.removed.has(id);
      if (!shown(r.cwd)) continue;
      const since = r.statusUpdatedAt || r.updatedAt || r.startedAt || now;
      if (dismissed && this.removed.expired(id, now, clearMs)) continue;
      const t = this.transcripts.readTranscript(r);
      rows.push({
        id, pid: r.pid, name: this.transcripts.displayName(r), cwd: r.cwd || '',
        repo: path.basename(r.cwd || '') || '?', status, attention, dismissed,
        waitingFor: r.waitingFor || '', since, startedAt: r.startedAt || since,
        closed: status === 'idle' && t.closed, folder: this.folders.of(id),
        cost: attention === 'ready' ? this.transcripts.replyCost(t.reply) : null,
      });
    }
    // Filed sessions no list above holds (ended here, or another window's): shown from the folder's copy.
    const listed = new Set(rows.map(x => x.id));
    for (const [id, f] of this.folders.filed) {
      if (listed.has(id) || this.liveIds.has(id) || this.removed.has(id)) continue;
      if (!shown(f.entry.cwd)) continue;
      rows.push(this.offlineRow(f.entry, false));
    }
    const rank = x => (x.attention === 'waiting' ? 0 : x.attention === 'ready' ? 1 : x.status === 'busy' ? 2 : x.closed ? 4 : 3);
    // Ready sessions: the one that takes least of your time first.
    const minutes = x => (x.cost ? x.cost.minutes : 0);
    rows.sort((a, b) => rank(a) - rank(b) || minutes(a) - minutes(b) || b.since - a.since);
    return rows;
  }
}

module.exports = { SessionList };
