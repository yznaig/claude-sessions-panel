// Claude Sessions — the Usage view. One card per Claude Code and Codex login on this machine,
// each with its current usage windows (5-hour, weekly, per-model weekly) and when they reset.
// Reads on open and on ↻ only; it never polls. Run by extension.js like core.js, so Reload Panel
// swaps it in without a window reload.
//
// Accounts are found, not configured: every ~/.claude* folder holding a .credentials.json and
// every ~/.codex* folder holding a ChatGPT-mode auth.json (the CLAUDE_CONFIG_DIR / CODEX_HOME
// pattern for running several logins side by side). The token is read from that file and sent
// only to the service that issued it, the same usage endpoint each CLI calls for /usage or /status.
// Neither endpoint is documented for outside use; when one changes, its cards show the error.
//
// A Claude login whose access token has expired is shown asleep with its last reading. Claude
// Code renews the token only while it runs on that login, so Wake runs one tiny print-mode prompt
// on it (a sliver of that account's usage) and reads again. The panel never renews tokens itself:
// a renewal racing a running session's can sign that session out.
'use strict';
const vscode = require('vscode');
const fs = require('fs');
const https = require('https');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const CACHE_KEY = 'claudeSessions.usage.last';
const CLAUDE_URL = 'https://api.anthropic.com/api/oauth/usage';
const CODEX_URL = 'https://chatgpt.com/backend-api/wham/usage';

function readJson(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } }

// ---- discovery ----------------------------------------------------------------

function discover(home = os.homedir()) {
  let names = [];
  try { names = fs.readdirSync(home); } catch { /* none */ }
  const out = [];
  for (const name of names.sort()) {
    const m = /^\.(claude|codex)(?:-([\w.-]+))?$/.exec(name);
    if (!m) continue;
    const dir = path.join(home, name);
    const kind = m[1];
    const label = m[2] || 'default';
    if (kind === 'claude' && fs.existsSync(path.join(dir, '.credentials.json'))) {
      out.push({ id: name, kind, label, dir, isDefault: !m[2] });
    } else if (kind === 'codex') {
      const auth = readJson(path.join(dir, 'auth.json'));
      if (auth && auth.tokens && auth.tokens.access_token) out.push({ id: name, kind, label, dir, isDefault: !m[2] });
    }
  }
  return out.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'claude' ? -1 : 1));
}

// ---- parsing (pure) -------------------------------------------------------------

const CLAUDE_PLANS = { max: 'Max', pro: 'Pro', team: 'Team', enterprise: 'Enterprise', free: 'Free' };

function claudePlan(creds) {
  const o = (creds && creds.claudeAiOauth) || {};
  const plan = CLAUDE_PLANS[o.subscriptionType] || o.subscriptionType || '';
  const tier = /max_(\d+x)/.exec(o.rateLimitTier || '');
  return plan === 'Max' && tier ? `Max ${tier[1]}` : plan;
}

// The usage response's `limits` list when present, else its five_hour / seven_day fields.
function claudeWindows(data) {
  const pct = n => Math.max(0, Math.round(Number(n) || 0));
  if (Array.isArray(data && data.limits) && data.limits.length) {
    return data.limits.map(l => {
      const model = l.scope && l.scope.model && (l.scope.model.display_name || l.scope.model.id);
      const label = l.kind === 'session' ? '5-hour' : l.group === 'weekly' ? (model ? `Weekly · ${model}` : 'Weekly') : (model || l.kind);
      return { label, percent: pct(l.percent), resetsAt: l.resets_at ? Date.parse(l.resets_at) : null, started: !!l.resets_at };
    });
  }
  const out = [];
  const add = (key, label) => { const w = data && data[key]; if (w) out.push({ label, percent: pct(w.utilization), resetsAt: w.resets_at ? Date.parse(w.resets_at) : null, started: !!w.resets_at }); };
  add('five_hour', '5-hour'); add('seven_day', 'Weekly'); add('seven_day_opus', 'Weekly · Opus'); add('seven_day_sonnet', 'Weekly · Sonnet');
  return out;
}

function windowName(seconds) {
  if (seconds === 18000) return '5-hour';
  if (seconds === 604800) return 'Weekly';
  if (seconds % 86400 === 0) return `${seconds / 86400}-day`;
  return `${Math.round(seconds / 3600)}-hour`;
}

function codexWindows(data, now = Date.now()) {
  const rl = (data && data.rate_limit) || {};
  const out = [];
  for (const w of [rl.primary_window, rl.secondary_window]) {
    if (!w) continue;
    // A window that hasn't started reports its full length as the time left.
    const started = !(Number(w.used_percent) === 0 && w.reset_after_seconds >= w.limit_window_seconds);
    out.push({
      label: windowName(w.limit_window_seconds),
      percent: Math.max(0, Math.round(Number(w.used_percent) || 0)),
      resetsAt: started ? (w.reset_at ? w.reset_at * 1000 : now + w.reset_after_seconds * 1000) : null,
      started,
    });
  }
  return out;
}

const CODEX_PLANS = { plus: 'Plus', pro: 'Pro', prolite: 'Pro Lite', team: 'Team', business: 'Business', enterprise: 'Enterprise', edu: 'Edu', free: 'Free' };

// ---- reading --------------------------------------------------------------------

// IPv4 on purpose: where IPv6 resolves but doesn't route (common under WSL), Node's default
// connect hangs until it times out.
function getJson(url, headers) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers, family: 4, timeout: 15000 }, res => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', d => { text += d; });
      res.on('end', () => {
        let body = null;
        try { body = JSON.parse(text); } catch { /* not json */ }
        resolve({ status: res.statusCode, body, text });
      });
    });
    req.on('timeout', () => req.destroy(Object.assign(new Error('Timed out'), { name: 'TimeoutError' })));
    req.on('error', reject);
  });
}

function claudeEmail(acct) {
  const file = acct.isDefault ? path.join(os.homedir(), '.claude.json') : path.join(acct.dir, '.claude.json');
  const d = readJson(file);
  return (d && d.oauthAccount && d.oauthAccount.emailAddress) || '';
}

async function readClaude(acct) {
  const creds = readJson(path.join(acct.dir, '.credentials.json'));
  const o = creds && creds.claudeAiOauth;
  const base = { plan: claudePlan(creds), email: claudeEmail(acct) };
  if (!o || !o.accessToken) return { ...base, state: 'error', error: 'No login in .credentials.json' };
  if (o.expiresAt && o.expiresAt < Date.now()) return { ...base, state: 'asleep' };
  const r = await getJson(CLAUDE_URL, { Authorization: `Bearer ${o.accessToken}`, 'anthropic-beta': 'oauth-2025-04-20', 'User-Agent': 'claude-sessions-panel' });
  if (r.status === 401) return { ...base, state: 'asleep' };
  if (r.status !== 200 || !r.body) return { ...base, state: 'error', error: `Usage read failed (HTTP ${r.status})` };
  return { ...base, state: 'ok', windows: claudeWindows(r.body) };
}

async function readCodex(acct) {
  const auth = readJson(path.join(acct.dir, 'auth.json'));
  const t = auth && auth.tokens;
  if (!t || !t.access_token) return { state: 'error', error: 'No login in auth.json' };
  const headers = { Authorization: `Bearer ${t.access_token}`, 'User-Agent': 'claude-sessions-panel' };
  if (t.account_id) headers['ChatGPT-Account-Id'] = t.account_id;
  const r = await getJson(CODEX_URL, headers);
  if (r.status === 401) return { state: 'error', error: 'Sign-in expired: run Codex once on this login' };
  if (r.status !== 200 || !r.body) return { state: 'error', error: `Usage read failed (HTTP ${r.status})` };
  const b = r.body;
  return {
    state: 'ok', plan: CODEX_PLANS[b.plan_type] || b.plan_type || '', email: b.email || '',
    windows: codexWindows(b), limitReached: !!(b.rate_limit && b.rate_limit.limit_reached),
  };
}

async function readOne(acct) {
  try { return await (acct.kind === 'claude' ? readClaude(acct) : readCodex(acct)); }
  catch (e) { return { state: 'error', error: e.name === 'TimeoutError' ? 'Timed out' : (e.message || String(e)) }; }
}

// Wake: one print-mode prompt on that login, so Claude Code renews its token. No tools, no MCP,
// no saved session; run from the temp folder so no project's settings or hooks load.
function wakeClaude(acct) {
  const env = { ...process.env };
  if (acct.isDefault) delete env.CLAUDE_CONFIG_DIR; else env.CLAUDE_CONFIG_DIR = acct.dir;
  env.PATH = [path.join(os.homedir(), '.local', 'bin'), env.PATH || ''].join(path.delimiter);
  const args = ['-p', 'Reply with the single word: ok', '--model', 'haiku', '--no-session-persistence', '--strict-mcp-config', '--tools', ''];
  return new Promise(resolve => {
    execFile('claude', args, { env, cwd: os.tmpdir(), timeout: 90000 }, (err, stdout, stderr) => {
      resolve(err ? (String(stderr || '').trim().split('\n').pop() || err.message) : null);
    });
  });
}

// ---- view -----------------------------------------------------------------------

function html(webview, rootUri) {
  const nonce = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
  const script = webview.asWebviewUri(vscode.Uri.joinPath(rootUri, 'media', 'usage.js'));
  const style = webview.asWebviewUri(vscode.Uri.joinPath(rootUri, 'media', 'usage.css'));
  return `<!DOCTYPE html><html><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<link rel="stylesheet" href="${style}"><title>Usage</title></head>
<body><div id="head"></div><div id="cards"></div>
<script nonce="${nonce}" src="${script}"></script></body></html>`;
}

function start(host) {
  const { context } = host;
  const rootUri = vscode.Uri.file(host.root);
  const subs = [];
  // id -> { account fields, reading fields, readAt }: the last good reading survives asleep and errors.
  const last = { ...(context.globalState.get(CACHE_KEY) || {}) };
  let cards = [];
  let refreshing = false;
  let refreshedAt = null;
  const waking = new Set();
  let view = null;
  let listeners = [];

  function push() {
    if (view) void view.webview.postMessage({ type: 'state', cards, refreshing, refreshedAt, waking: [...waking], now: Date.now() });
  }

  function cardFor(acct, reading) {
    const now = Date.now();
    const prev = last[acct.id];
    if (reading.state === 'ok') last[acct.id] = { windows: reading.windows, readAt: now };
    const shown = reading.state === 'ok' ? reading : { ...reading, windows: prev ? prev.windows : [], stale: !!prev, readAt: prev ? prev.readAt : null };
    return { id: acct.id, kind: acct.kind, label: acct.label, plan: reading.plan || (prev && prev.plan) || '', email: reading.email || '', ...shown, readAt: reading.state === 'ok' ? now : shown.readAt };
  }

  async function refresh(onlyId) {
    if (refreshing && !onlyId) return;
    const accounts = discover();
    if (!onlyId) { refreshing = true; push(); }
    const targets = onlyId ? accounts.filter(a => a.id === onlyId) : accounts;
    const readings = await Promise.all(targets.map(readOne));
    const fresh = targets.map((a, i) => cardFor(a, readings[i]));
    if (onlyId) cards = cards.map(c => fresh.find(f => f.id === c.id) || c);
    else { cards = fresh; refreshedAt = Date.now(); refreshing = false; }
    for (const c of fresh) if (last[c.id] && c.plan) last[c.id].plan = c.plan;
    void context.globalState.update(CACHE_KEY, last);
    push();
  }

  async function wake(id) {
    const acct = discover().find(a => a.id === id);
    if (!acct || acct.kind !== 'claude' || waking.has(id)) return;
    waking.add(id); push();
    const err = await wakeClaude(acct);
    waking.delete(id);
    if (err) vscode.window.showWarningMessage(`Usage: could not wake ${acct.label} (${err}).`);
    await refresh(id);
  }

  function attach(v) {
    for (const l of listeners) l.dispose();
    view = v;
    v.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(rootUri, 'media')] };
    v.webview.html = html(v.webview, rootUri);
    listeners = [v.webview.onDidReceiveMessage(m => {
      if (m.type === 'refresh') void refresh();
      else if (m.type === 'wake') void wake(m.id);
      else if (m.type === 'ready') push();
    })];
    // One read the first time the view opens in this window; after that only ↻ reads.
    if (!refreshedAt && !refreshing) void refresh(); else push();
  }

  subs.push(vscode.commands.registerCommand('claudeSessions.refreshUsage', () => refresh()));
  if (host.view) attach(host.view);
  return {
    attach,
    stop() {
      for (const l of listeners) l.dispose();
      for (const s of subs.splice(0)) { try { s.dispose(); } catch { /* keep going */ } }
      return null;
    },
  };
}

module.exports = { start, discover, readOne, wakeClaude, claudeWindows, codexWindows, claudePlan, windowName };
