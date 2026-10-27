// Which sessions belong to this VS Code window, judged by the session's folder (its cwd).
// `folders()` returns the window's workspace folder paths; it is called each time, since a window's
// folders can change while it runs.
'use strict';

function windowScope(folders) {
  const inside = cwd => {
    const fs = folders().map(f => f.replace(/\/$/, ''));
    return !!cwd && fs.some(f => cwd === f || cwd.startsWith(f + '/'));
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

module.exports = { windowScope };
