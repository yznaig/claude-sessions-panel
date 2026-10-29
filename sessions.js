// The session list: which Claude sessions the panel lists, and how each one stands (running,
// ready, needs you, closed, removed, filed in a folder, asleep, not running since a restart).
//
//   const list = new SessionList({ store, transcripts, procs, scope, now, removedClearMs, autoCloseMs, live, ended }, carried)
//   list.observe(registry, trail) -> sounds to play ('ready' | 'waiting'); also stops sessions quiet for autoCloseMs
//   list.act({ type, id, folder, name, to, stop })   ack | mark | keep | dismiss | restore | move | addFolder | renameFolder | deleteFolder
//   list.stopRisk(id) -> 'working' | 'waiting' | null: what removing it with stop would cut off
//   list.rows(showAll) -> the rows to show, in order
//   list.handOver() -> what a Reload Panel passes to the next copy as `carried`
//
// It touches no VS Code and no files itself. `store` is VS Code's globalState (get/update, shared by
// every window); `transcripts` reads Claude Code's transcripts (transcript.js); `procs` checks and
// stops session processes (procs.js); `scope` says which sessions are this window's (window.js); `now`
// is the clock. Each saved concern has one owner below: Removed, Saved (the list that survives a
// restart), Folders, Asleep (sessions the panel stopped), Kept (never auto-close), and the
// auto-closed record.
//
// Stopping only ends a session's process, never its place: the panel controls what is listed,
// stopping controls what is running. An asleep session wakes when clicked (Claude Code resumes it).
'use strict';
const path = require('path');

const KEYS = {
  removed: 'claudeSessions.dismissed',
  autoClosed: 'claudeSessions.autoClosed',
  saved: 'claudeSessions.open',
  folders: 'claudeSessions.folders',
  asleep: 'claudeSessions.asleep',
  kept: 'claudeSessions.keepRunning',
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
// A stopped session's process normally goes within seconds; one still there after this is taken as
// not stopped, and left alone for STUCK_RETRY_MS before it is tried again.
const STOP_GRACE_MS = 60e3;
const STUCK_RETRY_MS = 3600e3;
// An asleep record no list holds is let go after this: another window may not have seen the list yet.
const UNHELD_ASLEEP_MS = 24 * 3600e3;
// Only sessions of Claude Code's VS Code extension are stopped: they wake by a click. A terminal
// session would not come back where it was.
const STOPPABLE_ENTRYPOINT = 'claude-vscode';

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
  constructor(store, scope, carried, upgrade, isAsleep) {
    this.store = store;
    this.scope = scope;
    this.isAsleep = isAsleep;
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
  // Not when the panel put it to sleep: that keeps its place.
  endedHere(id, cwd, liveIds) { return this.ranHere.has(id) && !liveIds.has(id) && this.scope.owns(cwd) && !this.isAsleep(id); }

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

// ---- Asleep: sessions whose process the panel stopped ----------------------------------------
// Saved as [id, { pid, at, ready }]: the process it stopped, when, and whether a reply was waiting
// to be read (it stays green while asleep). Shared by every window, so read fresh before each use.
class Asleep {
  constructor(store) { this.store = store; this.load(); }
  load() {
    const s = this.store.get(KEYS.asleep, []);
    this.map = new Map((Array.isArray(s) ? s : []).filter(x => Array.isArray(x) && x[1] && x[1].pid));
  }
  get(id) { return this.map.get(id); }
  has(id) { return this.map.has(id); }
  add(id, rec) { this.load(); this.map.set(id, rec); this.save(); }
  clearReady(id) { this.load(); const a = this.map.get(id); if (a && a.ready) { a.ready = false; this.save(); } }
  // A window that saw the reply arrive marks it unread, whichever window did the stopping.
  markReady(id, pid) {
    if (!this.has(id)) return;
    this.load();
    const a = this.map.get(id);
    if (a && a.pid === pid && !a.ready) { a.ready = true; this.save(); }
  }
  // Let go of sessions running again (a new process), stops that did not take, and sessions no
  // list holds any more (`held`). Returns the pids that did not stop.
  tidy(regs, now, held) {
    this.load();
    const live = new Map(regs.map(r => [r.sessionId, r]));
    const stuck = [];
    let changed = false;
    for (const [id, a] of [...this.map]) {
      const r = live.get(id);
      let drop;
      if (!r) drop = !held(id) && now - a.at > UNHELD_ASLEEP_MS;
      else if (r.pid !== a.pid) drop = true;
      else if (now - a.at > STOP_GRACE_MS) { drop = true; stuck.push(r.pid); }
      if (drop) { this.map.delete(id); changed = true; }
    }
    if (changed) this.save();
    return stuck;
  }
  save() { void this.store.update(KEYS.asleep, [...this.map].slice(-500)); }
}

// ---- Kept: sessions marked "keep running", never auto-closed ----------------------------------
class Kept {
  constructor(store) { this.store = store; }
  ids() { return new Set(this.store.get(KEYS.kept, [])); }
  toggle(id) {
    const s = this.ids();
    if (!s.delete(id)) s.add(id);
    void this.store.update(KEYS.kept, [...s].slice(-300));
  }
}

// ---- the list ---------------------------------------------------------------------------------

class SessionList {
  constructor({ store, transcripts, procs, scope, now, removedClearMs, autoCloseMs, live, ended }, carried) {
    this.store = store;
    this.transcripts = transcripts;
    this.procs = procs;
    this.scope = scope;
    this.now = now;
    this.removedClearMs = removedClearMs;
    this.autoCloseMs = autoCloseMs;
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
    this.asleep = new Asleep(store);
    this.kept = new Kept(store);
    this.stuck = new Map(); // pid -> when a stop of it did not take
    this.saved = new Saved(store, scope, carried, upgrade, id => this.asleep.has(id));
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
    // handle: the registry's name for it (hire-17), which other sessions use to message it.
    return { id: r.sessionId, cwd: r.cwd || '', name: this.transcripts.displayName(r), handle: r.name || '', since, startedAt: r.startedAt || since };
  }
  closedAt(id, cwd) { return this.transcripts.readTranscript({ sessionId: id, cwd }).closed; }

  // A look at the registry (running sessions) and the trail (what VS Code shows).
  observe(regs, trail) {
    const now = this.now();
    const sounds = [];
    this.folders.load();
    this.asleep.load();
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
    for (const r of regs) if (this.attention.get(r.sessionId) === 'ready') this.asleep.markReady(r.sessionId, r.pid);
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
    for (const pid of this.asleep.tidy(regs, now, id => this.saved.listed.has(id) || !!this.folders.of(id) || this.removed.has(id))) this.stuck.set(pid, now);
    this.autoClose(trail, now);
    return sounds;
  }

  // ---- stopping ----
  stoppable(r) { return r.entrypoint === STOPPABLE_ENTRYPOINT && this.procs.isHere(r); }
  reg(id) { return this.regs.find(r => r.sessionId === id); }

  // Ends a session's process (procs.stop checks the pid is still that session's). It stays wherever
  // it is listed, as asleep.
  stop(r) {
    if (!r || !this.stoppable(r)) return false;
    const a = this.asleep.get(r.sessionId);
    if (a && a.pid === r.pid) return true; // already on its way out
    if (!this.procs.stop(r)) return false;
    this.asleep.add(r.sessionId, { pid: r.pid, at: this.now(), ready: this.attention.get(r.sessionId) === 'ready' });
    return true;
  }

  // A session's state for search results: its live status, asleep, or null when not running.
  statusOf(id) {
    const r = this.reg(id);
    if (r) return r.status || 'idle';
    return this.asleep.has(id) ? 'asleep' : null;
  }

  stopRisk(id) {
    const r = this.reg(id);
    if (!r || !this.stoppable(r)) return null;
    if ((r.status || 'idle') === 'busy') return 'working';
    if (r.status === 'waiting' || this.attention.get(id) === 'waiting') return 'waiting';
    return null;
  }

  // Stops sessions with nothing going on for autoCloseMs: not working, not waiting on you, not kept
  // running, not on screen, no background command, nothing written by them or a subagent, not shown
  // or hidden. Needs the session-trail mod, and leaves a process that ignored a stop for an hour.
  autoClose(trail, now) {
    const ms = this.autoCloseMs();
    // Without the session-trail mod nothing says which sessions are on screen.
    if (!(ms > 0) || !trail.size) return;
    const kept = this.kept.ids();
    for (const r of this.regs) {
      const id = r.sessionId;
      if ((r.status || 'idle') !== 'idle' || this.attention.get(id) === 'waiting') continue;
      if (kept.has(id) || this.asleep.has(id) || !this.stoppable(r)) continue;
      if (now - (this.stuck.get(r.pid) || -Infinity) < STUCK_RETRY_MS) continue;
      const t = trail.get(id);
      // On screen in some window: Claude Code would show an error banner in its place.
      if (t && t.shown) continue;
      const last = Math.max(r.statusUpdatedAt || 0, r.updatedAt || 0, r.startedAt || 0,
        this.transcripts.lastWrite(r), t ? Math.max(t.shownAt || 0, t.hiddenAt || 0) : 0);
      if (now - last < ms) continue;
      if (this.procs.hasBackgroundCommand(r.pid)) continue;
      this.stop(r);
    }
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
      case 'ack': this.attention.delete(a.id); this.asleep.clearReady(a.id); break;
      case 'keep': this.kept.toggle(a.id); break;
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
      // The X: off the list, and with `stop` its process ended too.
      case 'dismiss': this.dismiss(a.id); if (a.stop) this.stop(this.reg(a.id)); break;
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

  // A stopped session: asleep if the panel stopped it (green still if its reply is unread), else
  // not running.
  offlineRow(e, dismissed, kept) {
    const a = this.asleep.get(e.id);
    const attention = a && a.ready && !dismissed ? 'ready' : null;
    return {
      id: e.id, pid: null, name: this.transcripts.displayName({ sessionId: e.id, cwd: e.cwd, name: e.name }), cwd: e.cwd,
      repo: path.basename(e.cwd) || '?', status: a ? 'asleep' : 'offline', attention, dismissed, handle: e.handle || '',
      waitingFor: '', since: e.since, startedAt: e.startedAt || e.since, closed: false, folder: this.folders.of(e.id),
      keep: kept.has(e.id), stopping: false, canStop: !!a,
      cost: attention ? this.transcripts.replyCost(this.transcripts.readTranscript({ sessionId: e.id, cwd: e.cwd }).reply) : null,
    };
  }

  rows(showAll) {
    const now = this.now();
    const clearMs = this.removedClearMs();
    const shown = cwd => showAll || this.scope.shows(cwd);
    const kept = this.kept.ids();
    this.asleep.load();
    const rows = [];
    // Stopped sessions: on the saved list or in Removed.
    for (const e of this.saved.known.values()) {
      if (this.liveIds.has(e.id) || this.saved.endedHere(e.id, e.cwd, this.liveIds)) continue;
      const dismissed = this.removed.has(e.id);
      if (!dismissed && !this.saved.listed.has(e.id)) continue;
      if (dismissed && this.removed.expired(e.id, now, clearMs)) continue;
      if (!shown(e.cwd)) continue;
      rows.push(this.offlineRow(e, dismissed, kept));
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
        repo: path.basename(r.cwd || '') || '?', status, attention, dismissed, handle: r.name || '',
        waitingFor: r.waitingFor || '', since, startedAt: r.startedAt || since,
        closed: status === 'idle' && t.closed, folder: this.folders.of(id),
        cost: attention === 'ready' ? this.transcripts.replyCost(t.reply) : null,
        keep: kept.has(id), stopping: !!(this.asleep.get(id) && this.asleep.get(id).pid === r.pid), canStop: this.stoppable(r),
      });
    }
    // Filed sessions no list above holds (ended here, or another window's): shown from the folder's copy.
    const listed = new Set(rows.map(x => x.id));
    for (const [id, f] of this.folders.filed) {
      if (listed.has(id) || this.liveIds.has(id) || this.removed.has(id)) continue;
      if (!shown(f.entry.cwd)) continue;
      rows.push(this.offlineRow(f.entry, false, kept));
    }
    const rank = x => (x.attention === 'waiting' ? 0 : x.attention === 'ready' ? 1 : x.status === 'busy' ? 2 : x.closed ? 4 : 3);
    // Ready sessions: the one that takes least of your time first.
    const minutes = x => (x.cost ? x.cost.minutes : 0);
    rows.sort((a, b) => rank(a) - rank(b) || minutes(a) - minutes(b) || b.since - a.since);
    return rows;
  }
}

module.exports = { SessionList };
