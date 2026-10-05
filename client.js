/**
 * Browser half of the sound-alerts bundle.
 *
 * Subscribes to the Host's alert stream and renders each frame as a short
 * Web Audio chime. Nothing is fetched or decoded: every sound is synthesized
 * from oscillators, so the bundle ships no audio files and needs no OS audio
 * player.
 *
 * The three alerts are deliberately different instruments rather than the same
 * chime at three pitches:
 *
 * - `turnEnd` — warm additive partials, a rising perfect fifth that resolves.
 * - `attention` — inharmonic bell partials, a rising arpeggio that rings.
 * - `error` — detuned odd harmonics that beat against each other, a falling
 *   figure that sounds wrong on purpose.
 *
 * Browser autoplay policy keeps an AudioContext suspended until the user has
 * interacted with the document. The context is resumed on the first pointer or
 * key event, so an alert arriving while the tab is in the background still
 * plays.
 */

window.__ModuleLoader__.load({
  id: 'dsh-sound-alerts',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** Document-relative form of the Host's alert route. */
    const ENDPOINT = 'sound-alerts/events'

    /** Settings namespace: the id of the row this bundle's patch declares. */
    const NS = 'sound-alerts'

    /** This row's key in the Plugins page: `<package name>#<row id>`. */
    const ROW_KEY = 'dsh-sound-alerts#sound-alerts'

    /** Form copy, registered under {@link NS} and read through the `t` seat. */
    const DICTIONARIES = {
      en: {
        turnEnd: 'Turn finished',
        turnEndHint: 'Play when a turn closes and the model owes no further response.',
        attention: 'Needs your attention',
        attentionHint: 'Play when the harness is blocked on your approval or your answer.',
        error: 'Turn failed',
        errorHint: 'Play when a step or turn errors.',
        quietSubagents: 'Quiet subagents',
        quietSubagentsHint: 'Silence turn-end and error chimes from subagent sessions. Attention alerts always play.',
        volume: 'Volume',
        volumeHint: 'Peak gain of every chime, 0 to 1.',
      },
      zh: {
        turnEnd: '回合结束',
        turnEndHint: '回合关闭且模型无需继续回应时播放。',
        attention: '需要你处理',
        attentionHint: 'Harness 等待你批准或回答时播放。',
        error: '回合失败',
        errorHint: '步骤或回合出错时播放。',
        quietSubagents: '静默子代理',
        quietSubagentsHint: '子代理会话的回合结束与失败不播放；需要处理的提醒始终播放。',
        volume: '音量',
        volumeHint: '每个提示音的峰值增益，0 到 1。',
      },
    }

    /**
     * Chime definitions, tuned in the 98-494 Hz band so they sit under speech
     * and music. `partials` are frequency multipliers and `amps` their relative
     * levels; an inharmonic set is what makes a bell sound like a bell.
     */
    const CHIMES = {
      turnEnd: {
        notes: [
          { frequency: 246.94, start: 0, duration: 0.9, gain: 1 },
          { frequency: 369.99, start: 0.1, duration: 1.1, gain: 0.85 },
        ],
        partials: [1, 2, 3],
        amps: [1, 0.28, 0.1],
        decaySeconds: 0.9,
        detuneCents: 0,
      },
      attention: {
        notes: [
          { frequency: 329.63, start: 0, duration: 0.3, gain: 1 },
          { frequency: 415.30, start: 0.13, duration: 0.3, gain: 1 },
          { frequency: 493.88, start: 0.26, duration: 0.62, gain: 0.9 },
        ],
        partials: [1, 2.76, 5.4],
        amps: [1, 0.5, 0.26],
        decaySeconds: 0.55,
        detuneCents: 0,
      },
      error: {
        notes: [
          { frequency: 164.81, start: 0, duration: 0.4, gain: 1 },
          { frequency: 130.81, start: 0.18, duration: 0.4, gain: 1 },
          { frequency: 98.00, start: 0.36, duration: 0.85, gain: 0.95 },
        ],
        partials: [1, 3, 5],
        amps: [1, 0.45, 0.28],
        decaySeconds: 0.7,
        detuneCents: 9,
      },
    }

    /** Fallback gain for a frame that omits one; matches the plugin default. */
    const DEFAULT_VOLUME = 0.25

    /** Lazily created shared output context, absent where Web Audio is unavailable. */
    let audio

    /** @returns The shared AudioContext, or undefined when the browser has none. */
    function audioContext() {
      if (audio !== undefined) return audio
      const Ctor = window.AudioContext ?? window.webkitAudioContext
      if (Ctor === undefined) return undefined
      audio = new Ctor()
      return audio
    }

    /** Resume a policy-suspended context; the user gesture makes this succeed. */
    function unlock() {
      const context = audioContext()
      if (context === undefined || context.state !== 'suspended') return
      // Rejects only when the context is already closed, which needs no recovery.
      context.resume().catch(() => undefined)
    }

    /**
     * Synthesize one chime.
     * @param kind - Alert kind naming a {@link CHIMES} entry.
     * @param volume - Peak output gain in the range 0..1.
     */
    function play(kind, volume) {
      const chime = CHIMES[kind]
      if (chime === undefined) {
        // A kind the client does not know is a code mismatch, not a config
        // error. Staying silent is how turn-end went missing while the other
        // two alerts kept working, so say so instead.
        console.warn(`sound-alerts: no chime defined for alert kind "${kind}"`)
        return
      }
      const context = audioContext()
      if (context === undefined) return
      unlock()

      const master = context.createGain()
      master.gain.value = Math.max(0, Math.min(1, volume))
      master.connect(context.destination)

      const origin = context.currentTime
      for (const note of chime.notes) {
        const start = origin + note.start
        const end = start + note.duration
        for (let index = 0; index < chime.partials.length; index += 1) {
          // A detuned pair beats against itself, which is what makes `error`
          // sound unstable. Halve each voice so the pair is not twice as loud.
          const voices = chime.detuneCents === 0 ? [0] : [-chime.detuneCents, chime.detuneCents]
          for (const cents of voices) {
            const oscillator = context.createOscillator()
            oscillator.type = 'sine'
            oscillator.frequency.value = note.frequency * chime.partials[index]
            oscillator.detune.value = cents

            const envelope = context.createGain()
            const peak = note.gain * chime.amps[index] * (voices.length > 1 ? 0.5 : 1)
            envelope.gain.setValueAtTime(0, start)
            envelope.gain.linearRampToValueAtTime(peak, start + 0.006)
            // Exponential release to near-silence; the target must stay non-zero.
            envelope.gain.exponentialRampToValueAtTime(0.0001, end)

            oscillator.connect(envelope)
            envelope.connect(master)
            oscillator.start(start)
            oscillator.stop(end + 0.02)
          }
        }
      }
    }

    /** One labelled row of the settings form. */
    function FormRow(props) {
      return h('div', {
        style: {
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          gap: 16, padding: '10px 0', borderTop: '1px solid var(--dsw-alias-border-l1)',
        },
      },
        h('div', { style: { minWidth: 0 } },
          h('div', { style: { color: 'var(--dsw-alias-label-primary)', fontSize: 13 } }, props.label),
          h('div', { style: { color: 'var(--dsw-alias-label-secondary)', fontSize: 12, marginTop: 2 } }, props.hint),
        ),
        props.children,
      )
    }

    /** A switch matching the host control's `role="switch"` contract. */
    function Switch(props) {
      return h('button', {
        type: 'button',
        role: 'switch',
        'aria-checked': props.checked,
        'aria-label': props.label,
        disabled: props.disabled,
        onClick: () => { props.onChange(!props.checked) },
        style: {
          flex: '0 0 auto', width: 38, height: 22, borderRadius: 11, padding: 0, position: 'relative',
          border: '1px solid var(--dsw-alias-border-l2)',
          background: props.checked ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-bg-layer-2)',
          cursor: props.disabled ? 'default' : 'pointer',
          opacity: props.disabled ? 0.5 : 1,
        },
      }, h('span', {
        'aria-hidden': true,
        style: {
          position: 'absolute', top: 3, left: props.checked ? 19 : 3, width: 14, height: 14,
          borderRadius: 7, background: 'var(--dsw-alias-bg-layer-1)', transition: 'left 120ms ease',
        },
      }))
    }

    /**
     * The volume control, committing once per gesture. Writing on every drag
     * step would send a Host write per pixel for no extra information.
     */
    function VolumeSlider(props) {
      const [draft, setDraft] = React.useState(props.value)
      React.useEffect(() => { setDraft(props.value) }, [props.value])
      const commit = () => { if (draft !== props.value) props.onCommit(draft) }
      return h('div', { style: { display: 'flex', alignItems: 'center', gap: 10 } },
        h('input', {
          type: 'range', min: 0, max: 1, step: 0.05,
          value: draft, disabled: props.disabled, 'aria-label': props.label,
          onChange: (event) => { setDraft(Number(event.target.value)) },
          onPointerUp: commit,
          onKeyUp: commit,
          onBlur: commit,
          style: { width: 160, accentColor: 'var(--dsw-alias-brand-primary)' },
        }),
        h('span', { style: { color: 'var(--dsw-alias-label-secondary)', fontSize: 12, width: 36 } }, draft.toFixed(2)),
      )
    }

    /**
     * This row's configuration, as the Plugins page asks for it. The page owns
     * the resolved values and the write actions; the component only renders
     * them and forwards edits.
     *
     * @param props - the requested view, the `t` seat, and the entry's form.
     * @returns The form for `view: 'page'`, otherwise nothing, which leaves the
     * page's own one-liner in place.
     */
    function SettingsCard(props) {
      const { view, form, t } = props
      if (view !== 'page' || form === undefined) return null
      const state = form.state
      const value = state.value ?? {}
      const alerts = value.alerts ?? {}
      const disabled = state.writable !== true
      const write = (path, next) => { void form.mutate([{ op: 'set', path, value: next }]) }
      const toggle = (kind, key, hintKey) => h(FormRow, { key: kind, label: t(key), hint: t(hintKey) },
        h(Switch, {
          checked: alerts[kind] === true, label: t(key), disabled,
          onChange: (next) => { write(['alerts', kind], next) },
        }))
      return h('div', { style: { paddingBottom: 4 } },
        toggle('turnEnd', 'turnEnd', 'turnEndHint'),
        toggle('attention', 'attention', 'attentionHint'),
        toggle('error', 'error', 'errorHint'),
        h(FormRow, { key: 'quiet', label: t('quietSubagents'), hint: t('quietSubagentsHint') },
          h(Switch, {
            checked: value.quietSubagents === true, label: t('quietSubagents'), disabled,
            onChange: (next) => { write(['quietSubagents'], next) },
          })),
        h(FormRow, { key: 'volume', label: t('volume'), hint: t('volumeHint') },
          h(VolumeSlider, {
            value: typeof value.volume === 'number' ? value.volume : DEFAULT_VOLUME,
            label: t('volume'), disabled,
            onCommit: (next) => { write(['volume'], next) },
          })),
      )
    }

    return {
      inject: ['slots', 'locale', 'configForms'],

      /** Open the alert stream, and contribute this row's settings form. */
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, DICTIONARIES), 'dsh-sound-alerts: dictionaries')

        // The Plugins page asks a row for its configuration once the Host
        // serves the namespace; without this contribution the schema is
        // validated and persisted but has no control anywhere.
        ctx.effect(() => ctx.configForms.whileServed([NS], () => ctx.slots.inject('plugins.row.config', () => ctx.slots.register({
          name: 'plugins.row.config',
          key: ROW_KEY,
          locale: NS,
        }, SettingsCard))), 'dsh-sound-alerts: settings form')

        ctx.effect(() => {
          window.addEventListener('pointerdown', unlock)
          window.addEventListener('keydown', unlock)

          const source = new EventSource(ENDPOINT)
          source.onmessage = (event) => {
            let frame
            try {
              frame = JSON.parse(event.data)
            } catch (error) {
              // A malformed frame is not actionable; keep the stream open for
              // the alerts that follow.
              if (!(error instanceof SyntaxError)) throw error
              return
            }
            if (frame === null || typeof frame !== 'object') return
            play(frame.kind, typeof frame.volume === 'number' ? frame.volume : DEFAULT_VOLUME)
          }

          return () => {
            window.removeEventListener('pointerdown', unlock)
            window.removeEventListener('keydown', unlock)
            source.close()
          }
        })
      },
    }
  },
})
