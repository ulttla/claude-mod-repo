// True while a new session still waits to be pinned
let isPending = false

// Pin this session in the desktop app's sidebar. Resolves to null once pinned, or to why it was not.
async function pin($) {
  try {
    const result = await $.mcp.call('ccd_sidebar', 'set_pinned', { session_id: 'self', pinned: true })
    if (!result.isError) return null
    const said = result.content
      .map((block) => (block.type === 'text' ? block.text : ''))
      .join(' ')
      .trim()
    return said || 'the sidebar refused the request'
  } catch (error) {
    // Outside the desktop app there is no sidebar to pin in
    return error instanceof Error ? error.message : String(error)
  }
}

export function register(on) {
  // Runs before your first prompt, and again after a reload
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'auto-pin',
      description: 'Pin this session in the sidebar',
      immediate: true,
    })
    // A session that already has prompts was resumed: you may have unpinned it, so leave it
    if ((await $.session.turns()) === 0) isPending = (await pin($)) !== null
    return next(e)
  })

  // The sidebar may not be connected yet when the session starts, so try once more
  on('turn.start', async ($, e, next) => {
    if (isPending) {
      isPending = false
      await pin($)
    }
    return next(e)
  })

  // Pins on request, and says why when it cannot
  on('command.run', { command: 'auto-pin' }, async ($) => {
    const reason = await pin($)
    return { text: reason === null ? 'Pinned this session' : `Could not pin this session: ${reason}` }
  })
}
