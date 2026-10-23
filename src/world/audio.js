// Rally sound, synthesised with Web Audio (no samples): a four-cylinder engine (firing-frequency sawtooth + sub
// square through a throttle-opened low-pass, plus exhaust rasp), gravel roar from the tyres, rain hiss and thunder.
// Browsers only allow audio after a user gesture, so start() is called from the first tap.
export class RallyAudio {
  constructor() {
    this.ctx = null;
    this.muted = false;
  }

  start() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
      return;
    }
    let ac;
    try {
      ac = new AudioContext();
    } catch {
      return;
    }
    this.ctx = ac;
    const master = (this.master = ac.createGain());
    master.gain.value = this.muted ? 0 : 0.7;
    master.connect(ac.destination);
    const noiseBuf = ac.createBuffer(1, ac.sampleRate * 2, ac.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    this.noiseBuf = noiseBuf;
    const noise = () => {
      const s = ac.createBufferSource();
      s.buffer = noiseBuf;
      s.loop = true;
      s.start();
      return s;
    };
    // engine
    this.saw = ac.createOscillator();
    this.saw.type = 'sawtooth';
    this.sub = ac.createOscillator();
    this.sub.type = 'square';
    this.engFilter = ac.createBiquadFilter();
    this.engFilter.type = 'lowpass';
    this.engFilter.Q.value = 3;
    this.engGain = ac.createGain();
    this.engGain.gain.value = 0;
    const subGain = ac.createGain();
    subGain.gain.value = 0.5;
    this.saw.connect(this.engFilter);
    this.sub.connect(subGain).connect(this.engFilter);
    this.engFilter.connect(this.engGain).connect(master);
    this.rasp = ac.createBiquadFilter();
    this.rasp.type = 'bandpass';
    this.rasp.Q.value = 1.2;
    this.raspGain = ac.createGain();
    this.raspGain.gain.value = 0;
    noise().connect(this.rasp).connect(this.raspGain).connect(master);
    this.saw.start();
    this.sub.start();
    // tyres on gravel
    this.gravel = ac.createBiquadFilter();
    this.gravel.type = 'bandpass';
    this.gravel.frequency.value = 700;
    this.gravel.Q.value = 0.6;
    this.gravelGain = ac.createGain();
    this.gravelGain.gain.value = 0;
    noise().connect(this.gravel).connect(this.gravelGain).connect(master);
    // rain
    const rainF = ac.createBiquadFilter();
    rainF.type = 'highpass';
    rainF.frequency.value = 1800;
    this.rainGain = ac.createGain();
    this.rainGain.gain.value = 0;
    noise().connect(rainF).connect(this.rainGain).connect(master);
  }

  setMuted(m) {
    this.muted = m;
    if (this.master) this.master.gain.setTargetAtTime(m ? 0 : 0.7, this.ctx.currentTime, 0.05);
  }

  /** Per-frame: rpm, throttle 0…1, speed m/s, slip 0…1, airborne, rain 0…1. */
  update({ rpm, throttle, speed, slip, airborne, rain }) {
    const ac = this.ctx;
    if (!ac || ac.state !== 'running') return;
    const t = ac.currentTime;
    const f = (rpm / 60) * 2; // four-stroke four: two firings per revolution
    this.saw.frequency.setTargetAtTime(f, t, 0.02);
    this.sub.frequency.setTargetAtTime(f / 2, t, 0.02);
    this.engFilter.frequency.setTargetAtTime(300 + throttle * 2200 + rpm * 0.15, t, 0.04);
    this.engGain.gain.setTargetAtTime(0.09 + throttle * 0.14, t, 0.05);
    this.rasp.frequency.setTargetAtTime(f * 3, t, 0.03);
    this.raspGain.gain.setTargetAtTime(throttle * 0.05 * (rpm / 8000), t, 0.05);
    const roll = airborne ? 0 : Math.min(1, speed / 30) * 0.12 + slip * 0.18;
    this.gravelGain.gain.setTargetAtTime(roll, t, 0.06);
    this.gravel.frequency.setTargetAtTime(500 + speed * 25, t, 0.1);
    this.rainGain.gain.setTargetAtTime(rain * 0.05, t, 0.3);
  }

  /** Thunder rumble arriving after `delay` seconds, louder when closer. */
  thunder(delay, loudness) {
    const ac = this.ctx;
    if (!ac || ac.state !== 'running') return;
    const t = ac.currentTime + delay;
    const src = ac.createBufferSource();
    src.buffer = this.noiseBuf;
    src.loop = true;
    const f = ac.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = 160 + loudness * 300;
    const g = ac.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.6 * loudness + 0.05, t + 0.08 + (1 - loudness) * 0.4);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 3.5 + loudness * 2);
    src.connect(f).connect(g).connect(this.master);
    src.start(t);
    src.stop(t + 6);
  }

  dispose() {
    this.ctx?.close().catch(() => {});
    this.ctx = null;
  }
}
