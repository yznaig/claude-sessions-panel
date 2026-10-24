// Renders the session list from host state messages; sends clicks back to the host.
(function () {
  const vscode = acquireVsCodeApi();
  const bar = document.getElementById('bar');
  const list = document.getElementById('list');
  const dismissedEl = document.getElementById('dismissed');
  let state = null;

  function age(ms) {
    const s = Math.max(0, Math.round(ms / 1000));
    if (s < 60) return s + 's';
    const m = Math.round(s / 60); if (m < 60) return m + 'm';
    const h = Math.round(m / 60); if (h < 48) return h + 'h';
    return Math.round(h / 24) + 'd';
  }
  function label(r) {
    if (r.closed) return '✓ closed';
    if (r.attention === 'waiting') return r.waitingFor ? 'needs you: ' + r.waitingFor : 'needs you';
    if (r.attention === 'ready') return 'response ready';
    if (r.status === 'busy') return 'running';
    if (r.status === 'waiting') return 'needs you';
    return 'idle';
  }
  function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; }

  function row(r) {
    const kind = r.closed ? 'closed' : (r.attention || r.status);
    const d = el('div', 'row ' + (r.attention || '') + (r.closed ? ' closedRow' : '') + (r.dismissed ? ' dismissedRow' : ''));
    d.title = r.cwd + '\n' + r.id;
    d.appendChild(el('span', 'dot ' + kind));
    d.appendChild(el('span', 'name', r.name));
    d.appendChild(el('span', 'repo', r.repo));
    d.appendChild(el('span', 'state ' + kind, label(r)));
    d.appendChild(el('span', 'age', age(state.now - r.since)));
    const x = el('button', 'x', r.dismissed ? '↩' : '✕');
    x.title = r.dismissed ? 'Bring back' : 'Remove from list';
    x.addEventListener('click', ev => { ev.stopPropagation(); vscode.postMessage({ type: r.dismissed ? 'restore' : 'dismiss', id: r.id }); });
    d.appendChild(x);
    d.addEventListener('click', () => vscode.postMessage({ type: 'focus', id: r.id }));
    return d;
  }

  function render() {
    if (!state) return;
    const live = state.rows.filter(r => !r.dismissed);
    const gone = state.rows.filter(r => r.dismissed);
    bar.replaceChildren();
    const scope = el('button', state.showAll ? 'on' : '', state.showAll ? 'All windows' : 'This window: ' + state.window);
    scope.title = 'Toggle between this window\'s sessions and every window\'s';
    scope.addEventListener('click', () => vscode.postMessage({ type: 'toggleAll' }));
    bar.appendChild(scope);
    const dis = el('button', state.showDismissed ? 'on' : '', 'Removed (' + gone.length + ')');
    dis.addEventListener('click', () => vscode.postMessage({ type: 'toggleDismissed' }));
    bar.appendChild(dis);
    bar.appendChild(el('span', '', state.soundOn ? '🔔 sounds on' : '🔕 sounds off'));
    list.replaceChildren();
    if (!live.length) list.appendChild(el('div', 'empty', 'No live Claude sessions here. Start one and it appears when it first runs.'));
    for (const r of live) list.appendChild(row(r));
    dismissedEl.replaceChildren();
    if (state.showDismissed && gone.length) {
      dismissedEl.appendChild(el('h4', '', 'Removed — click ↩ to bring one back; any new activity brings it back on its own'));
      for (const r of gone) dismissedEl.appendChild(row(r));
    }
  }

  window.addEventListener('message', ev => { if (ev.data && ev.data.type === 'state') { state = ev.data; render(); } });
  setInterval(() => { if (state) { state.now += 15000; render(); } }, 15000);
  vscode.postMessage({ type: 'ready' });
})();
