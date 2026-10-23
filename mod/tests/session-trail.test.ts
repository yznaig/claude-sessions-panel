import { expect, mock, test } from 'claude-code/testing'

function world(on: any) {
  const w = { files: {} as Record<string, string>, surfaces: ['vscode'] as string[] }
  const clock = mock.clock(on, { now: 1000 })
  on('env.get', () => ({ value: '/home/me' }))
  on('session.id', () => ({ value: 's1' }))
  on('session.cwd', () => ({ value: '/work/repo' }))
  on('session.surfaces', () => ({ value: [...w.surfaces] }))
  on('fs.write', (_: unknown, e: { path: string; text: string }) => { w.files[e.path] = e.text; return { value: undefined } })
  on('session.start', (_: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  on('session.attach', (_: unknown, e: { clientId: string }) => ({ clientId: e.clientId }))
  on('session.detach', (_: unknown, e: { clientId: string }) => ({ clientId: e.clientId }))
  return { w, clock }
}

const FILE = '/home/me/.claude/session-trail/s1.json'

test('showing then hiding the session writes its trail', async ($, on) => {
  const { w, clock } = world(on)
  await $.session.start({ cwd: '/work/repo', surface: 'vscode', isInteractive: true })
  expect(JSON.parse(w.files[FILE]!)).toMatchObject({ sessionId: 's1', cwd: '/work/repo', shown: true, shownAt: 1000 })

  await clock.advance(5000)
  w.surfaces = []
  await $.session.detach({ surface: 'vscode', clientId: 'vscode:default', reason: 'detach' })
  expect(JSON.parse(w.files[FILE]!)).toMatchObject({ shown: false, shownAt: 1000, hiddenAt: 6000 })

  await clock.advance(5000)
  w.surfaces = ['vscode']
  await $.session.attach({ surface: 'vscode', clientId: 'vscode:default' })
  expect(JSON.parse(w.files[FILE]!)).toMatchObject({ shown: true, shownAt: 11000 })
})

test('a phone attaching is not VS Code showing it', async ($, on) => {
  const { w } = world(on)
  w.surfaces = []
  await $.session.start({ cwd: '/work/repo', surface: 'mobile', isInteractive: true })
  await $.session.attach({ surface: 'mobile', clientId: 'mobile:default' })
  expect(w.files[FILE]).toBeUndefined()
})
