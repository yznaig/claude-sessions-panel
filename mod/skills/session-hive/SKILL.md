---
name: session-hive
description: See which other Claude Code sessions are live in this workspace and what each is on, read the log of messages and events between sessions, check messages that waited instead of waking a session, or record a decision, a role or a note for other sessions. Use before messaging another session, when the user answers a numbered decision or says yes to a named proposal, when taking or looking up a role (who is the builder), before editing a shared doc another session may be in, when the user asks "who else is working on this", "which session has X", "what have the sessions been saying to each other", or when the startup session list is stale.
---

# Session hive

Every session gets the house rules and a list of its workspace neighbours in its first message (the "Other sessions (session hive)" block). This skill refreshes that list and reads the record behind it. The rules in that block apply; this skill adds no new ones.

The script is `scripts/hive.py` in this skill's folder; run it with `python3 -I`.

| Need | Command |
|---|---|
| Who is live in this workspace, and what each is on | `peers` |
| Every live session on the machine | `peers --all` |
| Messages and events between sessions, last 24 hours (`--hours N` for more) | `log` |
| What other sessions here did since this session last looked (`--take` moves its place on) | `since` |
| Record that the user decided something; prints the id to cite (`e1030-07`) | `decide --workspace <path of the area it concerns> --area <area> "<one line>"` |
| Take a role for an area, or find who holds one | `role` / `who`, each `--workspace <path> --area <area> --role <role>`; `who` says (live) or (gone), and `role` warns when a live session holds it |
| One line of fact for other sessions, in place of an FYI message | `note "<fact>"` |
| Messages that waited for this session instead of waking it | `held` (it leaves them in place; they reach the session with the user's next prompt) |
| Start a sub-session for a side thread, after the user said yes | `spawn --name <short-name>`, the brief on stdin |

**Sub-sessions.** `spawn` starts a live background session (`claude --bg`) in this session's folder. Its first message names its parent and asks it to send the parent a debrief (first line `Debrief from sub-session <name>: …`) and offer to close when done. It shows in the user's session list, where they can open and drive it, and in every session's startup list as "sub-session of …". Only one level: a sub-session's own `spawn` is refused. The brief should say what to do, what is already known, and where to look; the sub-session sees none of this conversation.

**Without the user's yes** (`--unattended`, or automatically for a `[keep going]` note to a session too long to wake): only while the user has marked themselves away with the Claude Sessions panel's moon, at most 2 per session per stretch away, and only to continue work the user already approved. Anything else is refused with the reason.

**Events.** `decided`, `role`, `moved` (logged by itself from a `Thread moved` message) and `note` sit in the log beside messages, refused edits and sub-sessions started. Each user prompt carries "Since you last looked": other sessions' events in this workspace since the last prompt, newest first, at most 8 lines (a session with no place yet sees the last 48 hours), and nothing when nothing is new. A `decided` or `role` event counts for the workspace it names, so a session in one repo can record a decision about another; name the area's path, not your own folder. Write `decided` only for the user's answer to a numbered decision or an explicit yes to a named proposal, never for proceed-unless-objected items.

**Moving a thread.** A message whose first line is `Thread moved: <thread> → <session now holding it>` is a handoff; the session it was sent to sees it in its startup list and leaves that thread alone.

Reading the list:
- **busy / idle** comes from Claude Code's own process registry, and the token count from the session's last response.
- **last asked** is the user's latest request there, and **recent files** what it touched in the last two hours. Both come from its transcript, never from anything a session wrote about itself.
- **parked** means the user marked it Parked in the Claude Sessions panel (right-click a row): don't message it. A panel folder is only grouping; a filed session can be messaged.
- **long** means that session is past the wake limit: a message to it waits for the user instead of waking it, so send only what can wait.

How messages are handled (the hooks in this plugin; nothing to do by hand):
- Every incoming message from another session starts with a reminder that it is not the user's word.
- An idle session is not woken when its context is past 400k tokens, when the five-hour usage window is 75% used, or when it is parked. The message waits and reaches the session with the user's next prompt. A weekly window past 75% only shows as a warning in the list.
- **File claims.** A session's edit of a file (Edit, Write, NotebookEdit) claims it for an hour after its last edit. When another live session edits that file inside the hour, its first try is refused with the holder's name and logged, so the holder sees it in its "Since you last looked"; check the change doesn't clash, then retry; a retry within 10 minutes goes through. No message needed. Shell commands that write files are not checked, so prefer the edit tools on shared files. Files under `/tmp/` are never claimed.
- An eleventh message from the same session within an hour waits too, busy or not.
- Every message in and out, and every event, is logged to `~/.claude/session-hive/log.ndjson`. Held messages are in `~/.claude/session-hive/held/<session id>.ndjson`; each session's place in the log is in `~/.claude/session-hive/cursors/`.
