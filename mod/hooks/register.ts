import type { EngineInterface, Register } from 'claude-code'

// session-trail: writes ~/.claude/session-trail/<session id>.json whenever a
// VS Code window shows or hides this session. The Claude Sessions panel reads
// those files to walk back through the sessions you looked at (Alt+Q).

type Trail = { sessionId: string; cwd: string; shown: boolean; shownAt: number; hiddenAt: number }

let shownAt = 0
let hiddenAt = 0

async function write($: EngineInterface, shown: boolean): Promise<void> {
  const home = await $.env.get('HOME')
  if (!home) return
  const sessionId = await $.session.id()
  const now = await $.clock.now()
  if (shown) shownAt = now
  else hiddenAt = now
  const trail: Trail = { sessionId, cwd: await $.session.cwd(), shown, shownAt, hiddenAt }
  await $.fs.write(`${home}/.claude/session-trail/${sessionId}.json`, JSON.stringify(trail) + '\n')
}

async function vscodeShows($: EngineInterface): Promise<boolean> {
  return (await $.session.surfaces()).includes('vscode')
}

// session hive: sessions that know about each other. The decisions live in
// skills/session-hive/scripts/hive.py; these hooks only hand it what the
// engine knows (who sent a message, whether a turn is running, the context
// size, the usage windows) and act on its answer. Any failure lets the
// message through as it came: the hive never loses one.
//
// Headless runs (`claude -p`, scripted workers like an overnight build
// runner) are left out entirely: no rules, no list, no claims, no logging.
// Headless means Claude Code stamped the process `sdk-cli` (or another
// `sdk-*`) in CLAUDE_CODE_ENTRYPOINT. A `-p` run started from inside a VS Code
// session inherits that session's stamp and keeps the hive; a runner that
// starts its workers from a clean environment gets `sdk-cli`.

let busy = false
let headless = false

async function hive($: EngineInterface, args: string[], stdin = ''): Promise<string> {
  const script = `${$.plugin.root}/skills/session-hive/scripts/hive.py`
  const self = await $.session.id()
  const r = await $.process.run(['python3', '-I', script, '--self', self, ...args], { stdin, timeoutMs: 60000 })
  if (r.exitCode !== 0) throw new Error(`hive.py ${args[0]} exited ${r.exitCode}: ${r.stderr.slice(0, 300)}`)
  return r.stdout
}

function senderOf(text: string): string {
  const m = /<cross-session-message\b[^>]*\bfrom-name="([^"]+)"/.exec(text) ?? /<cross-session-message\b[^>]*\bfrom="([^"]+)"/.exec(text)
  return m?.[1] ?? 'unknown'
}

async function measures($: EngineInterface): Promise<string[]> {
  const u = await $.session.usage()
  const out: string[] = []
  if (u.context?.tokens) out.push('--tokens', String(u.context.tokens))
  // Only the five-hour window holds wakes: it resets within hours, so a held
  // note never sits for days. The weekly window is a warning in the list.
  const fiveHour = (u.rateLimits ?? []).find(l => l.kind === 'five_hour')
  if (fiveHour) out.push('--usage', String(fiveHour.percentUsed))
  return out
}

async function weekly($: EngineInterface): Promise<string[]> {
  const week = ((await $.session.usage()).rateLimits ?? []).find(l => l.kind === 'seven_day')
  return week ? ['--week', String(week.percentUsed)] : []
}

// A file edit's claim check: a refusal to hand back, or undefined to go on.
async function claimRefusal($: EngineInterface, path: string | undefined): Promise<{ deny: string } | undefined> {
  if (!path || headless) return undefined
  try {
    const verdict = JSON.parse(await hive($, ['claim', '--path', path])) as { action: string; message?: string }
    if (verdict.action === 'refuse' && verdict.message) return { deny: verdict.message }
  } catch (err) {
    $.ui.log(`session hive: claim not checked (${err})`, { to: 'debug' })
  }
  return undefined
}

// Ready to close: a sub-session's final debrief (first line `Debrief from sub-session …`) is refused while a
// background task it started is still open, and once sent marks it ready to close (the panel's red row). New
// work clears the mark: an edit (the claim check above clears it), a commit, push, merge or PR, or starting a
// background task. Conversation doesn't. The decisions are hive.py's (`check`, `sent`, `work`).
const DEBRIEF = /^\s*Debrief from sub-session\b/
const WORK_CMD = /\bgit\s+(?:-C\s+\S+\s+)?(?:commit|push|merge)\b|\bgh\s+pr\s+(?:create|merge)\b/

async function newWork($: EngineInterface, what: string): Promise<void> {
  if (headless) return
  await hive($, ['work', '--what', what]).catch(err => $.ui.log(`session hive: mark not cleared (${err})`, { to: 'debug' }))
}

function isUser(origin: { kind: string } | undefined): boolean {
  return !origin || origin.kind === 'composer' || origin.kind === 'bridge'
}

// A hive sub-session opened as a VS Code tab: the Claude Sessions panel opens a new tab with
// "[hive:<token>]" in its prompt box (spawns.js in the panel). This new session takes the request
// (`hive.py pickup`) and submits its brief as if typed, so the turn runs in the tab. Only a fresh
// session looks, only while a request is open, and only for about 20 seconds; anything else in the
// box (the person typing) ends the look.
const TAG = /\[hive:([0-9a-f]{8,32})\]/

async function watchForSubSession($: EngineInterface): Promise<void> {
  if ((await $.session.turns()) > 0) return
  const home = await $.env.get('HOME')
  const dir = `${home}/.claude/session-hive/spawn`
  if (!(await $.fs.exists(dir))) return
  if (!(await $.fs.list(dir)).some(f => f.name.endsWith('.opening'))) return
  let tries = 0
  let done = false
  const timer = $.clock.every(500, () => {
    if (done) return
    void (async () => {
      tries++
      const box = await $.prompt.read()
      const m = TAG.exec(box.text)
      if (!m) {
        if (box.text.trim() || tries >= 40) { done = true; timer.cancel() }
        return
      }
      done = true
      timer.cancel()
      const verdict = JSON.parse(await hive($, ['pickup', '--token', m[1]])) as { action: string; name?: string; text?: string }
      if (verdict.action !== 'submit' || !verdict.text) return
      const brief = verdict.text
      // Named first, while the session is idle: the tab and the session list show the sub-session's
      // name, and messages reach it by that name.
      if (verdict.name) {
        await $.command.run({ command: 'rename', args: verdict.name })
          .catch(err => $.ui.log(`session hive: sub-session not renamed (${err})`, { to: 'debug' }))
      }
      try {
        await $.prompt.submit({ text: brief, asUser: true })
      } catch (err) {
        // Not sent: hand the brief to the person, one Enter away, rather than lose it.
        await $.prompt.fill({ text: brief, mode: 'replace' }).catch(() => {})
        $.ui.toast('Session hive: the sub-session brief could not be sent by itself; it is in the box, press Enter.')
        throw err
      }
      await $.prompt.fill({ text: '', mode: 'replace' }).catch(() => {})
    })().catch(err => { done = true; timer.cancel(); $.ui.log(`session hive: sub-session not taken (${err})`, { to: 'debug' }) })
  })
}

// A background session the Claude Sessions panel brought into VS Code while it watched a command:
// the stop that freed it ended the command. The panel left a note; the session gets it as its next
// prompt (framed as this plugin's, not the person's) and can start the command again.
async function tellWhatWasCutOff($: EngineInterface): Promise<void> {
  const home = await $.env.get('HOME')
  if (!(await $.fs.exists(`${home}/.claude/session-hive/resume/${await $.session.id()}.json`))) return
  const note = (await hive($, ['resumed'])).trim()
  if (note) void $.prompt.submit({ text: note })
}

export const register: Register = on => {
  on('prompt.context', async ($, e, next) => {
    const r = await next(e)
    if (headless) return r
    try {
      const text = (await hive($, ['peers', '--cwd', await $.session.cwd(), ...(await weekly($))])).trim()
      if (text) return { ...r, blocks: [...r.blocks, { name: 'sessionHive', text }] }
    } catch (err) {
      $.ui.log(`session hive: no peer list (${err})`, { to: 'debug' })
    }
    return r
  })

  on('turn.start', async ($, e, next) => {
    if (!e.agentId) busy = true
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (!e.agentId) busy = false
    return next(e)
  })

  on('session.receive', async ($, e, next) => {
    if (headless || e.origin.kind !== 'peer' || 'teammate' in e.origin || e.agentId) return next(e)
    try {
      const args = ['receive', '--from', senderOf(e.text), '--busy', busy ? '1' : '0', ...(await measures($))]
      const verdict = JSON.parse(await hive($, args, e.text)) as { action: string; reason?: string; text?: string }
      if (verdict.action === 'hold') return { consumed: `session hive: waits for the user (${verdict.reason})` }
      if (verdict.text) return next({ ...e, text: verdict.text })
    } catch (err) {
      $.ui.log(`session hive: delivered unchecked (${err})`, { to: 'debug' })
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  // Each user prompt carries the notes that waited for this session, then
  // "Since you last looked": what other sessions in this workspace did since
  // the last prompt (decisions, roles, handoffs, notes, messages, claims). The
  // fold rides here and not in prompt.context, which the engine computes once
  // per conversation. Nothing new adds nothing. After a long wait hive.py
  // screens the news against what this session is doing, so the prompt goes
  // to it on stdin.
  on('prompt.submit', async ($, e, next) => {
    if (headless || e.command || !isUser(e.origin)) return next(e)
    const read = async (args: string[], what: string, stdin = ''): Promise<string> => {
      try {
        return (await hive($, args, stdin)).trim()
      } catch (err) {
        $.ui.log(`session hive: ${what} not read (${err})`, { to: 'debug' })
        return ''
      }
    }
    const cwd = await $.session.cwd()
    const blocks = (await Promise.all([
      read(['held', '--take'], 'waiting notes'),
      read(['since', '--take', '--cwd', cwd], 'since you last looked', e.text ?? ''),
    ])).filter(Boolean)
    return next(blocks.length ? { ...e, context: [...(e.context ?? []), ...blocks] } : e)
  }).catch(($, e, next) => next(e))

  on('session.send', async ($, e, next) => {
    if (e.agentId || headless) return next(e)
    // A message to a session that handed its role on (a replaced Desk) goes to the role's live holder instead.
    // A failed lookup sends it as addressed.
    try {
      const v = JSON.parse(await hive($, ['redirect', '--to', e.to], e.text)) as { action: string; to?: string; text?: string }
      if (v.action === 'redirect' && v.to && v.text) e = { ...e, to: v.to, text: v.text }
    } catch (err) {
      $.ui.log(`session hive: redirect not checked (${err})`, { to: 'debug' })
    }
    if (DEBRIEF.test(e.text)) {
      try {
        const verdict = JSON.parse(await hive($, ['check', '--to', e.to], e.text)) as { action: string; message?: string }
        if (verdict.action === 'refuse' && verdict.message) return { isDelivered: false, reason: verdict.message }
      } catch (err) {
        $.ui.log(`session hive: debrief not checked (${err})`, { to: 'debug' })
      }
    }
    const r = await next(e)
    await hive($, ['sent', '--to', e.to, ...(r.isDelivered ? [] : ['--undelivered'])], e.text).catch(() => {})
    return r
  }).catch(($, e, next) => next(e))

  // File claims: the first edit claims a file for an hour; another live
  // session's first edit of it inside that hour is refused once, naming the
  // holder, and its retry goes through. A failed check never blocks an edit.
  on('tool.call', { tool: 'Edit' }, async ($, e, next) => (await claimRefusal($, e.file_path)) ?? next(e))
    .catch(($, e, next) => next(e))
  on('tool.call', { tool: 'Write' }, async ($, e, next) => (await claimRefusal($, e.file_path)) ?? next(e))
    .catch(($, e, next) => next(e))
  on('tool.call', { tool: 'NotebookEdit' }, async ($, e, next) => (await claimRefusal($, e.notebook_path)) ?? next(e))
    .catch(($, e, next) => next(e))

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    if (e.run_in_background) await newWork($, 'a background command: ' + (e.description || e.command).slice(0, 60))
    else if (WORK_CMD.test(e.command)) await newWork($, (WORK_CMD.exec(e.command)?.[0] ?? 'a commit').replace(/\s+/g, ' '))
    return next(e)
  }).catch(($, e, next) => next(e))
  // Agent calls run in the background in this build; its old name, Task, reaches the same hook.
  for (const tool of ['Agent', 'Monitor', 'Workflow'] as const) {
    on('tool.call', { tool }, async ($, e, next) => {
      await newWork($, `a background ${tool}`)
      return next(e)
    }).catch(($, e, next) => next(e))
  }

  on('session.start', async ($, e, next) => {
    const entrypoint = (await $.env.get('CLAUDE_CODE_ENTRYPOINT').catch(() => undefined)) ?? ''
    headless = entrypoint.startsWith('sdk')
    const r = await next(e)
    if (await vscodeShows($)) await write($, true).catch(() => {})
    // VS Code starts its sessions with isInteractive false, so the entrypoint is the test.
    if (entrypoint === 'claude-vscode') {
      await watchForSubSession($).catch(() => {})
      await tellWhatWasCutOff($).catch(err => $.ui.log(`session hive: resume note not read (${err})`, { to: 'debug' }))
    }
    return r
  })

  on('session.attach', async ($, e, next) => {
    const r = await next(e)
    if (e.surface === 'vscode') await write($, true).catch(() => {})
    return r
  })

  on('session.detach', async ($, e, next) => {
    const r = await next(e)
    if (e.surface === 'vscode' && !(await vscodeShows($))) await write($, false).catch(() => {})
    return r
  })

  on('session.end', async ($, e, next) => {
    if (await vscodeShows($)) await write($, false).catch(() => {})
    return next(e)
  })
}
