# dsh-sound-alerts

Audible chimes for the DeepSeek Harness **Web UI**. It plays a sound in your
browser when a turn finishes, when the harness is blocked waiting on your
approval or your answer, or when a turn fails — so you can look away during a
long run and still know the moment it needs you.

A [Cordis](https://github.com/cordiverse/cordis) bundle with a Host half that
detects alerts and a browser half that plays them.

## Install

```sh
dsh plugin --profile <name> add github:minti2/dsh-sound-alerts
```

That is the whole install. `dsh plugin` forwards to pnpm and appends the bundle
to the profile's `dsh.profile.bundles`, so nothing needs editing by hand.

This package is plain JavaScript with **no build step**, which matters for a git
install: git fetches sources rather than built artifacts, so a TypeScript plugin
would need a `prepare` script plus a `pnpm-workspace.yaml` build allowlist that
grants it permission to execute code on your machine at install time. There is
no build here, so there is no allowlist and no install-time code execution.

Installing into an agent's own profile uses the plugin manager instead:

```
plugin_manager  action: install_bundle
                target: /path/to/dsh-sound-alerts
```

## What triggers a sound

| Alert | Harness event | When it plays |
| --- | --- | --- |
| `attention` | `approval/request`, `user-questions/request` | The harness is blocked until you approve an action or answer a question. |
| `turnEnd` | `agent/turn-stopping` | The turn is about to close and the model owes no further response. |
| `error` | `agent/error` | A step or turn errored. |

`attention` is the alert worth looking up for, and it covers **every** approval
the harness asks for — including the sandbox escalation prompt you get when a
tool tries to write outside the workspace. `packages/sandbox/sandbox/src/escalation.ts`
routes those through `ctx.approval.request(...)`, which is exactly the event this
plugin observes.

## The three sounds

Each alert is a different instrument, not the same beep at three pitches. All
three are synthesized from oscillators in the browser, so nothing is downloaded
and no OS audio tool is involved.

| Alert | Voice | Figure |
| --- | --- | --- |
| `turnEnd` | Warm additive partials | Rising perfect fifth, B3 → F#4 |
| `attention` | Inharmonic bell partials | Rising arpeggio, E4 → G#4 → B4 |
| `error` | Detuned odd harmonics, beating | Falling figure, E3 → C3 → G2 |

Even `turnEnd` and `attention` share no partial structure: `attention` uses the
inharmonic ratios that make a bell ring, while `error` detunes two voices against
each other so the sound beats and reads as wrong.

## Configuration

`Config` is a Schemastery schema, and the browser half contributes the matching
form, so every field below is editable without touching a file: **Settings →
Plugins → `dsh-sound-alerts` → the `sound-alerts` row's configure control**. It
gives a switch per alert, a switch for subagent quiet, and a slider for volume.
Edits persist through the same profile patch layer a hand edit would use.

The controls need three things, and losing any one is silent in a different
place. The schema is what the Host validates against. `.volatile()` on every
field is what puts it in the settings document at all: the service projects only
volatile fields, and drops an entry whose volatile projection is empty, so an
ordinary field never reaches the UI. The row's `plugins.row.config` contribution
is what draws it. A plugin can report `status: "schema"` and still show no
controls anywhere.

Edits take effect on the next alert rather than at the next restart: volatile
fields resolve to accessors, so the plugin reads their current value each time it
publishes instead of snapshotting at activation.

The same fields can be set directly in a profile's `cordis.patch.yml`:

```yaml
- id: sound-alerts
  name: dsh-sound-alerts
  config:
    alerts:
      turnEnd: true      # chime when a turn finishes
      attention: true    # chime when the harness waits on you
      error: true        # chime when a turn errors
    quietSubagents: true # silence turnEnd and error from subagent sessions
    volume: 0.25         # peak gain of every chime, 0..1
```

Notes:

- **`volume` is the one knob for loudness.** It travels in each alert frame and
  is applied in the browser, so tuning it does not require touching the chimes.
- **`quietSubagents`** covers `turnEnd` and `error` only. Attention alerts
  always play: a blocked request needs a human no matter which agent raised it.
- **Changing config live reconnects your tab.** Applying new config disposes and
  re-registers the alert route; the disposer ends the open streams, so the
  browser reopens them instead of holding a dead one.
- **Invalid values fail at activation** with the offending path named, so a typo
  never silently disables an alert.

### Why the Host detects and the browser plays

Neither side can do both jobs.

**Detection must be on the Host.** `approval/request` and `user-questions/request`
are waterfall events. The Harness application registers its own listener for
both, which forwards the request to the connected UI and returns your answer;
when the UI answers, that listener resolves **without calling `next()`**, so the
rest of the chain is skipped. The Host half registers with `prepend: true` and
therefore observes the request before the answering listener runs. The browser
half has no equivalent: `ctx.remote.$on` accepts no options, and the built-in
approval and question panels are always registered first, so a browser-side
observer would never be reached.

**Playback must be in the browser.** It reaches the machine you are actually
sitting at, works when the Host runs remotely or in a container, and needs no
`afplay`/`paplay`/PowerShell player.

The two halves are joined by a Server-Sent Events route, `/sound-alerts/events`,
which the browser half subscribes to with `EventSource`.

## Verify

```sh
pnpm install                 # supplies the dev dependency the check imports
node scripts/self-check.mjs
```

Checks that defaults resolve and invalid values are rejected, that the Config is
a native Schemastery graph and every field is volatile (losing either silently
removes the settings controls), that the route and four listeners register, that
the alert stream opens, rejects non-GET, and survives a stream that dies
mid-write, that subagent turns stay quiet while attention still fires, that both
waterfall listeners delegate onward with `next()`, that disposal ends open
streams, and that every published alert kind has a browser voice.

The check imports `@deepseek-ai/schemastery`, which the Host supplies at runtime
through the profile resolution layer and `devDependencies` supplies for the
check itself. Without the install step it fails to resolve the module.

## Known limitations

- **Web UI only.** The plugin requires the Host's web server, so it stays
  inactive in a headless profile. There is no terminal alert.
- **The bass notes need speakers that reproduce them.** `error` bottoms out at
  98 Hz and `turnEnd` at 247 Hz. Laptop speakers roll off below roughly 150 Hz,
  so the lowest fundamentals are carried by their harmonics rather than
  reproduced directly; raise the pitches in `client.js` if the low alerts sound
  thin.
- **A user-cancelled turn still chimes.** `agent/turn-stopping` fires when a turn
  closes for any reason, including a cancel you initiated.
- **The prepend depends on the application's forwarded-event listener not
  prepending itself.** Both still run if it does, but a future change that
  prepends it ahead of this plugin would silence the attention chime while
  leaving turn-end and error alerts working. The self-check asserts the prepend
  so that regression cannot land silently.
- **The alert route is not authenticated.** `/sound-alerts/events` is served by
  the Host's web server without a credential check, matching the shipped
  `/plugins/events` route. It is a receive-only channel — nothing can be
  injected through it, and it cannot be made to produce sound — but a client
  that can reach the port can subscribe and learn *that an approval or question
  is pending*. That is metadata, not content. It matters only if the Host is
  bound beyond loopback; on the default loopback binding the reachable set is
  the local machine, which can already read the profile's files.
- **The settings card renders nothing for `view: 'summary'`.** The page falls
  back to its own one-liner for this row. That is the intended reading of the
  slot contract, but it is the one behaviour here verified only against the
  running UI rather than asserted by the self-check.

## Development

**Editing `index.js` or `client.js` requires a Harness restart.** A profile
enables `dsh-hmr` for configuration, but its `root` defaults to `[]`, so module
roots — the JavaScript itself — are not watched. Only `cordis.patch.yml` changes
apply live.

To iterate without restarting, add this package to the module watch roots in the
profile's `dsh-hmr` config:

```yaml
- id: hmr
  config:
    root:
      - /path/to/dsh-sound-alerts
```

Run `node scripts/self-check.mjs` before reloading; it covers the listener
wiring and schema shape that a silent failure would otherwise hide.
