# Changelog

## 0.8.0 — 2026-10-25
**↻ Reload Panel** loads the newest installed version of the panel without reloading the window, keeping the rows, ready and waiting marks, and Removed list; a newly installed version offers it in a notification. The panel code moved to `core.js`, run by a small loader in `extension.js`. Changes to the loader or to the manifest's commands, keys, settings and menus still need a window reload.

## 0.7.0 — 2026-10-25
Idle sessions no longer drop off the list after 12 hours: they stay until you remove them, they close, or they end. The timer moved to the Removed list: a removed session clears from it 12 hours after you removed it (setting `claudeSessions.removedClearHours`, replacing `idleHideHours`).

## 0.6.0 — 2026-10-24
The session list survives a VS Code restart: sessions listed when VS Code closes come back as "not running" rows, and a click reopens one. The Removed list is cleared on restart. On the first start after upgrading, the list is rebuilt from the records the stopped sessions left in the registry.

## 0.5.1 — 2026-10-23
A finished session now also leaves when you switch away with a click in this panel: another session shown since counts as leaving it. The panel watches the trail folder, so it leaves at once.

## 0.5.0 — 2026-10-23
Alt+A: ask an aside about the text you highlighted in a Claude reply, handed to the side-fork mod in the session on screen.

## 0.4.0 — 2026-10-23
Sessions whose last turn was an anything-left run that answered "Good to close" show as closed and move to Removed once you switch away from them.

## 0.3.1 — 2026-10-23
Session names follow the titles Claude gives a session and the names you set, read from its transcript the way the Claude extension's own list does, instead of the registry's placeholder.

## 0.3.0 — 2026-10-23
Alt+Q / Alt+Shift+Q walk back and forward through the sessions you looked at in this window, with the session-trail companion mod.

## 0.2.0 — 2026-10-23
First public release: panel view over the Claude Code session registry, running / ready / waiting states, badge, bundled VS Code chimes with pickers, focus on click, dismiss and restore, per-window filter.
