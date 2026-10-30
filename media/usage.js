// Usage view: renders the cards usage.js sends. ↻ in the view's title bar or the header reads again.
(function () {
  const vscode = acquireVsCodeApi();
  const head = document.getElementById('head');
  const root = document.getElementById('cards');

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function clock(t) { return new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); }

  function resetText(t, now) {
    const ms = t - now;
    if (ms <= 0) return 'reset';
    const mins = Math.round(ms / 60000);
    if (mins < 60) return `resets in ${mins}m`;
    const h = Math.floor(mins / 60);
    if (h < 24) return `resets in ${h}h ${mins % 60}m · ${clock(t)}`;
    const d = new Date(t);
    return `resets ${d.toLocaleDateString([], { weekday: 'short' })} ${clock(t)}`;
  }

  function readText(t, now) {
    if (!t) return '';
    const mins = Math.round((now - t) / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    if (mins < 24 * 60) return clock(t);
    return new Date(t).toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' + clock(t);
  }

  function level(p) { return p >= 90 ? 'high' : p >= 70 ? 'mid' : 'low'; }

  function card(c, s) {
    const box = el('div', 'card' + (c.state !== 'ok' ? ' ' + c.state : '') + (c.limitReached ? ' limited' : ''));
    const top = el('div', 'top');
    top.append(el('span', 'kind', c.kind === 'claude' ? 'Claude' : 'Codex'), el('span', 'label', c.label));
    if (c.plan) top.append(el('span', 'plan', c.plan));
    box.append(top);
    if (c.email) box.append(el('div', 'email', c.email));

    if (c.state === 'asleep') {
      const row = el('div', 'note');
      const waking = s.waking.includes(c.id);
      row.append(el('span', null, waking ? 'Waking…' : `Asleep: login token expired${c.readAt ? ` · last read ${readText(c.readAt, s.now)}` : ''}`));
      if (!waking) {
        const b = el('button', 'wake', 'Wake');
        b.title = 'Run one tiny Haiku prompt on this login so Claude Code renews it, then read again (uses a sliver of this account\'s usage)';
        b.onclick = () => vscode.postMessage({ type: 'wake', id: c.id });
        row.append(b);
      }
      box.append(row);
    } else if (c.state === 'error') {
      box.append(el('div', 'note err', c.error + (c.readAt ? ` · last read ${readText(c.readAt, s.now)}` : '')));
    } else if (c.state === 'throttled') {
      const n = el('div', 'note', c.readAt ? `Rate limited · last read ${readText(c.readAt, s.now)}` : 'Rate limited · no reading yet, try ↻ in a few minutes');
      n.title = 'The usage service is refusing reads for this login for now, usually because something else reads it often. Try ↻ later.';
      box.append(n);
    }

    for (const w of c.windows || []) {
      const row = el('div', 'win' + (c.state !== 'ok' ? ' stale' : ''));
      const bar = el('div', 'bar');
      const fill = el('div', 'fill ' + level(w.percent));
      fill.style.width = Math.min(100, w.percent) + '%';
      bar.append(fill);
      row.append(el('span', 'wlabel', w.label), bar, el('span', 'pct', w.percent + '%'));
      row.append(el('span', 'reset', !w.started ? 'not started' : w.resetsAt ? resetText(w.resetsAt, s.now) : ''));
      box.append(row);
    }
    if (c.state === 'ok' && !(c.windows || []).length) box.append(el('div', 'note', 'No usage windows reported'));
    return box;
  }

  function render(s) {
    head.textContent = '';
    const info = el('span', null, s.refreshing ? 'Reading…' : s.refreshedAt ? `Read ${readText(s.refreshedAt, s.now)}` : '');
    const b = el('button', null, '↻ Refresh');
    b.disabled = s.refreshing;
    b.onclick = () => vscode.postMessage({ type: 'refresh' });
    head.append(info, b);
    root.textContent = '';
    if (!s.cards.length && !s.refreshing) root.append(el('div', 'note', 'No Claude Code or Codex logins found in ~/.claude* or ~/.codex*.'));
    for (const c of s.cards) root.append(card(c, s));
  }

  window.addEventListener('message', e => { if (e.data && e.data.type === 'state') render(e.data); });
  vscode.postMessage({ type: 'ready' });
})();
