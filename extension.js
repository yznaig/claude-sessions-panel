// Claude Sessions — loader. Holds the panel's view and the Reload Panel command, and runs the
// panel itself from core.js. Reload Panel stops the running core.js and starts the newest
// installed copy's, so an update lands without reloading the window (which would interrupt the
// Claude sessions running in it). Keep this file small and stable: a change here, or to the
// package.json contributions (commands, keys, settings, menus), still needs a window reload.
'use strict';
const vscode = require('vscode');
const fs = require('fs');
const path = require('path');

const ID = 'yznaig.claude-sessions-panel';

function versionOf(dir) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).version || '0.0.0'; } catch { return '0.0.0'; }
}

function newer(a, b) {
  const pa = String(a).split('.').map(Number), pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  return false;
}

// The newest installed copy, from VS Code's list of installed extensions next to this one's folder.
// This copy when that list can't be read or names nothing usable (running from source).
function newestCopy(own) {
  let best = { dir: own, version: versionOf(own) };
  try {
    const parent = path.dirname(own);
    const list = JSON.parse(fs.readFileSync(path.join(parent, 'extensions.json'), 'utf8'));
    for (const e of list) {
      if (!e || !e.identifier || e.identifier.id !== ID) continue;
      const dir = (e.location && (e.location.fsPath || e.location.path)) || (e.relativeLocation && path.join(parent, e.relativeLocation));
      if (dir && fs.existsSync(path.join(dir, 'core.js')) && newer(e.version, best.version)) best = { dir, version: e.version };
    }
  } catch { /* keep this copy */ }
  return best;
}

function requireFresh(dir) {
  for (const k of Object.keys(require.cache)) if (k.startsWith(dir + path.sep)) delete require.cache[k];
  return require(path.join(dir, 'core.js'));
}

// The Usage view's module from the same copy; a stub when that copy predates it.
const NO_USAGE = { start() { return { attach() {}, stop() { return null; } }; } };
function usageFrom(dir) {
  const file = path.join(dir, 'usage.js');
  return fs.existsSync(file) ? require(file) : NO_USAGE;
}

function activate(context) {
  const own = context.extensionPath;
  let view = null;
  let copy = { dir: own, version: versionOf(own) };
  let core = requireFresh(own).start({ context, root: own, view: null, carried: null });
  let usageView = null;
  let usage = usageFrom(own).start({ context, root: own, view: null });
  let offered = copy.version; // the newest version already offered, so each is offered once

  context.subscriptions.push(vscode.window.registerWebviewViewProvider('claudeSessions.view', {
    resolveWebviewView(v) { view = v; core.attach(v); },
  }, { webviewOptions: { retainContextWhenHidden: true } }));
  context.subscriptions.push(vscode.window.registerWebviewViewProvider('claudeSessions.usage', {
    resolveWebviewView(v) { usageView = v; usage.attach(v); },
  }, { webviewOptions: { retainContextWhenHidden: true } }));

  function reload() {
    const next = newestCopy(own);
    const carried = core.stop();
    try { usage.stop(); } catch { /* replaced below */ }
    try {
      core = requireFresh(next.dir).start({ context, root: next.dir, view, carried });
      usage = usageFrom(next.dir).start({ context, root: next.dir, view: usageView });
    } catch (e) {
      try {
        core = requireFresh(copy.dir).start({ context, root: copy.dir, view, carried });
        usage = usageFrom(copy.dir).start({ context, root: copy.dir, view: usageView });
        vscode.window.showErrorMessage(`Claude Sessions: ${next.version} failed to load, kept ${copy.version} (${e.message}).`);
      } catch (e2) {
        core = { attach() {}, stop() { return carried; } };
        vscode.window.showErrorMessage(`Claude Sessions: the panel failed to load (${e.message}); reload the window to recover.`);
      }
      return;
    }
    const from = copy.version;
    copy = next;
    offered = newer(copy.version, offered) ? copy.version : offered;
    vscode.window.setStatusBarMessage(from === copy.version ? `Claude Sessions: panel reloaded (${copy.version})` : `Claude Sessions: panel updated ${from} → ${copy.version}`, 4000);
  }

  // A newer version installed: offer the reload once.
  function check() {
    const next = newestCopy(own);
    if (!newer(next.version, offered)) return;
    offered = next.version;
    vscode.window.showInformationMessage(`Claude Sessions ${next.version} is installed.`, 'Reload Panel').then(pick => { if (pick) reload(); });
  }
  let pending = null;
  let watcher = null;
  try { watcher = fs.watch(path.dirname(own), { persistent: false }, () => { clearTimeout(pending); pending = setTimeout(check, 3000); }); } catch { /* the poll covers it */ }
  const poll = setInterval(check, 5 * 60e3);

  context.subscriptions.push(
    vscode.commands.registerCommand('claudeSessions.reloadPanel', reload),
    { dispose: () => { if (watcher) watcher.close(); clearInterval(poll); clearTimeout(pending); core.stop(); usage.stop(); } },
  );
}

function deactivate() {}
module.exports = { activate, deactivate };
