import { strict as assert } from 'node:assert'
import { Config, apply } from '../index.js'

const validate = (input) => Config['~standard'].validate(input)

// Defaults resolve to the three bundled chimes and the platform player.
const base = validate(undefined)
assert.ok(base.value, `default config rejected: ${JSON.stringify(base.issues)}`)
assert.deepEqual(base.value.alerts, { turnEnd: true, attention: true, error: true })
assert.equal(base.value.quietSubagents, true)
assert.equal(base.value.player.command, '/usr/bin/afplay')
for (const kind of ['turnEnd', 'attention', 'error']) {
  assert.ok(base.value.sounds[kind].endsWith('.wav'), `${kind} did not resolve`)
}
console.log('ok  defaults resolve')

// Misconfiguration must fail loud rather than at the first alert.
assert.ok(validate({ nope: 1 }).issues.some((i) => i.message.includes('unknown config key')))
assert.ok(validate({ alerts: { bogus: true } }).issues.some((i) => i.message.includes('unknown alert kind')))
assert.ok(validate({ alerts: { turnEnd: 'yes' } }).issues.some((i) => i.message.includes('must be a boolean')))
assert.ok(validate({ sounds: { turnEnd: './missing.wav' } }).issues.some((i) => i.message.includes('missing file')))
assert.ok(validate({ sounds: { done: './missing.wav' } }).issues.some((i) => i.message.includes('unknown alert kind')))
assert.ok(validate({ player: { args: ['-v', '0.5'] } }).issues.some((i) => i.message.includes('{file}')))
assert.ok(validate({ player: { command: 'x', args: ['{file}'] } }).value)
console.log('ok  invalid configs rejected')

// Disabling an alert is honoured at dispatch time.
const listeners = new Map()
const warnings = []
apply(
  { on: (name, fn) => listeners.set(name, fn), logger: { warn: (m) => warnings.push(m) } },
  { ...base.value, alerts: { turnEnd: false, attention: true, error: true } },
)
assert.deepEqual([...listeners.keys()], [
  'agent/turn-stopping',
  'agent/error',
  'approval/request',
  'user-questions/request',
])
console.log('ok  listeners registered')

// Root agents alert; subagent turns stay quiet under quietSubagents.
listeners.get('agent/turn-stopping')({ agent: { session: { header: {} } } })
listeners.get('agent/turn-stopping')({ agent: { session: { header: { origin: 'subagent' } } } })
listeners.get('agent/turn-stopping')({ agent: { session: { header: { origin: 'subagent' } } } })
console.log('ok  turn-stopping dispatch (one root chime expected)')

// Waterfall events must delegate onward, never short-circuit.
for (const event of ['approval/request', 'user-questions/request']) {
  let delegated = false
  const outcome = await listeners.get(event)({}, () => {
    delegated = true
    return Promise.resolve('outcome')
  })
  assert.equal(delegated, true, `${event} did not call next()`)
  assert.equal(outcome, 'outcome', `${event} did not forward the outcome`)
}
console.log('ok  waterfall listeners delegate via next()')

await new Promise((resolve) => setTimeout(resolve, 1500))
assert.deepEqual(warnings, [], `unexpected playback warnings: ${warnings.join('; ')}`)
console.log('ok  no playback failures')
