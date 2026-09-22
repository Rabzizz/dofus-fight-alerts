/** Generate the default alert sounds into data/sounds/.
 *
 *     npm run sounds
 *
 * Why synthesised and not real Dofus sounds: Dofus 3 packs its audio into 7092
 * FMOD .bank files (FSB5, Vorbis codec). FMOD strips the Vorbis headers and
 * rebuilds them at runtime from a codebook table, so extracting one needs a
 * dedicated FSB5 tool plus a ~1 MB third-party codebook blob - and the result
 * would be Ankama's audio committed into a repository. Neither is worth it for
 * a notification chime. Add your own from the app if you want the real thing.
 *
 * These are designed to be told apart with a game running over them: each has a
 * distinct shape (rising, falling, double, bell, sweep) rather than a distinct
 * pitch alone, because pitch is the first thing you stop noticing.
 */

import { mkdir, writeFile } from "node:fs/promises";

const RATE = 44100;

/** 16-bit mono PCM WAV around a Float32Array of samples in [-1, 1]. */
function wav(samples) {
  const data = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) {
    const clipped = Math.max(-1, Math.min(1, samples[i]));
    data.writeInt16LE(Math.round(clipped * 32767), i * 2);
  }
  const head = Buffer.alloc(44);
  head.write("RIFF", 0);
  head.writeUInt32LE(36 + data.length, 4);
  head.write("WAVEfmt ", 8);
  head.writeUInt32LE(16, 16);      // fmt chunk size
  head.writeUInt16LE(1, 20);       // PCM
  head.writeUInt16LE(1, 22);       // mono
  head.writeUInt32LE(RATE, 24);
  head.writeUInt32LE(RATE * 2, 28); // byte rate
  head.writeUInt16LE(2, 32);       // block align
  head.writeUInt16LE(16, 34);
  head.write("data", 36);
  head.writeUInt32LE(data.length, 40);
  return Buffer.concat([head, data]);
}

const buffer = (seconds) => new Float32Array(Math.ceil(seconds * RATE));

/** Percussive envelope: fast attack, exponential decay. */
const pluck = (t, dur, attack = 0.005) =>
  t < attack ? t / attack : Math.exp(-3.5 * (t - attack) / (dur - attack));

/** Add a note. `partials` are [harmonic, gain] pairs - a couple of them is the
 *  difference between a chime and a test beep. */
function note(out, { at, dur, freq, gain = 0.5, partials = [[1, 1], [2, 0.35], [3, 0.12]], bend = 1, attack = 0.005 }) {
  const start = Math.floor(at * RATE);
  const n = Math.floor(dur * RATE);
  for (let i = 0; i < n && start + i < out.length; i++) {
    const t = i / RATE;
    const env = pluck(t, dur, attack);
    // A small pitch glide makes a sound feel intentional rather than electronic.
    const f = freq * (1 + (bend - 1) * (t / dur));
    let s = 0;
    for (const [h, g] of partials) s += g * Math.sin(2 * Math.PI * f * h * t);
    out[start + i] += (s / partials.length) * env * gain;
  }
}

/** Filtered noise burst, for the percussive ones. */
function noise(out, { at, dur, gain = 0.2, cutoff = 0.25 }) {
  const start = Math.floor(at * RATE);
  const n = Math.floor(dur * RATE);
  let last = 0;
  for (let i = 0; i < n && start + i < out.length; i++) {
    const white = Math.random() * 2 - 1;
    last += cutoff * (white - last); // one-pole low pass
    out[start + i] += last * pluck(i / RATE, dur) * gain;
  }
}

/** Gentle fade at both ends so nothing clicks. */
function finish(out) {
  const edge = Math.floor(0.004 * RATE);
  for (let i = 0; i < edge; i++) {
    out[i] *= i / edge;
    out[out.length - 1 - i] *= i / edge;
  }
  let peak = 0;
  for (const s of out) peak = Math.max(peak, Math.abs(s));
  if (peak > 0) for (let i = 0; i < out.length; i++) out[i] = (out[i] / peak) * 0.89;
  return out;
}

const SOUNDS = {
  // Something appeared: two notes going up.
  "gain-montant.wav": () => {
    const o = buffer(0.7);
    note(o, { at: 0, dur: 0.22, freq: 587.33 });            // D5
    note(o, { at: 0.11, dur: 0.5, freq: 880.0, gain: 0.55 }); // A5
    return finish(o);
  },
  // Something went away: the same idea going down.
  "perte-descendante.wav": () => {
    const o = buffer(0.7);
    note(o, { at: 0, dur: 0.22, freq: 783.99 });            // G5
    note(o, { at: 0.11, dur: 0.5, freq: 493.88, gain: 0.55 }); // B4
    return finish(o);
  },
  // Urgent: low, doubled, slightly detuned so it beats.
  "alerte-grave.wav": () => {
    const o = buffer(0.75);
    for (const at of [0, 0.17]) {
      note(o, { at, dur: 0.3, freq: 146.83, gain: 0.6, partials: [[1, 1], [2, 0.6], [3, 0.3], [4.02, 0.2]] });
      noise(o, { at, dur: 0.09, gain: 0.25, cutoff: 0.12 });
    }
    return finish(o);
  },
  // A bell, for the one rule that really matters.
  "cloche.wav": () => {
    const o = buffer(1.8);
    // Inharmonic partials are what makes a bell a bell rather than an organ.
    note(o, { at: 0, dur: 1.75, freq: 659.25, gain: 0.6,
              partials: [[1, 1], [2.01, 0.5], [2.76, 0.34], [4.07, 0.18], [5.43, 0.1]] });
    return finish(o);
  },
  // Three rising notes: good for "this is the thing you were waiting for".
  "carillon.wav": () => {
    const o = buffer(1.1);
    note(o, { at: 0.0, dur: 0.3, freq: 523.25 });  // C5
    note(o, { at: 0.1, dur: 0.3, freq: 659.25 });  // E5
    note(o, { at: 0.2, dur: 0.85, freq: 783.99, gain: 0.55 }); // G5
    return finish(o);
  },
  // Short and dry: for a rule that fires often.
  "clic.wav": () => {
    const o = buffer(0.16);
    note(o, { at: 0, dur: 0.1, freq: 1046.5, gain: 0.5, partials: [[1, 1], [2, 0.25]] });
    noise(o, { at: 0, dur: 0.035, gain: 0.35, cutoff: 0.6 });
    return finish(o);
  },
  // A sonar ping: long tail, carries over game noise without being harsh.
  "sonar.wav": () => {
    const o = buffer(1.4);
    note(o, { at: 0, dur: 1.35, freq: 990, gain: 0.55, bend: 0.97,
              partials: [[1, 1], [1.5, 0.2]], attack: 0.012 });
    return finish(o);
  },
  // Downward sweep: unmistakably "bad thing happened".
  "chute.wav": () => {
    const o = buffer(0.85);
    note(o, { at: 0, dur: 0.8, freq: 700, gain: 0.6, bend: 0.32,
              partials: [[1, 1], [2, 0.4], [3, 0.15]], attack: 0.008 });
    return finish(o);
  },
};

const dir = new URL("../data/sounds/", import.meta.url);
await mkdir(dir, { recursive: true });
for (const [name, make] of Object.entries(SOUNDS)) {
  const buf = wav(make());
  await writeFile(new URL(name, dir), buf);
  console.log(`  ${name.padEnd(26)} ${(buf.length / 1024).toFixed(0)} KB`);
}
console.log(`${Object.keys(SOUNDS).length} sounds written to data/sounds/`);
