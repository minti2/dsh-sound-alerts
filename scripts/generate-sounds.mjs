/**
 * Synthesizes the three alert chimes shipped in `sounds/`.
 *
 * Run `node scripts/generate-sounds.mjs` to regenerate every WAV from scratch.
 * The chimes are generated rather than sampled so the repository carries no
 * third-party audio and the exact timbre is reproducible from this source.
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SAMPLE_RATE = 44_100
const OUTPUT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'sounds')

/**
 * Amplitude envelope for one note: a short attack ramp that avoids a click at
 * the onset, and a linear release that forces the tail to exact silence.
 *
 * @param t - Seconds since the note started.
 * @param duration - Total note length in seconds.
 * @returns Envelope gain in the range 0..1.
 */
function envelope(t, duration) {
  const attack = 0.006
  const release = 0.05
  if (t < 0 || t > duration) return 0
  const rise = t < attack ? t / attack : 1
  const fall = t > duration - release ? Math.max(0, (duration - t) / release) : 1
  return rise * fall
}

/**
 * Renders one note as a sum of decaying sine partials.
 *
 * @param note - Frequency in Hz, onset and duration in seconds, peak gain, the
 * partial multipliers to stack, the harmonic decay scalar, and the exponential
 * decay rate that sets how quickly the chime fades.
 * @returns Mono samples for this note, one float per sample at `SAMPLE_RATE`.
 */
function renderNote(note) {
  const length = Math.ceil(note.duration * SAMPLE_RATE)
  const samples = new Float64Array(length)
  for (let index = 0; index < length; index += 1) {
    const t = index / SAMPLE_RATE
    let value = 0
    for (let partial = 0; partial < note.partials.length; partial += 1) {
      const multiple = note.partials[partial]
      const amplitude = note.amps[partial] * Math.exp(-t * note.decay * (1 + partial * 0.9))
      value += amplitude * Math.sin(2 * Math.PI * note.frequency * multiple * t)
    }
    samples[index] = value * envelope(t, note.duration)
  }
  return samples
}

/**
 * Mixes notes into one track at their scheduled onsets.
 *
 * @param notes - Notes to mix, each with an additional `start` offset in seconds.
 * @param totalSeconds - Track length in seconds.
 * @returns Mono float samples spanning `totalSeconds`.
 */
function mixdown(notes, totalSeconds) {
  const track = new Float64Array(Math.ceil(totalSeconds * SAMPLE_RATE))
  for (const note of notes) {
    const rendered = renderNote(note)
    const offset = Math.round(note.start * SAMPLE_RATE)
    for (let index = 0; index < rendered.length; index += 1) {
      const target = offset + index
      if (target >= track.length) break
      track[target] += rendered[index] * note.gain
    }
  }
  return track
}

/**
 * Scales a track so its loudest sample sits just below full scale.
 *
 * @param track - Mono float samples.
 * @param peak - Target peak amplitude in the range 0..1.
 * @returns A new track scaled to `peak`.
 */
function normalize(track, peak) {
  let loudest = 0
  for (const sample of track) loudest = Math.max(loudest, Math.abs(sample))
  const scale = loudest === 0 ? 1 : peak / loudest
  const scaled = new Float64Array(track.length)
  for (let index = 0; index < track.length; index += 1) scaled[index] = track[index] * scale
  return scaled
}

/**
 * Encodes mono float samples as a 16-bit PCM WAV file.
 *
 * @param track - Mono float samples in the range -1..1.
 * @returns The complete WAV file bytes.
 */
function encodeWav(track) {
  const dataBytes = track.length * 2
  const buffer = Buffer.alloc(44 + dataBytes)
  buffer.write('RIFF', 0, 'ascii')
  buffer.writeUInt32LE(36 + dataBytes, 4)
  buffer.write('WAVE', 8, 'ascii')
  buffer.write('fmt ', 12, 'ascii')
  buffer.writeUInt32LE(16, 16)
  buffer.writeUInt16LE(1, 20)
  buffer.writeUInt16LE(1, 22)
  buffer.writeUInt32LE(SAMPLE_RATE, 24)
  buffer.writeUInt32LE(SAMPLE_RATE * 2, 28)
  buffer.writeUInt16LE(2, 32)
  buffer.writeUInt16LE(16, 34)
  buffer.write('data', 36, 'ascii')
  buffer.writeUInt32LE(dataBytes, 40)
  for (let index = 0; index < track.length; index += 1) {
    const clamped = Math.max(-1, Math.min(1, track[index]))
    buffer.writeInt16LE(Math.round(clamped * 32_767), 44 + index * 2)
  }
  return buffer
}

/** Sine partial multipliers and their amplitudes, one entry per shipped chime. */
const TIMBRES = {
  // Warm and mostly fundamental: resolves rather than demands attention.
  done: { partials: [1, 2, 3], amps: [1, 0.26, 0.1], decay: 5.2 },
  // Brighter upper partials with a faster decay cut through background audio.
  attention: { partials: [1, 2, 4], amps: [1, 0.34, 0.16], decay: 7.5 },
  // A muffled low voice: audible without sounding like a failure alarm.
  error: { partials: [1, 2], amps: [1, 0.2], decay: 4.2 },
}

/**
 * Builds one chime from its note schedule.
 *
 * @param voice - Timbre key in {@link TIMBRES}.
 * @param notes - Scheduled `{ frequency, start, duration, gain }` entries.
 * @param tail - Extra seconds rendered after the last note for its decay.
 * @returns A normalized mono track.
 */
function chime(voice, notes, tail) {
  const timbre = TIMBRES[voice]
  const last = notes.reduce((end, note) => Math.max(end, note.start + note.duration), 0)
  const track = mixdown(
    notes.map((note) => ({ ...timbre, ...note })),
    last + tail,
  )
  return normalize(track, 0.89)
}

const CHIMES = {
  // Rising perfect fifth (E5 -> B5): an affirmative "finished".
  done: chime('done', [
    { frequency: 659.25, start: 0, duration: 0.9, gain: 1 },
    { frequency: 987.77, start: 0.1, duration: 1.1, gain: 0.85 },
  ], 0.05),
  // Rising A-major arpeggio (A5 -> C#6 -> E6): three quick pings that read as
  // "the harness is waiting on you" without the harshness of a buzzer.
  attention: chime('attention', [
    { frequency: 880.0, start: 0, duration: 0.3, gain: 1 },
    { frequency: 1108.73, start: 0.13, duration: 0.3, gain: 1 },
    { frequency: 1318.51, start: 0.26, duration: 0.62, gain: 0.9 },
  ], 0.05),
  // Falling A-minor triad (A4 -> F4 -> C4): a low, subdued "that did not work".
  error: chime('error', [
    { frequency: 440.0, start: 0, duration: 0.35, gain: 1 },
    { frequency: 349.23, start: 0.16, duration: 0.35, gain: 1 },
    { frequency: 261.63, start: 0.32, duration: 0.8, gain: 0.95 },
  ], 0.05),
}

mkdirSync(OUTPUT_DIR, { recursive: true })
for (const [voice, track] of Object.entries(CHIMES)) {
  const file = join(OUTPUT_DIR, `${voice}.wav`)
  const wav = encodeWav(track)
  writeFileSync(file, wav)
  const seconds = (track.length / SAMPLE_RATE).toFixed(2)
  console.log(`${voice}.wav  ${seconds}s  ${(wav.length / 1024).toFixed(0)} KiB`)
}
