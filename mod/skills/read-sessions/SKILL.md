---
name: read-sessions
description: Find and read the user's other Claude Code sessions to build a consolidated picture before the work at hand. Use when they point at their sessions as context — "the sessions in my panel", "my recent sessions on X", "all the sessions that touched X", "read that session", "catch up on the other sessions", "consolidate where everything stands" — or ask which session did something.
---

# Read sessions

The user's other sessions are context for what they want done here. Find exactly the sessions they mean, read them to the depth the count allows, and come back with one consolidated picture, saying what you read and what you skipped.

The finder is `scripts/find_sessions.py` in this skill's folder; run it with `python3 -I`. `--help` on each command lists its options.

## 1. Scope

Take the scope from their words:

| They say | Scope | Command |
|---|---|---|
| "in my panel", "my panel sessions", "the sessions I have open" | the rows on the Main tab of this window's Claude Sessions panel; sessions parked in its folders are left out | `panel` |
| a panel folder by name ("my Later folder", "the HIRE folder"), or "including the parked ones" | only that folder's sessions, or Main plus every folder | `panel --folder "<name>"` or `panel --all-folders` |
| "recent", "lately", or a topic with no time word | last 7 days ("today", "this week" set `--days`) | `recent --topic "..."` |
| "all", "every session that", "ever", "dig through everything" | every session on the machine | `all --topic "..." --files ...` |
| a session's name or something it produced | find that one | `all --topic "<name or the words they recall>"` |

Build `--topic` from the words they used, with "quoted phrases" for names. For "all" on a topic, also pass `--files` with the paths that topic lives in (the repo files, plans or notes it concerns), so sessions that worked on those files rank even when they never used the words.

## 2. Resolve the list

Run the command. Then:
- Drop this session itself: the running session in this folder whose last message is the request you are answering.
- A `fork of` row repeats its parent's start; read the one that went furthest.
- When they name one session, show the top two or three candidates with the evidence (title, dates, first message) and confirm before reading, unless one is an exact title match.
- More than 12 sessions, or a topic that pulled in strays: show the list and say which ones you will read and why, then go on.

The resolved list is done when every session in it is one they meant, with nothing they named missing.

## 3. Read

Read every session whole. `digest <id>` prints every turn and every message in full by default. Write each one to its own scratchpad file (`digest <id> > <scratchpad>/<id>.md`) and read that file to the end.
- **Never trim the output.** No `head`, `tail`, `cut` or `--chars` on a digest you report from. Do not loop several digests into one command whose output gets cut. A summary built from a cut-off transcript is the failure this skill exists to prevent: the session's last message is where its open items live.
- **A very long session** (digest over about 80 KB): read the first two turns and the last ten in full (`--turns 12`), plus `grep` the file for `Decision`, `your call`, `needs you` and `?` in Claude's replies so items from the skipped middle still surface. Say which sessions you read this way.
- **The last message, always in full.** Claude's final reply and the user's final prompt decide whether a session is done.
- **More than 12 sessions:** subagents on a mid-tier model, five to eight sessions each. Write one brief to the scratchpad naming the user's goal, the finder's path, the same full-read rules, and the reply shape: per session, what it set out to do, what it produced, where it stopped, what it is waiting on, at most 12 lines, with **stated** (the transcript says it) kept apart from **inferred**.

While reading:
- **Check claims against the world.** A session saying it committed, merged, sent or filed something is a lead; confirm it in the repo (`git log`, the file) before you repeat it.
- **Running sessions move.** A session whose state is `busy`, `idle` or `waiting` is still open; its last word is provisional.
- **Stay out of other sessions.** Read transcripts only; never message a live session as part of this.

- **Before calling something not done, look where it would have landed:** the repo, the asks or reports folder, sent mail. A different session may have finished it.

Reading is done when every session on the list has been read in full (or the long-session way, named), or named as skipped with the reason.

## 4. Report

Open with the coverage line: "Read N of M sessions (depth); skipped: …". Then, in plain words and under about 60 lines:

1. A table: session · what it did or produced · where it stopped or what it waits on.
2. Where things stand: done, in flight, blocked.
3. Decisions the user owes, numbered, each with your recommendation.
4. Conflicts between sessions (two sessions that changed the same thing, or disagree).
5. What the transcripts could not tell you.

**Safe to close** is a verdict, not a guess. A session is safe to close only when its last message leaves nothing open, or every open item is named where it now lives (a list another session holds, a committed file, a sent message). Name the place beside each one. A session with an open item that lives nowhere else is "keep".

Then carry on with what they asked for; the reading was context for it.

## Notes

- Sessions come from every `~/.claude*/projects` folder (each `CLAUDE_CONFIG_DIR`), plus the Windows side under WSL. Headless `claude -p` runs and subagent transcripts are left out; `--include-headless` brings the headless ones back.
- The panel scope reads `~/.claude/sessions-panel/<window>.json`, which the panel writes whenever its list changes. If that is missing (panel older than 0.10, or closed), say so and fall back to `recent --days 2`, which covers what was open.
- "Recent" uses the times inside each transcript, so a reset file time does not distort it.
