/**
 * Host half of the sound-alerts bundle.
 *
 * The Host owns *detection* and the browser owns *playback*, because each side
 * can only do one of them well:
 *
 * - Detection must be here. `approval/request` and `user-questions/request` are
 *   waterfall events, and the application's own forwarded-event listener
 *   answers them and resolves without calling `next()`. This plugin therefore
 *   registers with `prepend: true` so it observes the request before the
 *   answering listener runs; a browser-side listener has no such option and is
 *   never reached.
 * - Playback must be in the browser. It reaches the machine the user is
 *   actually sitting at, needs no OS audio player, and works when the Host runs
 *   remotely. The Host plays nothing.
 *
 * The two halves are joined by a Server-Sent Events route; the browser half
 * renders each frame as a Web Audio chime.
 *
 * @module @minti2/dsh-sound-alerts
 */

/** Plugin identity used by the Loader and in diagnostics. */
export const name = 'sound-alerts'

/**
 * Required Host service. This plugin exists to alert the Web UI, so a profile
 * without a web server has nothing for it to do; it stays inactive rather than
 * reporting alerts nobody can hear.
 */
export const inject = ['webServer']

/** Route carrying alert frames to every connected browser. */
export const EVENTS_ENDPOINT = '/sound-alerts/events'

/** Alert kinds a config may enable or disable. */
const ALERT_KINDS = ['turnEnd', 'attention', 'error']

/** Top-level config keys this plugin accepts. */
const CONFIG_KEYS = ['alerts', 'quietSubagents', 'volume']

/**
 * Validate and normalize the row's `config` into the complete spec `apply`
 * consumes, so a misconfiguration fails at load rather than at the first alert.
 *
 * @param value - Raw `config` from the Loader row, absent when the row omits it.
 * @returns `{ value: spec }` when the config is usable, otherwise `{ issues }`
 * describing every problem found.
 */
function validateConfig(value) {
  const issues = []
  const raw = value === undefined || value === null ? {} : value
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { issues: [{ message: 'sound-alerts: config must be a mapping' }] }
  }
  for (const key of Object.keys(raw)) {
    if (!CONFIG_KEYS.includes(key)) {
      issues.push({ message: `sound-alerts: unknown config key "${key}"` })
    }
  }

  const alerts = { turnEnd: true, attention: true, error: true }
  if (raw.alerts !== undefined) {
    if (typeof raw.alerts !== 'object' || raw.alerts === null || Array.isArray(raw.alerts)) {
      issues.push({ message: 'sound-alerts: "alerts" must map an alert kind to a boolean' })
    } else {
      for (const [kind, enabled] of Object.entries(raw.alerts)) {
        if (!ALERT_KINDS.includes(kind)) {
          issues.push({ message: `sound-alerts: unknown alert kind "${kind}" in "alerts"` })
        } else if (typeof enabled !== 'boolean') {
          issues.push({ message: `sound-alerts: "alerts.${kind}" must be a boolean` })
        } else {
          alerts[kind] = enabled
        }
      }
    }
  }

  let quietSubagents = true
  if (raw.quietSubagents !== undefined) {
    if (typeof raw.quietSubagents !== 'boolean') {
      issues.push({ message: 'sound-alerts: "quietSubagents" must be a boolean' })
    } else {
      quietSubagents = raw.quietSubagents
    }
  }

  let volume = 0.25
  if (raw.volume !== undefined) {
    if (typeof raw.volume !== 'number' || !Number.isFinite(raw.volume) || raw.volume < 0 || raw.volume > 1) {
      issues.push({ message: 'sound-alerts: "volume" must be a number between 0 and 1' })
    } else {
      volume = raw.volume
    }
  }

  if (issues.length > 0) return { issues }
  return { value: { alerts, quietSubagents, volume } }
}

/** Loader-facing config schema; a plain Standard Schema keeps the bundle dependency-free. */
export const Config = {
  '~standard': {
    version: 1,
    vendor: 'sound-alerts',
    validate: validateConfig,
  },
}

/**
 * Register the alert listeners and the browser alert stream.
 *
 * @param ctx - Plugin context owning the route, the listeners, and the
 * connections they publish to.
 * @param config - The validated spec returned by {@link Config}.
 */
export function apply(ctx, config) {
  const { alerts, quietSubagents, volume } = config
  const connections = new Set()

  /** Write one alert frame to every open browser stream. */
  const publish = (kind) => {
    if (!alerts[kind] || connections.size === 0) return
    const frame = `data: ${JSON.stringify({ kind, volume })}\n\n`
    for (const response of connections) response.write(frame)
  }

  ctx.effect(
    () => ctx.webServer.register({
      kind: 'exact',
      path: EVENTS_ENDPOINT,
      handler: (request, response) => {
        // Named routes match ahead of the carrier's method gate, so non-GET
        // requests are rejected here rather than upstream.
        if (request.method !== 'GET') {
          response.writeHead(405)
          response.end()
          return
        }
        response.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          'connection': 'keep-alive',
        })
        // A comment frame makes the channel observably live before any alert.
        response.write(': connected\n\n')
        connections.add(response)
        response.on('close', () => { connections.delete(response) })
      },
    }),
    'sound-alerts: browser alert stream',
  )

  // A subagent session is background work owned by another turn: alerting for
  // each of them drowns out the alert that matters.
  const notifyAgent = (kind, agent) => {
    if (quietSubagents && agent?.session?.header?.origin === 'subagent') return
    publish(kind)
  }

  ctx.on('agent/turn-stopping', ({ agent }) => {
    notifyAgent('turnEnd', agent)
  })

  ctx.on('agent/error', ({ agent }) => {
    notifyAgent('error', agent)
  })

  // Both are waterfall events and both must delegate onward. `prepend: true` is
  // required, not cosmetic: the application's forwarded-event listener answers
  // these on behalf of the connected UI and resolves without calling `next()`,
  // so a listener registered behind it is never invoked. Observing ahead of the
  // answerer cannot alter a decision — the 'never' approval policy returns from
  // inside the approval service before the event is dispatched.
  ctx.on('approval/request', (_request, next) => {
    publish('attention')
    return next()
  }, { prepend: true })

  ctx.on('user-questions/request', (_request, next) => {
    publish('attention')
    return next()
  }, { prepend: true })
}
