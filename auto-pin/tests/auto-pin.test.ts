import { expect, test } from 'claude-code/testing'

// What the sidebar answers when it pins
const PINNED = { value: { content: [], isError: false } }

test('a new session is pinned as it starts', async ($, on) => {
  const calls: unknown[] = []
  on('session.turns', () => ({ value: 0 }))
  on('mcp.call', ($, e) => {
    calls.push(e)
    return PINNED
  })
  on('command.register', () => ({ value: undefined }))
  on('session.start', () => ({ cwd: '/work' }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))

  await $.session.start({ surface: 'desktop', isInteractive: false, cwd: '/work' })
  expect(calls).toEqual([
    { server: 'ccd_sidebar', tool: 'set_pinned', args: { session_id: 'self', pinned: true } },
  ])

  // Once pinned it is left alone, so unpinning it later sticks
  await $.turn.start({ turnId: 't1' })
  expect(calls.length).toBe(1)
})

test('a resumed session is left as it is', async ($, on) => {
  const calls: unknown[] = []
  on('session.turns', () => ({ value: 3 }))
  on('mcp.call', ($, e) => {
    calls.push(e)
    return PINNED
  })
  on('command.register', () => ({ value: undefined }))
  on('session.start', () => ({ cwd: '/work' }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))

  await $.session.start({ surface: 'desktop', isInteractive: false, cwd: '/work' })
  await $.turn.start({ turnId: 't1' })
  expect(calls.length).toBe(0)
})

test('a pin that fails at the start is tried once more on the first turn', async ($, on) => {
  let isConnected = false
  let calls = 0
  on('session.turns', () => ({ value: 0 }))
  on('mcp.call', () => {
    calls++
    if (!isConnected) throw new Error('no such server')
    return PINNED
  })
  on('command.register', () => ({ value: undefined }))
  on('session.start', () => ({ cwd: '/work' }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))

  await $.session.start({ surface: 'desktop', isInteractive: false, cwd: '/work' })
  expect(calls).toBe(1)

  isConnected = true
  await $.turn.start({ turnId: 't1' })
  expect(calls).toBe(2)

  await $.turn.start({ turnId: 't2' })
  expect(calls).toBe(2)
})
