import { expect, test } from 'claude-code/testing'

// The hooks hand hive.py what the engine knows and act on its answer. Here a
// stand-in for hive.py records each call and answers as the test says.

type Call = { argv: readonly string[]; stdin: string }

function world(on: any, answer: (argv: readonly string[]) => { exitCode?: number; stdout?: string }) {
  const w = { calls: [] as Call[], received: [] as string[], submitted: [] as { text: string; context?: readonly string[] }[], tokens: 50000, usage: 20, edits: [] as string[] }
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
  on('prompt.submit', (_: unknown, e: { text: string; context?: readonly string[] }) => { w.submitted.push({ text: e.text, context: e.context }); return { text: e.text, context: e.context } })
  on('prompt.context', (_: unknown, e: { blocks: readonly unknown[] }) => ({ blocks: e.blocks }))
  on('session.send', () => ({ isDelivered: true }))
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
