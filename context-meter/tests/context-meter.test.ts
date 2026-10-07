import { expect, test } from 'claude-code/testing'

// What Claude Code passes to a ui.render hook for the band, apart from the app
const BAND = {
  plugin: 'context-meter',
  component: 'AbovePrompt',
  viewport: { columns: 140, rows: 40 },
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 4,
    bodyColumns: 120,
    scroll: { offset: 0, bodyRows: 4 },
    view: {},
  },
} as const

test('the band draws before the first response, when the fill is absent', async ($, on) => {
  on('session.usage', () => ({
    value: { startedAt: 0, context: { window: 1000000 }, rateLimits: [] },
  }))
  on('command.register', () => ({ value: undefined }))
  on('session.start', () => ({ cwd: '/work' }))
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['drawn by Claude Code'] }))

  await $.session.start({ surface: 'desktop', isInteractive: true, cwd: '/work' })

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: '컨텍스트 – (–/1M)' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '직전 턴 –' })).toBeDefined()
})

test('the band shows the context, what the last turn added, and a plan limit', async ($, on) => {
  // The figures $.session.usage resolves to, which the test changes mid-turn
  let tokens = 138000
  on('session.usage', () => ({
    value: {
      startedAt: 0,
      context: { tokens, window: 1000000, percent: Math.round(tokens / 10000) },
      rateLimits: [{ kind: 'five_hour', percentUsed: 4, resetsAt: '2026-10-06T19:30:00.000Z' }],
    },
  }))
  on('command.register', () => ({ value: undefined }))
  on('session.start', () => ({ cwd: '/work' }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  // Stands for what Claude Code would draw in the band
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['drawn by Claude Code'] }))

  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await $.turn.start({ turnId: 't1' })
  tokens = 150236
  await $.turn.complete({ turnId: 't1', answer: 'ok', durationMs: 1, isAborted: false, usage: null })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect(await ui.find({ type: 'Text', text: '컨텍스트 15% (150k/1M)' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '직전 턴 +12.2k' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^5시간 4%/ })).toBeDefined()
    // The band keeps what the other mods drew
    expect(await ui.find({ type: 'Text', text: 'drawn by Claude Code' })).toBeDefined()
    await ui.unmount()
  }
})
