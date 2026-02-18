const TRACK_BINDINGS = {
    t1: "bright",
    t2: "bright",
    t3: "softPad",
    t4: "pluck",
    // drum tracks are added dynamically in setup()
  };
  
  const INSTRUMENTS = {
    bright: {
      kind: "tone",
      wave: "triangle",
      attack: 0.01,
      decay: 0.1,
      sustain: 0.7,
      release: 0.2,
      gain: 0.2,
    },
  
    kick: {
      kind: "kick",
      wave: "triangle",
      attack: 0.001,
      decay: 0.15,
      sustain: 0.0,
      release: 0.05,
      gain: 2,
    },
  
    snare: {
      kind: "tone",
      wave: "square",
      attack: 0.001,
      decay: 0.09,
      sustain: 0.0,
      release: 0.05,
      gain: 0.35,
      baseFreq: 200,
    },

    hihatClosed: {
      kind: "tone",
      wave: "square",
      attack: 0.001,
      decay: 0.04,
      sustain: 0.0,
      release: 0.02,
      gain: 0.35,
      baseFreq: 800,
    },
  
    hihatOpen: {
      kind: "tone",
      wave: "square",
      attack: 0.001,
      decay: 0.18,
      sustain: 0.0,
      release: 0.12,
      gain: 0.3,
      baseFreq: 6500,
    },
  
    softPad: {
      kind: "tone",
      wave: "triangle",
      attack: 0.6,
      decay: 1.2,
      sustain: 0.85,
      release: 1.8,
      gain: 0.4,
    },
  
    pluck: {
      kind: "tone",
      wave: "sine",
      attack: 0.02,
      decay: 0.15,
      sustain: 0.9,
      release: 0.35,
      gain: 0.8,
      glide: 0.12,
      mono: true,
    },
  };
  
  const VOICES_PER_INSTR = 8;
  
  const DRUM_LABEL_TO_INSTR = {
    kick: "kick",
    snare: "snare",
    clap: "snare",
    hihat_closed: "hihatClosed",
    hihat_open: "hihatOpen",
    hihat_pedal: "hihatClosed",
  };
  
  const GM_DRUM_PITCH_TO_LABEL = {
    35: "kick",
    36: "kick",
    38: "snare",
    40: "snare",
    39: "clap",
    42: "hihat_closed",
    44: "hihat_pedal",
    46: "hihat_open",
  };

// ==============================
// 2.5) LOOP RANGE (edit these)
// ==============================
// Inclusive step range for playback loop. Use null for "end of song".
const LOOP_START_STEP = 60;
const LOOP_END_STEP = 510;
  
  // ==============================
  // 3) STATE
  // ==============================
  
  function fmtBool(b) {
    return b ? "ON" : "off";
  }
  
let instrumentPools = {};
let trackState = {};
let stepMs = 0;
let globalStep = 0;
let masterClockRunning = false;
let loopStartStep = 0;
let loopEndStep = 0;
let lastTickTime = 0;
let arcSegmentsByTrack = {};
let hasStarted = false;
  
  
  
  // ==============================
  // 4) UTILS
  // ==============================
  
  function midiToFreq440(m) {
    return 440 * Math.pow(2, (m - 69) / 12);
  }
  
  function clamp01(x) {
    return Math.max(0, Math.min(1, x));
  }
  
  function glideVoiceFreq(v, target, glideSec) {
    if (v.lastFreq == null) {
      v.osc.freq(target);
    } else {
      v.osc.freq(target, glideSec);
    }
    v.lastFreq = target;
  }
  
  function toggleTrackMuteByNumber(n) {
    const tr = SEQ_DATA.tracks[n - 1];
    if (tr) tr.mute = !tr.mute;
  }
  
  function splitDrumTracks() {
    const rebuilt = [];
  
    for (const tr of SEQ_DATA.tracks) {
      const steps = tr.pattern?.steps || [];
      const lengthSteps = Math.max(1, steps.length || tr.pattern?.lengthSteps || 1);
      if (!steps.length) {
        tr.pattern = tr.pattern || {};
        tr.pattern.steps = steps;
        tr.pattern.lengthSteps = lengthSteps;
        rebuilt.push(tr);
        continue;
      }
  
      if (tr.channel !== 9) {
        rebuilt.push(tr);
        continue;
      }

      const drumStepsByInstr = {};
      for (const instrId of Object.values(DRUM_LABEL_TO_INSTR)) {
        drumStepsByInstr[instrId] = steps.map(() => []);
      }

      let hasAny = false;

      const normalizeDrumLabel = (note) => {
        if (!note) return null;
        if (DRUM_LABEL_TO_INSTR[note]) return note;
        if (typeof note === "number") return GM_DRUM_PITCH_TO_LABEL[note] ?? null;
        if (typeof note === "string" && note.startsWith("drum_")) {
          const pitch = Number(note.slice(5));
          if (!Number.isNaN(pitch)) return GM_DRUM_PITCH_TO_LABEL[pitch] ?? null;
        }
        return null;
      };

      for (let i = 0; i < steps.length; i++) {
        for (const ev of steps[i]) {
          const label = normalizeDrumLabel(ev?.note);
          if (!label) continue;
          const instrId = DRUM_LABEL_TO_INSTR[label];
          if (!instrId) continue;
          drumStepsByInstr[instrId][i].push({ ...ev, note: label });
          hasAny = true;
        }
      }

      const makeDrumTrack = (suffix, instrId, label) => {
        const id = `${tr.id}_${suffix}`;
        const stepsForInstr = drumStepsByInstr[instrId];
        TRACK_BINDINGS[id] = instrId;
        rebuilt.push({
          id,
          name: `${label}`,
          channel: tr.channel,
          mute: false,
          solo: false,
          pattern: {
            lengthSteps,
            steps: stepsForInstr,
          },
        });
      };

      makeDrumTrack("kick", "kick", "Kick");
      makeDrumTrack("snare", "snare", "Snare");
      makeDrumTrack("hhc", "hihatClosed", "Hihat Closed");
      makeDrumTrack("hho", "hihatOpen", "Hihat Open");
    }
  
    SEQ_DATA.tracks = rebuilt;
  }

function getMaxPatternLength() {
  let maxLen = 1;
  for (const tr of SEQ_DATA.tracks) {
    const len = tr.pattern?.lengthSteps || tr.pattern?.steps?.length || 1;
    if (len > maxLen) maxLen = len;
  }
  return maxLen;
}

function clampLoopRange(maxLen) {
  const start = Math.max(0, Math.min(LOOP_START_STEP, maxLen - 1));
  const end =
    LOOP_END_STEP == null
      ? maxLen - 1
      : Math.max(start, Math.min(LOOP_END_STEP, maxLen - 1));
  return { start, end };
}

function getLoopLength() {
  return Math.max(1, loopEndStep - loopStartStep + 1);
}

function stepToAngle(step, progress = 0) {
  const loopLen = getLoopLength();
  const idx = (step - loopStartStep + loopLen) % loopLen;
  const pct = (idx + progress) / loopLen;
  return pct * TWO_PI - HALF_PI;
}

function getTrackRadius(trackIndex, totalTracks, maxRadius) {
  if (totalTracks <= 1) return maxRadius;
  const step = maxRadius / (totalTracks - 1);
  return maxRadius - trackIndex * step;
}

const PITCH_MIN = 36;
const PITCH_MAX = 96;
const NOTE_OFFSET_RANGE = 2;

function getNoteOffsetNorm(ev) {
  if (ev?.note != null) return 0;
  if (typeof ev?.pitch !== "number") return 0;
  const t = clamp01((ev.pitch - PITCH_MIN) / (PITCH_MAX - PITCH_MIN));
  return (t * 2 - 1) * NOTE_OFFSET_RANGE;
}

function addArcSegment(trackId, durationSteps, noteOffsetNorm) {
  const loopLen = getLoopLength();
  const span = Math.min(durationSteps, loopLen) / loopLen * TWO_PI;
  const startAngle = stepToAngle(globalStep, 0);
  const endAngle = startAngle + span;
  if (!arcSegmentsByTrack[trackId]) arcSegmentsByTrack[trackId] = [];
  arcSegmentsByTrack[trackId].push({ startAngle, endAngle, noteOffsetNorm });
  if (arcSegmentsByTrack[trackId].length > 3000) {
    arcSegmentsByTrack[trackId].shift();
  }
}
  
  // ==============================
  // 5) SETUP
  // ==============================
  
  function setup() {
  createCanvas(windowWidth, windowHeight);
  pixelDensity(1);
    textFont("monospace");
  colorMode(HSB, 360, 100, 100, 100);
  noFill();
  
    for (const id in INSTRUMENTS) {
      const cfg = INSTRUMENTS[id];
  
      const gainNode = new p5.Gain();
      gainNode.amp(cfg.gain);
      gainNode.disconnect();
      gainNode.connect();
  
      const pool = {
        params: cfg,
        gainNode,
        voices: [],
        monoVoice: null,
        voiceIndex: 0,
      };
  
      const count = cfg.mono ? 1 : VOICES_PER_INSTR;
  
      for (let i = 0; i < count; i++) {
        const osc = new p5.Oscillator(cfg.wave);
        const env = new p5.Envelope();
        env.setADSR(cfg.attack, cfg.decay, cfg.sustain, cfg.release);
  
        osc.amp(env);
        osc.disconnect();
        osc.connect(gainNode);
        osc.start();
  
        pool.voices.push({ osc, env, lastFreq: null });
      }
  
      if (cfg.mono) pool.monoVoice = pool.voices[0];
      instrumentPools[id] = pool;
    }
  
    splitDrumTracks();

  const loopRange = clampLoopRange(getMaxPatternLength());
  loopStartStep = loopRange.start;
  loopEndStep = loopRange.end;
  globalStep = loopStartStep;
  lastTickTime = millis();
  
    for (const tr of SEQ_DATA.tracks) {
      trackState[tr.id] = { stepPos: 0, heldUntilStep: -1, isHeld: false };
    arcSegmentsByTrack[tr.id] = [];
    }
  
    const { bpm, stepsPerBeat } = SEQ_DATA.transport;
    stepMs = ((60 / bpm) * 1000) / stepsPerBeat;
  
    setInterval(tick, stepMs);
  }

function windowResized() {
  resizeCanvas(windowWidth, windowHeight);
}
  
  function stopMasterClock() {
    masterClockRunning = false;
  
    for (const tr of SEQ_DATA.tracks) {
      const instrId = TRACK_BINDINGS[tr.id];
      if (instrId === "pluck") {
        const st = trackState[tr.id];
        st.isHeld = false;
        st.heldUntilStep = -1;
        const pool = instrumentPools[instrId];
        if (pool?.monoVoice) pool.monoVoice.env.triggerRelease();
      }
    }
  }
  
  function toggleMasterClock() {
    if (masterClockRunning) {
      stopMasterClock();
    } else {
      masterClockRunning = true;
    if (!hasStarted) hasStarted = true;
    }
  }
  
  function mousePressed() {
    userStartAudio();
    toggleMasterClock();
  }
  
  function touchStarted() {
    userStartAudio();
    toggleMasterClock();
    return false;
  }
  
  // ==============================
  // 6) DRAW
  // ==============================
  
  function draw() {
  background(240);

  const cx = width / 2;
  const cy = height / 2;
  const maxRadius = Math.min(width, height) * 0.4;
  const totalTracks = SEQ_DATA.tracks.length;
  const trackSpacing = totalTracks > 1 ? maxRadius / (totalTracks - 1) : 0;

  const now = millis();
  const stepProgress = masterClockRunning
    ? clamp01((now - lastTickTime) / stepMs)
    : 0;
  const angle = stepToAngle(globalStep, stepProgress);


  // Draw accumulated note arcs
  
  for (let i = 0; i < totalTracks; i++) {
    const tr = SEQ_DATA.tracks[i];
    const baseR = getTrackRadius(i, totalTracks, maxRadius);
    const hueMin = 0;
    const hueMax = 60;
    const t = totalTracks <= 1 ? 0 : i / (totalTracks - 1);
    const hue = hueMin + t * (hueMax - hueMin);
    stroke(hue, 80, 100, 80);
    strokeWeight(maxRadius/totalTracks);
    const segments = arcSegmentsByTrack[tr.id] || [];
    for (const seg of segments) {
      const r = Math.max(2, baseR + (seg.noteOffsetNorm ?? 0) * trackSpacing);
      const startNorm = (seg.startAngle % TWO_PI + TWO_PI) % TWO_PI;
      const endNormRaw = seg.endAngle - seg.startAngle;
      if (endNormRaw >= TWO_PI) {
        arc(cx, cy, r * 2, r * 2, 0, TWO_PI);
        continue;
      }
      const endNorm = startNorm + endNormRaw;
      if (endNorm <= TWO_PI) {
        arc(cx, cy, r * 2, r * 2, startNorm, endNorm, CHORD);
      } else {
        // arc(cx, cy, r * 2, r * 2, startNorm, TWO_PI);
        // arc(cx, cy, r * 2, r * 2, 0, endNorm - TWO_PI);
      }
    }
  }

  // Rotating radial line with points
  stroke(100, 100, 0, 60);
  strokeWeight(2);
  const x2 = cx + Math.cos(angle) * maxRadius;
  const y2 = cy + Math.sin(angle) * maxRadius;
  line(cx, cy, x2, y2);

  if (!hasStarted) {
    noStroke();
    fill(0, 0, 0, 70);
    textAlign(CENTER, TOP);
    textSize(Math.max(14, maxRadius * 0.06));
    text("tap to start", cx, cy + Math.max(16, maxRadius * 0.2));
  }
  }
  
  
  // ==============================
  // 7) INPUT
  // ==============================
  
  function keyPressed() {
    const k = key.toUpperCase();
  
    if (k >= "1" && k <= "9") toggleTrackMuteByNumber(+k);
  
    if (k === "M") toggleMasterClock();
  }
  
  
  function tick() {
    if (!masterClockRunning) return;
  lastTickTime = millis();
  
    // 1) Release pluck notes whose duration ended (even if muted)
    for (const tr of SEQ_DATA.tracks) {
      const instrId = TRACK_BINDINGS[tr.id];
      if (instrId !== "pluck") continue;
  
      const st = trackState[tr.id];
      if (st.isHeld && globalStep >= st.heldUntilStep) {
        const pool = instrumentPools[instrId];
        if (pool?.monoVoice) pool.monoVoice.env.triggerRelease();
        st.isHeld = false;
      }
    }
  
  // 2) Process ALL tracks for timing (globalStep drives each track)
    for (const tr of SEQ_DATA.tracks) {
      const st = trackState[tr.id];
      const pat = tr.pattern;
  
      // Determine local step for THIS tick (before increment)
    const stepIdx = (globalStep % pat.lengthSteps + pat.lengthSteps) % pat.lengthSteps;
      const events = (pat.steps && pat.steps[stepIdx]) ? pat.steps[stepIdx] : [];
  
      // If muted: don't trigger, but keep time.
      // Also: if this track is pluck and it's currently holding, kill it when muted.
      if (tr.mute) {
        if (TRACK_BINDINGS[tr.id] === "pluck" && st.isHeld) {
          const pool = instrumentPools["pluck"];
          if (pool?.monoVoice) pool.monoVoice.env.triggerRelease();
          st.isHeld = false;
          st.heldUntilStep = -1;
        }
      } else {
    // Not muted → trigger events
    for (const ev of events) triggerEvent(tr.id, ev);
      }
  
    // Keep per-track state in sync for display/debug
    st.stepPos = stepIdx;
    }
  
    // 3) Advance global step
  if (globalStep >= loopEndStep) {
    globalStep = loopStartStep;
  } else {
    globalStep++;
  }
  }
  
  
  
  // ==============================
  // 9) TRIGGER
  // ==============================
  
  function triggerEvent(trackId, ev) {
    const instrId = TRACK_BINDINGS[trackId];
    const pool = instrumentPools[instrId];
    if (!pool) return;
  
    const vel = clamp01(ev.velocity ?? 1);
    const durSteps = Math.max(1, ev.duration ?? 1);

  addArcSegment(trackId, durSteps, getNoteOffsetNorm(ev));
  
    if (instrId === "pluck") {
      const v = pool.monoVoice;
      glideVoiceFreq(v, midiToFreq440(ev.pitch), pool.params.glide);
  
      if (!trackState[trackId].isHeld) {
        v.env.setRange(vel, 0);
        v.env.triggerAttack();
        trackState[trackId].isHeld = true;
      }
  
      trackState[trackId].heldUntilStep = globalStep + durSteps;
      return;
    }
  
    const v = pool.voices[pool.voiceIndex];
    pool.voiceIndex = (pool.voiceIndex + 1) % pool.voices.length;
  
    if (ev.note) {
      if (ev.note === "kick") {
        v.osc.freq(150);
        v.osc.freq(50, 0.08);
      } else if (ev.note.startsWith("hihat")) {
        const base = pool.params.baseFreq ?? 7000;
        v.osc.freq(base);
      } else {
        const base = pool.params.baseFreq ?? 300;
        v.osc.freq(base);
      }
    } else {
      v.osc.freq(midiToFreq440(ev.pitch));
    }
  
    v.env.setRange(vel, 0);
    v.env.triggerAttack();
    setTimeout(() => v.env.triggerRelease(), durSteps * stepMs * 0.9);
  }
  