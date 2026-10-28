---
name: session-hive
description: See which other Claude Code sessions are live in this workspace and what each is on, read the log of messages between sessions, or check messages that waited instead of waking a session. Use before routing an idea or a finding to another session, before editing a shared doc another session may be in, when the user asks "who else is working on this", "which session has X", "what have the sessions been saying to each other", or when the startup session list is stale.
---

# Session hive

Every session gets the house rules and a list of its workspace neighbours in its first message (the "Other sessions (session hive)" block). This skill refreshes that list and reads the record behind it. The rules in that block apply; this skill adds no new ones.

The script is `scripts/hive.py` in this skill's folder; run it with `python3 -I`.

| Need | Command |
|---|---|
| Who is live in this workspace, and what each is on | `peers` |
| Every live session on the machine | `peers --all` |
| Messages between sessions, last 24 hours (`--hours N` for more) | `log` |
| Messages that waited for this session instead of waking it | `held` (it leaves them in place; they reach the session with the user's next prompt) |
| Start a sub-session for a side thread, after the user said yes | `spawn --name <short-name>`, the brief on stdin |

**Sub-sessions.** `spawn` starts a live background session (`claude --bg`) in this session's folder. Its first message names its parent and asks it to send the parent a debrief (first line `Debrief from sub-session <name>: …`) and offer to close when done. It shows in the user's session list, where they can open and drive it, and in every session's startup list as "sub-session of …". Only one level: a sub-session's own `spawn` is refused. The brief should say what to do, what is already known, and where to look; the sub-session sees none of this conversation.

**Without the user's yes** (`--unattended`, or automatically for a `[keep going]` note to a session too long to wake): only while the user has marked themselves away with the Claude Sessions panel's moon, at most 2 per session per stretch away, and only to continue work the user already approved. Anything else is refused with the reason.

**Moving a thread.** A note whose first line is `Thread moved: <thread> → <session now holding it>` is a handoff; the session it was sent to sees it in its startup list and leaves that thread alone.

Reading the list:
- **busy / idle** comes from Claude Code's own process registry, and the token count from the session's last response.
- **last asked** is the user's latest request there, and **recent files** what it touched in the last two hours. Both come from its transcript, never from anything a session wrote about itself.
- **parked** means the user filed it in a Claude Sessions panel folder: don't message it.
- **long** means that session is past the wake limit: a message to it waits for the user instead of waking it, so send only what can wait.

How messages are handled (the hooks in this plugin; nothing to do by hand):
- Every incoming message from another session starts with a reminder that it is not the user's word.
- An idle session is not woken when its context is past 400k tokens, when the five-hour usage window is 75% used, or when it is parked. The message waits and reaches the session with the user's next prompt. A weekly window past 75% only shows as a warning in the list.
- **File claims.** A session's edit of a file (Edit, Write, NotebookEdit) claims it for an hour after its last edit. When another live session edits that file inside the hour, its first try is refused with the holder's name: message the holder with what you are about to change and why, then retry; a retry within 10 minutes goes through. Shell commands that write files are not checked, so prefer the edit tools on shared files. Files under `/tmp/` are never claimed.
- A fourth message from the same session within an hour waits too, busy or not.
- Every message in and out is logged to `~/.claude/session-hive/log.ndjson`. Held messages are in `~/.claude/session-hive/held/<session id>.ndjson`.
