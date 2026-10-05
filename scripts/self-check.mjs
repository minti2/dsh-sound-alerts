import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { Config, EVENTS_ENDPOINT, apply } from '../index.js'

// The schema supplies every default, including for omitted nested fields.
// Volatile fields resolve to accessors, so values are read through `.get()`.
const base = Config({})
assert.equal(base.alerts.turnEnd.get(), true)
assert.equal(base.alerts.attention.get(), true)
assert.equal(base.alerts.error.get(), true)
assert.equal(base.quietSubagents.get(), true)
assert.equal(base.volume.get(), 0.25)
assert.equal(Config({ volume: 0.5 }).volume.get(), 0.5)
assert.equal(Config({ alerts: { turnEnd: false } }).alerts.attention.get(), true)
console.log('ok  defaults resolve')

// Out-of-range and mistyped values fail at activation, not at the first alert.
assert.throws(() => Config({ volume: 2 }), /volume/)
assert.throws(() => Config({ volume: 'loud' }))
assert.throws(() => Config({ alerts: { turnEnd: 'yes' } }))
console.log('ok  invalid configs rejected')

// The settings service projects a native Schemastery graph into an editable
// form. A schema that only validates reports `unsupported` and gets no
// controls, which is a silent loss of the settings UI.
assert.equal(Reflect.get(Config, Symbol.for('schemastery')), true)
assert.equal(typeof Config.type, 'string')
assert.equal(typeof Config.meta, 'object')
console.log('ok  config is a native schemastery graph, so settings renders controls')

// Regression: the settings service serves ONLY volatile fields. `describe()`
// drops an entry whose volatile projection is empty, so a non-volatile field
// validates and persists yet never reaches the UI, and a browser form waiting
// on that namespace silently never mounts.
const editable = {
  'alerts.turnEnd': Config.dict.alerts.dict.turnEnd,
  'alerts.attention': Config.dict.alerts.dict.attention,
  'alerts.error': Config.dict.alerts.dict.error,
  quietSubagents: Config.dict.quietSubagents,
  volume: Config.dict.volume,
}
for (const [path, field] of Object.entries(editable)) {
  assert.equal(field.meta.volatile, true, `${path} must be volatile or the settings form omits it`)
}
console.log('ok  every editable field is volatile, so describe() serves the namespace')

// Wire the plugin to a test context and capture its route and listeners.
const listeners = new Map()
const listenerOptions = new Map()
const effects = []
const warnings = []
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
  logger: { warn: (line) => warnings.push(line) },
}
apply(ctx, base)

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

// Regression: a stream that dies mid-write must not reject the dispatch.
// `agent/turn-stopping` is a cordis `serial`, which propagates a listener throw
// instead of containing it, and the loop awaits it inside the turn's own try —
// so a throw here would mark a successful turn failed and raise exactly the
// error alert this plugin exists to report, not cause. This runs against the
// first instance, before the block below rebinds `listeners` to a second one.
const boomEnded = []
let boomWrites = 0
assert.doesNotThrow(() => {
  route.handler({ method: 'GET' }, {
    writeHead: () => {},
    // The handshake succeeds and the alert write is the one that fails, which
    // is the ordering a socket destroyed mid-stream actually produces.
    write: () => {
      boomWrites += 1
      if (boomWrites > 1) throw new Error('socket destroyed')
      return true
    },
    on: () => {},
    end: () => { boomEnded.push(true) },
  })
  listeners.get('agent/turn-stopping')({ agent: { session: { header: {} } } })
}, 'a failing stream must not propagate out of the turn-stopping listener')
assert.ok(
  warnings.some((line) => line.includes('dropped a failed alert stream')),
  'a failed stream must be dropped and reported',
)

// A socket that dies before the channel opens is contained at the route too.
assert.doesNotThrow(() => {
  route.handler({ method: 'GET' }, {
    writeHead: () => {},
    write: () => { throw new Error('gone before open') },
    on: () => {},
    end: () => {},
  })
}, 'a stream that dies before opening must not throw out of the route handler')
assert.ok(
  warnings.some((line) => line.includes('failed to open')),
  'a stream that never opened must be reported',
)
console.log('ok  a failing stream is dropped instead of failing the turn')

// The frame carries the configured volume so tuning stays in the config.
const tuned = Config({ volume: 0.05, alerts: { error: false } })
const tunedFrames = []
let tunedRoute
apply(
  {
    effect: (fn) => { fn(); return () => {} },
    on: (name, fn) => listeners.set(name, fn),
    webServer: { register: (registered) => { tunedRoute = registered; return () => {} } },
    logger: { warn: (line) => warnings.push(line) },
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
// A stream dropped by a failed write is already gone, so disposal must not
// touch it again; only the streams still open are closed.
assert.deepEqual(boomEnded, [], 'a dropped stream must not be closed again on disposal')
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
