import { expect, mock, test } from 'claude-code/testing'
import type { Engine, On } from 'claude-code/testing'

// What the app answers when it queues the clear
const CLEARED = { value: { content: [{ type: 'text', text: 'queued' }], isError: false } }

// A finished turn of the main loop, as the engine reports it
const turn = (turnId: string, reason: 'answer' | 'aborted' | 'error' = 'answer') =>
  ({ turnId, reason, answer: 'ok', durationMs: 1, isAborted: reason === 'aborted' }) as const

// What the session's context looks like at `percent` full
type Context = { percent: number }

// Wires the engine beneath the mod and records what the mod submits and calls
function wire($: Engine, on: On, context: Context, commands: string[] = [], mcp: unknown = CLEARED) {
  const submitted: string[] = []
  const calls: unknown[] = []
  const clock = mock.clock(on)
  on('session.usage', () => ({
    value: {
      startedAt: 0,
      context: { tokens: context.percent * 10000, window: 1000000, percent: context.percent },
      rateLimits: [],
    },
  }))
  on('command.register', () => ({ value: undefined }))
  on('command.list', () => ({
    value: commands.map((name) => ({ name, description: '', source: 'user' as const })),
  }))
  on('session.root', () => ({ value: '/work' }))
  on('fs.exists', () => ({ value: false }))
  on('prompt.submit', ($, e) => {
    submitted.push(e.text)
    return { text: e.text, origin: e.origin }
  })
  on('mcp.call', ($, e) => {
    calls.push(e)
    return mcp
  })
  on('session.start', () => ({ cwd: '/work' }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))
  on('classic.SessionStart', () => ({}))
  on('ui.toast', () => ({ value: undefined }))
  return { submitted, calls, clock }
}

test('past the threshold the mod records a hand-off, clears, and resumes in the fresh conversation', async ($, on) => {
  const context = { percent: 45 }
  const { submitted, calls } = wire($, on, context)

  await $.session.start({ surface: 'desktop', isInteractive: true, cwd: '/work' })
  await $.turn.start({ turnId: 't1', text: 'fix the build' })
  await $.turn.complete(turn('t1'))

  // The hand-off prompt is submitted, and nothing is cleared yet
  expect(submitted.length).toBe(1)
  expect(submitted[0]).toContain('[context-handoff]')
  expect(submitted[0]).toContain('45% full, past the 40%')
  expect(submitted[0]).toContain('HANDOFF.md')
  expect(calls.length).toBe(0)

  // The hand-off turn runs and ends: the clear is asked for
  await $.turn.start({ turnId: 't2', text: submitted[0] })
  await $.turn.complete(turn('t2'))
  expect(calls).toEqual([{ server: 'ccd_session_mgmt', tool: 'clear_session', args: { session_id: 'self' } }])
  expect(submitted.length).toBe(1)

  // The conversation ends with the clear, and the fresh one begins: the resume prompt is submitted once
  await $.session.end({ reason: 'clear', sessionId: 's1', resume: { id: 's1' } })
  await $.classic.SessionStart({ source: 'clear' })
  expect(submitted.length).toBe(2)
  expect(submitted[1]).toContain('cleared after a hand-off')
  expect(submitted[1]).toContain('PROGRESS.md')

  // The fresh conversation is far below the threshold, so its turns pass
  context.percent = 3
  await $.turn.start({ turnId: 't3', text: submitted[1] })
  await $.turn.complete(turn('t3'))
  expect(submitted.length).toBe(2)
  expect(calls.length).toBe(1)
})

test('below the threshold nothing happens', async ($, on) => {
  const { submitted, calls } = wire($, on, { percent: 39 })
  await $.session.start({ surface: 'desktop', isInteractive: true, cwd: '/work' })
  await $.turn.start({ turnId: 't1', text: 'hello' })
  await $.turn.complete(turn('t1'))
  expect(submitted.length).toBe(0)
  expect(calls.length).toBe(0)
})

test('a turn the user ran before the hand-off turn is left alone', async ($, on) => {
  const { submitted, calls } = wire($, on, { percent: 50 })
  await $.session.start({ surface: 'desktop', isInteractive: true, cwd: '/work' })
  await $.turn.start({ turnId: 't1', text: 'hello' })
  await $.turn.complete(turn('t1'))
  expect(submitted.length).toBe(1)

  // A prompt the user had queued runs first: no clear, no second hand-off
  await $.turn.start({ turnId: 't2', text: 'one more thing' })
  await $.turn.complete(turn('t2'))
  expect(calls.length).toBe(0)
  expect(submitted.length).toBe(1)

  // Then the hand-off turn runs
  await $.turn.start({ turnId: 't3', text: submitted[0] })
  await $.turn.complete(turn('t3'))
  expect(calls.length).toBe(1)
})

test('an interrupted hand-off is given up, and tried again once the context grew by the step', async ($, on) => {
  const context = { percent: 41 }
  const { submitted, calls } = wire($, on, context)
  await $.session.start({ surface: 'desktop', isInteractive: true, cwd: '/work' })
  await $.turn.start({ turnId: 't1', text: 'hello' })
  await $.turn.complete(turn('t1'))
  expect(submitted.length).toBe(1)

  // The user interrupts the hand-off turn: nothing is cleared
  await $.turn.start({ turnId: 't2', text: submitted[0] })
  await $.turn.complete(turn('t2', 'aborted'))
  expect(calls.length).toBe(0)

  // Still over the threshold, but not by the step: no new hand-off
  context.percent = 44
  await $.turn.start({ turnId: 't3', text: 'go on' })
  await $.turn.complete(turn('t3'))
  expect(submitted.length).toBe(1)

  // Grown by the step: the hand-off is tried again
  context.percent = 46
  await $.turn.start({ turnId: 't4', text: 'go on' })
  await $.turn.complete(turn('t4'))
  expect(submitted.length).toBe(2)
})

test('a turn that runs after the clear was asked for records the hand-off again', async ($, on) => {
  const { submitted, calls } = wire($, on, { percent: 45 })
  await $.session.start({ surface: 'desktop', isInteractive: true, cwd: '/work' })
  await $.turn.start({ turnId: 't1', text: 'hello' })
  await $.turn.complete(turn('t1'))
  await $.turn.start({ turnId: 't2', text: submitted[0] })
  await $.turn.complete(turn('t2'))
  expect(calls.length).toBe(1)

  // The app dropped the clear because the user had a message waiting; that message runs
  await $.turn.start({ turnId: 't3', text: 'also do this' })
  await $.turn.complete(turn('t3'))
  expect(submitted.length).toBe(2)
  expect(submitted[1]).toContain('[context-handoff]')

  // And the second hand-off turn leads to a clear again
  await $.turn.start({ turnId: 't4', text: submitted[1] })
  await $.turn.complete(turn('t4'))
  expect(calls.length).toBe(2)
})

test('a clear the app refuses is reported and given up', async ($, on) => {
  const REFUSED = { value: { content: [{ type: 'text', text: 'session is pinned' }], isError: true } }
  const { submitted } = wire($, on, { percent: 45 }, [], REFUSED)
  await $.session.start({ surface: 'desktop', isInteractive: true, cwd: '/work' })
  await $.turn.start({ turnId: 't1', text: 'hello' })
  await $.turn.complete(turn('t1'))
  await $.turn.start({ turnId: 't2', text: submitted[0] })
  await $.turn.complete(turn('t2'))

  // No clear happened, so no resume prompt follows
  await $.classic.SessionStart({ source: 'clear' })
  expect(submitted.length).toBe(1)
})

test("the project's close skill is run when the project has it", async ($, on) => {
  const { submitted } = wire($, on, { percent: 45 }, ['session-close', 'deploy-staging'])
  await $.session.start({ surface: 'desktop', isInteractive: true, cwd: '/work' })
  await $.turn.start({ turnId: 't1', text: 'hello' })
  await $.turn.complete(turn('t1'))
  expect(submitted.length).toBe(1)
  expect(submitted[0].startsWith('[context-handoff]')).toBe(true)
  expect(submitted[0]).toContain('/session-close skill')
  expect(submitted[0]).toContain('45% full')
  expect(submitted[0]).not.toContain('HANDOFF.md')
})

test(
  'the options set the threshold, the close skill and the prompts, and turn the automatic hand-off off',
  { options: { threshold: 20, closeCommand: '/wrap-up', closePrompt: 'Close at {percent}% ({threshold}%)', resumePrompt: 'Go on' } },
  async ($, on) => {
    const { submitted, calls } = wire($, on, { percent: 25 }, ['wrap-up'])
    await $.session.start({ surface: 'desktop', isInteractive: true, cwd: '/work' })
    await $.turn.start({ turnId: 't1', text: 'hello' })
    await $.turn.complete(turn('t1'))
    // A custom prompt replaces both the built-in one and the close skill
    expect(submitted).toEqual(['[context-handoff] Close at 25% (20%)'])

    await $.turn.start({ turnId: 't2', text: submitted[0] })
    await $.turn.complete(turn('t2'))
    expect(calls.length).toBe(1)
    await $.session.end({ reason: 'clear', sessionId: 's1', resume: { id: 's1' } })
    await $.classic.SessionStart({ source: 'clear' })
    expect(submitted[1]).toBe('[context-handoff] Go on')
  },
)

test('with the automatic hand-off off, only /handoff-now hands off', { options: { enabled: false } }, async ($, on) => {
  const { submitted, calls, clock } = wire($, on, { percent: 90 })
  await $.session.start({ surface: 'desktop', isInteractive: true, cwd: '/work' })
  await $.turn.start({ turnId: 't1', text: 'hello' })
  await $.turn.complete(turn('t1'))
  expect(submitted.length).toBe(0)

  const { text } = await $.command.run({ command: 'handoff-now' })
  expect(text).toContain('Recording the hand-off at 90%')

  // While one is in progress the command says so instead of starting another
  const again = await $.command.run({ command: 'handoff-now' })
  expect(again.text).toContain('already in progress')

  // The prompt is submitted a moment after the command, once its run has ended
  expect(submitted.length).toBe(0)
  await clock.advance(50)
  expect(submitted.length).toBe(1)
  expect(submitted[0]).toContain('90% full')

  await $.turn.start({ turnId: 't2', text: submitted[0] })
  await $.turn.complete(turn('t2'))
  expect(calls.length).toBe(1)
})

test('when no SessionStart follows the clear, the resume prompt is submitted by the timer', async ($, on) => {
  const { submitted, clock } = wire($, on, { percent: 45 })
  await $.session.start({ surface: 'desktop', isInteractive: true, cwd: '/work' })
  await $.turn.start({ turnId: 't1', text: 'hello' })
  await $.turn.complete(turn('t1'))
  await $.turn.start({ turnId: 't2', text: submitted[0] })
  await $.turn.complete(turn('t2'))
  await $.session.end({ reason: 'clear', sessionId: 's1', resume: { id: 's1' } })
  expect(submitted.length).toBe(1)

  await clock.advance(3000)
  expect(submitted.length).toBe(2)
  expect(submitted[1]).toContain('cleared after a hand-off')

  // A SessionStart arriving afterwards does not submit it twice
  await $.classic.SessionStart({ source: 'clear' })
  expect(submitted.length).toBe(2)
})
