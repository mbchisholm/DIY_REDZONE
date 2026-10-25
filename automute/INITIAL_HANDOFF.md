# Football Commercial Detection → Auto-Mute

## What this is

A local macOS project. It watches a live football broadcast playing on this
machine, detects when the broadcast cuts to a commercial break, and calls Home
Assistant to mute the TV — then unmute when the game returns.

This is an experiment. The point is to find out quickly whether a simple
approach works, not to build a polished system. Optimize for reaching a
validated yes/no fast, and do not build infrastructure for stages we have not
yet proven we need.

## Environment facts you need to know

- **Machine:** macOS. Python available. You have shell and file access.
- **Video source:** YouTube TV, watched in a web browser on this machine. The
  operator has a subscription and will open and control it.
- **You cannot control the browser or the YouTube TV account.** You cannot log
  in, start a stream, pick a game, or scrub a recording. Anything requiring a
  human at the keyboard must be handed back with exact instructions (see
  "Working with the operator").
- **Home Assistant** runs on the local network and controls the TV audio. Its
  URL, token, and entity ID are unknown to you and will be supplied via `.env`
  when Phase 4 arrives. Do not guess them.
- **Chrome, Safari, and Firefox** are all installed and available for testing.

## Constraints

- **Video must come from YouTube TV via screen capture on this machine.** Other
  capture routes (game consoles, HDMI capture cards) were considered and ruled
  out by the operator. Do not propose them.
- **Do not attempt to circumvent DRM.** YouTube TV is DRM-protected and screen
  capture may return black frames. Phase 0 exists to find out. If capture is
  blocked, report it — do not look for a way around the protection.
- Everything runs locally. No cloud services, no hosted inference.
- Python, `pyproject.toml`.

## Out of scope for now

- No neural network, no labeling tool, no training pipeline. Phase 2 defines the
  single condition under which any of that becomes relevant.
- No live operation until it works on recorded video.
- No multiview handling, though two interfaces must stay compatible with it —
  see "Forward compatibility".

---

## Working with the operator

Several steps need a human. When you hit one:

1. Stop.
2. Print exactly what they should do — literal commands, literal button clicks,
   literal file paths.
3. Say what you need back from them.
4. Wait. Do not guess and proceed.

Steps that are theirs, not yours: opening YouTube TV and starting playback;
granting macOS Screen Recording permission; identifying which network is
broadcasting a given recording; scrubbing a recording to note where the
commercial breaks fall; supplying Home Assistant credentials.

Everything else is yours.

---

# Phase 0 — Prove screen capture works

Nothing downstream is possible if screen capture of YouTube TV returns black
frames. This is the most likely way the project dies, so establish it before
writing any project code.

Write one standalone script — `probe_capture.py`, no package structure, delete
it later — that captures the full screen to a PNG and to a short burst of PNGs.
Full screen, not a region: the operator doesn't need to find coordinates yet,
and a black video area is obvious at a glance.

Then hand the operator this, filling in your actual command names:

> **Before we start, one setup step:** open System Settings → Privacy &
> Security → Screen Recording and enable it for Terminal. macOS silently
> returns black images without it, which would look exactly like a DRM block.
>
> **Then, for each of Chrome, Safari, and Firefox:**
> 1. Open YouTube TV in that browser and start playing any live channel.
> 2. Leave it playing and visible on screen.
> 3. Run: `python probe_capture.py --browser chrome` (etc.)
> 4. Open the PNGs it writes to `/tmp/probe/` and tell me, for each browser,
>    whether the video area shows the broadcast or is black.
>
> Also tell me the browser versions, and whether any browser refused to play at
> all.

Record the results in `docs/capture-findings.md`.

### Decision gate

- **At least one browser gives real frames** → that browser is the capture
  target for the whole project. Note it in the findings file. Proceed to Phase 1.
- **All browsers give black frames** → stop and report. Present these options to
  the operator and wait for a decision:
  1. Optical capture — a camera or phone aimed at a second display playing the
     broadcast. Downstream code is unaffected; it adds a one-time perspective
     correction, and the Phase 2 detectors are coarse enough to tolerate it.
  2. Audio-only detection via a loopback audio device, dropping video entirely.
  3. Revisit the source constraint.

  Do not pick one yourself, and do not start building any of them.

---

# Phase 1 — Recorder and recordings

One capture path will serve both the training corpus and, later, live
operation — build it once, behind the `FrameSource` interface below.

Build:

- `ScreenCaptureSource` — captures a configured screen region at a configured
  FPS, using whichever browser Phase 0 validated.
- `VideoFileSource` — reads a video file. Same interface.
- A CLI command that records to `data/raw/<name>.mp4` with a sidecar
  `<name>.json` containing: capture region, FPS, resolution, browser, wall-clock
  start time, and **which network is broadcasting** (CBS, FOX, NBC, or ESPN).

That last field matters: each network puts its score graphic in a different
place and draws it differently. Without it, a cross-network test will look like
a detection failure when it's really a missing config.

You'll need the operator for two things here: the screen coordinates of the
video area (tell them how to get them — `Cmd+Shift+4` shows coordinates while
dragging, then Esc), and the network name per recording.

**Ask the operator to produce two recordings, different networks, roughly 45
minutes each, each containing at least six commercial breaks.** Ask them to
record from DVR playback rather than live — identical pixels, but it can be
scrubbed, which Phase 2 needs.

`data/raw/` is immutable. Never write derived output into it.

---

# Phase 2 — Simple detector, and the decision it settles

**The hypothesis: a couple of cheap fixed-position visual features separate game
from commercial well enough that no machine learning is needed.**

The reason to expect this is that broadcasts deliberately keep a score graphic
on screen throughout play and deliberately remove it during ads. If that single
signal is enough, an entire labeling and training pipeline becomes unnecessary
work. Test it before building any of that.

Implement two detectors, each mapping a frame to a probability:

1. **Score graphic presence.** OpenCV template match inside a fixed region of
   interest. One template per network under `templates/<network>/`, ROI in
   config. You can crop templates yourself from a frame of each recording.
2. **Grass-hue fraction.** Share of pixels falling in the turf hue range. Cheap,
   robust, no per-network config.

If those two fall short, optional additional signals: frame-to-frame change rate
(ads cut every one to two seconds, game footage does not), and audio spectral
stationarity if the recordings captured audio. Note that broadcast ads are
loudness-normalized by law, so absolute volume is not a usable signal —
spectral character is.

### Ground truth, without building a labeling tool

Ask the operator to scrub one recording and write break boundaries into
`data/truth/<name>.csv` — roughly twenty rows, about fifteen minutes of their
time:

```csv
video,start_s,end_s,label
game_001,0,742.5,game
game_001,742.5,921.0,commercial
game_001,921.0,1455.0,game
```

Do not build a labeling UI. Do not extract a frame dataset. Do not train
anything.

### Decision gate

Run both detectors across the full recording, compare against the CSV, and
report per-frame precision and recall for the commercial class plus a confusion
matrix.

- **Commercial precision ≥ 95%** → hypothesis holds. No ML needed at all. Go to
  Phase 3.
- **85–95%** → add the optional signals above, and try logistic regression over
  the handful of features. Still no neural network.
- **Below 85%** → stop and report before escalating. Only then is a learned
  model worth discussing, and the first thing to try would be frozen pretrained
  embeddings with a linear head, split by *video* rather than by frame to avoid
  adjacent frames leaking between train and test.

---

# Phase 3 — Temporal state machine

A single frame never decides anything.

States: `GAME`, `COMMERCIAL`. A transition requires N consecutive frames past a
confidence threshold. N and the threshold are configuration values, never
literals in code.

Required safety behavior:

- **Default to `GAME` — unmuted.** On detector exception, capture stall, or
  dropped frames, fall back to `GAME`. Muting during live play is the failure
  that makes the system unusable; missing an ad is a minor annoyance. Treat these
  as asymmetric everywhere.
- **Minimum commercial duration** around 20 seconds, so a brief graphics-heavy
  moment or replay transition can't trigger a mute.
- **Maximum commercial duration** around 4 minutes. Past that, assume the
  detector is wrong and force back to `GAME`.
- Emit a command only when the state *changes*. Never repeat.

Deliverable: run against a full recording and print a timeline.

```
00:00 - 12:22  GAME
12:22 - 15:21  COMMERCIAL
15:21 - 28:17  GAME
```

Then compare that timeline against the truth CSV and report: false mute events
per game, missed breaks, and mean detection latency.

### Success bar

- **Zero false mutes across a full game.** Non-negotiable.
- Missed breaks: up to about 20% is acceptable.
- Detection latency under 2 seconds. The mute action itself adds delay
  downstream, so this is the part we control.
- Do not report or tune frame-level accuracy as the headline metric. It is not
  the objective and it will mislead you.

---

# Phase 4 — Home Assistant

Home Assistant is an external actuator. The detector must know nothing about
TVs.

```python
class Actuator(Protocol):
    def set_audio_source(self, idx: int | None) -> None: ...  # None = mute
```

Two implementations:

- `DryRunActuator` — logs `COMMERCIAL → would mute`. **This is the default.**
- `HomeAssistantActuator` — REST call. Requires an explicit opt-in flag to run.

Configuration comes from the environment, never from source:

```
HA_URL=
HA_TOKEN=
HA_MUTE_ENTITY=
```

Commit `.env.example`, gitignore `.env`. Ask the operator for these values when
you reach this phase; do not guess entity names.

---

# Phase 5 — Live operation

Only after Phase 3 passes on recorded video. It should be a configuration
change, not new code: swap `VideoFileSource` for `ScreenCaptureSource` and run
the same pipeline. If it takes more than that, the abstraction in Phase 1 was
wrong — fix that rather than writing a parallel live path.

---

# Forward compatibility

YouTube TV has a multiview mode showing four games in a 2×2 grid, where audio
follows whichever pane is selected. The eventual goal is to switch audio between
panes rather than just mute. A pane is a scaled-down full frame, so the
detectors carry over unchanged — but the plumbing must not assume one region per
frame:

```python
class FrameSource(Protocol):
    def regions(self) -> Iterator[list[Region]]: ...  # 1 for full frame, 4 for a grid
```

Ship a single-region implementation now. Do not build the grid splitter. The
actuator signature above is already grid-shaped: mute is just `idx=None`.

---

# Structure

Keep it flat. Create a module when it has contents, not in anticipation.

```
football-commercial-detector/
├── README.md
├── pyproject.toml
├── .env.example
├── .gitignore
├── src/admute/
│   ├── __init__.py
│   ├── cli.py            # single entry point
│   ├── config.py
│   ├── sources.py        # FrameSource, VideoFileSource, ScreenCaptureSource
│   ├── detect.py
│   ├── state.py
│   └── actuator.py
├── templates/            # score graphic templates, per network
├── data/
│   ├── raw/              # immutable recordings + sidecar json
│   └── truth/            # hand-written interval CSVs
├── tests/
└── docs/
    └── capture-findings.md
```

Dependencies: `opencv-python`, `numpy`, `httpx`, `pytest`, `python-dotenv`.
**Do not add PyTorch or any ML framework** unless the Phase 2 gate explicitly
sends you there.

One CLI: `python -m admute <subcommand>`. Do not also create a `scripts/`
directory of entry points — two front doors drift apart.

Derived frame filenames use zero-padded integer milliseconds
(`000742500.jpg`), not floating-point seconds. Floats in paths break globbing
and sorting.

Configurable, never hard-coded: sample FPS, capture region, per-network ROI,
template paths, confidence thresholds, smoothing window, minimum and maximum
commercial duration, Home Assistant URL and entity.

---

# Order of work

| # | Deliverable | Gate to pass |
|---|---|---|
| 0 | `probe_capture.py`, `docs/capture-findings.md` | Real frames from at least one browser, or stop and report |
| 1 | Scaffold, `pytest` green, recorder writes mp4 + sidecar | Two recordings in `data/raw/` |
| 2 | Truth CSV, both detectors, precision/recall report | ≥95% commercial precision, or report before escalating |
| 3 | State machine, timeline output, false-mute count | Zero false mutes, latency under 2s |
| 4 | Dry-run actuator, then HA behind a flag | Timeline drives correct dry-run output |
| 5 | Live capture through the same pipeline | — |

---

# Your first task

**Phase 0 only.**

Write `probe_capture.py`, then hand the operator the instructions for running it
across the three browsers and wait for their answer. Write up what they report
in `docs/capture-findings.md` and state which branch of the decision gate we're
on.

Do not scaffold the project. Do not create `pyproject.toml`. Do not install
dependencies beyond what the probe script needs. Do not write detectors.

If capture works, you'll get Phase 1 next.
