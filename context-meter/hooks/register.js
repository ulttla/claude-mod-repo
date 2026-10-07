// The latest measurement, shared by the hooks below
let usage = null
// Context tokens when the current turn began, and whether that turn is still running
let turnBase = null
let turnOpen = false
// Context tokens the last finished turn added
let lastDelta = null

const DAYS = ['일', '월', '화', '수', '목', '금', '토']

// 12345 -> "12.3k", 150236 -> "150k", 1000000 -> "1M"
function formatTokens(n) {
  const abs = Math.abs(n)
  if (abs < 1000) return String(n)
  const [value, unit] = abs < 999500 ? [n / 1000, 'k'] : [n / 1000000, 'M']
  return (Math.abs(value) < 100 ? Number(value.toFixed(1)) : Math.round(value)) + unit
}

// A negative delta means the turn compacted the conversation
function formatDelta(n) {
  if (n === 0) return '±0'
  return (n > 0 ? '+' : '−') + formatTokens(Math.abs(n))
}

function contextPercent(context) {
  if (typeof context.percent === 'number') return context.percent
  return context.window > 0 ? (context.tokens / context.window) * 100 : 0
}

// The plan limit kinds Claude Code reports. An unknown kind is shown as it is.
const LIMIT_LABELS = { five_hour: '5시간', seven_day: '주간', spend_limit: '지출 한도' }

// One plan limit as the band draws it
function limitOf(raw) {
  // Round to the minute, so a reset at 12:29:59 reads 12:30
  const ms = raw.resetsAt ? Math.round(new Date(raw.resetsAt).getTime() / 60000) * 60000 : NaN
  return {
    label: LIMIT_LABELS[raw.kind] ?? String(raw.kind),
    percent: raw.percentUsed,
    resetsAt: Number.isNaN(ms) ? null : new Date(ms),
  }
}

// "12:30" for a reset within a day, "수 11:00" for one further off
function formatReset(date, now) {
  const time = String(date.getHours()).padStart(2, '0') + ':' + String(date.getMinutes()).padStart(2, '0')
  return date.getTime() - now < 24 * 60 * 60 * 1000 ? time : DAYS[date.getDay()] + ' ' + time
}

// The band's segments in the order they are drawn. A segment with a percent is colored by it.
function segments(showResets, now) {
  const { context, rateLimits } = usage
  // The fill is absent until the first response reports one
  const isFilled = typeof context.tokens === 'number'
  const percent = isFilled ? contextPercent(context) : undefined
  const fill = isFilled ? `${Math.round(percent)}% (${formatTokens(context.tokens)}` : '– (–'
  const parts = [
    { text: `컨텍스트 ${fill}/${formatTokens(context.window)})`, percent },
    { text: '직전 턴 ' + (lastDelta === null ? '–' : formatDelta(lastDelta)) },
  ]
  for (const limit of rateLimits.map(limitOf)) {
    const reset = showResets && limit.resetsAt ? ' ↻' + formatReset(limit.resetsAt, now) : ''
    parts.push({ text: `${limit.label} ${Math.round(limit.percent)}%${reset}`, percent: limit.percent })
  }
  return parts
}

// Text props for how full something is: plain, then yellow, then bold red
function tone(percent) {
  if (typeof percent !== 'number' || percent < 70) return {}
  return percent < 90 ? { color: 'yellow' } : { color: 'red', bold: true }
}

// Read the figures again and ask for a redraw. A failed read keeps the last figures.
async function measure($) {
  try {
    usage = await $.session.usage()
  } catch {
    return
  }
  // Once the turn has ended, what it added is the difference from where it began
  const { tokens } = usage.context
  if (!turnOpen && turnBase !== null && typeof tokens === 'number') lastDelta = tokens - turnBase
  $.ui.invalidate('ui.render')
}

export function register(on) {
  // Runs before your first prompt, and again after a reload
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'context-meter',
      description: '컨텍스트 사용량, 직전 턴 증가분, 플랜 한도 사용량 표시',
      immediate: true,
    })
    await measure($)
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    await measure($)
    // Before the first response nothing is in the window yet
    if (usage) turnBase = usage.context.tokens ?? 0
    turnOpen = true
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    turnOpen = false
    await measure($)
    return next(e)
  })

  // Fires after each turn, and when a plan limit's percent used changes
  on('session.measure', async ($, e, next) => {
    await measure($)
    return next(e)
  })

  // The same line as text, for apps that don't draw the band
  on('command.run', { command: 'context-meter' }, async ($) => {
    await measure($)
    if (!usage) return { text: '사용량을 아직 읽지 못했습니다' }
    return {
      text: segments(true, Date.now())
        .map((part) => part.text)
        .join(' · '),
    }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    // Keep what the mods after this one draw in the band
    const theirs = await next(e)
    // Stay out of the way of a survey, and draw nothing before the first reading
    if (!usage || e.props.hasSurvey) return theirs
    const { Box, Text } = $.ui.resolve(e)
    // The reset times fit only in a wide band
    const showResets = (e.props.bodyColumns ?? 0) >= 100
    const row = Box({
      flexDirection: 'row',
      columnGap: 3,
      children: segments(showResets, Date.now()).map((part) =>
        Text({ ...tone(part.percent), children: [part.text] }),
      ),
    })
    return theirs ? Box({ flexDirection: 'column', children: [row, theirs] }) : row
  })
}
