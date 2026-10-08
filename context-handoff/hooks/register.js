// The mod's name, as toasts, log lines and the hand-off prompts carry it
const NAME = 'context-handoff'
// A tag every prompt this mod submits carries, so its own turn can be told apart
const MARK = '[context-handoff]'
// The store key that survives the desktop app's clear, which ends the process
const RESUME_KEY = 'pendingResume'
// How long a pending resume in the store stays valid
const RESUME_WINDOW_MS = 15 * 60 * 1000
// How long the app gets to clear the conversation once the hand-off turn has ended
const CLEAR_WAIT_MS = 8000
// When the compaction is tried after the hand-off turn: it is refused while a turn still runs
const COMPACT_TRIES_MS = [300, 1000, 2000, 4000, 8000]
// How long the /compact command gets to compact the conversation where it stands in for the call
const COMPACT_COMMAND_WAIT_MS = 5 * 60 * 1000
// How long after the compaction the resume prompt is submitted
const RESUME_AFTER_COMPACT_MS = 1000
// What the summarizer is told when the conversation is compacted after a hand-off
const COMPACT_INSTRUCTIONS =
  'A hand-off for a fresh start was just recorded in the project notes. Keep only: where the notes are (file and section), ' +
  'the exact next step, and any question still waiting for the user. Leave out everything else; it is in the notes.'

// Where the hand-off stands:
//   idle        nothing in progress
//   closing     the hand-off prompt is submitted; waiting for its turn to run and finish
//   clearing    (clear) the app was asked to clear; waiting for the conversation to end with it
//   compacting  (compact) the hand-off turn has ended; compacting the conversation
//   resuming    the conversation was reset; waiting to submit the resume prompt
let phase = 'idle'
// The hand-off prompt as submitted, and the id of the turn running it
let closeText = null
let closeTurnId = null
// The context percent at which the last hand-off began; the next waits for `step` more
let triggeredAt = null
// The fallback that submits the resume prompt when no SessionStart follows the clear
let resumeTimer = null
// Gives up when the app has not cleared the conversation soon after the hand-off turn ended
let clearWatchdog = null
// The compaction attempt waiting to run
let compactTimer = null
// How the conversation is being compacted: the engine's call, or the /compact command where
// the session has no such call (a headless one, as the desktop app runs)
let compactVia = null
// Gives up when the /compact command has not compacted the conversation in time
let compactWatchdog = null
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
    reset: options.reset === 'clear' ? 'clear' : 'compact',
    compaction: options.compaction === 'call' || options.compaction === 'command' ? options.compaction : 'auto',
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
function closePromptFor(cfg, percent, hasClose) {
  const level = `The context window is ${Math.round(percent)}% full, past the ${cfg.threshold}% hand-off threshold.`
  const pending =
    'If the previous turn stopped to ask the user something, put that question in the notes instead of answering it.'
  const then = 'the context is then reset automatically and the work continues from the notes.'
  if (cfg.closePrompt) return `${MARK} ${fillIn(cfg.closePrompt, percent, cfg)}`
  // A prompt may not begin with a slash, so the skill is named for the model to invoke
  if (hasClose) {
    return (
      `${MARK} ${level} Run this project's /${cfg.closeCommand} skill now (invoke it with the Skill tool) to record the hand-off, ` +
      `and make the next starting point exact. ${pending} When the notes are written, stop: ${then}`
    )
  }
  return (
    `${MARK} ${level} Do not start new work. Record a hand-off for a fresh start: ` +
    "if this project's CLAUDE.md defines a session-close or progress-logging procedure, follow it; " +
    'otherwise update PROGRESS.md if the project has one, or else write HANDOFF.md at the project root. ' +
    'Cover what was done this session, the current state, measured facts worth not measuring again, open questions, ' +
    `and the exact next step. ${pending} When the notes are written, stop: ${then}`
  )
}

// The prompt that continues the work after the reset
function resumePromptFor(cfg) {
  if (cfg.resumePrompt) return `${MARK} ${cfg.resumePrompt}`
  return (
    `${MARK} The context was reset after a hand-off. Read this project's hand-off notes: ` +
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

// Whether the engine answered that this session has no compaction call: a headless (SDK)
// session, as the desktop app runs, where a compaction runs as a /compact prompt
function hasNoCompactCall(message) {
  return /headless|SDK|\/compact prompt/i.test(message)
}

// The sizes a compaction reports, for the transcript line
function sizesOf(result) {
  return typeof result?.tokensBefore === 'number' && typeof result?.tokensAfter === 'number'
    ? ` (${result.tokensBefore} to ${result.tokensAfter} tokens)`
    : ''
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

// The desktop app's id of this session, which outlives the process; null outside the app
async function appSessionId($) {
  try {
    const result = await $.mcp.call('ccd_session_mgmt', 'get_session', { session_id: 'self' })
    if (result.isError) return null
    const id = JSON.parse(textOf(result)).sessionId
    return typeof id === 'string' ? id : null
  } catch {
    return null
  }
}

// Turn Remote Control on again after it was turned off for the clear
async function restoreRemoteControl($) {
  if (!remoteControlPaused) return
  remoteControlPaused = false
  const failed = await callApp($, 'set_remote_control', { session_id: 'self', enabled: true })
  note($, failed ? `Remote Control could not be turned on again: ${failed}` : 'Remote Control turned on again')
}

function cancelTimers() {
  if (resumeTimer) resumeTimer.cancel()
  if (clearWatchdog) clearWatchdog.cancel()
  if (compactTimer) compactTimer.cancel()
  if (compactWatchdog) compactWatchdog.cancel()
  resumeTimer = clearWatchdog = compactTimer = compactWatchdog = null
}

function forgetPendingResume($) {
  $.store.delete(RESUME_KEY).catch(() => {})
}

// Give up the hand-off in progress and say why; the next tries once the context grew by the step
function abandon($, reason) {
  phase = 'idle'
  closeText = null
  closeTurnId = null
  compactVia = null
  cancelTimers()
  forgetPendingResume($)
  note($, `gave up: ${reason}`)
  $.ui.toast(`${NAME}: ${reason}. /handoff-now retries.`, { timeoutMs: 8000 })
  void restoreRemoteControl($)
}

// Submit the hand-off prompt; its turn is found by the tag at turn.start
async function begin($, cfg, percent, why) {
  phase = 'closing'
  closeTurnId = null
  triggeredAt = percent
  cancelTimers()
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

// Ask the desktop app to clear this conversation once the running turn ends. The app keeps
// the request only while the turn runs and acts on it as the turn's result arrives, so it is
// made as the hand-off turn starts. A session started from another device (Remote Control)
// cannot be cleared, so Remote Control is turned off for it when allowed.
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
  // The clear ends this process; the next one finds the resume to make in the store
  try {
    await $.store.set(RESUME_KEY, {
      appSessionId: await appSessionId($),
      cwd: await $.session.cwd(),
      askedAt: await $.clock.now(),
    })
  } catch (error) {
    note($, `the resume could not be stored for the next process: ${messageOf(error)}`)
  }
  note($, 'the app will clear the conversation when the hand-off turn ends')
}

// The hand-off turn has ended: the app clears the conversation now, or the hand-off is given up
function awaitClear($) {
  note($, 'hand-off recorded, waiting for the app to clear the conversation')
  $.ui.toast(`${NAME}: hand-off recorded, clearing the context`)
  if (clearWatchdog) clearWatchdog.cancel()
  clearWatchdog = $.clock.after(CLEAR_WAIT_MS, () => {
    clearWatchdog = null
    if (phase === 'clearing') {
      abandon($, `the app did not clear the conversation within ${CLEAR_WAIT_MS / 1000} s of the hand-off turn ending`)
    }
  })
}

// The hand-off turn has ended: compact the conversation down to the notes, then resume.
// A compaction is refused while a turn still runs, so it is tried a few times. A session
// with no compaction call of its own (the desktop app's) compacts through /compact instead,
// as does one configured to.
function startCompaction($, cfg) {
  phase = 'compacting'
  compactVia = 'call'
  note($, 'hand-off recorded, compacting the conversation')
  $.ui.toast(`${NAME}: hand-off recorded, compacting the conversation`)
  const attempt = (i) => {
    compactTimer = $.clock.after(COMPACT_TRIES_MS[i], async () => {
      compactTimer = null
      if (phase !== 'compacting') return
      if (cfg.compaction === 'command') return compactByCommand($, cfg, 'compacting through /compact, as configured')
      let result
      try {
        result = await $.session.compact({ instructions: COMPACT_INSTRUCTIONS })
      } catch (error) {
        const message = messageOf(error)
        if (cfg.compaction === 'auto' && hasNoCompactCall(message)) {
          return compactByCommand($, cfg, 'this session has no compaction call; compacting through /compact')
        }
        if (i + 1 < COMPACT_TRIES_MS.length) return attempt(i + 1)
        return abandon($, `the conversation could not be compacted: ${message}`)
      }
      if (result && result.skip) return abandon($, `the compaction was skipped: ${result.skip}`)
      compacted($, cfg, `compacted the conversation${sizesOf(result)}`, 0)
    })
  }
  attempt(0)
}

// Compact through the /compact command, queued as if typed, with the same instructions.
// The compaction is seen as it runs, by the session.compact hook; the command's own answer,
// which may come later or never, stands in when the hook saw nothing.
function compactByCommand($, cfg, why) {
  compactVia = 'command'
  note($, why)
  if (compactWatchdog) compactWatchdog.cancel()
  compactWatchdog = $.clock.after(COMPACT_COMMAND_WAIT_MS, () => {
    compactWatchdog = null
    if (phase === 'compacting') {
      abandon($, `the /compact command did not compact the conversation within ${COMPACT_COMMAND_WAIT_MS / 60000} min`)
    }
  })
  $.command
    .run({ command: 'compact', args: COMPACT_INSTRUCTIONS })
    .then(async (result) => {
      if (phase !== 'compacting') return
      // The hook saw no compaction: the context says whether the command made one
      const percent = await readPercent($)
      const answer = typeof result?.text === 'string' && result.text.trim() ? `: ${result.text.trim().slice(0, 160)}` : ''
      if (percent !== null && triggeredAt && percent >= triggeredAt) {
        return abandon($, `the /compact command ran, but the context is still at ${Math.round(percent)}%${answer}`)
      }
      compacted($, cfg, `the /compact command finished${percent === null ? '' : `, the context at ${Math.round(percent)}%`}`)
    })
    .catch((error) => {
      if (phase === 'compacting') abandon($, `the /compact command failed: ${messageOf(error)}`)
    })
}

// The conversation is compacted: the resume prompt follows, once. From the engine's call it
// follows at once (the call resolves between turns, the compaction installed); from /compact
// a moment later, as the hook sees the compaction while the command's turn still runs.
function compacted($, cfg, what, afterMs = RESUME_AFTER_COMPACT_MS) {
  if (phase !== 'compacting') return
  phase = 'resuming'
  cancelTimers()
  note($, what)
  if (afterMs === 0) submitResume($, cfg)
  else resumeTimer = $.clock.after(afterMs, () => submitResume($, cfg))
}

// Submit the resume prompt into the fresh conversation, once
function submitResume($, cfg) {
  if (phase !== 'resuming') return
  phase = 'idle'
  closeText = null
  closeTurnId = null
  triggeredAt = null
  compactVia = null
  cancelTimers()
  forgetPendingResume($)
  note($, 'continuing in a fresh context')
  $.ui.toast(`${NAME}: continuing in a fresh context`)
  $.prompt.submit({ text: resumePromptFor(cfg), asUser: true }).catch(() => {})
}

// A fresh process after the app's clear: when the store says this session's hand-off asked
// for a resume, and no prompt has run yet, continue from the notes
async function resumeIfPending($, cfg) {
  let pending
  try {
    pending = await $.store.get(RESUME_KEY)
  } catch {
    return
  }
  if (!pending || typeof pending !== 'object') return
  const forget = () => forgetPendingResume($)
  if ((await $.session.turns()) !== 0) return forget()
  if (typeof pending.askedAt !== 'number' || (await $.clock.now()) - pending.askedAt > RESUME_WINDOW_MS) return forget()
  const id = await appSessionId($)
  const isThisSession =
    id && pending.appSessionId ? id === pending.appSessionId : (await $.session.cwd()) === pending.cwd
  // Another session's hand-off: leave its resume to it
  if (!isThisSession) return
  forget()
  phase = 'resuming'
  note($, 'a fresh process after the clear; continuing from the notes')
  resumeTimer = $.clock.after(1000, () => submitResume($, cfg))
}

export function register(on, options) {
  const cfg = settingsOf(options)

  // Runs before your first prompt, and again after a reload
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'handoff-now',
      description: 'Record a hand-off now, reset the context, and continue from the notes',
    })
    await $.command.register({
      name: 'handoff-status',
      description: 'Show where the automatic hand-off stands and what it did last',
    })
    await resumeIfPending($, cfg)
    return next(e)
  })

  // The turn that runs the hand-off prompt is the one whose text carries the tag. With the
  // clear, the app is asked as it starts, so the conversation is cleared as this turn ends.
  on('turn.start', async ($, e, next) => {
    if (phase === 'closing' && closeTurnId === null && typeof e.text === 'string' && e.text.includes(MARK)) {
      closeTurnId = e.turnId
      note($, 'the hand-off turn is running')
      if (cfg.reset === 'clear') await requestClear($, cfg)
    }
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const out = await next(e)
    // A subagent's turn is not the conversation's
    if (e.agentId !== undefined) return out
    const ended = e.reason ?? (e.isAborted ? 'aborted' : 'answer')

    if (phase === 'closing') {
      // The hand-off prompt is still queued, behind the turn that just ran
      if (e.turnId !== closeTurnId) return out
      if (ended === 'aborted') abandon($, 'the hand-off turn was interrupted')
      else startCompaction($, cfg)
      return out
    }
    if (phase === 'clearing') {
      if (e.turnId === closeTurnId) {
        // An interrupted hand-off turn takes the app's queued clear with it
        if (ended === 'aborted') abandon($, 'the hand-off turn was interrupted')
        else awaitClear($)
      } else if (ended === 'answer') {
        // A turn ran after the hand-off, so the app dropped the clear: record again
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

  // A compaction run through /compact passes here as it runs: once it stands, the resume
  // follows; a compaction the engine makes on its own meanwhile serves as well
  on('session.compact', async ($, e, next) => {
    const watching = phase === 'compacting' && compactVia === 'command' && e.agentId === undefined
    let out
    try {
      out = await next(e)
    } catch (error) {
      if (watching && phase === 'compacting') abandon($, `the compaction failed: ${messageOf(error)}`)
      throw error
    }
    if (watching && phase === 'compacting') {
      if (out && out.skip !== undefined) abandon($, `the compaction was skipped: ${out.skip}`)
      else compacted($, cfg, `compacted the conversation${sizesOf(out)}`)
    }
    return out
  })

  // A /clear ends the conversation; where the process goes on, it continues with a fresh one
  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear' && phase === 'clearing') {
      phase = 'resuming'
      cancelTimers()
      resumeTimer = $.clock.after(3000, () => submitResume($, cfg))
    } else if (e.reason !== 'clear') {
      phase = 'idle'
      cancelTimers()
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
        `Once it is written the context is reset (${cfg.reset}) and the work continues from the notes.`,
    }
  })

  on('command.run', { command: 'handoff-status' }, async ($) => {
    const percent = await readPercent($)
    const fill = percent === null ? 'no reading yet' : `${Math.round(percent)}%`
    return {
      text:
        `Phase: ${phase}. Context: ${fill} (threshold ${cfg.threshold}%). ` +
        `Automatic hand-off: ${cfg.enabled ? 'on' : 'off'}. Reset: ${cfg.reset}. Last: ${lastOutcome}.`,
    }
  })
}
