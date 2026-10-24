# Claude Sessions

A VS Code panel tab (next to Terminal) that lists your live Claude Code sessions and tells you which ones want you.

- **Spinner** — the session is running.
- **Green** — it finished a turn and has a response you haven't looked at yet.
- **Blue** — it is waiting on you: a permission, a question, an MCP dialog.
- **Badge** on the panel tab counts sessions that need you, so it shows even when the panel is collapsed.
- **Sound** on each green and blue transition. Default green is VS Code's success sound, default blue is VS Code's "chat needs your action" sound. **Claude Sessions: Pick Ready Sound** / **Pick Waiting Sound** preview the bundled set as you arrow through it; any `.wav` path works too, so you can drop in your own editor's chime.
- **Click a row** to focus that session (it reveals its tab, or activates it in the Claude sidebar).
- **✕** removes a session you're done with. **Removed (n)** shows them; **↩** brings one back. Any new activity in a removed session brings it back on its own.
- **Alt+Q** jumps back to the session you looked at before this one. Keep pressing to walk further back; **Alt+Shift+Q** walks forward again. Switching to a session yourself starts a fresh walk from there. It needs the companion mod below.
- **This window / All windows** filters to sessions whose folder is inside this window's workspace. Two windows, two lists.
- **Closed sessions leave on their own.** When a session's last turn ran the `anything-left` skill and its answer opens with "Good to close", the row turns into a dim **✓ closed** with no sound or badge. Once you switch away from it, it moves to Removed. Keep working in it and it comes back. Without the companion mod the panel can't tell when you left, so it moves the session two minutes after the answer instead. The skill's name and the phrase are constants at the top of the transcript section in `extension.js`.
- Idle sessions with no status change for 12 hours drop off the list (setting `claudeSessions.idleHideHours`). Sessions that need you never drop.

## How it works

Claude Code keeps a registry of its running processes at `~/.claude/sessions/<pid>.json` with the session id, folder, name, and a status of `busy`, `idle` or `waiting`. The extension watches that folder, drops entries whose process is gone, and derives **ready** from a `busy → idle` change. Nothing is injected into Claude Code; no hooks are needed.

Focusing a session calls the Claude Code extension's own `claude-vscode.editor.open` command with the session id. That command is internal and undocumented, so it may change between extension versions; the command name is a setting if it does.

## Install (from source)

```bash
npx --yes @vscode/vsce package --allow-missing-repository
code --install-extension claude-sessions-panel-0.1.0.vsix
```

Under WSL run that from a VS Code terminal so it installs into the WSL side (the extension runs where Claude Code runs). Then reload the window and open the panel (`Ctrl+J`), tab **Claude Sessions**.

## Companion mod: session-trail

The session history behind Alt+Q needs to know which session VS Code is showing, which only Claude Code itself sees. The `session-trail` mod in [`mod/`](mod) records it: each time VS Code shows or hides a session it writes `~/.claude/session-trail/<session id>.json`. Install it from a clone of this repo:

```bash
claude plugin marketplace add /path/to/claude-sessions-panel
claude plugin install session-trail@claude-sessions-panel
```

Sessions pick it up when they start, or after `/reload-plugins`.

## Settings

| Setting | Default | What |
|---|---|---|
| `claudeSessions.sessionsDir` | `~/.claude/sessions` | Registry folder |
| `claudeSessions.idleHideHours` | 12 | Hide idle sessions older than this |
| `claudeSessions.sound.enabled` | true | Play sounds |
| `claudeSessions.sound.ready` | `success` | Green sound: bundled name or `.wav` path |
| `claudeSessions.sound.waiting` | `chatUserActionRequired` | Blue sound: bundled name or `.wav` path |
| `claudeSessions.focusCommand` | `claude-vscode.editor.open` | Command run on row click |

Sounds play through PowerShell under WSL and on Windows, `afplay` on macOS, `paplay` elsewhere. Command **Claude Sessions: Play Test Sounds** checks them.

### Bundled sounds and their origin

`media/sounds/` holds wav conversions of the notification sounds from [microsoft/vscode](https://github.com/microsoft/vscode) (`src/vs/platform/accessibilitySignal/browser/media`), MIT licensed: `chatUserActionRequired`, `success`, `taskCompleted`, `requestSent`, `responseReceived1`, `quickFixes`, `warning`, `terminalBell`.

## Status

Built 2026-10-23 on Windows + WSL with VS Code and Claude Code 2.1.309. Other platforms are untested; the sound player has macOS and Linux branches that nobody has run yet. Issues and PRs welcome.
