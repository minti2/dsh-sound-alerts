# dsh-sound-alerts

Audible chimes for the DeepSeek Harness **Web UI**. It plays a sound in your
browser when a turn finishes, when the harness is blocked waiting on your
approval or your answer, or when a turn fails — so you can look away during a
long run and still know the moment it needs you.

A [Cordis](https://github.com/cordiverse/cordis) bundle with a Host half that
detects alerts and a browser half that plays them.

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
| `done` | Warm additive partials | Rising perfect fifth, E3 → B3 |
| `attention` | Inharmonic bell partials | Rising arpeggio, A3 → C#4 → E4 |
| `error` | Detuned odd harmonics, beating | Falling figure, A2 → F2 → C2 |

Even `done` and `attention` share no partial structure: `attention` uses the
inharmonic ratios that make a bell ring, while `error` detunes two voices against
each other so the sound beats and reads as wrong.

## Why the Host detects and the browser plays

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

## Install

```
plugin_manager  action: install_bundle
                target: /Users/<you>/Documents/dsh-plugins/dsh-sound-alerts
```

The bundle links the checkout into your profile, so edits take effect on the
next Host restart.

## Configuration

Every field is optional; the defaults are shown in
[`cordis.patch.yml`](cordis.patch.yml).

```yaml
- insert:
    - id: sound-alerts
      name: '@minti2/dsh-sound-alerts'
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
- **Unknown keys and wrong types are rejected at load** with a message naming the
  problem, so a typo never silently disables an alert.
- **A live config change reconnects your tab.** Applying new config disposes and
  re-registers the alert route; the disposer ends the open streams, so the
  browser reopens them instead of holding a dead one.

## Verify

```sh
node scripts/self-check.mjs
```

Checks that defaults resolve, that misconfiguration is rejected at load, that the
route and four listeners register, that the alert stream opens and rejects
non-GET, that subagent turns stay quiet while attention still fires, that the two
waterfall listeners delegate onward with `next()`, and that a disabled alert
stays silent.

## Known limitations

- **Web UI only.** The plugin requires the Host's web server, so it stays
  inactive in a headless profile. There is no terminal alert.
- **The bass notes need speakers that reproduce them.** `error` bottoms out at
  65 Hz and `done` at 165 Hz. Laptop speakers roll off below roughly 150 Hz, so
  the lowest fundamentals are carried by their harmonics rather than reproduced
  directly; raise the pitches if the low alerts sound thin.
- **A user-cancelled turn still chimes.** `agent/turn-stopping` fires when a turn
  closes for any reason, including a cancel you initiated.
- **The prepend depends on the application's forwarded-event listener not
  prepending itself.** Both still run if it does, but a future change that
  prepends it ahead of this plugin would silence the attention chime while
  leaving turn-end and error alerts working. The self-check asserts the prepend
  so that regression cannot land silently.

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
      - /Users/<you>/Documents/dsh-plugins/dsh-sound-alerts
```

Run `node scripts/self-check.mjs` before reloading; it covers the listener
wiring that a silent failure would otherwise hide.
