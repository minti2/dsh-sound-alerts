# Sound Alerts

Audible chimes for the DeepSeek Harness. It plays a sound when a turn finishes,
when the harness is blocked waiting on your approval or your answer, or when a
turn fails — so you can look away during a long run and still know the moment it
needs you.

This is a [Cordis](https://github.com/cordiverse/cordis) bundle: a single Host
plugin plus the three chimes it plays.

## What triggers a sound

| Alert | Harness event | When it plays |
| --- | --- | --- |
| `attention` | `approval/request`, `user-questions/request` | The harness is blocked until you approve an action or answer a question. |
| `turnEnd` | `agent/turn-stopping` | The turn is about to close and the model owes no further response. |
| `error` | `agent/error` | A step or turn errored. |

`attention` is the alert worth waking up for: it fires at the exact moment the
run cannot continue without you.

## The chimes

All three are synthesized by [`scripts/generate-sounds.mjs`](scripts/generate-sounds.mjs),
so the repository carries no third-party audio. Regenerate them with:

```sh
node scripts/generate-sounds.mjs
```

| File | Sound |
| --- | --- |
| `sounds/done.wav` | Rising perfect fifth (E5 → B5). An affirmative "finished". |
| `sounds/attention.wav` | Rising A-major arpeggio (A5 → C#6 → E6). Three quick pings that read as "waiting on you". |
| `sounds/error.wav` | Falling A-minor triad (A4 → F4 → C4). Low and subdued rather than alarming. |

## Install

Install the bundle into a Harness profile from this directory:

```
plugin_manager  action: install_bundle
                target: /Users/<you>/Documents/dsh-plugins/sound-alerts
```

That links this checkout into the profile, so edits here take effect on the next
Harness restart without reinstalling.

## Configuration

Every field is optional; the defaults are shown in
[`cordis.patch.yml`](cordis.patch.yml). The full set:

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
        sounds:
          turnEnd: sounds/done.wav
          attention: sounds/attention.wav
          error: sounds/error.wav
        player:
          command: /usr/bin/afplay
          args: ['{file}']
```

Notes:

- **Sound paths** resolve relative to this package unless absolute. A path that
  does not exist fails at load, not at the first alert.
- **`quietSubagents`** covers `turnEnd` and `error` only. Attention alerts always
  play: a blocked request needs a human no matter which agent raised it.
- **`player.args`** must contain a `{file}` placeholder, which is replaced with
  the resolved absolute path of the chime.
- **Unknown keys and wrong types are rejected at load** with a message naming the
  problem, so a typo never silently disables an alert.

### Player defaults per platform

| Platform | Command | Notes |
| --- | --- | --- |
| macOS | `/usr/bin/afplay {file}` | Set `args: ['-v', '0.4', '{file}']` to lower the volume. |
| Linux | `paplay {file}` | Needs PulseAudio; use `aplay -q {file}` for bare ALSA. |
| Windows | `powershell -NoProfile -NonInteractive -Command "(New-Object Media.SoundPlayer '{file}').PlaySync()"` | |

Any player works, for example `ffplay -nodisp -autoexit -loglevel quiet {file}`
or `mpv --no-video {file}`.

## Verify

```sh
node scripts/self-check.mjs
```

Checks that defaults resolve, that misconfiguration is rejected at load, that
the four listeners register, and that the two waterfall listeners delegate
onward with `next()` instead of swallowing the approval or question.

## Why the attention listeners prepend

`approval/request` and `user-questions/request` are waterfall events. The
Harness application registers its own listener for both, which forwards the
request to the connected UI and returns the user's answer; when the UI answers,
that listener resolves **without calling `next()`**, so the rest of the chain is
skipped. A plugin listener registered after it is never invoked at all.

Both attention listeners therefore register with `prepend: true` so the chime
fires before the answering listener runs. This observation cannot change a
decision: the `never` approval policy is settled inside the approval service
before the event is dispatched, so a policy-blocked request never reaches any
listener.

## Known limitations

- **The sound plays where the Host process runs.** Driving a remote Harness over
  SSH rings the remote machine, not your laptop.
- **A user-cancelled turn still chimes.** `agent/turn-stopping` fires when a turn
  closes for any reason, including a cancel you initiated.
- **Unix only out of the box** for `afplay`/`paplay`; on Windows the default
  PowerShell player blocks its own process, which is harmless because it is
  detached.
- **The prepend depends on the application's forwarded-event listener not
  prepending itself.** Both still run if it does, but a future change that
  prepends it ahead of this plugin would silence the attention chime while
  leaving turn-end and error alerts working.
