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
 *
 * Every field is `.volatile()` because that is the settings surface. The
 * settings service projects only volatile fields, and `describe()` drops an
 * entry whose volatile projection is empty — so an ordinary schema yields no
 * namespace at all, and a browser form waiting on that namespace never mounts.
 */
export const Config = Schema.object({
  alerts: Schema.object({
    turnEnd: Schema.boolean().default(true).volatile()
      .description('Chime when a turn finishes.'),
    attention: Schema.boolean().default(true).volatile()
      .description('Chime when the harness is blocked waiting on your approval or your answer.'),
    error: Schema.boolean().default(true).volatile()
      .description('Chime when a step or turn fails.'),
  }).default({}).description('Which events produce a sound.'),

  quietSubagents: Schema.boolean().default(true).volatile()
    .description('Silence turn-end and error chimes raised by subagent sessions. Attention alerts always play.'),

  volume: Schema.number().min(0).max(1).step(0.05).default(0.25).volatile()
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
  const connections = new Set()

  /** Stop publishing to one browser stream. */
  const drop = (response) => { connections.delete(response) }

  /**
   * Write one alert frame to every open browser stream.
   *
   * Each write is contained and a failed stream is dropped rather than
   * rethrown. `agent/turn-stopping` is a Cordis `serial` dispatch, which
   * propagates a listener throw instead of containing it, and the loop awaits
   * it inside the turn's own try — where the rejection marks a successful turn
   * failed and raises the error alert this plugin exists to report, not to
   * cause. A stream can die between its `close` event and this write.
   *
   * Volatile fields resolve to accessors rather than plain values, so each
   * alert reads them here instead of destructuring once at activation. That is
   * what makes a settings edit audible on the next alert rather than at the
   * next restart.
   */
  const publish = (kind) => {
    if (!config.alerts[kind].get() || connections.size === 0) return
    const frame = `data: ${JSON.stringify({ kind, volume: config.volume.get() })}\n\n`
    for (const response of connections) {
      try {
        response.write(frame)
      } catch (error) {
        drop(response)
        ctx.logger.warn(`sound-alerts: dropped a failed alert stream: ${String(error)}`)
      }
    }
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
          // It is contained like every other write: a request whose socket died
          // before this point must not throw out of the route handler.
          try {
            response.write(': connected\n\n')
          } catch (error) {
            ctx.logger.warn(`sound-alerts: alert stream failed to open: ${String(error)}`)
            return
          }
          connections.add(response)
          response.on('close', () => { drop(response) })
          // A socket that dies mid-stream raises 'error'; with no listener that
          // is an unhandled 'error' event, which takes down the Host process.
          response.on('error', (error) => {
            drop(response)
            ctx.logger.warn(`sound-alerts: alert stream failed: ${String(error)}`)
          })
        },
      })
      // Ending the open streams here is what lets a browser reconnect. An
      // orphaned response stays open, so EventSource never notices the route is
      // gone and silently stops receiving alerts until the page is reloaded.
      return () => {
        for (const response of connections) {
          try {
            response.end()
          } catch (error) {
            // The socket is already gone; there is nothing left to close.
            ctx.logger.warn(`sound-alerts: closing an alert stream failed: ${String(error)}`)
          }
        }
        connections.clear()
        disposeRoute()
      }
    },
    'sound-alerts: browser alert stream',
  )

  /**
   * Report one agent alert, contained end to end. A subagent session is
   * background work owned by another turn: alerting for each of them drowns
   * out the alert that matters.
   *
   * The containment is not decorative. `agent/error` is emitted through the
   * agent's own dispatcher, which contains listener throws, but
   * `agent/turn-stopping` is dispatched with Cordis `serial`, which does not:
   * its rejection lands in the turn's catch and marks the turn failed.
   */
  const notifyAgent = (kind, agent) => {
    try {
      if (config.quietSubagents.get() && agent?.session?.header?.origin === 'subagent') return
      publish(kind)
    } catch (error) {
      ctx.logger.warn(`sound-alerts: ${kind} alert failed: ${String(error)}`)
    }
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
