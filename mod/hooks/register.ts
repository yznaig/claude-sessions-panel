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

let busy = false

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
  if (!path) return undefined
  try {
    const verdict = JSON.parse(await hive($, ['claim', '--path', path])) as { action: string; message?: string }
    if (verdict.action === 'refuse' && verdict.message) return { deny: verdict.message }
  } catch (err) {
    $.ui.log(`session hive: claim not checked (${err})`, { to: 'debug' })
  }
  return undefined
}

function isUser(origin: { kind: string } | undefined): boolean {
  return !origin || origin.kind === 'composer' || origin.kind === 'bridge'
}

export const register: Register = on => {
  on('prompt.context', async ($, e, next) => {
    const r = await next(e)
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
    if (e.origin.kind !== 'peer' || 'teammate' in e.origin || e.agentId) return next(e)
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

  on('prompt.submit', async ($, e, next) => {
    if (e.command || !isUser(e.origin)) return next(e)
    try {
      const notes = (await hive($, ['held', '--take'])).trim()
      if (notes) return next({ ...e, context: [...(e.context ?? []), notes] })
    } catch (err) {
      $.ui.log(`session hive: waiting notes not read (${err})`, { to: 'debug' })
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('session.send', async ($, e, next) => {
    const r = await next(e)
    if (!e.agentId) await hive($, ['sent', '--to', e.to], e.text).catch(() => {})
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

  on('session.start', async ($, e, next) => {
    const r = await next(e)
    if (await vscodeShows($)) await write($, true).catch(() => {})
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
