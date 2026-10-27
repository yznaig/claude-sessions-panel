// What the Sessions panel shows, driven through the real code. Run: npm test
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Harness, lines: L, words } = require('./harness');

const eq = assert.equal, same = assert.deepEqual;
const OPEN_KEY = 'claudeSessions.open';
const DISMISSED_KEY = 'claudeSessions.dismissed';
const H = 3600e3;

// Each test gets its own harness; `step` moves the clock past the sound throttle and refreshes.
function withHarness(name, opts, fn) {
  if (typeof opts === 'function') { fn = opts; opts = {}; }
  test(name, async () => {
    const h = new Harness(opts);
    h.step = (ms = 2000) => { h.advance(ms); return h.refresh(); };
    try { await fn(h); } finally { await h.cleanup(); }
  });
}

// ---- live sessions: running, ready, needs you --------------------------------

withHarness('first load: no ready for idle sessions and no sound for one already waiting', h => {
  h.session('b', { status: 'busy' }); h.session('w', { status: 'waiting' }); h.session('i');
  h.start();
  eq(h.row('b').status, 'busy'); eq(h.row('b').attention, null);
  eq(h.row('w').attention, 'waiting');
  eq(h.row('i').attention, null);
  same(h.takeSounds(), []);
});

withHarness('a turn ending turns a session green with a sound; a click clears it', async h => {
  const a = h.session('a', { status: 'busy' });
  h.start();
  a.set('idle'); h.step();
  eq(h.row('a').attention, 'ready'); same(h.takeSounds(), ['ready']);
  await h.send({ type: 'focus', id: a.id });
  eq(h.row('a').attention, null);
  eq(h.executed.at(-1)[0], 'claude-vscode.editor.open'); eq(h.executed.at(-1)[1], a.id);
});

withHarness('needing you turns a session blue with a sound; running again clears it', h => {
  const a = h.session('a', { status: 'idle' });
  h.start();
  a.set('waiting', { waitingFor: 'Bash permission' }); h.step();
  eq(h.row('a').attention, 'waiting'); eq(h.row('a').waitingFor, 'Bash permission'); same(h.takeSounds(), ['waiting']);
  a.set('busy'); h.step();
  eq(h.row('a').attention, null); eq(h.row('a').status, 'busy');
});

withHarness('a session that appears already waiting after the first load sounds', h => {
  h.start();
  h.session('late', { status: 'waiting' }); h.step();
  same(h.takeSounds(), ['waiting']);
});

withHarness('titles: your title, else the generated one, else the registry name, else the id', h => {
  h.session('c', { transcript: [L.aiTitle('Generated'), L.customTitle('Mine')] });
  h.session('g', { transcript: [L.aiTitle('Generated')] });
  h.session('r', { regName: 'from-registry' });
  h.session('n', { regName: '' });
  h.start();
  eq(h.row('c').name, 'Mine'); eq(h.row('g').name, 'Generated'); eq(h.row('r').name, 'from-registry');
  eq(h.row('n').name, h.id('n').slice(0, 8));
  eq(h.row('c').repo, 'proj');
});

withHarness('this window shows its own sessions; All windows shows every one', h => {
  h.session('here'); h.session('there', { cwd: h.other });
  h.start();
  same(h.order(), ['here']);
  return h.send({ type: 'toggleAll' }).then(() => {
    same(h.order().sort(), ['here', 'there']); eq(h.state.showAll, true);
    h.restart(); eq(h.state.showAll, true);
  });
});

withHarness('a window with no folder shows every session', { noFolder: true }, h => {
  h.session('a'); h.session('b', { cwd: h.other });
  h.start();
  same(h.order().sort(), ['a', 'b']);
});

withHarness('order: needs you, ready (quickest first), running, idle, closed', h => {
  const long = h.session('long', { status: 'busy', transcript: [L.user('go'), L.text(words(900))] });
  const quick = h.session('quick', { status: 'busy', transcript: [L.user('go'), L.text(words(20))] });
  h.session('wait', { status: 'waiting' }); h.session('run', { status: 'busy' }); h.session('idle');
  h.session('done', { transcript: [L.user('wrap'), L.skill('anything-left'), L.stamped('Good to close.', h.now)] });
  h.start();
  long.set('idle'); quick.set('idle'); h.step();
  same(h.order(), ['wait', 'quick', 'long', 'run', 'idle', 'done']);
});

withHarness('badge counts sessions that need you and unfiled ready ones', async h => {
  const a = h.session('a', { status: 'busy' }); h.session('w', { status: 'waiting' }); h.session('i');
  h.start();
  eq(h.badge, 1);
  a.set('idle'); h.step();
  eq(h.badge, 2);
  await h.send({ type: 'ack', id: a.id });
  eq(h.badge, 1);
});

// ---- the star ----------------------------------------------------------------

withHarness('star: marks an idle session green, clears on a second click or a row click', async h => {
  const a = h.session('a');
  h.start();
  await h.send({ type: 'mark', id: a.id });
  eq(h.row('a').attention, 'ready'); assert.ok(h.row('a').cost); eq(h.badge, 1); same(h.takeSounds(), []);
  h.step(); eq(h.row('a').attention, 'ready');
  await h.send({ type: 'mark', id: a.id }); eq(h.row('a').attention, null);
  await h.send({ type: 'mark', id: a.id }); await h.send({ type: 'focus', id: a.id }); eq(h.row('a').attention, null);
});

withHarness('star: ignored on sessions that need you, are running, or are not running', async h => {
  const w = h.session('w', { status: 'waiting' }); const b = h.session('b', { status: 'busy' }); const s = h.session('s');
  h.start();
  h.stop(); await s.end(); h.start();
  await h.send({ type: 'mark', id: w.id }); eq(h.row('w').attention, 'waiting');
  await h.send({ type: 'mark', id: b.id }); eq(h.row('b').attention, null);
  await h.send({ type: 'mark', id: s.id }); eq(h.row('s').attention, null); eq(h.row('s').status, 'offline');
});

// ---- Removed -----------------------------------------------------------------

withHarness('remove and bring back', async h => {
  const a = h.session('a', { status: 'busy' });
  h.start(); a.set('idle'); h.step();
  await h.send({ type: 'dismiss', id: a.id });
  eq(h.row('a').dismissed, true); eq(h.row('a').attention, null); same(h.order(), []);
  await h.send({ type: 'restore', id: a.id });
  eq(h.row('a').dismissed, false); same(h.order(), ['a']);
});

withHarness('a removed session comes back on new activity, even after it left the Removed list', async h => {
  const a = h.session('a'); const b = h.session('b'); const c = h.session('c', { status: 'busy' });
  h.start();
  for (const s of [a, b, c]) await h.send({ type: 'dismiss', id: s.id });
  h.step(13 * H);
  eq(h.row('a'), undefined, 'cleared from Removed after 12 hours');
  a.set('busy'); b.set('waiting'); c.set('idle'); h.step();
  same(h.order().sort(), ['a', 'b', 'c']);
});

withHarness('Removed clears after the configured hours', async h => {
  h.config.removedClearHours = 1;
  const a = h.session('a');
  h.start(); await h.send({ type: 'dismiss', id: a.id });
  h.step(0.5 * H); eq(h.row('a').dismissed, true);
  h.step(0.6 * H); eq(h.row('a'), undefined);
});

// ---- restart, reload, ending -------------------------------------------------

withHarness('restart: listed sessions come back, stopped ones as not running; Removed keeps only running ones', async h => {
  h.session('a'); const s = h.session('s'); const d = h.session('d'); const x = h.session('x');
  h.start();
  await h.send({ type: 'dismiss', id: d.id }); await h.send({ type: 'dismiss', id: x.id });
  h.stop(); await s.end(); await x.end(); h.start();
  eq(h.row('a').status, 'idle');
  eq(h.row('s').status, 'offline'); eq(h.row('s').pid, null);
  eq(h.row('d').dismissed, true);
  eq(h.row('x'), undefined);
  await h.send({ type: 'focus', id: s.id });
  eq(h.executed.at(-1)[1], s.id);
  h.session('x'); h.step(); // resumed later: back on the list, not still removed
  eq(h.row('x').dismissed, false);
});

withHarness('a stopped session coming back to life turns into a live row', async h => {
  const s = h.session('s');
  h.start(); h.stop(); await s.end(); h.start();
  eq(h.row('s').status, 'offline');
  const again = h.session('s', { status: 'busy' }); h.step();
  eq(h.row('s').status, 'busy'); eq(h.rows.filter(r => r.id === again.id).length, 1);
});

withHarness('reload keeps green and blue marks and the Removed list', async h => {
  const a = h.session('a', { status: 'busy' }); const m = h.session('m'); const d = h.session('d');
  h.start(); a.set('idle'); h.step();
  await h.send({ type: 'mark', id: m.id }); await h.send({ type: 'dismiss', id: d.id }); await h.send({ type: 'toggleDismissed' });
  h.reload();
  eq(h.row('a').attention, 'ready'); eq(h.row('m').attention, 'ready'); eq(h.row('d').dismissed, true);
  eq(h.state.showDismissed, true);
  same(h.takeSounds(), ['ready'], 'no sound replayed by the reload');
});

withHarness('a session ended while VS Code runs leaves at once and is not saved', async h => {
  const e = h.session('e'); h.session('keep');
  h.start();
  await e.end(); h.step();
  eq(h.row('e'), undefined);
  h.step(31e3); h.restart();
  eq(h.row('e'), undefined); eq(h.row('keep').status, 'idle');
});

withHarness('a session ended just before VS Code closes still comes back after the restart', async h => {
  const e = h.session('e');
  h.start(); await e.end(); h.step(); h.restart();
  eq(h.row('e').status, 'offline');
});

withHarness("another window's stopped sessions follow that window's saved list", h => {
  const id = h.id('far');
  h.globalState.update(OPEN_KEY, [{ id, cwd: h.other, name: 'far', since: h.now, startedAt: h.now }]);
  h.start();
  return h.send({ type: 'toggleAll' }).then(() => {
    eq(h.row('far').status, 'offline');
    h.globalState.update(OPEN_KEY, []); h.step();
    eq(h.row('far'), undefined);
  });
});

withHarness('first start after upgrading: recent stopped sessions rebuilt from the registry', h => {
  h.deadRecord('recent', { at: h.now - H });
  h.deadRecord('ancient', { at: h.now - 13 * H });
  h.deadRecord('gone', { at: h.now - H });
  h.globalState.update(DISMISSED_KEY, [h.id('gone')]); // before 0.7.0: bare ids
  h.start();
  eq(h.row('recent').status, 'offline'); eq(h.row('ancient'), undefined); eq(h.row('gone'), undefined);
});

// ---- Good to close -----------------------------------------------------------

const closing = h => [L.user('wrap up'), L.skill('anything-left'), L.stamped('**Good to close.** Nothing left.', h.now)];

withHarness('Good to close: shown as closed, no green, no sound', h => {
  const c = h.session('c', { status: 'busy', transcript: closing(h) });
  h.start(); c.set('idle'); h.step();
  eq(h.row('c').closed, true); eq(h.row('c').attention, null); same(h.takeSounds(), []);
});

withHarness('Good to close without the trail mod: moves to Removed two minutes later', h => {
  h.session('c', { transcript: closing(h) });
  h.start();
  h.step(60e3); eq(h.row('c').dismissed, false);
  h.step(70e3); eq(h.row('c').dismissed, true);
});

withHarness('Good to close: moves to Removed once VS Code hides it', h => {
  const t = h.now;
  h.session('c', { transcript: closing(h) });
  h.trail('c', { shown: true, shownAt: t - 5000 });
  h.start(); eq(h.row('c').dismissed, false);
  h.trail('c', { shown: false, shownAt: t - 5000, hiddenAt: t + 1000 }); h.step();
  eq(h.row('c').dismissed, true);
});

withHarness('Good to close: moves to Removed once another session in the window is shown', h => {
  const t = h.now;
  h.session('c', { transcript: closing(h) }); h.session('o');
  h.trail('c', { shown: true, shownAt: t - 5000 });
  h.start(); eq(h.row('c').dismissed, false);
  h.trail('o', { shown: true, shownAt: t + 1000 }); h.step();
  eq(h.row('c').dismissed, true);
});

withHarness('Good to close: brought back by hand, it is not moved again', async h => {
  const c = h.session('c', { transcript: closing(h) });
  h.start(); h.step(3 * 60e3); eq(h.row('c').dismissed, true);
  await h.send({ type: 'restore', id: c.id }); h.step(3 * 60e3);
  eq(h.row('c').dismissed, false);
});

withHarness('Good to close: a new prompt reopens it', h => {
  h.session('c', { transcript: closing(h) });
  h.start(); eq(h.row('c').closed, true);
  h.transcript('c', [L.user('one more thing')]); h.step();
  eq(h.row('c').closed, false);
});

withHarness('a closed session that stopped is not saved for the restart', async h => {
  const c = h.session('c', { transcript: closing(h) });
  h.start(); h.stop(); await c.end(); h.start();
  eq(h.row('c'), undefined);
});

// ---- time estimates ----------------------------------------------------------

withHarness('time chip: final reply only, numbered items as decisions', h => {
  const big = h.session('big', { status: 'busy', transcript: [L.user('go'), L.text('Checking first. ' + words(400)), L.tool(), L.result(),
    L.text(words(920) + '\n\nDecisions for you:\n1. **One**\n2. **Two**\n   1. nested\n3. Three\n```\n4. in code\n```')] });
  const small = h.session('small', { status: 'busy', transcript: [L.user('fix'), L.tool(), L.result(), L.text(words(40)), L.side(words(5000))] });
  h.start(); eq(h.row('big').cost, null);
  big.set('idle'); small.set('idle'); h.step();
  const c = h.row('big').cost;
  eq(c.decisions, 3); eq(c.words, 936);
  assert.ok(Math.abs(c.readMinutes - 936 / 230) < 1e-9); eq(c.decideMinutes, 2.25); eq(c.minutes, c.readMinutes + c.decideMinutes);
  eq(h.row('small').cost.words, 40); eq(h.row('small').cost.decisions, 0);
});

withHarness('time chip: a new prompt starts a new reply', h => {
  const a = h.session('a', { status: 'busy', transcript: [L.user('one'), L.text(words(300))] });
  h.start(); a.set('idle'); h.step(); eq(h.row('a').cost.words, 300);
  h.transcript('a', [L.user('two'), L.text(words(10))]); a.set('busy'); h.step(); a.set('idle'); h.step();
  eq(h.row('a').cost.words, 10);
});

// ---- folders -----------------------------------------------------------------

withHarness('folders: create from a row, names checked, tab chosen per window', async h => {
  const a = h.session('a'); h.session('b');
  h.start();
  h.answers.push('Later'); await h.send({ type: 'newFolder', id: a.id });
  same(h.state.folders, ['Later']); eq(h.row('a').folder, 'Later'); eq(h.row('b').folder, '');
  h.answers.push('main'); await h.send({ type: 'newFolder' });
  h.answers.push('later'); await h.send({ type: 'newFolder' });
  same(h.state.folders, ['Later']); eq(h.refused.length, 2);
  h.answers.push('HIRE'); await h.send({ type: 'newFolder' });
  same(h.state.folders, ['Later', 'HIRE']); eq(h.state.viewFolder, 'HIRE');
  await h.send({ type: 'showFolder', folder: 'Later' }); h.restart();
  eq(h.state.viewFolder, 'Later');
});

withHarness('folders: a filed ready session is quiet and off the badge; needing you still counts', h => {
  const a = h.session('a', { status: 'busy' });
  h.start();
  h.answers.push('Later');
  return h.send({ type: 'newFolder', id: a.id }).then(() => {
    a.set('idle'); h.step();
    eq(h.row('a').attention, 'ready'); same(h.takeSounds(), []); eq(h.badge, 0);
    a.set('waiting'); h.step();
    same(h.takeSounds(), ['waiting']); eq(h.badge, 1);
  });
});

withHarness('folders: a filed session that ends stays, and moving it to Main keeps it there', async h => {
  const a = h.session('a');
  h.start();
  h.answers.push('Later'); await h.send({ type: 'newFolder', id: a.id });
  await a.end(); h.step(); h.step(31e3);
  eq(h.row('a').status, 'offline'); eq(h.row('a').folder, 'Later');
  await h.send({ type: 'move', id: a.id, folder: '' }); h.step(31e3);
  eq(h.row('a').folder, ''); eq(h.row('a').status, 'offline');
  h.restart(); eq(h.row('a').status, 'offline');
});

withHarness('folders: rename and delete', async h => {
  const a = h.session('a'); const b = h.session('b');
  h.start();
  h.answers.push('Later'); await h.send({ type: 'newFolder', id: a.id });
  await h.send({ type: 'move', id: b.id, folder: 'Later' });
  await h.send({ type: 'showFolder', folder: 'Later' });
  h.answers.push('Someday'); await h.send({ type: 'renameFolder', folder: 'Later' });
  same(h.state.folders, ['Someday']); eq(h.row('a').folder, 'Someday'); eq(h.state.viewFolder, 'Someday');
  h.confirm = undefined; await h.send({ type: 'deleteFolder', folder: 'Someday' });
  same(h.state.folders, ['Someday'], 'cancelled delete keeps it');
  h.confirm = 'Delete'; await h.send({ type: 'deleteFolder', folder: 'Someday' });
  same(h.state.folders, []); eq(h.row('a').folder, ''); eq(h.row('b').folder, ''); eq(h.state.viewFolder, '');
});

withHarness('folders: removing takes a session out; bringing it back puts it on Main', async h => {
  const a = h.session('a');
  h.start();
  h.answers.push('X'); await h.send({ type: 'newFolder', id: a.id });
  await h.send({ type: 'dismiss', id: a.id }); eq(h.row('a').folder, '');
  await h.send({ type: 'restore', id: a.id }); eq(h.row('a').folder, ''); eq(h.row('a').dismissed, false);
});

withHarness('folders: survive reload and restart, and stay through new activity', async h => {
  const a = h.session('a');
  h.start();
  h.answers.push('X'); await h.send({ type: 'newFolder', id: a.id });
  h.reload(); eq(h.row('a').folder, 'X');
  a.set('busy'); h.step(); a.set('idle'); h.step(); eq(h.row('a').folder, 'X');
  h.restart(); eq(h.row('a').folder, 'X');
});

withHarness("folders: a filed session's copy follows its title, and a closed one leaves", async h => {
  const a = h.session('a', { transcript: [L.aiTitle('Old')] }); const c = h.session('c', { transcript: closing(h) });
  h.start();
  h.answers.push('X'); await h.send({ type: 'newFolder', id: a.id }); await h.send({ type: 'move', id: c.id, folder: 'X' });
  h.transcript('a', [L.customTitle('New')]); h.step();
  h.stop(); await a.end(); await c.end(); h.start();
  eq(h.row('a').name, 'New'); eq(h.row('a').folder, 'X');
  eq(h.row('c'), undefined);
});

// ---- the snapshot read-sessions uses -----------------------------------------

withHarness('snapshot: the rows shown, with state and folder, never removed ones', async h => {
  const a = h.session('a', { status: 'busy' }); h.session('i'); const d = h.session('d'); const f = h.session('f');
  h.start(); a.set('idle'); h.step();
  await h.send({ type: 'dismiss', id: d.id });
  h.answers.push('Later'); await h.send({ type: 'newFolder', id: f.id });
  const snap = h.snapshot();
  const by = Object.fromEntries(snap.rows.map(r => [r.id.slice(h.prefix.length), r]));
  eq(by.a.state, 'ready'); eq(by.i.state, 'idle'); eq(by.d, undefined); eq(by.f.folder, 'Later'); eq(by.i.folder, undefined);
  same(snap.folders, [h.proj]);
});

// ---- Alt+Q history -----------------------------------------------------------

withHarness("Alt+Q: back to the session shown before this one, this window's only", async h => {
  const t = h.now;
  const a = h.session('a'); const b = h.session('b'); h.session('far', { cwd: h.other });
  h.trail('a', { shown: false, shownAt: t - 9000, hiddenAt: t - 5000 });
  h.trail('far', { shown: false, shownAt: t - 3000, hiddenAt: t - 2000 });
  h.trail('b', { shown: true, shownAt: t - 1000 });
  h.start();
  await h.commands.get('claudeSessions.goBack')();
  eq(h.executed.at(-1)[1], a.id);
  assert.notEqual(h.executed.at(-1)[1], b.id);
});
