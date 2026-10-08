// The mod's name, as toasts, log lines and the hand-off prompts carry it
const NAME = 'context-handoff'
// A tag every prompt this mod submits carries, so its own turn can be told apart
const MARK = '[context-handoff]'

// Where the hand-off stands:
//   idle      nothing in progress
//   closing   the hand-off prompt is submitted; waiting for its turn to finish
//   clearing  the clear is requested; waiting for the conversation to end with it
//   resuming  the conversation was cleared; waiting to submit the resume prompt
let phase = 'idle'
// The hand-off prompt as submitted, and the id of the turn running it
let closeText = null
let closeTurnId = null
// The context percent at which the last hand-off began; the next waits for `step` more
let triggeredAt = null
// The fallback that submits the resume prompt when no SessionStart follows the clear
let resumeTimer = null
// True while Remote Control is turned off for the clear, to be turned on again after the resume
let remoteControlPaused = false
// The last thing that happened, for /handoff-status
let lastOutcome = 'nothing yet'

// A number option, or its default when unset or out of range
function numberOf(value, fallback, min, max) {
  const n = typeof value === 'string' ? Number(value) : value
  return typeof n === 'number' && Number.isFinite(n) && n >= min && n <= max ? n : fallback
}

// The settings, from the options plugin.json declares
function settingsOf(options) {
  return {
    enabled: options.enabled !== false,
    threshold: numberOf(options.threshold, 40, 1, 100),
    step: numberOf(options.retriggerStep, 5, 1, 100),
    closeCommand: String(options.closeCommand ?? 'session-close').trim().replace(/^\//, ''),
    closePrompt: String(options.closePrompt ?? '').trim(),
    resumePrompt: String(options.resumePrompt ?? '').trim(),
    pauseRemoteControl: options.pauseRemoteControl !== false,
  }
}

function fillIn(text, percent, cfg) {
  return text
    .replaceAll('{percent}', String(Math.round(percent)))
    .replaceAll('{threshold}', String(cfg.threshold))
}

// The prompt that records the hand-off: the project's own close skill when it has one,
// a custom prompt when configured, or the built-in instructions
function closePromptFor(cfg, percent, hasCommand) {
  const level = `The context window is ${Math.round(percent)}% full, past the ${cfg.threshold}% hand-off threshold.`
  const pending =
    'If the previous turn stopped to ask the user something, put that question in the notes instead of answering it.'
  if (cfg.closePrompt) return `${MARK} ${fillIn(cfg.closePrompt, percent, cfg)}`
  // A prompt may not begin with a slash, so the skill is named for the model to invoke
  if (hasCommand) {
    return (
      `${MARK} ${level} Run this project's /${cfg.closeCommand} skill now (invoke it with the Skill tool) to record the hand-off, ` +
      'and make the next starting point exact. ' +
      `After this turn the context is cleared automatically and a new conversation continues from the notes. ${pending}`
    )
  }
  return (
    `${MARK} ${level} Do not start new work. Record a hand-off for a fresh conversation: ` +
    "if this project's CLAUDE.md defines a session-close or progress-logging procedure, follow it; " +
    'otherwise update PROGRESS.md if the project has one, or else write HANDOFF.md at the project root. ' +
    'Cover what was done this session, the current state, measured facts worth not measuring again, open questions, ' +
    `and the exact next step. ${pending} ` +
    'When the notes are written, stop: the context is then cleared automatically and a new conversation continues from them.'
  )
}

// The prompt that continues the work after the clear
function resumePromptFor(cfg) {
  if (cfg.resumePrompt) return `${MARK} ${cfg.resumePrompt}`
  return (
    `${MARK} The context was cleared after a hand-off. Read this project's hand-off notes: ` +
    'the progress file CLAUDE.md names, else PROGRESS.md, else HANDOFF.md at the project root. ' +
    'Say in one line what you are picking up, then continue from the recorded next step without redoing work the notes mark as done. ' +
    'If the notes hold a question for the user, ask it and wait.'
  )
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

// The text blocks of an MCP result, joined
function textOf(result) {
  return (result.content ?? [])
    .map((block) => (block.type === 'text' ? block.text : ''))
    .join(' ')
    .trim()
}

// Keep what happened: a dim line in the transcript, and the answer of /handoff-status
function note($, text) {
  lastOutcome = text
  $.ui.log(`${NAME}: ${text}`)
}

// How full the context window is, in percent; null before the first reading
async function readPercent($) {
  try {
    const { context } = await $.session.usage()
    if (typeof context.percent === 'number') return context.percent
    if (typeof context.tokens === 'number' && context.window > 0) return (context.tokens / context.window) * 100
  } catch {
    // Keep going without a reading
  }
  return null
}

// Whether the project offers the close command: listed as a command, or a skill folder of the project
async function hasCommand($, name) {
  if (!name) return false
  try {
    if ((await $.command.list()).some((command) => command.name === name)) return true
  } catch {
    // Not listable here; look at the folder
  }
  try {
    const root = await $.session.root()
    return await $.fs.exists(`${root}/.claude/skills/${name}/SKILL.md`)
  } catch {
    return false
  }
}

// One call on the desktop app's session server. Resolves to null when it succeeded, else to why not.
async function callApp($, tool, args) {
  try {
    const result = await $.mcp.call('ccd_session_mgmt', tool, args)
    return result.isError ? textOf(result) || 'no reason given' : null
  } catch (error) {
    return messageOf(error)
  }
}

// Turn Remote Control on again after it was turned off for the clear
async function restoreRemoteControl($) {
  if (!remoteControlPaused) return
  remoteControlPaused = false
  const failed = await callApp($, 'set_remote_control', { session_id: 'self', enabled: true })
  note($, failed ? `Remote Control could not be turned on again: ${failed}` : 'Remote Control turned on again')
}

function cancelResumeTimer() {
  if (resumeTimer) resumeTimer.cancel()
  resumeTimer = null
}

// Give up the hand-off in progress and say why; the next tries once the context grew by the step
function abandon($, reason) {
  phase = 'idle'
  closeText = null
  closeTurnId = null
  cancelResumeTimer()
  note($, `gave up: ${reason}`)
  $.ui.toast(`${NAME}: ${reason}. /handoff-now retries.`, { timeoutMs: 8000 })
  void restoreRemoteControl($)
}

// Submit the hand-off prompt; its turn is found by the tag at turn.start
async function begin($, cfg, percent, why) {
  phase = 'closing'
  closeTurnId = null
  triggeredAt = percent
  const text = closePromptFor(cfg, percent, await hasCommand($, cfg.closeCommand))
  closeText = text
  note($, `hand-off started: ${why}`)
  $.ui.toast(`${NAME}: ${why}, recording the hand-off`)
  $.prompt
    .submit({ text, asUser: true })
    .then((result) => {
      if (result && result.drop && phase === 'closing' && closeText === text) {
        abandon($, `the hand-off prompt was refused: ${result.drop}`)
      }
    })
    .catch((error) => {
      if (phase === 'closing' && closeText === text) abandon($, `the hand-off prompt failed: ${messageOf(error)}`)
    })
}

// Ask the desktop app to clear this conversation once the turn ends. A session serving
// Remote Control cannot be cleared, so Remote Control is turned off for it when allowed.
async function requestClear($, cfg) {
  phase = 'clearing'
  let refused = await callApp($, 'clear_session', { session_id: 'self' })
  if (refused && cfg.pauseRemoteControl && /remote control/i.test(refused)) {
    const failed = await callApp($, 'set_remote_control', { session_id: 'self', enabled: false })
    if (failed) {
      return abandon($, `the app refused to clear the context: ${refused}; Remote Control could not be turned off: ${failed}`)
    }
    remoteControlPaused = true
    note($, 'Remote Control turned off for the clear; it is turned on again after the resume')
    refused = await callApp($, 'clear_session', { session_id: 'self' })
  }
  if (refused) return abandon($, `the app refused to clear the context: ${refused}`)
  note($, 'hand-off recorded, clearing the context')
  $.ui.toast(`${NAME}: hand-off recorded, clearing the context`)
}

// Submit the resume prompt into the fresh conversation, once
function submitResume($, cfg) {
  if (phase !== 'resuming') return
  phase = 'idle'
  closeText = null
  closeTurnId = null
  triggeredAt = null
  cancelResumeTimer()
  note($, 'continuing in a fresh context')
  $.ui.toast(`${NAME}: continuing in a fresh context`)
  $.prompt.submit({ text: resumePromptFor(cfg), asUser: true }).catch(() => {})
}

export function register(on, options) {
  const cfg = settingsOf(options)

  // Runs before your first prompt, and again after a reload
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'handoff-now',
      description: 'Record a hand-off now, clear the context, and continue from the notes',
    })
    await $.command.register({
      name: 'handoff-status',
      description: 'Show where the automatic hand-off stands and what it did last',
    })
    return next(e)
  })

  // The turn that runs the hand-off prompt is the one whose text carries the tag
  on('turn.start', async ($, e, next) => {
    if (phase === 'closing' && closeTurnId === null && typeof e.text === 'string' && e.text.includes(MARK)) {
      closeTurnId = e.turnId
      note($, 'the hand-off turn is running')
    }
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const out = await next(e)
    // A subagent's turn is not the conversation's
    if (e.agentId !== undefined) return out
    const ended = e.reason ?? (e.isAborted ? 'aborted' : 'answer')

    if (phase === 'closing') {
      // Another turn ran first: the hand-off prompt is still queued behind it
      if (e.turnId !== closeTurnId) return out
      if (ended === 'answer') await requestClear($, cfg)
      else abandon($, `the hand-off turn ended early (${ended})`)
      return out
    }
    if (phase === 'clearing') {
      // A turn ran after the clear was asked for, so the app dropped the clear: record again
      if (ended === 'answer') {
        const percent = (await readPercent($)) ?? triggeredAt ?? cfg.threshold
        await begin($, cfg, percent, 'a turn ran before the clear')
      }
      return out
    }
    if (phase !== 'idle') return out
    // The resume turn has run: the session may serve Remote Control again
    await restoreRemoteControl($)
    if (!cfg.enabled || ended !== 'answer') return out

    const percent = await readPercent($)
    if (percent === null || percent < cfg.threshold) return out
    if (triggeredAt !== null && percent < triggeredAt + cfg.step) return out
    await begin($, cfg, percent, `context at ${Math.round(percent)}%, past ${cfg.threshold}%`)
    return out
  })

  // A /clear ends the conversation; the process goes on with a fresh one
  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear' && phase === 'clearing') {
      phase = 'resuming'
      cancelResumeTimer()
      resumeTimer = $.clock.after(3000, () => submitResume($, cfg))
    } else if (e.reason !== 'clear') {
      phase = 'idle'
      cancelResumeTimer()
    }
    return next(e)
  })

  // The fresh conversation's SessionStart is the moment to continue
  on('classic.SessionStart', async ($, e, next) => {
    const out = await next(e)
    if (e.source === 'clear' && phase === 'resuming') submitResume($, cfg)
    return out
  }).catch(($, e, next) => next(e)) // A failure here never holds up the session

  // Hand off on request, whatever the context holds. A prompt cannot be submitted from
  // inside a command's own run, so the hand-off begins a moment later, from a timer.
  on('command.run', { command: 'handoff-now' }, async ($) => {
    if (phase !== 'idle') return { text: `A hand-off is already in progress (${phase})` }
    const percent = (await readPercent($)) ?? 0
    phase = 'closing'
    $.clock.after(50, () => {
      phase = 'idle'
      void begin($, cfg, percent, 'asked by /handoff-now')
    })
    return {
      text:
        `Recording the hand-off at ${Math.round(percent)}% context. ` +
        'Once it is written the context is cleared and a new conversation continues from the notes.',
    }
  })

  on('command.run', { command: 'handoff-status' }, async ($) => {
    const percent = await readPercent($)
    const fill = percent === null ? 'no reading yet' : `${Math.round(percent)}%`
    return {
      text:
        `Phase: ${phase}. Context: ${fill} (threshold ${cfg.threshold}%). ` +
        `Automatic hand-off: ${cfg.enabled ? 'on' : 'off'}. Last: ${lastOutcome}.`,
    }
  })
}
