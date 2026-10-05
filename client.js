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
  id: '@minti2/dsh-sound-alerts',
  factory() {
    /** Document-relative form of the Host's alert route. */
    const ENDPOINT = 'sound-alerts/events'

    /**
     * Chime definitions, tuned in the 65-330 Hz band so they sit under speech
     * and music. `partials` are frequency multipliers and `amps` their relative
     * levels; an inharmonic set is what makes a bell sound like a bell.
     */
    const CHIMES = {
      turnEnd: {
        notes: [
          { frequency: 164.81, start: 0, duration: 0.9, gain: 1 },
          { frequency: 246.94, start: 0.1, duration: 1.1, gain: 0.85 },
        ],
        partials: [1, 2, 3],
        amps: [1, 0.28, 0.1],
        decaySeconds: 0.9,
        detuneCents: 0,
      },
      attention: {
        notes: [
          { frequency: 220.0, start: 0, duration: 0.3, gain: 1 },
          { frequency: 277.18, start: 0.13, duration: 0.3, gain: 1 },
          { frequency: 329.63, start: 0.26, duration: 0.62, gain: 0.9 },
        ],
        partials: [1, 2.76, 5.4],
        amps: [1, 0.5, 0.26],
        decaySeconds: 0.55,
        detuneCents: 0,
      },
      error: {
        notes: [
          { frequency: 110.0, start: 0, duration: 0.4, gain: 1 },
          { frequency: 87.31, start: 0.18, duration: 0.4, gain: 1 },
          { frequency: 65.41, start: 0.36, duration: 0.85, gain: 0.95 },
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

    return {
      /** Open the alert stream and own it for the lifetime of this plugin. */
      apply(ctx) {
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
