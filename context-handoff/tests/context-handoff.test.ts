import { expect, mock, test } from 'claude-code/testing'
import type { Engine, On } from 'claude-code/testing'

// What the app answers when it queues the clear
const CLEARED = { value: { content: [{ type: 'text', text: 'queued' }], isError: false } }

// A finished turn of the main loop, as the engine reports it
const turn = (turnId: string, reason: 'answer' | 'aborted' | 'error' = 'answer') =>
  ({ turnId, reason, answer: 'ok', durationMs: 1, isAborted: reason === 'aborted' }) as const

// What the session's context looks like at `percent` full
type Context = { percent: number }

// One call the mod made on the app's session server
type AppCall = { server: string; tool: string; args?: Record<string, unknown> }

// What the app answers: one answer for every call, or one per call
type AppAnswer = unknown | ((call: AppCall) => unknown)

// Wires the engine beneath the mod and records what the mod submits, calls and logs
function wire($: Engine, on: On, context: Context, commands: string[] = [], app: AppAnswer = CLEARED) {
  const submitted: string[] = []
  const calls: AppCall[] = []
  const logged: string[] = []
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
    const call = e as AppCall
    calls.push(call)
    return typeof app === 'function' ? app(call) : app
  })
  on('session.start', () => ({ cwd: '/work' }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))
  on('classic.SessionStart', () => ({}))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.log', ($, e) => {
    logged.push(e.text)
    return { value: undefined }
  })
  return { submitted, calls, logged, clock }
}

// The clear calls among what the mod called
const clears = (calls: AppCall[]) => calls.filter((call) => call.tool === 'clear_session')

test('past the threshold the mod records a hand-off, clears, and resumes in the fresh conversation', async ($, on) => {
  const context = { percent: 45 }
  const { submitted, calls, logged } = wire($, on, context)

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

  // Each step left a line in the transcript
  expect(logged).toEqual([
    'context-handoff: hand-off started: context at 45%, past 40%',
    'context-handoff: the hand-off turn is running',
    'context-handoff: hand-off recorded, clearing the context',
    'context-handoff: continuing in a fresh context',
  ])
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
  const { submitted, calls, logged } = wire($, on, context)
  await $.session.start({ surface: 'desktop', isInteractive: true, cwd: '/work' })
  await $.turn.start({ turnId: 't1', text: 'hello' })
  await $.turn.complete(turn('t1'))
  expect(submitted.length).toBe(1)

  // The user interrupts the hand-off turn: nothing is cleared, and the transcript says why
  await $.turn.start({ turnId: 't2', text: submitted[0] })
  await $.turn.complete(turn('t2', 'aborted'))
  expect(calls.length).toBe(0)
  expect(logged.at(-1)).toBe('context-handoff: gave up: the hand-off turn ended early (aborted)')

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
  const REFUSED = { value: { content: [{ type: 'text', text: 'the session is still working' }], isError: true } }
  const { submitted, calls, logged } = wire($, on, { percent: 45 }, [], REFUSED)
  await $.session.start({ surface: 'desktop', isInteractive: true, cwd: '/work' })
  await $.turn.start({ turnId: 't1', text: 'hello' })
  await $.turn.complete(turn('t1'))
  await $.turn.start({ turnId: 't2', text: submitted[0] })
  await $.turn.complete(turn('t2'))
  expect(logged.at(-1)).toBe('context-handoff: gave up: the app refused to clear the context: the session is still working')

  // No Remote Control change for a refusal that is not about it, and no resume prompt
  expect(calls.length).toBe(1)
  await $.classic.SessionStart({ source: 'clear' })
  expect(submitted.length).toBe(1)
})

test('a session serving Remote Control has it turned off for the clear, and on again after the resume', async ($, on) => {
  let remoteControl = 'on'
  const app = (call: AppCall) => {
    if (call.tool === 'set_remote_control') {
      remoteControl = call.args?.enabled ? 'on' : 'off'
      return { value: { content: [{ type: 'text', text: remoteControl }], isError: false } }
    }
    return remoteControl === 'on'
      ? { value: { content: [{ type: 'text', text: 'a session serving a Remote Control client cannot be cleared' }], isError: true } }
      : CLEARED
  }
  const context = { percent: 45 }
  const { submitted, calls, logged } = wire($, on, context, [], app)
  await $.session.start({ surface: 'desktop', isInteractive: true, cwd: '/work' })
  await $.turn.start({ turnId: 't1', text: 'hello' })
  await $.turn.complete(turn('t1'))
  await $.turn.start({ turnId: 't2', text: submitted[0] })
  await $.turn.complete(turn('t2'))

  // Refused once, Remote Control turned off, cleared on the second try
  expect(calls.map((call) => [call.tool, call.args?.enabled])).toEqual([
    ['clear_session', undefined],
    ['set_remote_control', false],
    ['clear_session', undefined],
  ])
  expect(logged).toContain('context-handoff: Remote Control turned off for the clear; it is turned on again after the resume')
  expect(logged.at(-1)).toBe('context-handoff: hand-off recorded, clearing the context')

  // The fresh conversation resumes; once its first turn has run, Remote Control is turned on again
  await $.session.end({ reason: 'clear', sessionId: 's1', resume: { id: 's1' } })
  await $.classic.SessionStart({ source: 'clear' })
  expect(submitted.length).toBe(2)
  expect(remoteControl).toBe('off')
  context.percent = 3
  await $.turn.start({ turnId: 't3', text: submitted[1] })
  await $.turn.complete(turn('t3'))
  expect(remoteControl).toBe('on')
  expect(logged.at(-1)).toBe('context-handoff: Remote Control turned on again')
  expect(clears(calls).length).toBe(2)
})

test('with pauseRemoteControl off, a Remote Control refusal is given up like any other', { options: { pauseRemoteControl: false } }, async ($, on) => {
  const REFUSED = {
    value: { content: [{ type: 'text', text: 'a session serving a Remote Control client cannot be cleared' }], isError: true },
  }
  const { submitted, calls } = wire($, on, { percent: 45 }, [], REFUSED)
  await $.session.start({ surface: 'desktop', isInteractive: true, cwd: '/work' })
  await $.turn.start({ turnId: 't1', text: 'hello' })
  await $.turn.complete(turn('t1'))
  await $.turn.start({ turnId: 't2', text: submitted[0] })
  await $.turn.complete(turn('t2'))
  expect(calls.map((call) => call.tool)).toEqual(['clear_session'])
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
  'the options set the threshold, the close skill and the prompts',
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

test('/handoff-status tells the phase, the context and what happened last', async ($, on) => {
  const { submitted } = wire($, on, { percent: 45 })
  await $.session.start({ surface: 'desktop', isInteractive: true, cwd: '/work' })
  const before = await $.command.run({ command: 'handoff-status' })
  expect(before.text).toBe('Phase: idle. Context: 45% (threshold 40%). Automatic hand-off: on. Last: nothing yet.')

  await $.turn.start({ turnId: 't1', text: 'hello' })
  await $.turn.complete(turn('t1'))
  expect(submitted.length).toBe(1)
  const during = await $.command.run({ command: 'handoff-status' })
  expect(during.text).toContain('Phase: closing.')
  expect(during.text).toContain('Last: hand-off started: context at 45%, past 40%.')
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
