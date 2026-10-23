// Synthesised puzzle sounds (Web Audio, no files): snap click, reject buzz, in-range tick, level fanfare.
const KEY = 'yaris-puzzle-sound';
let ctx = null;
let muted = (() => {
  try {
    return localStorage.getItem(KEY) === 'off';
  } catch {
    return false;
  }
})();

function audio() {
  if (muted) return null;
  try {
    ctx ??= new AudioContext();
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    return ctx.state === 'running' ? ctx : null;
  } catch {
    return null;
  }
}

function tone(ac, { type = 'sine', from, to = from, start = 0, dur, gain = 0.2 }) {
  const t = ac.currentTime + start;
  const o = ac.createOscillator();
  const g = ac.createGain();
  o.type = type;
  o.frequency.setValueAtTime(from, t);
  o.frequency.exponentialRampToValueAtTime(to, t + dur);
  g.gain.setValueAtTime(gain, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(ac.destination);
  o.start(t);
  o.stop(t + dur + 0.02);
}

function noise(ac, { start = 0, dur, gain = 0.2, freq = 3000 }) {
  const t = ac.currentTime + start;
  const buf = ac.createBuffer(1, Math.ceil(ac.sampleRate * dur), ac.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / d.length) ** 3;
  const src = ac.createBufferSource();
  src.buffer = buf;
  const f = ac.createBiquadFilter();
  f.type = 'bandpass';
  f.frequency.value = freq;
  const g = ac.createGain();
  g.gain.value = gain;
  src.connect(f).connect(g).connect(ac.destination);
  src.start(t);
}

export const sound = {
  get muted() {
    return muted;
  },
  setMuted(m) {
    muted = m;
    try {
      localStorage.setItem(KEY, m ? 'off' : 'on');
    } catch {
      /* not kept */
    }
  },
  /**
   * Create the (suspended) audio context ahead of time, outside any interaction: constructing one can take over
   * 100 ms on phones, which would otherwise land in the first tap. A later gesture only has to resume it.
   */
  prepare() {
    if (muted || ctx) return;
    try {
      ctx = new AudioContext();
    } catch {
      /* no audio */
    }
  },
  /** Call from a user gesture so later sounds are allowed to play. */
  unlock() {
    audio();
  },
  snap() {
    const ac = audio();
    if (!ac) return;
    noise(ac, { dur: 0.035, gain: 0.35, freq: 4200 });
    tone(ac, { type: 'triangle', from: 220, to: 70, dur: 0.14, gain: 0.35 });
    noise(ac, { start: 0.06, dur: 0.03, gain: 0.2, freq: 2600 });
  },
  reject() {
    const ac = audio();
    if (!ac) return;
    tone(ac, { type: 'square', from: 150, to: 110, dur: 0.11, gain: 0.06 });
    tone(ac, { type: 'square', from: 130, to: 90, start: 0.13, dur: 0.13, gain: 0.06 });
  },
  tick() {
    const ac = audio();
    if (ac) tone(ac, { from: 1400, to: 1800, dur: 0.05, gain: 0.05 });
  },
  win() {
    const ac = audio();
    if (!ac) return;
    [523, 659, 784, 1047].forEach((f, i) => tone(ac, { type: 'triangle', from: f, start: i * 0.11, dur: 0.35, gain: 0.12 }));
  },
};
