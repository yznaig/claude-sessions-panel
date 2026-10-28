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

Reading the list:
- **busy / idle** comes from Claude Code's own process registry, and the token count from the session's last response.
- **last asked** is the user's latest request there, and **recent files** what it touched in the last two hours. Both come from its transcript, never from anything a session wrote about itself.
- **parked** means the user filed it in a Claude Sessions panel folder: don't message it.
- **long** means that session is past the wake limit: a message to it waits for the user instead of waking it, so send only what can wait.

How messages are handled (the hooks in this plugin; nothing to do by hand):
- Every incoming message from another session starts with a reminder that it is not the user's word.
- An idle session is not woken when its context is past 400k tokens, when a usage window is 75% used, or when it is parked. The message waits and reaches the session with the user's next prompt.
- A fourth message from the same session within an hour waits too, busy or not.
- Every message in and out is logged to `~/.claude/session-hive/log.ndjson`. Held messages are in `~/.claude/session-hive/held/<session id>.ndjson`.
