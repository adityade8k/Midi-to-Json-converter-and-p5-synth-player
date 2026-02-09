const TRACK_BINDINGS = {
    t1: "pluck",
    t2: "bright",
    t3: "softPad",
    t4: "kick",
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
      gain: 2.5,
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
      baseFreq: 8000,
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
  
  let masterPan; // p5.Panner3D
  
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
  
  // ==============================
  // 5) SETUP
  // ==============================
  
  function setup() {
    createCanvas(850, 420);
    textFont("monospace");
    noStroke();
  
    masterPan = new p5.Panner3D();
    masterPan.connect();
  
    for (const id in INSTRUMENTS) {
      const cfg = INSTRUMENTS[id];
  
      const gainNode = new p5.Gain();
      gainNode.amp(cfg.gain);
      gainNode.disconnect();
      gainNode.connect(masterPan);
  
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
  
    for (const tr of SEQ_DATA.tracks) {
      trackState[tr.id] = { stepPos: 0, heldUntilStep: -1, isHeld: false };
    }
  
    const { bpm, stepsPerBeat } = SEQ_DATA.transport;
    stepMs = ((60 / bpm) * 1000) / stepsPerBeat;
  
    setInterval(tick, stepMs);
  }
  
  function mousePressed() {
    userStartAudio();
  }
  
  // ==============================
  // 6) DRAW + PAN CONTROL
  // ==============================
  
  function draw() {
    background(0);
    fill("lime");
    textSize(14);
  
    // mouseX (0..width) -> pan (-1..+1)
    const panVal = map(constrain(mouseX, 0, width), 0, width, -1, 1);
    // p5.Panner3D uses .set(x,y,z) (NOT setPosition)
    if (masterPan) masterPan.set(panVal, 0, 0.5);
  
    let y = 24;
  
    text("Step Sequencer (JSON patterns + external instruments)", 18, y);
    y += 18;
  
    const t = SEQ_DATA.transport;
    text(
      `BPM=${t.bpm}  stepsPerBeat=${t.stepsPerBeat}  stepMs=${stepMs.toFixed(1)}`,
      18,
      y
    );
    y += 18;

    const instrNames = Object.keys(INSTRUMENTS).join(", ");
    text(`Instruments: ${instrNames}`, 18, y);
    y += 18;
  
    text(
      `GLOBAL STEP: ${globalStep}  [${masterClockRunning ? "RUNNING" : "STOPPED"}]`,
      18,
      y
    );
    y += 18;
  
    text("Click to enable audio | M start/stop | 1..9 mute | mouseX pan", 18, y);
    y += 24;
  
    // Track table header
    text("Tracks:", 18, y);
    y += 18;
  
    // Track rows
    for (let i = 0; i < SEQ_DATA.tracks.length; i++) {
      const tr = SEQ_DATA.tracks[i];
      if (tr.id.endsWith("_hhc") || tr.id.endsWith("_hho")) continue;
      const idxNum = i + 1;
  
      const bind = TRACK_BINDINGS[tr.id] || "(unbound)";
      const st = trackState[tr.id] || { stepPos: 0, heldUntilStep: -1, isHeld: false };
      const pat = tr.pattern || {};
      const len = pat.lengthSteps || (pat.steps ? pat.steps.length : 0);
  
      // pluck-specific extra debug
      let extra = "";
      if (bind === "pluck") {
        extra = `  held=${fmtBool(st.isHeld)}  heldUntil=${st.heldUntilStep}`;
      }
  
      text(
        `${idxNum}:${tr.id} "${tr.name}"  chan=${tr.channel}  instr=${bind}  mute=${fmtBool(tr.mute)}  stepPos=${st.stepPos}/${len}${extra}`,
        18,
        y
      );
      y += 18;
  
      // Show a compact view of current step events (optional but useful)
      const stepsArr = pat.steps || [];
      const localStep = (st.stepPos || 0) % (len || 1);
      const evs = stepsArr[localStep] || [];
  
      // Print current step events (trim if too many)
      const evText =
        evs.length === 0
          ? "[]"
          : "[" +
            evs
              .slice(0, 3)
              .map((e) => {
                if (e.note) {
                  return `${e.note} v=${(e.velocity ?? 1).toFixed(2)} d=${e.duration ?? 1}`;
                }
                return `p=${e.pitch} v=${(e.velocity ?? 1).toFixed(2)} d=${e.duration ?? 1}`;
              })
              .join(" | ") +
            (evs.length > 3 ? " | ..." : "") +
            "]";
  
      text(`    step=${localStep} events=${evText}`, 18, y);
      y += 18;
    }
  
    y += 10;
    text(`Master pan: ${panVal.toFixed(2)} (mouseX)`, 18, y);
  }
  
  
  // ==============================
  // 7) INPUT
  // ==============================
  
  function keyPressed() {
    const k = key.toUpperCase();
  
    if (k >= "1" && k <= "9") toggleTrackMuteByNumber(+k);
  
    if (k === "M") {
      masterClockRunning = !masterClockRunning;
  
      // When stopping, release held pluck so it doesn't hang
      if (!masterClockRunning) {
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
    }
  }
  
  
  function tick() {
    if (!masterClockRunning) return;
  
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
  
    // 2) Process ALL tracks for timing (advance stepPos no matter what)
    for (const tr of SEQ_DATA.tracks) {
      const st = trackState[tr.id];
      const pat = tr.pattern;
  
      // Determine local step for THIS tick (before increment)
      const stepIdx = st.stepPos;
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
  
      // Always advance step position to stay in sync with master
      st.stepPos = (st.stepPos + 1) % pat.lengthSteps;
    }
  
    // 3) Advance global step
    globalStep++;
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
  