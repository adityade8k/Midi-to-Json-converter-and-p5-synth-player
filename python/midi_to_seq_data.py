#!/usr/bin/env python3
"""
midi_to_seq_data.py

Converts a .mid into the EXACT JSON shape your p5.js sketch expects:

{
  "version": 1,
  "transport": { "bpm": <float>, "stepsPerBeat": <int>, "beatsPerBar": <int>, "bars": <int> },
  "tracks": [
    {
      "id": "t1",                 # IMPORTANT: sequential t1, t2, t3... (matches your TRACK_BINDINGS style)
      "name": "...",
      "channel": <0..15>,
      "mute": false,
      "solo": false,
      "pattern": {
        "lengthSteps": <int>,
        "steps": [ [ {pitch/velocity/duration} or {note/velocity/duration} ], [], ... ]
      }
    }
  ]
}

Notes:
- Step-grid is derived from MIDI ticks_per_beat and stepsPerBeat.
- Events are stored as "note-ons that START at this step".
- Overlaps are supported via "duration" in steps.
- Uses FIRST tempo found (ignores later tempo changes).
- Uses FIRST time_signature found (defaults to 4/4 if none).
- Default drum handling is "gm_labels" for channel 9 to emit multiple drum names.
  (Use kick_only if your JS only supports a single kick instrument.)

Install:
  pip install mido

Usage:
  python midi_to_seq_data.py input.mid output.json --steps-per-beat 4
"""

import argparse
import json
import math
from dataclasses import dataclass
from typing import Any, Dict, List, Optional, Tuple

import mido


# ------------ Drum helpers ------------
# GM drum note -> label used in JSON for multi-drum support
GM_DRUM_LABELS = {
    35: "kick",  # Acoustic Bass Drum
    36: "kick",  # Bass Drum 1
    37: "snare_side",  # Side Stick
    38: "snare",  # Acoustic Snare
    39: "clap",  # Hand Clap
    40: "snare",  # Electric Snare
    41: "tom_low_floor",
    42: "hihat_closed",
    43: "tom_high_floor",
    44: "hihat_pedal",
    45: "tom_low",
    46: "hihat_open",
    47: "tom_mid",
    48: "tom_mid_high",
    49: "crash",
    50: "tom_high",
    51: "ride",
    52: "china",
    53: "ride_bell",
    54: "tambourine",
    55: "splash",
    56: "cowbell",
    57: "crash_2",
    58: "vibraslap",
    59: "ride_2",
    60: "bongo_high",
    61: "bongo_low",
    62: "conga_mute",
    63: "conga_open",
    64: "conga_low",
    65: "timbale_high",
    66: "timbale_low",
    67: "agogo_high",
    68: "agogo_low",
    69: "cabasa",
    70: "maracas",
    71: "whistle_short",
    72: "whistle_long",
    73: "guiro_short",
    74: "guiro_long",
    75: "claves",
    76: "woodblock_high",
    77: "woodblock_low",
    78: "cuica_mute",
    79: "cuica_open",
    80: "triangle_mute",
    81: "triangle_open",
}


@dataclass
class NoteSpan:
    start_tick: int
    end_tick: int
    pitch: int
    velocity: int
    channel: int


def first_tempo_us_per_beat(mid: mido.MidiFile, default: int = 500000) -> int:
    for track in mid.tracks:
        abs_tick = 0
        for msg in track:
            abs_tick += msg.time
            if msg.type == "set_tempo":
                return int(msg.tempo)
    return default  # 120 BPM


def first_time_signature(mid: mido.MidiFile, default_num: int = 4, default_den: int = 4) -> Tuple[int, int]:
    for track in mid.tracks:
        abs_tick = 0
        for msg in track:
            abs_tick += msg.time
            if msg.type == "time_signature":
                return int(msg.numerator), int(msg.denominator)
    return default_num, default_den


def midi_length_ticks(mid: mido.MidiFile) -> int:
    max_tick = 0
    for track in mid.tracks:
        abs_tick = 0
        for msg in track:
            abs_tick += msg.time
            if abs_tick > max_tick:
                max_tick = abs_tick
    return max_tick


def collect_note_spans_by_channel(mid: mido.MidiFile) -> Dict[int, List[NoteSpan]]:
    """
    Parse MIDI to note spans grouped by channel.
    Handles:
      - note_on velocity>0 => start
      - note_off OR note_on velocity=0 => end
    Supports overlaps of same pitch by stacking (LIFO).
    """
    by_ch: Dict[int, List[NoteSpan]] = {}
    active: Dict[Tuple[int, int], List[Tuple[int, int]]] = {}  # (ch,pitch) -> [(start_tick, vel), ...]

    for track in mid.tracks:
        abs_tick = 0
        for msg in track:
            abs_tick += msg.time

            if msg.type == "note_on" and msg.velocity > 0:
                key = (msg.channel, msg.note)
                active.setdefault(key, []).append((abs_tick, msg.velocity))

            elif msg.type == "note_off" or (msg.type == "note_on" and msg.velocity == 0):
                key = (msg.channel, msg.note)
                stack = active.get(key)
                if stack:
                    start_tick, vel = stack.pop()
                    by_ch.setdefault(msg.channel, []).append(
                        NoteSpan(
                            start_tick=start_tick,
                            end_tick=abs_tick,
                            pitch=msg.note,
                            velocity=vel,
                            channel=msg.channel,
                        )
                    )

    # Close hanging notes at EOF
    end_tick = midi_length_ticks(mid)
    for (ch, pitch), stack in active.items():
        while stack:
            start_tick, vel = stack.pop()
            by_ch.setdefault(ch, []).append(
                NoteSpan(
                    start_tick=start_tick,
                    end_tick=end_tick,
                    pitch=pitch,
                    velocity=vel,
                    channel=ch,
                )
            )

    return by_ch


def clamp01(x: float) -> float:
    return max(0.0, min(1.0, x))


def tick_to_step_floor(tick: int, step_ticks: float) -> int:
    return int(math.floor(tick / step_ticks))


def duration_steps_ceil(start_tick: int, end_tick: int, step_ticks: float) -> int:
    dt = max(0, end_tick - start_tick)
    return max(1, int(math.ceil(dt / step_ticks)))


def ensure_len_steps(steps: List[List[Dict[str, Any]]], length_steps: int) -> List[List[Dict[str, Any]]]:
    if len(steps) < length_steps:
        steps.extend([[] for _ in range(length_steps - len(steps))])
    return steps


def spans_to_stepgrid(
    spans: List[NoteSpan],
    length_steps: int,
    step_ticks: float,
    *,
    channel: int,
    drum_mode: str,
) -> List[List[Dict[str, Any]]]:
    """
    Returns steps array where steps[s] is a list of events that START at step s.
    Events:
      - melodic: {pitch:<midi>, velocity:<0..1>, duration:<steps>}
      - drums: {note:<label>, velocity:<0..1>, duration:<steps>}
    """
    steps: List[List[Dict[str, Any]]] = [[] for _ in range(length_steps)]

    for n in spans:
        s = tick_to_step_floor(n.start_tick, step_ticks)
        if s < 0:
            continue

        dur = duration_steps_ceil(n.start_tick, n.end_tick, step_ticks)
        vel = clamp01(n.velocity / 127.0)

        if channel == 9:  # GM drum channel
            if drum_mode == "kick_only":
                label = GM_DRUM_LABELS.get(n.pitch)
                if label != "kick":
                    continue
                ev = {"note": "kick", "velocity": vel, "duration": dur}
            else:
                label = GM_DRUM_LABELS.get(n.pitch, f"drum_{n.pitch}")
                ev = {"note": label, "velocity": vel, "duration": dur}
        else:
            ev = {"pitch": int(n.pitch), "velocity": vel, "duration": dur}

        if s >= len(steps):
            # extend if needed
            steps.extend([[] for _ in range(s - len(steps) + 1)])
        steps[s].append(ev)

    return steps


def convert_midi_to_seq_json(
    midi_path: str,
    *,
    steps_per_beat: int = 4,
    beats_per_bar_override: Optional[int] = None,
    drum_mode: str = "gm_labels",
) -> Dict[str, Any]:
    mid = mido.MidiFile(midi_path)

    tempo_us = first_tempo_us_per_beat(mid)
    bpm = float(mido.tempo2bpm(tempo_us))

    ts_num, ts_den = first_time_signature(mid)
    # Your JS transport only stores beatsPerBar; assume common time grid (quarter-note beat).
    beats_per_bar = beats_per_bar_override if beats_per_bar_override is not None else ts_num

    ppq = mid.ticks_per_beat
    step_ticks = ppq / float(steps_per_beat)

    total_ticks = midi_length_ticks(mid)
    total_steps = max(1, int(math.ceil(total_ticks / step_ticks)))

    steps_per_bar = steps_per_beat * beats_per_bar
    bars = max(1, int(math.ceil(total_steps / steps_per_bar)))

    by_ch = collect_note_spans_by_channel(mid)

    # Build tracks with ids t1, t2, t3... so you can bind externally like your sketch
    tracks_out: List[Dict[str, Any]] = []
    track_index = 1

    for ch in sorted(by_ch.keys()):
        spans = by_ch[ch]

        steps = spans_to_stepgrid(
            spans,
            length_steps=total_steps,
            step_ticks=step_ticks,
            channel=ch,
            drum_mode=drum_mode,
        )
        total_steps = max(total_steps, len(steps))  # in case we extended

        track = {
            "id": f"t{track_index}",
            "name": "Drums" if ch == 9 else f"Channel {ch}",
            "channel": int(ch),
            "mute": False,
            "solo": False,
            "pattern": {
                "lengthSteps": int(len(steps)),
                "steps": steps,
            },
        }
        tracks_out.append(track)
        track_index += 1

    # Ensure all tracks have the same lengthSteps (your JS is fine either way, but this is cleaner)
    max_len = 1
    for tr in tracks_out:
        max_len = max(max_len, tr["pattern"]["lengthSteps"])
    for tr in tracks_out:
        tr["pattern"]["steps"] = ensure_len_steps(tr["pattern"]["steps"], max_len)
        tr["pattern"]["lengthSteps"] = max_len

    out = {
        "version": 1,
        "transport": {
            "bpm": bpm,
            "stepsPerBeat": int(steps_per_beat),
            "beatsPerBar": int(beats_per_bar),
            "bars": int(bars),
        },
        "tracks": tracks_out,
    }
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("input_midi")
    ap.add_argument("output_json")
    ap.add_argument("--steps-per-beat", type=int, default=4)
    ap.add_argument("--beats-per-bar", type=int, default=None)
    ap.add_argument(
        "--drum-mode",
        choices=["kick_only", "gm_labels"],
        default="gm_labels",
        help="gm_labels emits GM drum labels (kick, snare, hihat_closed, etc.).",
    )
    args = ap.parse_args()

    data = convert_midi_to_seq_json(
        args.input_midi,
        steps_per_beat=args.steps_per_beat,
        beats_per_bar_override=args.beats_per_bar,
        drum_mode=args.drum_mode,
    )

    with open(args.output_json, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2)

    print(f"Wrote {args.output_json}")
    print(f"BPM={data['transport']['bpm']:.2f}, tracks={len(data['tracks'])}, stepsPerBeat={data['transport']['stepsPerBeat']}")
    if data["tracks"]:
        print("Track ids:", ", ".join(t["id"] for t in data["tracks"][:8]), "...")


if __name__ == "__main__":
    main()
