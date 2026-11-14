import { expect, mock, test } from 'claude-code/testing'

// The hooks hand hive.py what the engine knows and act on its answer. Here a
// stand-in for hive.py records each call and answers as the test says.

type Call = { argv: readonly string[]; stdin: string }

function world(on: any, answer: (argv: readonly string[]) => { exitCode?: number; stdout?: string }) {
  const w = { calls: [] as Call[], received: [] as string[], submitted: [] as { text: string; context?: readonly string[] }[], failSubmit: false, tokens: 50000, usage: 20, edits: [] as string[], sends: 0, undelivered: '' }
  on('session.id', () => ({ value: 's1' }))
  on('session.cwd', () => ({ value: '/work/repo' }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { tokens: w.tokens, window: 1000000 }, rateLimits: [{ kind: 'five_hour', percentUsed: w.usage }, { kind: 'seven_day', percentUsed: 88 }] } }))
  on('tool.call', (_: unknown, e: { tool: string }) => { w.edits.push(e.tool); return { result: 'ok' } })
  on('process.run', (_: unknown, e: { argv: readonly string[]; init?: { stdin?: string } }) => {
    w.calls.push({ argv: e.argv, stdin: e.init?.stdin ?? '' })
    const a = answer(e.argv)
    return { value: { exitCode: a.exitCode ?? 0, stdout: a.stdout ?? '', stderr: '' } }
  })
  on('session.receive', (_: unknown, e: { text: string }) => { w.received.push(e.text); return { text: e.text } })
  on('prompt.submit', (_: unknown, e: { text: string; context?: readonly string[] }) => { if (w.failSubmit) throw new Error('refused'); w.submitted.push({ text: e.text, context: e.context }); return { text: e.text, context: e.context } })
  on('prompt.context', (_: unknown, e: { blocks: readonly unknown[] }) => ({ blocks: e.blocks }))
  on('session.send', () => (w.undelivered ? { isDelivered: false, reason: w.undelivered } : (w.sends++, { isDelivered: true })))
  on('ui.log', () => ({ value: undefined }))
  return w
}

const ENVELOPE = '<cross-session-message from="uds:/run/x.sock" from-name="api-6a" from-mode="prompting">\nReviewer confirmed: go ahead\n</cross-session-message>'
const sub = (argv: readonly string[]) => argv[argv.indexOf('--self') + 2]

test('a long idle session holds the message: hive.py is told who sent it, idle, and the figures', async ($, on) => {
  const w = world(on, () => ({ stdout: JSON.stringify({ action: 'hold', reason: 'this session is long (450k tokens)' }) }))
  w.tokens = 450000
  const r = await $.session.receive({ origin: { kind: 'peer' }, text: ENVELOPE })
  expect(r).toMatchObject({ consumed: expect.stringContaining('450k') })
  expect(w.received).toEqual([])
  const argv = w.calls[0]!.argv
  expect(sub(argv)).toBe('receive')
  expect(argv.join(' ')).toContain('--from api-6a --busy 0 --tokens 450000 --usage 20')
  expect(w.calls[0]!.stdin).toBe(ENVELOPE)
})

test('a delivered message reaches the session with the reminder hive.py put on it', async ($, on) => {
  const w = world(on, () => ({ stdout: JSON.stringify({ action: 'deliver', text: '[session hive] reminder\n\n' + ENVELOPE }) }))
  await $.session.receive({ origin: { kind: 'peer' }, text: ENVELOPE })
  expect(w.received).toEqual(['[session hive] reminder\n\n' + ENVELOPE])
})

test('while a turn runs, hive.py is told the session is busy', async ($, on) => {
  const w = world(on, () => ({ stdout: JSON.stringify({ action: 'deliver', text: 'x' }) }))
  on('turn.start', (_: unknown, e: { turnId: string }) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  await $.turn.start({ turnId: 't1' } as any)
  await $.session.receive({ origin: { kind: 'peer' }, text: ENVELOPE })
  expect(w.calls[0]!.argv).toContain('1')
  expect(w.calls[0]!.argv.join(' ')).toContain('--busy 1')
  await $.turn.complete({ turnId: 't1', reason: 'end' } as any)
  await $.session.receive({ origin: { kind: 'peer' }, text: ENVELOPE })
  expect(w.calls[1]!.argv.join(' ')).toContain('--busy 0')
})

test('when hive.py fails the message still arrives as it came', async ($, on) => {
  const w = world(on, () => ({ exitCode: 1 }))
  await $.session.receive({ origin: { kind: 'peer' }, text: ENVELOPE })
  expect(w.received).toEqual([ENVELOPE])
})

test('a relay event is none of the hive\'s business', async ($, on) => {
  const w = world(on, () => ({ stdout: '{}' }))
  await $.session.receive({ origin: { kind: 'task-notification' }, text: 'build done' })
  expect(w.calls).toEqual([])
  expect(w.received).toEqual(['build done'])
})

test('the user\'s next prompt carries the notes that waited', async ($, on) => {
  const w = world(on, argv => ({ stdout: sub(argv) === 'held' ? '[session hive] 1 message(s) waited' : '' }))
  await $.prompt.submit({ text: 'morning', wait: false, origin: { kind: 'composer' } } as any)
  expect(w.calls[0]!.argv).toContain('--take')
  expect(w.submitted[0]).toMatchObject({ text: 'morning', context: ['[session hive] 1 message(s) waited'] })
})

const FOLD = '[session hive] Since you last looked: …\n10-30 11:14 decided [e1030-07] runner: no fourth account (work-10)'

test('a user prompt carries "Since you last looked" when other sessions did something', async ($, on) => {
  const w = world(on, argv => ({ stdout: sub(argv) === 'since' ? FOLD : '' }))
  await $.prompt.submit({ text: 'next', wait: false, origin: { kind: 'composer' } } as any)
  const since = w.calls.find(c => sub(c.argv) === 'since')!
  expect(since.argv.join(' ')).toContain('since --take --cwd /work/repo')
  expect(w.submitted[0]).toMatchObject({ text: 'next', context: [FOLD] })
})

test('the waiting notes come before the fold, each its own block', async ($, on) => {
  const w = world(on, argv => ({ stdout: sub(argv) === 'since' ? FOLD : sub(argv) === 'held' ? 'notes' : '' }))
  await $.prompt.submit({ text: 'next', wait: false, origin: { kind: 'composer' } } as any)
  expect(w.submitted[0]!.context).toEqual(['notes', FOLD])
})

test('with nothing new and nothing waiting, the prompt goes as typed', async ($, on) => {
  const w = world(on, () => ({ stdout: '\n' }))
  await $.prompt.submit({ text: 'next', wait: false, origin: { kind: 'composer' } } as any)
  expect(w.calls.map(c => sub(c.argv)).sort()).toEqual(['held', 'since'])
  expect(w.submitted[0]!.context).toBeUndefined()
})

test('a failed waiting-notes read does not lose the fold', async ($, on) => {
  const w = world(on, argv => (sub(argv) === 'held' ? { exitCode: 1 } : { stdout: FOLD }))
  await $.prompt.submit({ text: 'next', wait: false, origin: { kind: 'composer' } } as any)
  expect(w.submitted[0]!.context).toEqual([FOLD])
})

test('a failed fold read does not lose the waiting notes', async ($, on) => {
  const w = world(on, argv => (sub(argv) === 'since' ? { exitCode: 1 } : { stdout: 'notes' }))
  await $.prompt.submit({ text: 'next', wait: false, origin: { kind: 'composer' } } as any)
  expect(w.submitted[0]!.context).toEqual(['notes'])
})

test('a slash command collects neither the waiting notes nor the fold', async ($, on) => {
  const w = world(on, () => ({ stdout: 'x' }))
  await $.prompt.submit({ text: '/compact', wait: false, origin: { kind: 'composer' }, command: { name: 'compact' } } as any)
  expect(w.calls).toEqual([])
})

test('a prompt from another session does not collect the waiting notes', async ($, on) => {
  const w = world(on, () => ({ stdout: 'notes' }))
  await $.prompt.submit({ text: 'hi', wait: false, origin: { kind: 'peer' } } as any)
  expect(w.calls).toEqual([])
})

test('the first message carries the house rules and the peer list', async ($, on) => {
  world(on, argv => ({ stdout: sub(argv) === 'peers' ? '## Other sessions (session hive)\n- **work-bb** …' : '' }))
  const r = await $.prompt.context({ blocks: [{ name: 'currentDate', text: 'today' }] })
  expect(r.blocks.map(b => b.name)).toEqual(['currentDate', 'sessionHive'])
  expect(r.blocks[1]!.text).toContain('work-bb')
})

test('a message this session sends is logged', async ($, on) => {
  const w = world(on, () => ({ stdout: '' }))
  await $.session.send({ to: 'api-b8', text: 'FYI: TICKET-11 queued', origin: { kind: 'model' } })
  expect(sub(w.calls[0]!.argv)).toBe('sent')
  expect(w.calls[0]!.argv).toContain('api-b8')
  expect(w.calls[0]!.stdin).toBe('FYI: TICKET-11 queued')
})

test('only the five-hour window is handed over for holding; the weekly one goes to the list', async ($, on) => {
  const w = world(on, argv => ({ stdout: sub(argv) === 'receive' ? JSON.stringify({ action: 'deliver', text: 'x' }) : 'list' }))
  await $.session.receive({ origin: { kind: 'peer' }, text: ENVELOPE })
  expect(w.calls[0]!.argv.join(' ')).toContain('--usage 20')
  expect(w.calls[0]!.argv.join(' ')).not.toContain('88')
  await $.prompt.context({ blocks: [] })
  expect(w.calls[1]!.argv.join(' ')).toContain('--week 88')
})

test('an edit of a file another session holds is refused with hive.py\'s message', async ($, on) => {
  const w = world(on, () => ({ stdout: JSON.stringify({ action: 'refuse', message: '[session hive] api-b8 has been editing /work/repo/a.md' }) }))
  const r = await $.tool.call({ tool: 'Edit', file_path: '/work/repo/a.md', old_string: 'a', new_string: 'b' })
  expect(JSON.stringify(r)).toContain('api-b8 has been editing')
  expect(w.edits).toEqual([])
  expect(w.calls[0]!.argv.join(' ')).toContain('claim --path /work/repo/a.md')
})

test('an unclaimed edit, a notebook edit, and an edit whose check failed all go through', async ($, on) => {
  let fail = false
  const w = world(on, () => (fail ? { exitCode: 1 } : { stdout: JSON.stringify({ action: 'allow' }) }))
  await $.tool.call({ tool: 'Write', file_path: '/work/repo/b.md', content: 'x' })
  await $.tool.call({ tool: 'NotebookEdit', notebook_path: '/work/repo/n.ipynb', new_source: 'x' } as any)
  fail = true
  await $.tool.call({ tool: 'Edit', file_path: '/work/repo/c.md', old_string: 'a', new_string: 'b' })
  expect(w.edits).toEqual(['Write', 'NotebookEdit', 'Edit'])
  expect(w.calls.map(c => c.argv[c.argv.length - 1])).toEqual(['/work/repo/b.md', '/work/repo/n.ipynb', '/work/repo/c.md'])
})

test('a headless run (an overnight runner worker) gets no hive at all', async ($, on) => {
  const w = world(on, () => ({ stdout: JSON.stringify({ action: 'refuse', message: 'held by someone' }) }))
  on('env.get', (_: unknown, e: { name?: string; key?: string }) => ({ value: (e.name ?? e.key) === 'CLAUDE_CODE_ENTRYPOINT' ? 'sdk-cli' : '/home/me' }))
  on('session.surfaces', () => ({ value: [] }))
  on('session.start', (_: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/work/repo', surface: null, isInteractive: false })
  const ctx = await $.prompt.context({ blocks: [{ name: 'currentDate', text: 'today' }] })
  expect(ctx.blocks.map(b => b.name)).toEqual(['currentDate'])
  await $.session.receive({ origin: { kind: 'peer' }, text: ENVELOPE })
  expect(w.received).toEqual([ENVELOPE])
  await $.tool.call({ tool: 'Edit', file_path: '/work/repo/a.md', old_string: 'a', new_string: 'b' })
  expect(w.edits).toEqual(['Edit'])
  await $.prompt.submit({ text: 'next', wait: false, origin: { kind: 'composer' } } as any)
  expect(w.submitted[0]!.context).toBeUndefined()
  await $.session.send({ to: 'api-b8', text: 'Thread moved: x → y', origin: { kind: 'model' } })
  expect(w.calls).toEqual([])
})

test('a VS Code session keeps the hive', async ($, on) => {
  const w = world(on, argv => ({ stdout: sub(argv) === 'peers' ? '## Other sessions (session hive)' : '' }))
  on('env.get', (_: unknown, e: { name?: string; key?: string }) => ({ value: (e.name ?? e.key) === 'CLAUDE_CODE_ENTRYPOINT' ? 'claude-vscode' : '/home/me' }))
  on('session.surfaces', () => ({ value: [] }))
  on('session.start', (_: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/work/repo', surface: null, isInteractive: false })
  const ctx = await $.prompt.context({ blocks: [] })
  expect(ctx.blocks.map(b => b.name)).toEqual(['sessionHive'])
  expect(w.calls.length).toBe(1)
})

// A sub-session opened as a VS Code tab: the panel put "[hive:<token>]" in the new tab's box.

function freshTab(on: any, box: { text: string }, opening = ['aaaa1111bbbb2222.opening']) {
  const w = world(on, argv => ({ stdout: sub(argv) === 'pickup' ? JSON.stringify({ action: 'submit', name: 'notice-drafts', text: 'You are **notice-drafts**…\n\n## Brief\n\nDig in.' }) : '' }))
  const clock = mock.clock(on)
  mock.env(on, { CLAUDE_CODE_ENTRYPOINT: 'claude-vscode', HOME: '/home/me' })
  const fills: string[] = []
  const commands: string[] = []
  on('command.run', (_: unknown, e: { command: string; args?: string }) => { commands.push(`/${e.command} ${e.args ?? ''}`.trim()); w.submitted.length && commands.push('AFTER SUBMIT'); return { text: '' } })
  on('session.surfaces', () => ({ value: [] }))
  on('session.turns', () => ({ value: 0 }))
  on('fs.exists', () => ({ value: true }))
  on('fs.list', () => ({ value: opening.map(name => ({ name, kind: 'file' })) }))
  on('prompt.read', () => ({ value: { text: box.text, cursor: 0 } }))
  on('prompt.fill', (_: unknown, e: { text: string }) => { fills.push(e.text); box.text = e.text; return { isFilled: true, text: e.text } })
  on('session.start', (_: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  return { w, clock, fills, commands }
}

test('a fresh VS Code tab opened with a hive tag takes its request and submits the brief as typed', async ($, on) => {
  const box = { text: '' }
  const { w, clock, fills, commands } = freshTab(on, box)
  await $.session.start({ cwd: '/work/repo', surface: null, isInteractive: false })
  await clock.advance(500)
  expect(w.calls.filter(c => sub(c.argv) === 'pickup')).toEqual([])
  box.text = 'Starting sub-session notice-drafts… [hive:aaaa1111bbbb2222]'
  await clock.advance(500)
  const pickups = w.calls.filter(c => sub(c.argv) === 'pickup')
  expect(pickups.length).toBe(1)
  expect(pickups[0]!.argv.join(' ')).toContain('pickup --token aaaa1111bbbb2222')
  expect(fills).toEqual([''])
  expect(commands).toEqual(['/rename notice-drafts'], 'named before the brief is sent')
  expect(w.submitted.map(s => s.text)).toEqual(['You are **notice-drafts**…\n\n## Brief\n\nDig in.'])
  await clock.advance(5000)
  expect(w.calls.filter(c => sub(c.argv) === 'pickup').length).toBe(1)
})

test('a fresh tab where the person types first, or no request is open, is left alone', async ($, on) => {
  const box = { text: 'what does this function do' }
  const { w, clock } = freshTab(on, box)
  await $.session.start({ cwd: '/work/repo', surface: null, isInteractive: false })
  await clock.advance(1000)
  box.text = '[hive:aaaa1111bbbb2222]'
  await clock.advance(25000)
  expect(w.calls.filter(c => sub(c.argv) === 'pickup')).toEqual([])
  expect(w.submitted).toEqual([])
})

test('with no request open, a fresh tab does not watch its box', async ($, on) => {
  const box = { text: '[hive:aaaa1111bbbb2222]' }
  const { w, clock } = freshTab(on, box, ['aaaa1111bbbb2222.taken'])
  await $.session.start({ cwd: '/work/repo', surface: null, isInteractive: false })
  await clock.advance(5000)
  expect(w.calls.filter(c => sub(c.argv) === 'pickup')).toEqual([])
})

test('when the brief cannot be sent, it is left in the box for the person', async ($, on) => {
  const box = { text: 'Starting sub-session notice-drafts… [hive:aaaa1111bbbb2222]' }
  const { w, clock, fills } = freshTab(on, box)
  w.failSubmit = true
  on('ui.toast', () => ({ value: undefined }))
  await $.session.start({ cwd: '/work/repo', surface: null, isInteractive: false })
  await clock.advance(500)
  expect(fills).toEqual(['You are **notice-drafts**…\n\n## Brief\n\nDig in.'])
})

// A watching background session brought into VS Code: the panel left a note for it.

test('a session brought into VS Code mid-watch is told what was cut off, as the plugin', async ($, on) => {
  const note = '[session hive] The user opened this session in VS Code while it was watching a background command (Poll deploy).'
  const w = world(on, argv => ({ stdout: sub(argv) === 'resumed' ? note + '\n' : '' }))
  const clock = mock.clock(on)
  mock.env(on, { CLAUDE_CODE_ENTRYPOINT: 'claude-vscode', HOME: '/home/me' })
  on('session.surfaces', () => ({ value: [] }))
  on('session.turns', () => ({ value: 12 }))
  on('fs.exists', (_: unknown, e: { path: string }) => ({ value: e.path === '/home/me/.claude/session-hive/resume/s1.json' }))
  on('session.start', (_: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/work/repo', surface: null, isInteractive: false })
  await clock.settle()
  expect(w.calls.filter(c => sub(c.argv) === 'resumed').length).toBe(1)
  expect(w.submitted.map(s => s.text)).toEqual([note])
})

test('a VS Code session with no note left for it asks nothing', async ($, on) => {
  const w = world(on, () => ({ stdout: '' }))
  mock.env(on, { CLAUDE_CODE_ENTRYPOINT: 'claude-vscode', HOME: '/home/me' })
  on('session.surfaces', () => ({ value: [] }))
  on('session.turns', () => ({ value: 12 }))
  on('fs.exists', () => ({ value: false }))
  on('session.start', (_: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/work/repo', surface: null, isInteractive: false })
  expect(w.calls.filter(c => sub(c.argv) === 'resumed')).toEqual([])
  expect(w.submitted).toEqual([])
})

// Ready to close: a final debrief is checked for open background tasks before it goes; new work clears the mark.

const DEBRIEF_TEXT = 'Debrief from sub-session ship-3: PR 712 merged, notes in docs/ship.md'

test('a final debrief hive.py refuses is not sent, and the session reads why', async ($, on) => {
  const w = world(on, argv => ({ stdout: sub(argv) === 'check' ? JSON.stringify({ action: 'refuse', message: '[session hive] Not sent: 1 background task is still open: Bash: Poll deploy' }) : '' }))
  const r = await $.session.send({ to: 'desk-4', text: DEBRIEF_TEXT, origin: { kind: 'model' } })
  expect(r).toMatchObject({ isDelivered: false, reason: expect.stringContaining('Poll deploy') })
  expect(w.sends).toBe(0)
  expect(w.calls.map(c => sub(c.argv))).toEqual(['check'])
  expect(w.calls[0]!.stdin).toBe(DEBRIEF_TEXT)
})

test('a final debrief hive.py allows is sent and logged as sent, which marks it', async ($, on) => {
  const w = world(on, argv => ({ stdout: sub(argv) === 'check' ? JSON.stringify({ action: 'allow' }) : '' }))
  const r = await $.session.send({ to: 'desk-4', text: DEBRIEF_TEXT, origin: { kind: 'model' } })
  expect(r.isDelivered).toBe(true)
  expect(w.calls.map(c => sub(c.argv))).toEqual(['check', 'sent'])
  expect(w.calls[1]!.argv).not.toContain('--undelivered')
})

test('a debrief whose check failed still goes; one that was not delivered is logged as such', async ($, on) => {
  const w = world(on, argv => (sub(argv) === 'check' ? { exitCode: 1 } : { stdout: '' }))
  w.undelivered = 'nobody by that name'
  const r = await $.session.send({ to: 'desk-9', text: DEBRIEF_TEXT, origin: { kind: 'model' } })
  expect(r).toMatchObject({ isDelivered: false, reason: 'nobody by that name' })
  expect(w.calls.map(c => sub(c.argv))).toEqual(['check', 'sent'])
  expect(w.calls[1]!.argv).toContain('--undelivered')
})

test('a question or progress note to the Desk is not checked', async ($, on) => {
  const w = world(on, () => ({ stdout: '' }))
  await $.session.send({ to: 'desk-4', text: 'Question: merge 712 before 713?', origin: { kind: 'model' } })
  await $.session.send({ to: 'desk-4', text: '[keep going] Debrief from sub-session ship-3: 712 merged, 713 next', origin: { kind: 'model' } })
  expect(w.calls.map(c => sub(c.argv))).toEqual(['sent', 'sent'])
})

test('a background command, a commit, a PR and a Monitor or Agent are new work; a plain command is not', async ($, on) => {
  const w = world(on, () => ({ stdout: '' }))
  await $.tool.call({ tool: 'Bash', command: 'ls' })
  await $.tool.call({ tool: 'Bash', command: 'npm test', description: 'Run the tests', run_in_background: true })
  await $.tool.call({ tool: 'Bash', command: 'git -C /work/repo commit -m x' })
  await $.tool.call({ tool: 'Bash', command: 'gh pr create --draft' })
  await $.tool.call({ tool: 'Monitor', command: 'tail -f x', description: 'watch' } as any)
  await $.tool.call({ tool: 'Agent', description: 'review', prompt: 'x' } as any)
  const works = w.calls.filter(c => sub(c.argv) === 'work').map(c => c.argv[c.argv.length - 1])
  expect(works).toEqual(['a background command: Run the tests', 'git -C /work/repo commit', 'gh pr create', 'a background Monitor', 'a background Agent'])
  expect(w.edits).toEqual(['Bash', 'Bash', 'Bash', 'Bash', 'Monitor', 'Agent'])
})
