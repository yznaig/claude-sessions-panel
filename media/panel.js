// Renders the session list from host state messages; sends clicks back to the host.
(function () {
  const vscode = acquireVsCodeApi();
  const post = m => vscode.postMessage(m);
  const bar = document.getElementById('bar');
  const list = document.getElementById('list');
  const dismissedEl = document.getElementById('dismissed');
  const DRAG_TYPE = 'application/x-claude-session';
  let state = null;
  let menu = null;

  function age(ms) {
    const s = Math.max(0, Math.round(ms / 1000));
    if (s < 60) return s + 's';
    const m = Math.round(s / 60); if (m < 60) return m + 'm';
    const h = Math.round(m / 60); if (h < 48) return h + 'h';
    return Math.round(h / 24) + 'd';
  }
  function label(r) {
    if (r.closed) return '✓ closed';
    if (r.status === 'offline') return 'not running';
    if (r.attention === 'waiting') return r.waitingFor ? 'needs you: ' + r.waitingFor : 'needs you';
    if (r.attention === 'ready') return 'response ready';
    if (r.status === 'busy') return 'running';
    if (r.status === 'waiting') return 'needs you';
    return 'idle';
  }
  function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; }

  // ---- pop-up menu (the ⋯ button and right-click) ----
  // items: { heading } | '-' | { label, run, current }
  function closeMenu() { if (menu) { menu.remove(); menu = null; } }
  function openMenu(x, y, items) {
    closeMenu();
    menu = el('div', 'menu');
    for (const it of items) {
      if (it === '-') { menu.appendChild(el('div', 'sep')); continue; }
      if (it.heading) { menu.appendChild(el('div', 'mhead', it.heading)); continue; }
      const b = el('button', 'mitem' + (it.current ? ' current' : ''), (it.current ? '✓ ' : '') + it.label);
      b.disabled = !!it.current;
      b.addEventListener('click', ev => { ev.stopPropagation(); closeMenu(); it.run(); });
      menu.appendChild(b);
    }
    menu.addEventListener('click', ev => ev.stopPropagation());
    document.body.appendChild(menu);
    const r = menu.getBoundingClientRect();
    menu.style.left = Math.max(4, Math.min(x, window.innerWidth - r.width - 4)) + 'px';
    menu.style.top = Math.max(4, Math.min(y, window.innerHeight - r.height - 4)) + 'px';
  }
  document.addEventListener('click', closeMenu);
  document.addEventListener('keydown', ev => { if (ev.key === 'Escape') closeMenu(); });
  window.addEventListener('blur', closeMenu);

  function rowMenu(r, x, y) {
    const items = [{ heading: 'Move to' }, { label: 'Main', current: !r.folder, run: () => post({ type: 'move', id: r.id, folder: '' }) }];
    for (const f of state.folders) items.push({ label: f, current: r.folder === f, run: () => post({ type: 'move', id: r.id, folder: f }) });
    items.push({ label: '+ New folder…', run: () => post({ type: 'newFolder', id: r.id }) });
    items.push('-', { label: 'Remove from list', run: () => post({ type: 'dismiss', id: r.id }) });
    openMenu(x, y, items);
  }
  function folderMenu(f, x, y) {
    openMenu(x, y, [
      { label: 'Rename…', run: () => post({ type: 'renameFolder', folder: f }) },
      { label: 'Delete… (its sessions go back to Main)', run: () => post({ type: 'deleteFolder', folder: f }) },
    ]);
  }

  // ---- your time for a ready reply ----
  // Heat from teal (quick) through amber (a few minutes) to red (8 minutes or more).
  const HEAT = [[0, [78, 201, 176]], [3, [215, 186, 125]], [8, [244, 135, 113]]];
  function heat(m) {
    for (let i = 0; i < HEAT.length - 1; i++) {
      const [a, ca] = HEAT[i], [b, cb] = HEAT[i + 1];
      if (m <= b) { const t = Math.max(0, (m - a) / (b - a)); return 'rgb(' + ca.map((c, k) => Math.round(c + (cb[k] - c) * t)).join(',') + ')'; }
    }
    return 'rgb(' + HEAT[HEAT.length - 1][1].join(',') + ')';
  }
  const minutesText = m => (m < 0.75 ? '<1m' : '~' + Math.round(m) + 'm');
  const plural = (n, w) => n + ' ' + w + (n === 1 ? '' : 's');
  function costChip(r) {
    if (!r.cost) return el('span');
    const c = r.cost;
    const chip = el('span', 'chip', minutesText(c.minutes) + (c.decisions ? ' · ' + plural(c.decisions, 'decision') : ''));
    chip.style.background = heat(c.minutes);
    chip.title = `Your time, roughly: ${plural(c.words, 'word')} to read (${(c.words / 230).toFixed(1)} min)` +
      (c.decisions ? ` + ${plural(c.decisions, 'numbered item')} to decide (${(c.decisions * 0.75).toFixed(1)} min)` : '');
    return chip;
  }

  function row(r) {
    const kind = r.closed ? 'closed' : (r.attention || r.status);
    const offline = r.status === 'offline';
    const d = el('div', 'row ' + (r.attention || '') + (r.closed ? ' closedRow' : '') + (offline ? ' offlineRow' : '') + (r.dismissed ? ' dismissedRow' : ''));
    d.title = r.cwd + '\n' + r.id + (offline ? '\nNot running: click to reopen' : '');
    d.appendChild(el('span', 'dot ' + kind));
    d.appendChild(el('span', 'name', r.name));
    d.appendChild(el('span', 'repo', r.repo));
    // The star: mark an idle session green to come back to it, or clear the mark. Not on running
    // sessions (they turn green by themselves) or ones that need you (already blue).
    if (!r.dismissed && !r.closed && r.status !== 'offline' && r.status !== 'busy' && r.attention !== 'waiting') {
      const marked = r.attention === 'ready';
      const star = el('button', 'star', marked ? '★' : '☆');
      star.title = marked ? 'Clear the green mark' : 'Mark green to come back to it';
      star.addEventListener('click', ev => { ev.stopPropagation(); post({ type: 'mark', id: r.id }); });
      d.appendChild(star);
    } else d.appendChild(el('span'));
    d.appendChild(costChip(r));
    d.appendChild(el('span', 'state ' + kind, label(r)));
    d.appendChild(el('span', 'age', age(state.now - r.since)));
    if (r.dismissed) {
      d.appendChild(el('span'));
    } else {
      const more = el('button', 'more', '⋯');
      more.title = 'Move to a folder';
      more.addEventListener('click', ev => { ev.stopPropagation(); const b = more.getBoundingClientRect(); rowMenu(r, b.left, b.bottom + 2); });
      d.appendChild(more);
      d.addEventListener('contextmenu', ev => { ev.preventDefault(); ev.stopPropagation(); rowMenu(r, ev.clientX, ev.clientY); });
      d.draggable = true;
      d.addEventListener('dragstart', ev => { ev.dataTransfer.setData(DRAG_TYPE, r.id); ev.dataTransfer.effectAllowed = 'move'; closeMenu(); });
    }
    const x = el('button', 'x', r.dismissed ? '↩' : '✕');
    x.title = r.dismissed ? 'Bring back' : 'Remove from list';
    x.addEventListener('click', ev => { ev.stopPropagation(); post({ type: r.dismissed ? 'restore' : 'dismiss', id: r.id }); });
    d.appendChild(x);
    d.addEventListener('click', () => post({ type: 'focus', id: r.id }));
    return d;
  }

  // A tab per folder, Main first. Each shows its count, and a dot when a session in it wants you.
  function tab(folder, live) {
    const inIt = live.filter(r => (r.folder || '') === folder);
    const on = state.viewFolder === folder;
    const t = el('button', 'tab' + (on ? ' on' : ''));
    t.appendChild(el('span', '', folder || 'Main'));
    t.appendChild(el('span', 'count', String(inIt.length)));
    const want = inIt.some(r => r.attention === 'waiting') ? 'waiting' : inIt.some(r => r.attention === 'ready') ? 'ready' : '';
    if (want && !on) t.appendChild(el('span', 'tdot ' + want));
    t.title = folder ? 'Right-click to rename or delete. Drop a session here to file it.' : 'Sessions not in any folder. Drop a session here to unfile it.';
    t.addEventListener('click', () => post({ type: 'showFolder', folder }));
    if (folder) {
      t.addEventListener('contextmenu', ev => { ev.preventDefault(); ev.stopPropagation(); folderMenu(folder, ev.clientX, ev.clientY); });
      if (on) {
        const more = el('span', 'tmore', '⋯');
        more.addEventListener('click', ev => { ev.stopPropagation(); const b = more.getBoundingClientRect(); folderMenu(folder, b.left, b.bottom + 2); });
        t.appendChild(more);
      }
    }
    t.addEventListener('dragover', ev => { if (ev.dataTransfer.types.includes(DRAG_TYPE)) { ev.preventDefault(); t.classList.add('drop'); } });
    t.addEventListener('dragleave', () => t.classList.remove('drop'));
    t.addEventListener('drop', ev => {
      ev.preventDefault(); t.classList.remove('drop');
      const id = ev.dataTransfer.getData(DRAG_TYPE);
      if (id) post({ type: 'move', id, folder });
    });
    return t;
  }

  function render() {
    if (!state) return;
    const live = state.rows.filter(r => !r.dismissed);
    const gone = state.rows.filter(r => r.dismissed);
    const shown = live.filter(r => (r.folder || '') === state.viewFolder);
    bar.replaceChildren();
    const tabs = el('div', 'tabs');
    tabs.appendChild(tab('', live));
    for (const f of state.folders) tabs.appendChild(tab(f, live));
    const add = el('button', 'tab add', '+');
    add.title = 'New folder';
    add.addEventListener('click', () => post({ type: 'newFolder' }));
    tabs.appendChild(add);
    bar.appendChild(tabs);
    bar.appendChild(el('span', 'spacer'));
    const scope = el('button', state.showAll ? 'on' : '', state.showAll ? 'All windows' : 'This window: ' + state.window);
    scope.title = 'Toggle between this window\'s sessions and every window\'s';
    scope.addEventListener('click', () => post({ type: 'toggleAll' }));
    bar.appendChild(scope);
    const dis = el('button', state.showDismissed ? 'on' : '', 'Removed (' + gone.length + ')');
    dis.addEventListener('click', () => post({ type: 'toggleDismissed' }));
    bar.appendChild(dis);
    bar.appendChild(el('span', '', state.soundOn ? '🔔 sounds on' : '🔕 sounds off'));
    list.replaceChildren();
    if (!shown.length) {
      let msg = 'No live Claude sessions here. Start one and it appears when it first runs.';
      if (state.viewFolder) msg = 'Nothing in ' + state.viewFolder + ' yet. Use ⋯ on a session, right-click it, or drag it onto this tab.';
      else if (live.length) msg = 'Nothing on Main: every session here is in a folder.';
      list.appendChild(el('div', 'empty', msg));
    }
    const costed = shown.filter(r => r.cost);
    list.classList.toggle('costs', costed.length > 0);
    for (const r of shown) list.appendChild(row(r));
    if (costed.length > 1) {
      const total = costed.reduce((n, r) => n + r.cost.minutes, 0);
      list.appendChild(el('div', 'costsum', `${costed.length} ready · about ${Math.max(1, Math.round(total))} min of you · shortest first`));
    }
    dismissedEl.replaceChildren();
    if (state.showDismissed && gone.length) {
      dismissedEl.appendChild(el('h4', '', 'Removed — click ↩ to bring one back; any new activity brings it back on its own'));
      for (const r of gone) dismissedEl.appendChild(row(r));
    }
  }

  window.addEventListener('message', ev => { if (ev.data && ev.data.type === 'state') { state = ev.data; render(); } });
  setInterval(() => { if (state) { state.now += 15000; render(); } }, 15000);
  post({ type: 'ready' });
})();
