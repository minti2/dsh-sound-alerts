import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { Config, EVENTS_ENDPOINT, apply } from '../index.js'

const validate = (input) => Config['~standard'].validate(input)

// Defaults resolve to all three alerts at the default volume.
const base = validate(undefined)
assert.ok(base.value, `default config rejected: ${JSON.stringify(base.issues)}`)
assert.deepEqual(base.value.alerts, { turnEnd: true, attention: true, error: true })
assert.equal(base.value.quietSubagents, true)
assert.equal(base.value.volume, 0.25)
console.log('ok  defaults resolve')

// Misconfiguration must fail loud rather than at the first alert.
assert.ok(validate({ nope: 1 }).issues.some((i) => i.message.includes('unknown config key')))
assert.ok(validate({ alerts: { bogus: true } }).issues.some((i) => i.message.includes('unknown alert kind')))
assert.ok(validate({ alerts: { turnEnd: 'yes' } }).issues.some((i) => i.message.includes('must be a boolean')))
assert.ok(validate({ volume: 2 }).issues.some((i) => i.message.includes('between 0 and 1')))
assert.ok(validate({ volume: 'loud' }).issues.some((i) => i.message.includes('between 0 and 1')))
assert.ok(validate({ volume: 0.5 }).value)
console.log('ok  invalid configs rejected')

// Wire the plugin to a test context and capture its route and listeners.
const listeners = new Map()
const listenerOptions = new Map()
const effects = []
let route
const ctx = {
  effect: (fn) => {
    effects.push(fn())
    return () => {}
  },
  on: (name, fn, options) => {
    listeners.set(name, fn)
    listenerOptions.set(name, options)
  },
  webServer: { register: (registered) => { route = registered; return () => {} } },
}
apply(ctx, base.value)

assert.equal(route.path, EVENTS_ENDPOINT)
assert.equal(route.kind, 'exact')
assert.deepEqual([...listeners.keys()], [
  'agent/turn-stopping',
  'agent/error',
  'approval/request',
  'user-questions/request',
])
console.log('ok  route and listeners registered')

// Regression: the application's forwarded-event listener answers these two
// requests on behalf of the UI and resolves WITHOUT calling next(), so an
// observer registered behind it is never reached. Both must prepend.
for (const event of ['approval/request', 'user-questions/request']) {
  assert.equal(
    listenerOptions.get(event)?.prepend,
    true,
    `${event} must register with prepend to observe the request`,
  )
}
assert.equal(listenerOptions.get('agent/turn-stopping'), undefined)
console.log('ok  attention listeners prepend ahead of the answering listener')

// Open one browser stream and record the frames the Host publishes to it.
const frames = []
const headers = []
const ended = []
const response = {
  writeHead: (status, sent) => { headers.push([status, sent]) },
  write: (chunk) => { frames.push(chunk); return true },
  on: () => {},
  end: () => { ended.push(true) },
}
route.handler({ method: 'GET' }, response)
assert.equal(headers[0][0], 200)
assert.equal(headers[0][1]['content-type'], 'text/event-stream')
assert.deepEqual(frames, [': connected\n\n'])

// A non-GET hit is rejected at the route, not upstream.
const rejected = []
route.handler({ method: 'POST' }, { writeHead: (s) => rejected.push(s), end: () => {} })
assert.deepEqual(rejected, [405])
console.log('ok  stream opens and rejects non-GET')

const parse = (chunk) => JSON.parse(chunk.slice('data: '.length))
const alerts = () => frames.slice(1).map((chunk) => parse(chunk).kind)

// Root agents alert; subagent turns stay quiet under quietSubagents.
listeners.get('agent/turn-stopping')({ agent: { session: { header: {} } } })
listeners.get('agent/turn-stopping')({ agent: { session: { header: { origin: 'subagent' } } } })
listeners.get('agent/error')({ agent: { session: { header: { origin: 'subagent' } } } })
assert.deepEqual(alerts(), ['turnEnd'])
console.log('ok  turn-end alerts, subagent turns stay quiet')

// Attention ignores quietSubagents: a blocked subagent still needs a human.
for (const event of ['approval/request', 'user-questions/request']) {
  let delegated = false
  const outcome = await listeners.get(event)({}, () => {
    delegated = true
    return Promise.resolve('outcome')
  })
  assert.equal(delegated, true, `${event} did not call next()`)
  assert.equal(outcome, 'outcome', `${event} did not forward the outcome`)
}
assert.deepEqual(alerts(), ['turnEnd', 'attention', 'attention'])
console.log('ok  waterfall listeners delegate via next() and still alert')

// The frame carries the configured volume so tuning stays in cordis.yml.
const tuned = validate({ volume: 0.05, alerts: { error: false } }).value
const tunedFrames = []
let tunedRoute
apply(
  {
    effect: (fn) => { fn(); return () => {} },
    on: (name, fn) => listeners.set(name, fn),
    webServer: { register: (registered) => { tunedRoute = registered; return () => {} } },
  },
  tuned,
)
tunedRoute.handler({ method: 'GET' }, { writeHead: () => {}, write: (c) => { tunedFrames.push(c); return true }, on: () => {} })
listeners.get('agent/error')({ agent: { session: { header: {} } } })
listeners.get('agent/turn-stopping')({ agent: { session: { header: {} } } })
assert.deepEqual(tunedFrames.slice(1).map(parse), [{ kind: 'turnEnd', volume: 0.05 }])
console.log('ok  disabled alerts stay silent and frames carry the configured volume')

// Disposal must end open streams. Regression: a live config reload used to
// orphan the browser's stream, and it stayed open, so EventSource never
// reconnected and every open tab went silent until the page was reloaded.
effects[0]()
assert.deepEqual(ended, [true], 'disposal must end open alert streams')
console.log('ok  disposal ends open streams so browsers reconnect')

// Regression: the browser selects its voice by alert kind, so every kind the
// Host publishes must exist in the client's chime map. They drifted once — the
// Host published `turnEnd` while the client only knew `done` — and the browser
// dropped the alert with no sound and no error.
const clientSource = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
for (const kind of ['turnEnd', 'attention', 'error']) {
  assert.ok(
    clientSource.includes(`${kind}: {`),
    `client.js defines no chime voice for alert kind "${kind}"`,
  )
}
console.log('ok  every published alert kind has a client chime voice')
