# Claude Sessions

A VS Code panel tab (next to Terminal) that lists your live Claude Code sessions and tells you which ones want you.

- **Spinner** — the session is running.
- **Green** — it finished a turn and has a response you haven't looked at yet.
- **Time chip** on each green row: roughly how long the reply will take you, so you can clear the quick ones first and get them running again while you take the long ones. Green rows sort shortest first. The estimate reads the turn's final reply (the text after its last tool call) at 230 words a minute and adds 45 seconds per numbered item, since replies number only the decisions they ask of you. The chip runs from teal (quick) through amber to red (8 minutes or more); hover it for the breakdown. With two or more on a tab, a line under the list totals them.
- **Blue** — it is waiting on you: a permission, a question, an MCP dialog.
- **☆ Star** (on hover, right of the repo name) marks a running session green again: you looked at it, but it still has something for you. Click **★** to clear the mark; clicking the row clears it too. It isn't offered on a running session, which turns green by itself when its turn ends.
- **Badge** on the panel tab counts sessions that need you, so it shows even when the panel is collapsed.
- **Sound** on each green and blue transition. Default green is VS Code's success sound, default blue is VS Code's "chat needs your action" sound. **Claude Sessions: Pick Ready Sound** / **Pick Waiting Sound** preview the bundled set as you arrow through it; any `.wav` path works too, so you can drop in your own editor's chime.
- **Click a row** to focus that session. It opens where Claude Code's *Preferred Location* setting (`claudeCode.preferredLocation`) says: set it to `sidebar` and sessions open in the chat sidebar, except one that already has its own tab, which is revealed.
- **✕** removes a session you're done with and stops its process (Claude Code's VS Code extension leaves a session's process running after you switch away from it or archive it: 200–400 MB each, plus its MCP helpers). If the session is working or waiting for your answer, it asks first: stop and remove, or remove and leave it running. Terminal sessions are only removed, never stopped. **Removed (n)** shows them; **↩** brings one back. Any new activity in a removed session brings it back on its own. The Removed list is cleared when VS Code restarts, and each removed session leaves it 12 hours after you removed it (setting `claudeSessions.removedClearHours`).
- **Asleep sessions.** A session quiet for 4 hours has its process stopped, but stays exactly where it is on the list, dimmed and marked **asleep**; a reply you hadn't read stays green, with its time chip. Click it to wake it: Claude Code resumes the conversation in a new process (if its tab is still open, the tab shows "process exited with code 143" until you type, then carries on). Never stopped: a session that is working, waiting for you, on screen in some window, running a background command or subagent, or marked **Keep running** (⋯ menu, shown as 📌; for sessions you're watching, like a runner watcher). The hours are the setting `claudeSessions.autoCloseHours`; 0 turns it off. Before stopping anything the panel checks the process is still that session's (its start time matches the registry) and on this machine.
- **The list survives a restart.** Sessions listed when VS Code closes come back as dim **not running** rows; click one to reopen it, and it turns back into a live row. A session you end while VS Code keeps running leaves the list as before.
- **Alt+Q** jumps back to the session you looked at before this one. Keep pressing to walk further back; **Alt+Shift+Q** walks forward again. Switching to a session yourself starts a fresh walk from there. It needs the companion mod below.
- **Alt+A** asks an aside about whatever you highlighted in a Claude reply: select the text, press Alt+A, and the session on screen opens a side question on it above its prompt box, answered from a fork of the conversation. Your clipboard is left as it was. It needs the `side-fork` mod in the session as well as the companion mod below.
- **🌙 Moon** (top bar) marks you away for a long stretch or overnight: one switch for the whole machine, lit with the time it went on. Click it again, or click any session (or its star) in the panel, and you're back. It's kept in `~/.claude/sessions-panel/away.json` so any Claude session can read it without the panel open: `{"away": true, "since": <ms>, "sinceIso": "...", "changedAt": <ms>, "how": "moon" | "clicked a session"}`; no file means not away. It only records the state; nothing in the panel acts on it.
- **This window / All windows** filters to sessions whose folder is inside this window's workspace. Two windows, two lists.
- **Folders** file sessions away from the main list without losing them. Tabs along the top: **Main** holds every session not in a folder, then one tab per folder, each with a count, and **+** makes a new one. Move a session with its **⋯** button, by right-clicking it, or by dragging it onto a tab. A session is in one folder at most. Filed sessions stay there across restarts and windows, even when not running (a dim **not running** row; click to reopen), and new activity doesn't pull them out. A **Good to close** or **✕** still takes one out. A filed session that **needs you** still sounds and counts on the badge. One with a **response ready** stays quiet and puts a dot on its folder's tab instead. Right-click a folder's tab (or its **⋯** while it's open) to rename it or delete it; deleting sends its sessions back to Main. Folders are shared by every window; each window remembers which tab it shows.
- **Closed sessions leave on their own.** When a session's last turn ran the `anything-left` skill and its answer opens with "Good to close", the row turns into a dim **✓ closed** with no sound or badge. Once you switch away from it, it moves to Removed. Keep working in it and it comes back. Without the companion mod the panel can't tell when you left, so it moves the session two minutes after the answer instead. The skill's name and the phrase are constants at the top of the transcript section in `core.js`.
- Idle sessions stay on the list however long they sit; only you, a "Good to close", or ending the session takes one off.
- **↻ Reload Panel** (panel title bar) loads the newest installed version of the panel without reloading the window, so running Claude sessions are not interrupted. Installing a new version also offers it in a notification. Rows, ready and waiting marks, and the Removed list carry over.

## Usage view

A second view, **Usage**, shows the current usage windows of every Claude Code and Codex login on the machine, one card per login: a bar per window (5-hour, weekly, per-model weekly), the percent used, and when it resets. It has its own icon in the activity bar; drag that icon to the Secondary Side Bar (the right side) and it stays there, open next to the Sessions tab.

- **Reads on demand.** It reads once when you first open it in a window, then only when you press **↻**. It never polls.
- **Accounts are found, not configured.** Every `~/.claude*` folder with a `.credentials.json` and every `~/.codex*` folder with a ChatGPT sign-in in `auth.json` gets a card, labelled by the folder's suffix (`~/.claude` is *default*, `~/.claude-work` is *work*). That is the `CLAUDE_CONFIG_DIR` / `CODEX_HOME` way of keeping several logins side by side.
- **Asleep and Wake.** Claude Code renews a login's token only while it runs on that login, so a login nobody has used for a while shows *Asleep* with its last reading, dimmed. **Wake** runs one tiny Haiku prompt on that login (`claude -p`, no tools, nothing saved), which makes Claude Code renew it, then reads again. It uses a sliver of that account's usage. The panel never renews a token itself, because a renewal racing a running session's can sign that session out.
- **Where the numbers come from.** Each login's token is read from its file and sent only to the service that issued it, to the same usage endpoint the CLI calls for `/usage` (Claude) or `/status` (Codex). Neither endpoint is documented for outside use; if one changes, those cards show the error and the rest keep working.

## How it works

Claude Code keeps a registry of its running processes at `~/.claude/sessions/<pid>.json` with the session id, folder, name, and a status of `busy`, `idle` or `waiting`. The extension watches that folder, drops entries whose process is gone, and derives **ready** from a `busy → idle` change. The sessions it lists are saved in VS Code's extension storage, which is how they come back after a restart. Nothing is injected into Claude Code; no hooks are needed.

Focusing a session calls the Claude Code extension's own `claude-vscode.editor.open` command with the session id. That command is internal and undocumented, so it may change between extension versions; the command name is a setting if it does.

### Code layout

| File | What it owns |
|---|---|
| `extension.js` | The loader: registers the views and Reload Panel, starts the newest installed `core.js`. |
| `core.js` | The VS Code side: reads the registry and trail, plays sounds, the webview, commands, Alt+Q, Alt+A, the snapshot. |
| `sessions.js` | Which sessions are listed and how each stands: ready, needs you, removed, filed, asleep, saved for the restart; and when to stop one. No VS Code, no files; everything comes in through its constructor. |
| `procs.js` | Session processes: is a pid still the session's, stop it, is it running a background command (Linux `/proc`). |
| `transcript.js` | Reading transcripts: titles, "Good to close", the waiting reply and its time estimate. |
| `window.js` | Which sessions belong to this window. |
| `away.js` | The moon's file: read and write `away.json`. |
| `usage.js` | The Usage view. |
| `media/` | The webviews' scripts and styles. |

### Tests

`npm test` runs `test/panel.test.js`: about 60 checks that drive the real code the way VS Code and the panel do (fake VS Code, stand-in session processes, real transcript files, a clock moved by hand) and check what the panel shows. Under a second; Linux or WSL, since session liveness is read from `/proc`.

## Install (from source)

```bash
npx --yes @vscode/vsce package --allow-missing-repository
code --install-extension claude-sessions-panel-0.1.0.vsix
```

Under WSL run that from a VS Code terminal so it installs into the WSL side (the extension runs where Claude Code runs). Then reload the window and open the panel (`Ctrl+J`), tab **Claude Sessions**.

For later versions, press **↻ Reload Panel** instead of reloading the window. That covers changes to `core.js` and `media/`. A change to `extension.js` (the loader) or to the `contributes` section of `package.json` (commands, keys, settings, menus) still needs one window reload.

## Companion mod: session-trail

The plugin carries the read-sessions skill above, and the session history behind Alt+Q, which needs to know which session VS Code is showing, which only Claude Code itself sees. The `session-trail` mod in [`mod/`](mod) records it: each time VS Code shows or hides a session it writes `~/.claude/session-trail/<session id>.json`. Install it from a clone of this repo:

```bash
claude plugin marketplace add /path/to/claude-sessions-panel
claude plugin install session-trail@claude-sessions-panel
```

Sessions pick it up when they start, or after `/reload-plugins`.

## Reading your sessions from a session: read-sessions

The companion plugin below also carries the **read-sessions** skill. In any Claude session, say things like:

- "read the sessions in my panel for context": the rows on this window's Main tab (sessions parked in folders are left out; name a folder, or say "including the parked ones", to read those);
- "look at my recent sessions on the billing page": the last 7 days, ranked by topic;
- "dig through all the sessions that touched the auth flow": every session on the machine, ranked by topic and by the files they edited.

It lists what it found, reads them (whole for a few, start and end for more, with helper agents past a dozen), checks what they claim against the repo, and reports where things stand, saying how many it read and at what depth. For the panel scope the panel writes its list to `~/.claude/sessions-panel/<window>.json` each time it changes (one file per VS Code window). The finder behind it runs on its own too: `python3 mod/skills/read-sessions/scripts/find_sessions.py --help`.

## Settings

| Setting | Default | What |
|---|---|---|
| `claudeSessions.sessionsDir` | `~/.claude/sessions` | Registry folder |
| `claudeSessions.removedClearHours` | 12 | Clear removed sessions from the Removed list this many hours after removal |
| `claudeSessions.autoCloseHours` | 4 | Stop a session's process after this many hours with no activity (it stays listed, asleep); 0 = off |
| `claudeSessions.sound.enabled` | true | Play sounds |
| `claudeSessions.sound.ready` | `success` | Green sound: bundled name or `.wav` path |
| `claudeSessions.sound.waiting` | `chatUserActionRequired` | Blue sound: bundled name or `.wav` path |
| `claudeSessions.focusCommand` | `claude-vscode.editor.open` | Command run on row click |

Sounds play through PowerShell under WSL and on Windows, `afplay` on macOS, `paplay` elsewhere. Command **Claude Sessions: Play Test Sounds** checks them.

### Bundled sounds and their origin

`media/sounds/` holds wav conversions of the notification sounds from [microsoft/vscode](https://github.com/microsoft/vscode) (`src/vs/platform/accessibilitySignal/browser/media`), MIT licensed: `chatUserActionRequired`, `success`, `taskCompleted`, `requestSent`, `responseReceived1`, `quickFixes`, `warning`, `terminalBell`.

## Status

Built 2026-10-23 on Windows + WSL with VS Code and Claude Code 2.1.309. Other platforms are untested; the sound player has macOS and Linux branches that nobody has run yet. Issues and PRs welcome.
