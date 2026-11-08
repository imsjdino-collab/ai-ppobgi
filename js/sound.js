// 효과음: 파일 없이 브라우저에서 직접 합성 (Web Audio)
let ctx = null, master = null, sfx = null, music = null, bgmTimer = null, step = 0;

function init() {
  if (ctx) return;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return;
  ctx = new AC();
  master = ctx.createGain(); master.gain.value = 0.7; master.connect(ctx.destination);
  sfx = ctx.createGain(); sfx.gain.value = 1; sfx.connect(master);
  music = ctx.createGain(); music.gain.value = 0.5; music.connect(master);
}

function tone(freq, dur, o = {}) {
  if (!ctx) return;
  const t = ctx.currentTime + (o.at || 0);
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.type = o.type || "square";
  osc.frequency.setValueAtTime(freq, t);
  if (o.to) osc.frequency.exponentialRampToValueAtTime(o.to, t + dur);
  const v = o.vol ?? 0.12;
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(v, t + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  osc.connect(g); g.connect(o.dest || sfx);
  osc.start(t); osc.stop(t + dur + 0.05);
}

function noise(dur, o = {}) {
  if (!ctx) return;
  const t = ctx.currentTime + (o.at || 0);
  const buf = ctx.createBuffer(1, Math.max(1, ctx.sampleRate * dur), ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  const src = ctx.createBufferSource(); src.buffer = buf;
  const f = ctx.createBiquadFilter(); f.type = "bandpass"; f.frequency.value = o.freq || 1200;
  const g = ctx.createGain();
  g.gain.setValueAtTime(o.vol ?? 0.2, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  src.connect(f); f.connect(g); g.connect(sfx);
  src.start(t); src.stop(t + dur + 0.02);
}

const N = (n) => 440 * Math.pow(2, (n - 69) / 12); // MIDI → Hz
const BGM = [60, 64, 67, 72, 67, 64, 60, 64, 57, 60, 64, 69, 64, 60, 57, 60,
             53, 57, 60, 65, 60, 57, 53, 57, 55, 59, 62, 67, 62, 59, 55, 59];

export const Sound = {
  init,
  get ready() { return !!ctx; },
  resume() { if (ctx && ctx.state === "suspended") ctx.resume(); },

  bgm(on) {
    if (!ctx) return;
    clearInterval(bgmTimer); bgmTimer = null;
    if (!on) return;
    bgmTimer = setInterval(() => {
      const n = BGM[step % BGM.length];
      tone(N(n + 12), 0.12, { type: "triangle", vol: 0.05, dest: music });
      if (step % 4 === 0) tone(N(BGM[step % BGM.length] - 12), 0.25, { type: "square", vol: 0.035, dest: music });
      step++;
    }, 140);
  },
  duck(on) { if (music) music.gain.setTargetAtTime(on ? 0.12 : 0.5, ctx.currentTime, 0.2); },

  join() { tone(N(76), 0.08, { vol: 0.1 }); tone(N(83), 0.12, { vol: 0.1, at: 0.08 }); },
  start() { [72, 76, 79, 84].forEach((n, i) => tone(N(n), 0.1, { vol: 0.12, at: i * 0.07 })); },
  move() { tone(N(84), 0.03, { type: "square", vol: 0.03 }); },
  beep(last) { tone(last ? N(88) : N(81), last ? 0.35 : 0.12, { vol: 0.15 }); },
  open() { tone(500, 0.15, { type: "sawtooth", to: 900, vol: 0.06 }); },
  drop() { tone(700, 1.2, { type: "sawtooth", to: 120, vol: 0.06 }); },
  clunk() { noise(0.12, { freq: 400, vol: 0.4 }); tone(110, 0.12, { type: "square", vol: 0.15 }); },
  rise() { tone(140, 1.0, { type: "sawtooth", to: 500, vol: 0.05 }); },
  plop() { tone(300, 0.25, { type: "sine", to: 80, vol: 0.25 }); noise(0.08, { freq: 900, vol: 0.2, at: 0.2 }); },

  drumroll(sec) {
    if (!ctx) return;
    let t = 0, gap = 0.09;
    while (t < sec) { noise(0.05, { freq: 2500, vol: 0.12 + (t / sec) * 0.2, at: t }); t += gap; gap = Math.max(0.03, gap * 0.95); }
  },
  crack() { noise(0.25, { freq: 3000, vol: 0.5 }); tone(1200, 0.2, { type: "square", to: 300, vol: 0.1 }); },

  result(rank) {
    if (!ctx) return;
    if (rank === 1) {
      [72, 76, 79, 84, 79, 84, 88].forEach((n, i) => tone(N(n), 0.16, { vol: 0.16, at: i * 0.12 }));
      [72, 76, 79, 84].forEach((n) => tone(N(n), 1.2, { type: "sawtooth", vol: 0.06, at: 0.9 }));
      for (let i = 0; i < 6; i++) {
        tone(650, 0.35, { type: "sawtooth", to: 1300, vol: 0.07, at: 2.1 + i * 0.7 });
        tone(1300, 0.35, { type: "sawtooth", to: 650, vol: 0.07, at: 2.45 + i * 0.7 });
      }
    } else if (rank === 2) {
      [72, 76, 79, 84, 88].forEach((n, i) => tone(N(n), 0.14, { vol: 0.15, at: i * 0.1 }));
      tone(N(84), 0.8, { type: "triangle", vol: 0.15, at: 0.55 });
    } else if (rank === 3) {
      [67, 72, 76, 79].forEach((n, i) => tone(N(n), 0.14, { vol: 0.14, at: i * 0.1 }));
    } else if (rank === 4) {
      [72, 76].forEach((n, i) => tone(N(n), 0.16, { vol: 0.13, at: i * 0.13 }));
    } else {
      tone(N(79), 0.25, { type: "square", to: N(55), vol: 0.14 });
      tone(N(55), 0.4, { type: "triangle", to: N(43), vol: 0.12, at: 0.3 });
    }
  },
};
