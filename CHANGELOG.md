# Changelog

## 0.18.3 — 2026-10-29
A usage read the service refuses as rate limited (HTTP 429) no longer shows as a red error. The card says **Rate limited · last read 7m ago** and keeps its last reading, dimmed. This happens when something else reads the same login's usage often, such as an overnight runner. Press ↻ again later.

## 0.18.2 — 2026-10-29
Twelve more dot colors: a row of grays from white to black, 48 in all. Very dark and very light ones get a faint ring so they don't disappear into the panel's background.

## 0.18.1 — 2026-10-29
A fuller range of dot colors: the whole color wheel, 12 hues (red through pink) each in a light, medium and deep shade, 36 in all. Colors already chosen stay as they are.

## 0.18.0 — 2026-10-29
**Dot colors.** Right-click a session's dot (or pick **Dot color…** in its ⋯ menu) to give it one of 16 pastels, mostly greens, teals and blues, so you can tell sessions apart at a glance; **No color** takes it off. The color replaces the dot's gray, green and blue, but the dot keeps its shape for the state: it still spins while running, glows when ready or waiting, and is a ring when asleep or not running. The row's green or blue background still shows ready and needs-you. Colors are shared by every window and stay through sleep, Removed and restarts; search results show them too.

## 0.17.3 — 2026-10-29
Clicking a session that runs in the background (started with `claude --bg`, as session-hive sub-sessions are) brings it into VS Code instead of hitting "This conversation is still open somewhere else". Done with its turn, it is stopped there with `claude stop` (the conversation is kept) and opens here a second later. Still working or waiting for an answer, it is left running, and the panel offers to watch it in a terminal (`claude attach`).

## 0.17.2 — 2026-10-28
Hovering a session shows the name other sessions know it by (`hire-17`, `command-hq-e2`: Claude Code's registry name, used when sessions message each other), above its folder and id. A session that is no longer running shows the name it had ("Was hire-17"); one whose registry name is just its title shows nothing extra.

## 0.17.1 — 2026-10-28
Session names get the room: every other column (repo, time chip, status, age) is now as wide as the widest thing in it, instead of a fixed width kept on every row, so names stop cutting off early in a narrow or zoomed panel.

## 0.17.0 — 2026-10-28
**Search every session.** 🔍 in the top bar (or Ctrl+Alt+F) opens a box over every Claude Code session on the machine, running or long ended: results as you type, ranked by where the words turn up (titles first, then what you said, files touched, Claude's final replies), with the matching line and who said it. Click one to open it, or wake it if asleep. **Ask Claude ✦** answers a vague question ("where did we decide where the moon goes?") from the best matches, with the sessions it came from and the passage that says so (one Sonnet call, 10–30 s, on your Claude plan). The index is kept in `~/.claude/sessions-panel/search-index.json`; the first build takes a few seconds in the background.

## 0.16.0 — 2026-10-27
**Sessions stop when you're done with them.** The ✕ now also stops the session's process, asking first if it is working or waiting for you. A session quiet for 4 hours (setting `claudeSessions.autoCloseHours`, 0 = off) is stopped too but stays where it is on the list, dimmed as **asleep**, still green if its reply is unread; click it to wake it. Never stopped: sessions working, waiting for you, on screen, running a background command or subagent, in a terminal, or marked **Keep running** (⋯ menu, 📌). Every stop first checks the pid is still the session's and on this machine. Auto-close needs the session-trail mod (it is how the panel knows what is on screen); without it, only the ✕ stops sessions.

## 0.15.0 — 2026-10-26
A **🌙 moon** in the top bar marks you away (a long stretch or overnight). It writes `~/.claude/sessions-panel/away.json` with the time it went on, for other sessions to read; click it again, or click any session or star in the panel, to mark yourself back.

## 0.14.0 — 2026-10-26
No change in what the panel does. Inside: a test suite (`npm test`, about 40 checks through the real code), and the session tracking moved out of `core.js` into `sessions.js`, where each saved list (Removed, the restart list, folders) has one owner, with `transcript.js` and `window.js` beside it.

## 0.13.1 — 2026-10-26
The star no longer shows on running sessions. Clicking it there turned the row green for a few seconds until the next refresh; a running session turns green by itself when its turn ends.

## 0.13.0 — 2026-10-26
A **☆** next to the repo name on hover marks a running session green again, so a session you looked at but still owe something stays flagged; it gets a time chip and counts on the badge like any green. Click the ★ to clear the mark, or click the row as usual. Not shown on sessions that are running, need you, closed, or not running.

## 0.12.1 — 2026-10-26
The time chip sits right against the row's status instead of after the repo name, and the repo pills line up down the list.

## 0.12.0 — 2026-10-26
**Time chips**: each session with a response ready shows roughly how long it will take you (reading time plus 45 seconds per numbered decision), colored teal to red, and ready sessions sort shortest first, with a total under the list. No window reload needed: ↻ Reload Panel picks it up.

## 0.11.0 — 2026-10-26
**Folders**: tabs along the top of the list (Main, then your folders, each with a count) to file sessions you want to come back to without keeping them on the main list. Move one with its ⋯ button, a right-click, or by dragging it onto a tab. Filed sessions stay put through restarts, other windows and ending, until you move or remove them or they close. In a folder, a session that needs you still sounds and counts on the badge, and a ready response is a quiet dot on the folder's tab. The panel's snapshot carries each row's folder. read-sessions (session-trail 0.2.2) reads only Main by default and says what it left out; `panel --folder NAME` reads one folder, `--all-folders` everything. No window reload needed: ↻ Reload Panel picks it up.

## 0.10.0 — 2026-10-26
The panel writes the rows it shows to `~/.claude/sessions-panel/<window>.json` whenever they change, and the companion plugin (0.2.0) gains the **read-sessions** skill: ask a session to read "the sessions in my panel", "my recent sessions on X" or "all the sessions that touched X", and it finds them, reads them to a depth that fits the count, and reports one consolidated picture. Its finder, `find_sessions.py`, also works on its own.

## 0.9.1 — 2026-10-26
Clicking a row (or Alt+Q) opens the session where Claude Code's **Preferred Location** setting says: the chat sidebar when it is set to sidebar, or the session's own tab when it already has one. Before, a session not on screen (every "not running" row after a restart) always opened in a new tab and switched that setting to tabs.

## 0.9.0 — 2026-10-26
A **Usage** view: one card per Claude Code and Codex login on the machine (every `~/.claude*` and `~/.codex*` folder with a login), with each usage window's percent and reset time. Reads on open and on ↻ only. A Claude login with an expired token shows its last reading and a **Wake** button that renews it through one tiny `claude -p` prompt. The view has its own activity-bar icon, so it can sit in the right sidebar while Sessions stays in the bottom panel. Needs one window reload (new view and command).

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
