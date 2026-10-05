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
 * @module dsh-sound-alerts
 */

import Schema from '@deepseek-ai/schemastery'

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

/**
 * Validated deployment choices.
 *
 * A native Schemastery graph rather than a hand-rolled schema: it validates the
 * row at activation AND projects to JSON Schema, which is what lets the
 * settings service generate an editable form for this entry. A schema that only
 * validates reports `unsupported` and gets no controls.
 */
export const Config = Schema.object({
  alerts: Schema.object({
    turnEnd: Schema.boolean().default(true)
      .description('Chime when a turn finishes.'),
    attention: Schema.boolean().default(true)
      .description('Chime when the harness is blocked waiting on your approval or your answer.'),
    error: Schema.boolean().default(true)
      .description('Chime when a step or turn fails.'),
  }).default({}).description('Which events produce a sound.'),

  quietSubagents: Schema.boolean().default(true)
    .description('Silence turn-end and error chimes raised by subagent sessions. Attention alerts always play.'),

  volume: Schema.number().min(0).max(1).step(0.05).default(0.25)
    .description('Peak gain of every chime, from 0 to 1.'),
})

/**
 * Register the alert listeners and the browser alert stream.
 *
 * @param ctx - Plugin context owning the route, the listeners, and the
 * connections they publish to.
 * @param config - The resolved config from {@link Config}.
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
    () => {
      const disposeRoute = ctx.webServer.register({
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
      })
      // Ending the open streams here is what lets a browser reconnect. An
      // orphaned response stays open, so EventSource never notices the route is
      // gone and silently stops receiving alerts until the page is reloaded.
      return () => {
        for (const response of connections) response.end()
        connections.clear()
        disposeRoute()
      }
    },
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
