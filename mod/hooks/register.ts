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

export const register: Register = on => {
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
