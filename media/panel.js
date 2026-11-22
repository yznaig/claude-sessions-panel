// Renders the session list from host state messages; sends clicks back to the host.
(function () {
  const vscode = acquireVsCodeApi();
  const post = m => vscode.postMessage(m);
  const bar = document.getElementById('bar');
  const list = document.getElementById('list');
  const dismissedEl = document.getElementById('dismissed');
  const searchEl = document.getElementById('search');
  const DRAG_TYPE = 'application/x-claude-session';
  let state = null;
  let menu = null;
  // The note being typed under a row: { id, value }. While it is open the list isn't redrawn, so
  // the panel's own updates never take the box away mid-word.
  let noteEdit = null;
  // Rows opened with a click on their dot: ASKED, NOW and the note show under the name. Closed by
  // default; kept in the webview's saved state so a redraw or a panel reload leaves them as they were.
  const saved = vscode.getState() || {};
  const opened = new Set(Array.isArray(saved.opened) ? saved.opened : []);
  function toggleOpen(id) {
    if (opened.has(id)) opened.delete(id); else opened.add(id);
    vscode.setState({ ...(vscode.getState() || {}), opened: [...opened] });
    render();
  }

  function age(ms) {
    const s = Math.max(0, Math.round(ms / 1000));
    if (s < 60) return s + 's';
    const m = Math.round(s / 60); if (m < 60) return m + 'm';
    const h = Math.round(m / 60); if (h < 48) return h + 'h';
    return Math.round(h / 24) + 'd';
  }
  function label(r) {
    if (r.closed) return '✓ closed';
    if (r.stopping) return 'stopping…';
    if (r.status === 'asleep' && r.attention === 'waiting') return (r.waitingFor ? 'needs you: ' + r.waitingFor : 'needs you') + ' · asleep';
    if (r.status === 'asleep') return r.attention === 'ready' ? 'ready · asleep' : r.attention === 'relayed' ? 'recap at ' + r.relayedTo + ' · asleep'
      : r.attention === 'closable' ? 'ready to close · asleep' : r.attention === 'paused' ? 'paused · asleep' : 'asleep';
    if (r.status === 'offline') return 'not running';
    if (r.attention === 'waiting') return r.waitingFor ? 'needs you: ' + r.waitingFor : 'needs you';
    if (r.attention === 'ready') return 'response ready';
    if (r.attention === 'relayed') return 'recap at ' + r.relayedTo + ' ↗';
    if (r.attention === 'closable') return 'ready to close';
    if (r.attention === 'paused') return r.pausedFor ? 'paused · ' + clip(r.pausedFor, WATCH_LABEL_MAX) : 'paused';
    if (r.status === 'busy') return 'running';
    if (r.status === 'watching') return r.watchingFor ? 'watching · ' + clip(r.watchingFor, WATCH_LABEL_MAX) : 'watching';
    if (r.status === 'waiting') return 'needs you';
    return 'idle';
  }
  // What a session watches runs across the star and time-chip columns too (a watching row has neither),
  // and the row cuts it off where that room ends; the whole description is in the row's tooltip.
  const WATCH_LABEL_MAX = 80;
  // A workspace pill shows 8 characters at most, so one long folder name doesn't narrow every name.
  const REPO_LABEL_MAX = 8;
  function clip(text, n) { return text.length > n ? text.slice(0, n - 1).trimEnd() + '…' : text; }
  function clock(ms) {
    if (!ms) return '?';
    const d = new Date(ms), now = new Date();
    const t = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    return d.toDateString() === now.toDateString() ? t : d.toLocaleDateString([], { weekday: 'short' }) + ' ' + t;
  }
  function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; }

  // ---- pop-up menu (the ⋯ button and right-click) ----
  // items: { heading } | '-' | { label, run, current } | { swatches: [[name, color]], current, pick }
  function closeMenu() { if (menu) { menu.remove(); menu = null; } }
  function openMenu(x, y, items) {
    closeMenu();
    menu = el('div', 'menu');
    for (const it of items) {
      if (it === '-') { menu.appendChild(el('div', 'sep')); continue; }
      if (it.heading) { menu.appendChild(el('div', 'mhead', it.heading)); continue; }
      if (it.swatches) {
        const grid = el('div', 'swatches');
        for (const [name, color] of it.swatches) {
          const s = el('button', 'swatch' + (color === it.current ? ' on' : ''));
          s.style.background = color;
          if (edgy(color)) s.classList.add('edge');
          s.title = name;
          s.addEventListener('click', ev => { ev.stopPropagation(); closeMenu(); it.pick(color); });
          grid.appendChild(s);
        }
        menu.appendChild(grid);
        continue;
      }
      const b = el('button', 'mitem' + (it.current ? ' current' : ''), (it.current || it.checked ? '✓ ' : '') + it.label);
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

  // ---- dot colors: right-click a session's dot to give it a color of your own ----
  // The whole color wheel, 12 hues, each light, medium and deep: one row per shade in the menu.
  // Then white to black.
  const PALETTE = [
    ['Light red', '#f4afaf'], ['Light orange', '#f4cfaf'], ['Light yellow', '#f4e8af'], ['Light lime', '#ddf4af'], ['Light green', '#aff4b4'], ['Light mint', '#aff4d7'],
    ['Light teal', '#aff4f1'], ['Light sky', '#afddf4'], ['Light blue', '#afc6f4'], ['Light indigo', '#b4aff4'], ['Light purple', '#d7aff4'], ['Light pink', '#f4afd7'],
    ['Red', '#e07b7b'], ['Orange', '#e0aa7b'], ['Yellow', '#e0cf7b'], ['Lime', '#bee07b'], ['Green', '#7be083'], ['Mint', '#7be0b6'],
    ['Teal', '#7be0dd'], ['Sky', '#7bbee0'], ['Blue', '#7b9de0'], ['Indigo', '#837be0'], ['Purple', '#b67be0'], ['Pink', '#e07bb6'],
    ['Deep red', '#ce4646'], ['Deep orange', '#ce8546'], ['Deep yellow', '#ceb746'], ['Deep lime', '#a0ce46'], ['Deep green', '#46ce51'], ['Deep mint', '#46ce95'],
    ['Deep teal', '#46cec9'], ['Deep sky', '#46a0ce'], ['Deep blue', '#4673ce'], ['Deep indigo', '#5146ce'], ['Deep purple', '#9546ce'], ['Deep pink', '#ce4695'],
    ['White', '#ffffff'], ['Gray 1', '#e8e8e8'], ['Gray 2', '#d1d1d1'], ['Gray 3', '#b9b9b9'], ['Gray 4', '#a2a2a2'], ['Gray 5', '#8b8b8b'],
    ['Gray 6', '#747474'], ['Gray 7', '#5d5d5d'], ['Gray 8', '#464646'], ['Gray 9', '#2e2e2e'], ['Gray 10', '#171717'], ['Black', '#000000'],
  ];
  function colorMenu(r, x, y) {
    openMenu(x, y, [
      { heading: 'Dot color' },
      { swatches: PALETTE, current: r.manualColor, pick: color => post({ type: 'color', id: r.id, color }) },
      '-',
      // Automatic: the color its name, title or hive role calls for (Settings: Claude Sessions: Auto Colors).
      { label: r.autoColor ? 'Automatic (by its job)' : 'Automatic (no rule matches)', current: !r.manualColor, run: () => post({ type: 'color', id: r.id, color: null }) },
      { label: 'No color', current: r.manualColor === 'none', run: () => post({ type: 'color', id: r.id, color: 'none' }) },
    ]);
  }
  // Very dark or very light colors get a faint ring, so they don't vanish into the background.
  function edgy(color) {
    const v = [1, 3, 5].map(i => parseInt(color.slice(i, i + 2), 16));
    const lum = (0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2]) / 255;
    return lum < 0.3 || lum > 0.92;
  }
  // The dot, in its own color when it has one; it keeps its shape for the state (spinning, ring,
  // three dots lighting in turn while it watches a background command).
  function dot(cls, color) {
    const d = el('span', 'dot ' + cls);
    if (cls === 'watching') for (let i = 0; i < 3; i++) d.appendChild(el('i'));
    if (color) { d.classList.add('tinted'); d.style.setProperty('--c', color); if (edgy(color)) d.classList.add('edge'); }
    return d;
  }

  // The X removes a session from the list and, if it is running in VS Code, stops its process.
  const removeLabel = r => (r.canStop && r.status !== 'asleep' && !r.stopping ? 'Remove from list and stop it' : 'Remove from list');

  function rowMenu(r, x, y) {
    const items = [{ heading: 'Move to' }, { label: 'Main', current: !r.folder, run: () => post({ type: 'move', id: r.id, folder: '' }) }];
    for (const f of state.folders) items.push({ label: f, current: r.folder === f, run: () => post({ type: 'move', id: r.id, folder: f }) });
    items.push({ label: '+ New folder…', run: () => post({ type: 'newFolder', id: r.id }) });
    if (r.canStop) {
      items.push('-');
      // Running in VS Code: stop it to free its memory; it stays here, asleep, until you click it.
      if (r.status !== 'asleep' && !r.stopping) items.push({ label: 'Put to sleep (frees memory, stays listed)', run: () => post({ type: 'sleep', id: r.id }) });
      items.push({ label: 'Keep running (never auto-close)', checked: !!r.keep, run: () => post({ type: 'keep', id: r.id }) });
    }
    items.push('-', { label: 'Parked (other sessions don\'t message it)', checked: !!r.parked, run: () => post({ type: 'park', id: r.id }) });
    items.push({ label: 'Dot color…', run: () => colorMenu(r, x, y) });
    // A note of your own, typed in a box that opens under the row.
    if (r.note) items.push({ label: 'Edit note', run: () => editNote(r) }, { label: 'Remove note', run: () => post({ type: 'note', id: r.id, text: '' }) });
    else items.push({ label: 'Add note', run: () => editNote(r) });
    items.push('-', { label: removeLabel(r), run: () => post({ type: 'dismiss', id: r.id }) });
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
    chip.title = `Your time, roughly: ${plural(c.words, 'word')} to read (${c.readMinutes.toFixed(1)} min)` +
      (c.decisions ? ` + ${plural(c.decisions, 'numbered item')} to decide (${c.decideMinutes.toFixed(1)} min)` : '');
    return chip;
  }

  function row(r) {
    const kind = r.closed ? 'closed' : (r.attention || r.status);
    const offline = r.status === 'offline';
    const asleep = r.status === 'asleep';
    const d = el('div', 'row ' + (r.attention || '') + (r.closed ? ' closedRow' : '') + (offline ? ' offlineRow' : '') + (asleep || r.stopping ? ' asleepRow' : '') + (r.dismissed ? ' dismissedRow' : ''));
    // The name other sessions know it by (myapp-17), when it isn't just the title shown.
    const known = r.handle && r.handle !== r.name ? (offline || asleep ? 'Was ' : '') + r.handle + '\n' : '';
    d.title = known + r.cwd + '\n' + r.id + (offline ? '\nNot running: click to reopen' : '') +
      (asleep ? (r.retired ? '\nAsleep: Claude Code stopped it after an hour waiting on you. Click to open it; the conversation resumes.' : '\nAsleep: its process was stopped to free memory. Click to wake it; the conversation resumes.') : '') +
      (r.status === 'watching' ? '\nWatching' + (r.watchingFor ? ': ' + r.watchingFor : ' a background command') + '. It carries on by itself when that finishes.' : '');
    // The dot opens and closes the row's lines (ASKED, NOW, your note); it is the big dot while open.
    // Right-click it for its color. A click anywhere else on the row opens the session.
    const isOpen = opened.has(r.id) || !!(noteEdit && noteEdit.id === r.id);
    const hasLines = !!(r.recap || r.note);
    if (isOpen) d.classList.add('open');
    const cell = el('span', 'dotcell' + (hasLines ? ' folds' : ''));
    cell.title = (hasLines ? (isOpen ? 'Click to hide what it was asked and where it stands' : 'Click to show what it was asked and where it stands') + (r.note ? ', and your note' : '') : 'No recap yet') +
      '\nRight-click for a color' + (r.autoColor && !r.manualColor ? ' (this one is automatic, from its name or role)' : '');
    // A closed row with a note: a tiny yellow dot on the edge of its dot (beside it, so it doesn't
    // spin or pulse with it).
    const wrap = el('span', 'dotwrap');
    wrap.appendChild(dot(kind, r.color));
    if (r.note && !isOpen) wrap.appendChild(el('b', 'notemark'));
    cell.appendChild(wrap);
    cell.addEventListener('click', ev => { ev.preventDefault(); ev.stopPropagation(); closeMenu(); toggleOpen(r.id); });
    cell.addEventListener('contextmenu', ev => { ev.preventDefault(); ev.stopPropagation(); colorMenu(r, ev.clientX, ev.clientY); });
    d.appendChild(cell);
    d.appendChild(el('span', 'name', r.name));
    const repo = el('span', 'repo', clip(r.repo, REPO_LABEL_MAX));
    if (r.repo.length > REPO_LABEL_MAX) repo.title = r.repo + '\n' + d.title;
    d.appendChild(repo);
    // A row that says what it watches gives that line the star and time-chip columns as well.
    const watchLine = kind === 'watching' && !r.stopping && !!r.watchingFor;
    // The star: mark an idle session green to come back to it, or clear the mark. Not on running or
    // watching sessions (they turn green by themselves) or ones that need you (already blue).
    if (watchLine) { /* no star, no chip: the state below spans their columns */ }
    // Nor on one ready to close or paused: new work in it, not a mark, is what clears that.
    else if (!r.dismissed && !r.closed && !offline && !asleep && !r.stopping && r.status !== 'busy' && r.status !== 'watching' && r.attention !== 'waiting' && r.attention !== 'closable' && r.attention !== 'paused') {
      const marked = r.attention === 'ready' || r.attention === 'relayed';
      const star = el('button', 'star', marked ? '★' : '☆');
      star.title = marked ? 'Clear the green mark' : 'Mark green to come back to it';
      star.addEventListener('click', ev => { ev.stopPropagation(); post({ type: 'mark', id: r.id }); });
      d.appendChild(star);
    } else d.appendChild(el('span'));
    if (!watchLine) d.appendChild(costChip(r));
    const st = el('span', 'state ' + (asleep && !r.attention ? 'asleep' : kind) + (watchLine ? ' wide' : ''), (r.parked ? '🔕 ' : '') + (r.keep ? '📌 ' : '') + label(r));
    const marks = [r.parked && 'Parked: other sessions don\'t message it', r.keep && 'Keep running: never auto-closed'].filter(Boolean);
    if (marks.length) st.title = marks.join('\n') + '\n(⋯ to change)';
    if (r.attention === 'relayed') st.title = `It sent its recap to ${r.relayedTo} this turn: answer it there. Click to open this session anyway.` + (st.title ? '\n' + st.title : '');
    if (r.attention === 'closable') st.title = 'Its final debrief went out with nothing it started still running, and it has done no new work since: safe to close. A new edit, commit or background task in it takes the mark off.' + (st.title ? '\n' + st.title : '');
    if (r.attention === 'paused') st.title = `Paused: it is waiting on ${r.pausedFor || 'something'}, and its next step comes back to it. Not done; keep it open.` + (st.title ? '\n' + st.title : '');
    d.appendChild(st);
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
    x.title = r.dismissed ? 'Bring back' : removeLabel(r);
    x.addEventListener('click', ev => { ev.stopPropagation(); post({ type: r.dismissed ? 'restore' : 'dismiss', id: r.id }); });
    d.appendChild(x);
    // Under the name: what it was asked and where it stands (written by a small model after each
    // turn), then your note. Each is a line as wide as the row; the row grows to hold them.
    // Shown only while the row is open; closed, they ride in the row's tooltip.
    if (isOpen) {
      if (r.recap) d.appendChild(recapLine(r, kind));
      if (noteEdit && noteEdit.id === r.id) d.appendChild(noteBox(r, d));
      else if (r.note) {
        const n = el('div', 'note', r.note);
        n.title = r.note + '\n(right-click the session to edit or remove the note)';
        d.appendChild(n);
      }
      if (r.recap || r.note || (noteEdit && noteEdit.id === r.id)) d.classList.add('lined');
    } else if (hasLines) {
      d.title = (r.recap && r.recap.asked ? 'Asked: ' + r.recap.asked + '\n' : '') + (r.recap && r.recap.now ? 'Now: ' + r.recap.now + '\n' : '') +
        (r.note ? 'Note: ' + r.note + '\n' : '') + '\n' + d.title;
    }
    d.addEventListener('click', () => post({ type: 'focus', id: r.id }));
    return d;
  }

  // ASKED: the job it was started for. NOW: where it stands, in the row's state color.
  function recapLine(r, kind) {
    const line = el('div', 'recap');
    if (r.recap.asked) { line.appendChild(el('span', 'lbl', 'asked')); line.appendChild(el('span', 'asked', r.recap.asked)); }
    if (r.recap.now) { line.appendChild(el('span', 'lbl', 'now')); line.appendChild(el('span', 'now ' + kind, r.recap.now)); }
    line.title = (r.recap.asked ? 'Asked: ' + r.recap.asked + '\n' : '') + (r.recap.now ? 'Now: ' + r.recap.now : '') + '\n(a recap, rewritten each time its turn ends)';
    return line;
  }

  // ---- your note: typed in place ----
  // Typing a note opens the row, so the note is in sight when the box closes.
  function editNote(r) {
    noteEdit = { id: r.id, value: r.note || '' };
    if (!opened.has(r.id)) { opened.add(r.id); vscode.setState({ ...(vscode.getState() || {}), opened: [...opened] }); }
    render();
  }
  function endNote(save) {
    if (!noteEdit) return;
    const { id, value } = noteEdit;
    noteEdit = null;
    if (save) post({ type: 'note', id, text: value });
    render();
  }
  function noteBox(r, d) {
    d.draggable = false; // so dragging inside the box selects text
    const box = el('div', 'notebox');
    const input = el('input');
    input.type = 'text'; input.maxLength = 200; input.value = noteEdit.value;
    input.placeholder = 'A note for yourself: what to check, what it waits on…';
    input.addEventListener('input', () => { noteEdit.value = input.value; });
    input.addEventListener('keydown', ev => {
      ev.stopPropagation();
      if (ev.key === 'Enter') { ev.preventDefault(); endNote(true); }
      if (ev.key === 'Escape') { ev.preventDefault(); endNote(false); }
    });
    input.addEventListener('blur', () => { if (noteEdit && noteEdit.id === r.id) endNote(true); });
    for (const t of ['click', 'mousedown', 'dblclick', 'contextmenu']) input.addEventListener(t, ev => ev.stopPropagation());
    box.appendChild(input);
    box.appendChild(el('span', 'hint', 'Enter saves · Esc cancels · empty removes'));
    setTimeout(() => { if (document.body.contains(input) && document.activeElement !== input) { input.focus(); input.setSelectionRange(input.value.length, input.value.length); } }, 0);
    return box;
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
    // The moon: you're away for a long stretch or overnight. Clicking any session turns it off.
    const away = state.away && state.away.away;
    const moon = el('button', 'moon' + (away ? ' on' : ''), away ? '🌙 Away since ' + clock(state.away.since) : '🌙');
    moon.title = away
      ? 'You are marked away. Click to mark yourself back; clicking any session does too.'
      : 'Mark yourself away (a long stretch or overnight). Clicking any session marks you back.';
    moon.addEventListener('click', () => post({ type: 'toggleAway' }));
    const find = el('button', 'find' + (search.open ? ' on' : ''), '🔍');
    find.title = 'Search every session (Ctrl+Alt+F)';
    find.addEventListener('click', () => (search.open ? closeSearch() : openSearch()));
    bar.appendChild(find);
    bar.appendChild(moon);
    bar.appendChild(el('span', '', state.soundOn ? '🔔 sounds on' : '🔕 sounds off'));
    list.hidden = dismissedEl.hidden = search.open;
    if (noteEdit && !search.open && list.querySelector('.notebox')) return; // typing a note: leave the list be
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

  // ---- search: a box over every session, and Ask Claude ----
  // The box and its results live in #search, drawn only when they change, so typing is never
  // interrupted by the list's own updates.
  const search = { open: false, q: '', all: true, results: null, answer: null, timer: null };
  let box = null;
  function openSearch() {
    search.open = true;
    drawSearch();
    render();
    box.focus(); box.select();
  }
  function closeSearch() { search.open = false; drawSearch(); render(); }
  function runSearch() { if (search.q.trim()) post({ type: 'search', q: search.q, all: search.all }); else { search.results = null; drawResults(); } }
  function marked(text, marks) {
    const span = el('span', 'snip');
    let at = 0;
    for (const [s, e] of marks || []) {
      if (s < at) continue;
      span.appendChild(document.createTextNode(text.slice(at, s)));
      span.appendChild(el('mark', '', text.slice(s, e)));
      at = e;
    }
    span.appendChild(document.createTextNode(text.slice(at)));
    return span;
  }
  const STATUS = { busy: 'running', watching: 'watching', idle: 'idle', waiting: 'needs you', asleep: 'asleep', ended: 'ended' };
  function resultRow(r) {
    const d = el('div', 'hit');
    d.title = r.cwd + '\n' + r.id + (r.here ? '\nClick to open' + (r.status === 'asleep' ? ' (wakes it)' : '') : '\nFrom another Claude login or the Windows side: click to read its transcript');
    const top = el('div', 'hittop');
    top.appendChild(dot(r.status === 'ended' ? 'offline' : r.status, r.color));
    top.appendChild(el('span', 'name', r.title));
    top.appendChild(el('span', 'repo', r.repo));
    top.appendChild(el('span', 'state ' + r.status, STATUS[r.status] || r.status));
    top.appendChild(el('span', 'age', age(Date.now() - r.end)));
    d.appendChild(top);
    if (r.snippet) {
      const line = el('div', 'hitline');
      line.appendChild(el('span', 'who', r.where === 'you' ? 'you:' : r.where === 'Claude' ? 'Claude:' : r.where + ':'));
      line.appendChild(marked(r.snippet, r.marks));
      d.appendChild(line);
    }
    d.addEventListener('click', () => post({ type: 'openResult', id: r.id, file: r.file }));
    return d;
  }
  function drawAnswer(wrap) {
    const a = search.answer;
    if (!a || a.q !== search.q || a.all !== search.all) return;
    const card = el('div', 'answer ' + a.state);
    if (a.state === 'working') card.appendChild(el('div', '', 'Asking Claude… (10–30 seconds)'));
    else if (a.state === 'none') card.appendChild(el('div', '', 'Claude didn\'t find an answer in the best matches. Try other words, or look through the results below.'));
    else if (a.state === 'error') card.appendChild(el('div', '', a.text));
    else {
      card.appendChild(el('div', 'atext', a.text));
      for (const s of a.sources) {
        const src = el('div', 'source');
        src.appendChild(el('span', 'name', s.title));
        src.appendChild(el('span', 'repo', s.repo));
        if (s.quote) src.appendChild(el('div', 'quote', '“' + s.quote + '”'));
        src.title = 'Click to open this session';
        src.addEventListener('click', () => post({ type: 'openResult', id: s.id, file: s.file }));
        card.appendChild(src);
      }
    }
    wrap.appendChild(card);
  }
  function drawResults() {
    const wrap = searchEl.querySelector('.hits');
    if (!wrap) return;
    wrap.replaceChildren();
    drawAnswer(wrap);
    const m = search.results;
    if (!m || m.q !== search.q || m.all !== search.all) {
      if (!search.q.trim()) wrap.appendChild(el('div', 'empty', 'Words or "a phrase": titles, what you said, Claude\'s replies, files touched. Or ask a question and press Ask Claude.'));
      return;
    }
    if (m.progress) wrap.appendChild(el('div', 'empty', `Indexing your sessions… ${m.progress.done} of ${m.progress.total}`));
    if (!m.results.length && !m.progress) wrap.appendChild(el('div', 'empty', 'No session mentions that. Try fewer words, or Ask Claude.'));
    for (const r of m.results) wrap.appendChild(resultRow(r));
  }
  function drawSearch() {
    searchEl.hidden = !search.open;
    if (!search.open) { searchEl.replaceChildren(); box = null; return; }
    if (box) { drawResults(); return; }
    searchEl.replaceChildren();
    const row = el('div', 'sbar');
    box = el('input', 'sbox');
    box.type = 'text'; box.placeholder = 'Search your sessions…'; box.value = search.q;
    box.addEventListener('input', () => {
      search.q = box.value;
      clearTimeout(search.timer);
      search.timer = setTimeout(runSearch, 150);
    });
    box.addEventListener('keydown', ev => {
      if (ev.key === 'Escape') { ev.preventDefault(); closeSearch(); }
      if (ev.key === 'Enter') { clearTimeout(search.timer); runSearch(); }
    });
    row.appendChild(box);
    const scope = el('button', '', search.all ? 'All sessions' : 'This window');
    scope.title = 'Search every session on this machine, or only this window\'s';
    scope.addEventListener('click', () => { search.all = !search.all; scope.textContent = search.all ? 'All sessions' : 'This window'; runSearch(); });
    row.appendChild(scope);
    const ask = el('button', 'ask', 'Ask Claude ✦');
    ask.title = 'Claude reads the best matches and answers your question, with the sessions it came from (10–30 s, uses your Claude plan)';
    ask.addEventListener('click', () => { if (search.q.trim()) post({ type: 'ask', q: search.q, all: search.all }); });
    row.appendChild(ask);
    const x = el('button', 'x', '✕');
    x.title = 'Close search (Esc)';
    x.addEventListener('click', closeSearch);
    row.appendChild(x);
    searchEl.appendChild(row);
    searchEl.appendChild(el('div', 'hits'));
    drawResults();
  }

  window.addEventListener('message', ev => {
    const m = ev.data;
    if (!m) return;
    if (m.type === 'state') { state = m; render(); }
    else if (m.type === 'results') { search.results = m; drawResults(); }
    else if (m.type === 'answer') { search.answer = m; drawResults(); }
    else if (m.type === 'openSearch') openSearch();
  });
  setInterval(() => { if (state) { state.now += 15000; render(); } }, 15000);
  post({ type: 'ready' });
})();
