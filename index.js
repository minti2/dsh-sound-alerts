/**
 * Play a chime when the harness finishes a turn, blocks on your input, or
 * fails a turn.
 *
 * Three harness events drive the alerts:
 *
 * - `agent/turn-stopping` — the turn is about to close and the model owes no
 *   further response, so a task or run has finished.
 * - `approval/request` and `user-questions/request` — the harness is now
 *   blocked until a human decides or answers.
 * - `agent/error` — a step or turn errored.
 *
 * Playback is fire-and-forget. `agent/turn-stopping` is a serial event, so a
 * listener that awaited its player would delay the very turn it announces; the
 * player is spawned detached and never observed beyond a one-time failure
 * warning.
 *
 * @module @minti2/dsh-sound-alerts
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Plugin identity used by the Loader and in diagnostics. */
export const name = 'sound-alerts'

/** Directory holding this package, used to resolve the bundled chimes. */
const PACKAGE_ROOT = fileURLToPath(new URL('.', import.meta.url))

/** Alert kinds that a config may enable, disable, or re-point at another file. */
const ALERT_KINDS = ['turnEnd', 'attention', 'error']

/** Bundled chime per alert kind, relative to the package root. */
const DEFAULT_SOUNDS = {
  turnEnd: 'sounds/done.wav',
  attention: 'sounds/attention.wav',
  error: 'sounds/error.wav',
}

/** Top-level config keys this plugin accepts. */
const CONFIG_KEYS = ['alerts', 'sounds', 'player', 'quietSubagents']

/**
 * Default player per platform. Every `{file}` occurrence in an argument is
 * replaced with the resolved absolute path of the chime.
 */
const DEFAULT_PLAYERS = {
  darwin: { command: '/usr/bin/afplay', args: ['{file}'] },
  linux: { command: 'paplay', args: ['{file}'] },
  win32: {
    command: 'powershell',
    args: [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      "(New-Object Media.SoundPlayer '{file}').PlaySync()",
    ],
  },
}

/**
 * Validate and normalize the row's `config` into the complete spec `apply`
 * consumes. Every default is applied here rather than inside the listeners, so
 * a misconfiguration fails at load instead of mid-turn.
 *
 * @param value - Raw `config` from the Loader row, absent when the row omits it.
 * @returns `{ value: spec }` when the config is usable, otherwise
 * `{ issues }` describing every problem found.
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

  const sounds = {}
  if (raw.sounds !== undefined && (typeof raw.sounds !== 'object' || raw.sounds === null || Array.isArray(raw.sounds))) {
    issues.push({ message: 'sound-alerts: "sounds" must map an alert kind to a file path' })
  } else {
    const configured = raw.sounds ?? {}
    for (const kind of Object.keys(configured)) {
      if (!ALERT_KINDS.includes(kind)) {
        issues.push({ message: `sound-alerts: unknown alert kind "${kind}" in "sounds"` })
      }
    }
    for (const kind of ALERT_KINDS) {
      const requested = configured[kind] ?? DEFAULT_SOUNDS[kind]
      if (typeof requested !== 'string' || requested.trim() === '') {
        issues.push({ message: `sound-alerts: "sounds.${kind}" must be a non-empty file path` })
        continue
      }
      const absolute = isAbsolute(requested) ? requested : resolve(PACKAGE_ROOT, requested)
      if (!existsSync(absolute)) {
        issues.push({ message: `sound-alerts: "sounds.${kind}" points at a missing file: ${absolute}` })
        continue
      }
      sounds[kind] = absolute
    }
  }

  const fallbackPlayer = DEFAULT_PLAYERS[process.platform]
  let player = fallbackPlayer
  if (raw.player !== undefined) {
    if (typeof raw.player !== 'object' || raw.player === null || Array.isArray(raw.player)) {
      issues.push({ message: 'sound-alerts: "player" must be a mapping with "command" and optional "args"' })
    } else {
      const requestedCommand = raw.player.command
      const command = requestedCommand ?? fallbackPlayer?.command
      if (typeof command !== 'string' || command.trim() === '') {
        issues.push({
          message: `sound-alerts: "player.command" is required on ${process.platform}, which has no default player`,
        })
      }
      let args = fallbackPlayer?.args ?? ['{file}']
      if (raw.player.args !== undefined) {
        const requested = raw.player.args
        if (!Array.isArray(requested) || requested.some((arg) => typeof arg !== 'string')) {
          issues.push({ message: 'sound-alerts: "player.args" must be an array of strings' })
        } else if (!requested.some((arg) => arg.includes('{file}'))) {
          issues.push({ message: 'sound-alerts: "player.args" must contain a "{file}" placeholder' })
        } else {
          args = requested
        }
      }
      if (typeof command === 'string' && command.trim() !== '') player = { command, args }
    }
  }
  if (player === undefined) {
    issues.push({
      message: `sound-alerts: no default player for ${process.platform}; set "player.command" and "player.args"`,
    })
  }

  if (issues.length > 0) return { issues }
  return { value: { alerts, quietSubagents, sounds, player } }
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
 * Warn once per distinct playback failure. A missing or broken player would
 * otherwise log on every turn; repeating the same message adds no information.
 *
 * @param logger - Cordis logger from the plugin context.
 * @returns A callback that reports an error at most once per distinct message.
 */
function createReporter(logger) {
  const reported = new Set()
  return (error) => {
    const message = error instanceof Error ? error.message : String(error)
    if (reported.has(message)) return
    reported.add(message)
    logger?.warn?.(`sound-alerts: playback failed: ${message}`)
  }
}

/**
 * Start the player for one chime without waiting for it.
 *
 * @param player - Resolved command and argument template.
 * @param file - Absolute path of the chime to play.
 * @param report - Failure callback; also receives the asynchronous `error`
 * event that `spawn` raises when the command cannot be started.
 */
function play(player, file, report) {
  let child
  try {
    child = spawn(
      player.command,
      player.args.map((arg) => arg.replaceAll('{file}', file)),
      { detached: true, stdio: 'ignore' },
    )
  } catch (error) {
    report(error)
    return
  }
  child.on('error', report)
  child.unref()
}

/**
 * Register the alert listeners.
 *
 * @param ctx - Plugin context owning every listener.
 * @param config - The validated spec returned by {@link Config}.
 */
export function apply(ctx, config) {
  const { alerts, quietSubagents, sounds, player } = config
  const report = createReporter(ctx.logger)

  const notify = (kind) => {
    if (!alerts[kind]) return
    play(player, sounds[kind], report)
  }

  // A subagent session is background work owned by another turn: alerting for
  // each of them drowns out the alert that matters.
  const notifyAgent = (kind, agent) => {
    if (quietSubagents && agent?.session?.header?.origin === 'subagent') return
    notify(kind)
  }

  ctx.on('agent/turn-stopping', ({ agent }) => {
    notifyAgent('turnEnd', agent)
  })

  ctx.on('agent/error', ({ agent }) => {
    notifyAgent('error', agent)
  })

  // Both are waterfall events: the alert observes the request for a human, it
  // does not answer or decide it, so it must delegate onward.
  ctx.on('approval/request', (_request, next) => {
    notify('attention')
    return next()
  })

  ctx.on('user-questions/request', (_request, next) => {
    notify('attention')
    return next()
  })
}
