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

// What the engine does when the mod compacts: the compaction, or a throw while a turn runs
type Compactor = (instructions: string | undefined) => unknown

// The transcript the engine hands a compaction, and the summary a compaction leaves
const TRANSCRIPT = [
  { role: 'user' as const, text: 'fix the build', toolUses: [] },
  { role: 'assistant' as const, text: 'done', toolUses: [] },
]
const SUMMARY = { role: 'assistant' as const, text: 'The notes are in PROGRESS.md; next: Phase C', toolUses: [] }

type WireOptions = {
  commands?: string[]
  app?: AppAnswer
  compact?: Compactor
  store?: Record<string, unknown>
  turns?: number
}

// Wires the engine beneath the mod and records what the mod submits, calls, stores and logs
function wire($: Engine, on: On, context: Context, options: WireOptions = {}) {
  const { commands = [], app = CLEARED, compact = () => ({ messages: [SUMMARY], tokensBefore: 450000, tokensAfter: 2100 }) } = options
  const store: Record<string, unknown> = { ...(options.store ?? {}) }
  const submitted: string[] = []
  const calls: AppCall[] = []
  const logged: string[] = []
  const compactions: (string | undefined)[] = []
  const clock = mock.clock(on)
  on('session.usage', () => ({
    value: {
      startedAt: 0,
      context: { tokens: context.percent * 10000, window: 1000000, percent: context.percent },
      rateLimits: [],
    },
  }))
  on('session.turns', () => ({ value: options.turns ?? 1 }))
  on('session.messages', () => ({ value: TRANSCRIPT }))
  on('session.cwd', () => ({ value: '/work' }))
  on('session.root', () => ({ value: '/work' }))
  on('command.register', () => ({ value: undefined }))
  on('command.list', () => ({
    value: commands.map((name) => ({ name, description: '', source: 'user' as const })),
  }))
  on('fs.exists', () => ({ value: false }))
  on('store.get', ($, e) => ({ value: store[e.key] }))
  on('store.set', ($, e) => {
    store[e.key] = e.value
    return { value: undefined }
  })
  on('store.delete', ($, e) => {
    delete store[e.key]
    return { value: undefined }
  })
  on('prompt.submit', ($, e) => {
    submitted.push(e.text)
    return { text: e.text, origin: e.origin }
  })
  on('session.compact', ($, e) => {
    compactions.push(e.instructions)
    return compact(e.instructions)
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
  return { submitted, calls, logged, compactions, store, clock }
}

// The clear calls among what the mod called
const clears = (calls: AppCall[]) => calls.filter((call) => call.tool === 'clear_session')

// Runs the session up to the end of the hand-off turn: the hand-off prompt is submitted[0]
async function handOff($: Engine, submitted: string[], reason: 'answer' | 'aborted' = 'answer') {
  await $.session.start({ surface: 'desktop', isInteractive: true, cwd: '/work' })
  await $.turn.start({ turnId: 't1', text: 'fix the build' })
  await $.turn.complete(turn('t1'))
  expect(submitted.length).toBe(1)
  await $.turn.start({ turnId: 't2', text: submitted[0] })
  await $.turn.complete(turn('t2', reason))
}

test('past the threshold the mod records a hand-off, compacts the conversation, and resumes', async ($, on) => {
  const context = { percent: 45 }
  const { submitted, calls, logged, compactions, clock } = wire($, on, context)

  await $.session.start({ surface: 'desktop', isInteractive: true, cwd: '/work' })
  await $.turn.start({ turnId: 't1', text: 'fix the build' })
  await $.turn.complete(turn('t1'))

  // The hand-off prompt is submitted; nothing is compacted or asked of the app yet
  expect(submitted.length).toBe(1)
  expect(submitted[0]).toContain('[context-handoff]')
  expect(submitted[0]).toContain('45% full, past the 40%')
  expect(submitted[0]).toContain('HANDOFF.md')
  expect(compactions.length).toBe(0)

  // The hand-off turn runs and ends: a moment later the conversation is compacted, then the resume prompt follows
  await $.turn.start({ turnId: 't2', text: submitted[0] })
  await $.turn.complete(turn('t2'))
  expect(compactions.length).toBe(0)
  await clock.advance(300)
  expect(compactions.length).toBe(1)
  expect(compactions[0]).toContain('Keep only')
  expect(submitted.length).toBe(2)
  expect(submitted[1]).toContain('reset after a hand-off')
  expect(submitted[1]).toContain('PROGRESS.md')
  expect(calls.length).toBe(0)

  // The compacted conversation is far below the threshold, so its turns pass
  context.percent = 3
  await $.turn.start({ turnId: 't3', text: submitted[1] })
  await $.turn.complete(turn('t3'))
  expect(submitted.length).toBe(2)
  expect(compactions.length).toBe(1)

  // Each step left a line in the transcript
  expect(logged).toEqual([
    'context-handoff: hand-off started: context at 45%, past 40%',
    'context-handoff: the hand-off turn is running',
    'context-handoff: hand-off recorded, compacting the conversation',
    'context-handoff: compacted the conversation (450000 to 2100 tokens)',
    'context-handoff: continuing in a fresh context',
  ])
})

test('a compaction refused while a turn still runs is tried again', async ($, on) => {
  let refusals = 2
  const compact: Compactor = () => {
    if (refusals-- > 0) throw new Error('a turn is running')
    return { messages: [SUMMARY] }
  }
  const { submitted, compactions, logged, clock } = wire($, on, { percent: 45 }, { compact })
  await handOff($, submitted)
  await clock.advance(300)
  expect(compactions.length).toBe(1)
  expect(submitted.length).toBe(1)
  await clock.advance(1000)
  expect(compactions.length).toBe(2)
  await clock.advance(2000)
  expect(compactions.length).toBe(3)
  expect(submitted.length).toBe(2)
  expect(logged.at(-1)).toBe('context-handoff: continuing in a fresh context')
})

test('a compaction that keeps failing, or is skipped, is given up', async ($, on) => {
  const { submitted, compactions, logged, clock } = wire($, on, { percent: 45 }, {
    compact: () => {
      throw new Error('a turn is running')
    },
  })
  await handOff($, submitted)
  await clock.advance(300 + 1000 + 2000 + 4000 + 8000)
  expect(compactions.length).toBe(5)
  expect(logged.at(-1)).toContain('context-handoff: gave up: the conversation could not be compacted')
  expect(submitted.length).toBe(1)
})

test('a skipped compaction is given up', async ($, on) => {
  const { submitted, logged, clock } = wire($, on, { percent: 45 }, { compact: () => ({ skip: 'a hook vetoed it' }) })
  await handOff($, submitted)
  await clock.advance(300)
  expect(logged.at(-1)).toBe('context-handoff: gave up: the compaction was skipped: a hook vetoed it')
  expect(submitted.length).toBe(1)
})

// --- The /compact command in the call's place: chosen, or where the session has no call (the desktop app's) ---

const COMMAND = { options: { compaction: 'command' } }

// One /compact run the mod asked for
type CommandRun = { command: string; args: string }

test('with the command, /compact is run with the instructions and the resume follows its compaction', COMMAND, async ($, on) => {
  const context = { percent: 45 }
  const ran: CommandRun[] = []
  const engine = $
  const { submitted, logged, compactions, clock } = wire($, on, context, { commands: ['compact'] })
  // The engine runs the queued /compact as a turn: the compaction passes through the mod's hook, then the command answers
  on('command.run', async (_, e) => {
    ran.push({ command: e.command, args: e.args })
    const result = await engine.session.compact({ trigger: 'manual', instructions: e.args, messages: TRANSCRIPT })
    context.percent = 3
    return { text: result.skip ? `skipped: ${result.skip}` : 'Compacted' }
  })
  await handOff($, submitted)
  expect(ran.length).toBe(0)
  await clock.advance(300)

  // No call was made; /compact ran with the same instructions, and its compaction was seen
  expect(ran.length).toBe(1)
  expect(ran[0].command).toBe('compact')
  expect(ran[0].args).toContain('Keep only')
  expect(compactions).toEqual([ran[0].args])
  expect(logged.slice(-3)).toEqual([
    'context-handoff: hand-off recorded, compacting the conversation',
    'context-handoff: compacting through /compact, as configured',
    'context-handoff: compacted the conversation (450000 to 2100 tokens)',
  ])

  // The resume prompt follows a moment later, once
  expect(submitted.length).toBe(1)
  await clock.advance(1000)
  expect(submitted.length).toBe(2)
  expect(submitted[1]).toContain('reset after a hand-off')
  expect(logged.at(-1)).toBe('context-handoff: continuing in a fresh context')
  await clock.advance(5 * 60 * 1000)
  expect(submitted.length).toBe(2)

  const status = await $.command.run({ command: 'handoff-status' })
  expect(status.text).toContain('Phase: idle.')
})

test('when the hook sees no compaction, the /compact command is taken at its word once the context has dropped', COMMAND, async ($, on) => {
  const context = { percent: 45 }
  const { submitted, logged, clock } = wire($, on, context, { commands: ['compact'] })
  on('command.run', () => {
    context.percent = 4
    return { text: 'Compacted' }
  })
  await handOff($, submitted)
  await clock.advance(300)
  expect(logged.at(-1)).toBe('context-handoff: the /compact command finished, the context at 4%')
  expect(submitted.length).toBe(1)
  await clock.advance(1000)
  expect(submitted.length).toBe(2)
  expect(submitted[1]).toContain('reset after a hand-off')
})

test('a /compact command that leaves the context where it was is given up', COMMAND, async ($, on) => {
  const { submitted, logged, clock } = wire($, on, { percent: 45 }, { commands: ['compact'] })
  on('command.run', () => ({ text: 'Error compacting conversation' }))
  await handOff($, submitted)
  await clock.advance(300)
  expect(logged.at(-1)).toBe(
    'context-handoff: gave up: the /compact command ran, but the context is still at 45%: Error compacting conversation',
  )
  await clock.advance(1000)
  expect(submitted.length).toBe(1)
})

test('a /compact command the session refuses is given up', COMMAND, async ($, on) => {
  const { submitted, logged, clock } = wire($, on, { percent: 45 }, { commands: [] })
  await handOff($, submitted)
  await clock.advance(300)
  expect(logged.at(-1)).toContain('context-handoff: gave up: the /compact command failed: ')
  await clock.advance(1000)
  expect(submitted.length).toBe(1)
})

test('a compaction /compact runs that is skipped is given up', COMMAND, async ($, on) => {
  const engine = $
  const { submitted, logged, clock } = wire($, on, { percent: 45 }, {
    compact: () => ({ skip: 'a hook vetoed it' }),
    commands: ['compact'],
  })
  on('command.run', async (_, e) => {
    const result = await engine.session.compact({ trigger: 'manual', instructions: e.args, messages: TRANSCRIPT })
    return { text: result.skip ? `skipped: ${result.skip}` : 'Compacted' }
  })
  await handOff($, submitted)
  await clock.advance(300)
  expect(logged.at(-1)).toBe('context-handoff: gave up: the compaction was skipped: a hook vetoed it')
  await clock.advance(1000)
  expect(submitted.length).toBe(1)
})

test("a compaction the engine makes on its own while /compact is awaited serves as the hand-off's", COMMAND, async ($, on) => {
  const context = { percent: 45 }
  const { submitted, logged, clock } = wire($, on, context, { commands: ['compact'] })
  let answer: (() => void) | null = null
  on('command.run', () => new Promise<{ text: string }>((resolve) => (answer = () => resolve({ text: 'Compacted' }))))
  await handOff($, submitted)
  await clock.advance(300)
  expect(logged.at(-1)).toBe('context-handoff: compacting through /compact, as configured')

  // The threshold compaction runs first
  await $.session.compact({ trigger: 'auto', messages: TRANSCRIPT })
  expect(logged.at(-1)).toBe('context-handoff: compacted the conversation (450000 to 2100 tokens)')
  await clock.advance(1000)
  expect(submitted.length).toBe(2)

  // The command's own answer, arriving afterwards, changes nothing
  answer!()
  await clock.advance(0)
  expect(submitted.length).toBe(2)
  expect(logged.at(-1)).toBe('context-handoff: continuing in a fresh context')
})

test('a /compact command that never compacts is given up after five minutes', COMMAND, async ($, on) => {
  const { submitted, logged, clock } = wire($, on, { percent: 45 }, { commands: ['compact'] })
  on('command.run', () => new Promise<{ text: string }>(() => {}))
  await handOff($, submitted)
  await clock.advance(300)
  await clock.advance(5 * 60 * 1000 - 1)
  expect(logged.at(-1)).toBe('context-handoff: compacting through /compact, as configured')
  await clock.advance(1)
  expect(logged.at(-1)).toBe('context-handoff: gave up: the /compact command did not compact the conversation within 5 min')
  expect(submitted.length).toBe(1)
})

test('with the call alone, a refusal naming a headless session is retried like any other', { options: { compaction: 'call' } }, async ($, on) => {
  const ran: CommandRun[] = []
  const { submitted, compactions, logged, clock } = wire($, on, { percent: 45 }, {
    compact: () => {
      throw new Error('not available in a headless (-p / SDK) session yet')
    },
    commands: ['compact'],
  })
  on('command.run', (_, e) => {
    ran.push({ command: e.command, args: e.args })
    return { text: 'Compacted' }
  })
  await handOff($, submitted)
  await clock.advance(300 + 1000 + 2000 + 4000 + 8000)
  expect(compactions.length).toBe(5)
  expect(ran.length).toBe(0)
  expect(logged.at(-1)).toContain('context-handoff: gave up: the conversation could not be compacted')
})

test('below the threshold nothing happens', async ($, on) => {
  const { submitted, compactions } = wire($, on, { percent: 39 })
  await $.session.start({ surface: 'desktop', isInteractive: true, cwd: '/work' })
  await $.turn.start({ turnId: 't1', text: 'hello' })
  await $.turn.complete(turn('t1'))
  expect(submitted.length).toBe(0)
  expect(compactions.length).toBe(0)
})

test('a turn the user ran before the hand-off turn is left alone', async ($, on) => {
  const { submitted, compactions, clock } = wire($, on, { percent: 50 })
  await $.session.start({ surface: 'desktop', isInteractive: true, cwd: '/work' })
  await $.turn.start({ turnId: 't1', text: 'hello' })
  await $.turn.complete(turn('t1'))
  expect(submitted.length).toBe(1)

  // A prompt the user had queued runs first: no compaction, no second hand-off
  await $.turn.start({ turnId: 't2', text: 'one more thing' })
  await $.turn.complete(turn('t2'))
  await clock.advance(300)
  expect(compactions.length).toBe(0)
  expect(submitted.length).toBe(1)

  // Then the hand-off turn runs, and the compaction follows it
  await $.turn.start({ turnId: 't3', text: submitted[0] })
  await $.turn.complete(turn('t3'))
  await clock.advance(300)
  expect(compactions.length).toBe(1)
})

test('an interrupted hand-off is given up, and tried again once the context grew by the step', async ($, on) => {
  const context = { percent: 41 }
  const { submitted, compactions, logged, clock } = wire($, on, context)
  await handOff($, submitted, 'aborted')
  await clock.advance(300)
  expect(compactions.length).toBe(0)
  expect(logged.at(-1)).toBe('context-handoff: gave up: the hand-off turn was interrupted')

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

test("the project's close skill is run when the project has it", async ($, on) => {
  const { submitted } = wire($, on, { percent: 45 }, { commands: ['session-close', 'deploy-staging'] })
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
    const { submitted, clock } = wire($, on, { percent: 25 }, { commands: ['wrap-up'] })
    await $.session.start({ surface: 'desktop', isInteractive: true, cwd: '/work' })
    await $.turn.start({ turnId: 't1', text: 'hello' })
    await $.turn.complete(turn('t1'))
    // A custom prompt replaces both the built-in one and the close skill
    expect(submitted).toEqual(['[context-handoff] Close at 25% (20%)'])

    await $.turn.start({ turnId: 't2', text: submitted[0] })
    await $.turn.complete(turn('t2'))
    await clock.advance(300)
    expect(submitted[1]).toBe('[context-handoff] Go on')
  },
)

test('with the automatic hand-off off, only /handoff-now hands off', { options: { enabled: false } }, async ($, on) => {
  const { submitted, compactions, clock } = wire($, on, { percent: 90 })
  await $.session.start({ surface: 'desktop', isInteractive: true, cwd: '/work' })
  await $.turn.start({ turnId: 't1', text: 'hello' })
  await $.turn.complete(turn('t1'))
  expect(submitted.length).toBe(0)

  const { text } = await $.command.run({ command: 'handoff-now' })
  expect(text).toContain('Recording the hand-off at 90%')
  expect(text).toContain('(compact)')

  // While one is in progress the command says so instead of starting another
  const again = await $.command.run({ command: 'handoff-now' })
  expect(again.text).toContain('already in progress')

  // The prompt is submitted a moment after the command, once its run has ended, and says
  // the hand-off was asked for rather than that a threshold was passed
  expect(submitted.length).toBe(0)
  await clock.advance(50)
  expect(submitted.length).toBe(1)
  expect(submitted[0]).toContain('90% full; a hand-off was asked for with /handoff-now.')
  expect(submitted[0].includes('threshold')).toBe(false)

  await $.turn.start({ turnId: 't2', text: submitted[0] })
  await $.turn.complete(turn('t2'))
  await clock.advance(300)
  expect(compactions.length).toBe(1)
})

test('/handoff-status tells the phase, the context, the reset and what happened last', async ($, on) => {
  const { submitted } = wire($, on, { percent: 45 })
  await $.session.start({ surface: 'desktop', isInteractive: true, cwd: '/work' })
  const before = await $.command.run({ command: 'handoff-status' })
  expect(before.text).toBe(
    'Phase: idle. Context: 45% (threshold 40%). Automatic hand-off: on. Reset: compact. Last: nothing yet.',
  )

  await $.turn.start({ turnId: 't1', text: 'hello' })
  await $.turn.complete(turn('t1'))
  expect(submitted.length).toBe(1)
  const during = await $.command.run({ command: 'handoff-status' })
  expect(during.text).toContain('Phase: closing.')
  expect(during.text).toContain('Last: hand-off started: context at 45%, past 40%.')
})

// --- The desktop app's clear, chosen with reset: 'clear' ---

const CLEAR = { options: { reset: 'clear' } }

test('with the clear, the app is asked as the hand-off turn starts, and the fresh conversation resumes', CLEAR, async ($, on) => {
  const context = { percent: 45 }
  const { submitted, calls, logged, store, compactions } = wire($, on, context, {
    app: (call: AppCall) =>
      call.tool === 'get_session'
        ? { value: { content: [{ type: 'text', text: JSON.stringify({ sessionId: 'local_a', title: 'work' }) }], isError: false } }
        : CLEARED,
  })

  await $.session.start({ surface: 'desktop', isInteractive: true, cwd: '/work' })
  await $.turn.start({ turnId: 't1', text: 'fix the build' })
  await $.turn.complete(turn('t1'))
  expect(submitted.length).toBe(1)
  expect(clears(calls).length).toBe(0)

  // As the hand-off turn starts, the app is asked to clear the conversation when it ends,
  // and the resume to make is stored for the process the app starts afterwards
  await $.turn.start({ turnId: 't2', text: submitted[0] })
  expect(clears(calls)).toEqual([{ server: 'ccd_session_mgmt', tool: 'clear_session', args: { session_id: 'self' } }])
  expect(store.pendingResume).toEqual({ appSessionId: 'local_a', cwd: '/work', askedAt: 0 })
  await $.turn.complete(turn('t2'))
  expect(submitted.length).toBe(1)
  expect(compactions.length).toBe(0)

  // Where the process goes on, the conversation ends with the clear and the fresh one begins
  await $.session.end({ reason: 'clear', sessionId: 's1', resume: { id: 's1' } })
  await $.classic.SessionStart({ source: 'clear' })
  expect(submitted.length).toBe(2)
  expect(submitted[1]).toContain('reset after a hand-off')
  expect(store.pendingResume).toBeUndefined()

  context.percent = 3
  await $.turn.start({ turnId: 't3', text: submitted[1] })
  await $.turn.complete(turn('t3'))
  expect(submitted.length).toBe(2)
  expect(clears(calls).length).toBe(1)

  expect(logged).toEqual([
    'context-handoff: hand-off started: context at 45%, past 40%',
    'context-handoff: the hand-off turn is running',
    'context-handoff: the app will clear the conversation when the hand-off turn ends',
    'context-handoff: hand-off recorded, waiting for the app to clear the conversation',
    'context-handoff: continuing in a fresh context',
  ])
})

test('a fresh process after the clear finds the stored resume and continues from the notes', CLEAR, async ($, on) => {
  const { submitted, logged, store, clock } = wire($, on, { percent: 0 }, {
    turns: 0,
    store: { pendingResume: { appSessionId: 'local_a', cwd: '/work', askedAt: 0 } },
    app: (call: AppCall) =>
      call.tool === 'get_session'
        ? { value: { content: [{ type: 'text', text: JSON.stringify({ sessionId: 'local_a' }) }], isError: false } }
        : CLEARED,
  })
  await $.session.start({ surface: 'desktop', isInteractive: true, cwd: '/work' })
  expect(logged.at(-1)).toBe('context-handoff: a fresh process after the clear; continuing from the notes')
  expect(store.pendingResume).toBeUndefined()
  expect(submitted.length).toBe(0)
  await clock.advance(1000)
  expect(submitted.length).toBe(1)
  expect(submitted[0]).toContain('reset after a hand-off')
})

test("a stored resume of another session, or of a conversation that already ran, is not taken", CLEAR, async ($, on) => {
  // Another session's: left in the store for it
  const other = wire($, on, { percent: 0 }, {
    turns: 0,
    store: { pendingResume: { appSessionId: 'local_b', cwd: '/work', askedAt: 0 } },
    app: (call: AppCall) =>
      call.tool === 'get_session'
        ? { value: { content: [{ type: 'text', text: JSON.stringify({ sessionId: 'local_a' }) }], isError: false } }
        : CLEARED,
  })
  await $.session.start({ surface: 'desktop', isInteractive: true, cwd: '/work' })
  await other.clock.advance(1000)
  expect(other.submitted.length).toBe(0)
  expect(other.store.pendingResume).toBeDefined()
})

test('a stored resume is dropped once prompts have run or it is too old', CLEAR, async ($, on) => {
  const { submitted, store, clock } = wire($, on, { percent: 0 }, {
    turns: 3,
    store: { pendingResume: { appSessionId: 'local_a', cwd: '/work', askedAt: 0 } },
  })
  await $.session.start({ surface: 'desktop', isInteractive: true, cwd: '/work' })
  await clock.advance(1000)
  expect(submitted.length).toBe(0)
  expect(store.pendingResume).toBeUndefined()
})

test('with the clear, a turn that runs after the hand-off turn records the hand-off again', CLEAR, async ($, on) => {
  const { submitted, calls } = wire($, on, { percent: 45 })
  await handOff($, submitted)
  expect(clears(calls).length).toBe(1)

  // The app dropped the clear because the user had a message waiting; that message runs
  await $.turn.start({ turnId: 't3', text: 'also do this' })
  await $.turn.complete(turn('t3'))
  expect(submitted.length).toBe(2)
  expect(submitted[1]).toContain('[context-handoff]')

  // And the second hand-off turn asks for a clear again
  await $.turn.start({ turnId: 't4', text: submitted[1] })
  expect(clears(calls).length).toBe(2)
})

test('with the clear, when the app does not clear the conversation after the hand-off turn, the mod gives up', CLEAR, async ($, on) => {
  const { submitted, logged, store, clock } = wire($, on, { percent: 45 })
  await handOff($, submitted)
  expect(logged.at(-1)).toBe('context-handoff: hand-off recorded, waiting for the app to clear the conversation')
  expect(store.pendingResume).toBeDefined()

  await clock.advance(7999)
  expect(logged.at(-1)).toBe('context-handoff: hand-off recorded, waiting for the app to clear the conversation')
  await clock.advance(1)
  expect(logged.at(-1)).toBe(
    'context-handoff: gave up: the app did not clear the conversation within 8 s of the hand-off turn ending',
  )
  expect(store.pendingResume).toBeUndefined()
  await $.classic.SessionStart({ source: 'clear' })
  expect(submitted.length).toBe(1)
})

test('with the clear, a clear the app refuses is reported and given up', CLEAR, async ($, on) => {
  const REFUSED = { value: { content: [{ type: 'text', text: 'a message the user sent is waiting' }], isError: true } }
  const { submitted, calls, logged } = wire($, on, { percent: 45 }, { app: REFUSED })
  await $.session.start({ surface: 'desktop', isInteractive: true, cwd: '/work' })
  await $.turn.start({ turnId: 't1', text: 'hello' })
  await $.turn.complete(turn('t1'))
  await $.turn.start({ turnId: 't2', text: submitted[0] })
  expect(logged.at(-1)).toBe('context-handoff: gave up: the app refused to clear the context: a message the user sent is waiting')
  expect(calls.map((call) => call.tool)).toEqual(['clear_session'])
  await $.turn.complete(turn('t2'))
  await $.classic.SessionStart({ source: 'clear' })
  expect(submitted.length).toBe(1)
})

test('with the clear, a session started from another device has Remote Control turned off for it, and on again after', CLEAR, async ($, on) => {
  let remoteControl = 'on'
  const app = (call: AppCall) => {
    if (call.tool === 'set_remote_control') {
      remoteControl = call.args?.enabled ? 'on' : 'off'
      return { value: { content: [{ type: 'text', text: remoteControl }], isError: false } }
    }
    if (call.tool === 'get_session') {
      return { value: { content: [{ type: 'text', text: JSON.stringify({ sessionId: 'local_a' }) }], isError: false } }
    }
    return remoteControl === 'on'
      ? { value: { content: [{ type: 'text', text: "This session can't be cleared right now: it is serving a Remote Control client." }], isError: true } }
      : CLEARED
  }
  const context = { percent: 45 }
  const { submitted, calls, logged } = wire($, on, context, { app })
  await $.session.start({ surface: 'desktop', isInteractive: true, cwd: '/work' })
  await $.turn.start({ turnId: 't1', text: 'hello' })
  await $.turn.complete(turn('t1'))
  await $.turn.start({ turnId: 't2', text: submitted[0] })

  // Refused once, Remote Control turned off, queued on the second try, the resume stored
  expect(calls.map((call) => [call.tool, call.args?.enabled])).toEqual([
    ['clear_session', undefined],
    ['set_remote_control', false],
    ['clear_session', undefined],
    ['get_session', undefined],
  ])
  expect(logged).toContain('context-handoff: Remote Control turned off for the clear; it is turned on again after the resume')
  await $.turn.complete(turn('t2'))

  await $.session.end({ reason: 'clear', sessionId: 's1', resume: { id: 's1' } })
  await $.classic.SessionStart({ source: 'clear' })
  expect(submitted.length).toBe(2)
  expect(remoteControl).toBe('off')
  context.percent = 3
  await $.turn.start({ turnId: 't3', text: submitted[1] })
  await $.turn.complete(turn('t3'))
  expect(remoteControl).toBe('on')
  expect(logged.at(-1)).toBe('context-handoff: Remote Control turned on again')
})

test('with the clear and pauseRemoteControl off, a Remote Control refusal is given up like any other', { options: { reset: 'clear', pauseRemoteControl: false } }, async ($, on) => {
  const REFUSED = {
    value: { content: [{ type: 'text', text: 'a session serving a Remote Control client cannot be cleared' }], isError: true },
  }
  const { submitted, calls } = wire($, on, { percent: 45 }, { app: REFUSED })
  await $.session.start({ surface: 'desktop', isInteractive: true, cwd: '/work' })
  await $.turn.start({ turnId: 't1', text: 'hello' })
  await $.turn.complete(turn('t1'))
  await $.turn.start({ turnId: 't2', text: submitted[0] })
  expect(calls.map((call) => call.tool)).toEqual(['clear_session'])
})

test('with the clear, when no SessionStart follows it, the resume prompt is submitted by the timer', CLEAR, async ($, on) => {
  const { submitted, clock } = wire($, on, { percent: 45 })
  await handOff($, submitted)
  await $.session.end({ reason: 'clear', sessionId: 's1', resume: { id: 's1' } })
  expect(submitted.length).toBe(1)

  await clock.advance(3000)
  expect(submitted.length).toBe(2)
  expect(submitted[1]).toContain('reset after a hand-off')

  // A SessionStart arriving afterwards does not submit it twice
  await $.classic.SessionStart({ source: 'clear' })
  expect(submitted.length).toBe(2)
})
