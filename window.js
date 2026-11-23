// Which sessions belong to this VS Code window, judged by the session's folder (its cwd), or, for a
// session working in a git worktree, by the repo the worktree belongs to.
// `folders()` returns the window's workspace folder paths; it is called each time, since a window's
// folders can change while it runs.
'use strict';
const fs = require('fs');
const path = require('path');

// The repo a git worktree belongs to: a folder at or above `cwd` whose `.git` is a file reading
// `gitdir: <repo>/.git/worktrees/<name>` gives `<repo>`. A session working in a worktree kept outside
// its repo (a ticket worktree under ~/.claude/jobs) belongs to that repo's window. Answers are kept:
// a found repo for good, a miss for a minute (cwds are few; search filters thousands of rows).
const MISS_MS = 60e3;
const repos = new Map(); // cwd -> { repo, at }
function worktreeRepo(cwd, now = Date.now()) {
  const kept = repos.get(cwd);
  if (kept && (kept.repo || now - kept.at < MISS_MS)) return kept.repo;
  let repo = null;
  for (let d = cwd; d && d !== path.dirname(d); d = path.dirname(d)) {
    let text;
    try { text = fs.readFileSync(path.join(d, '.git'), 'utf8'); }
    catch (e) { if (e.code === 'EISDIR') break; continue; } // a plain repo, or no .git here
    const m = /^gitdir:\s*(.+?)\/\.git\/worktrees\/[^/]+\s*$/m.exec(text);
    if (m) repo = m[1];
    break;
  }
  repos.set(cwd, { repo, at: now });
  return repo;
}

function windowScope(folders) {
  const under = (cwd, fs) => fs.some(f => cwd === f || cwd.startsWith(f + '/'));
  const inside = cwd => {
    if (!cwd) return false;
    const fs = folders().map(f => f.replace(/\/$/, ''));
    if (!fs.length) return false;
    if (under(cwd, fs)) return true;
    const repo = worktreeRepo(cwd);
    return !!repo && under(repo, fs);
  };
  return {
    // This window's own session: its saved copy is this window's to keep or drop.
    // A window with no folder owns none.
    owns: inside,
    // Listed under "This window". A window with no folder lists every session.
    shows: cwd => !folders().length || !cwd || inside(cwd),
    // Two sessions in the same window: both inside this one, or, for another window's, the same folder.
    sameWindow: (a, b) => (inside(a) || inside(b) ? inside(a) && inside(b) : !!a && a === b),
  };
}

module.exports = { windowScope, worktreeRepo };
