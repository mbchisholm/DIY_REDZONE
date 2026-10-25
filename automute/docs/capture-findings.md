# Phase 0 — Screen capture findings

Date: 2026-09-16
Machine: macOS 26.6.2, two displays (external 1920×1080, built-in 2560×1600 Retina)
Method: `probe_capture.py` — macOS `screencapture -x`, one full-screen shot of
every display followed by a burst (5 × 1 s; also 20 × 0.25 s for Firefox).
Output in `/tmp/probe/<browser>/`. Frames were inspected visually and diffed
pixel-for-pixel.

Screen Recording permission was granted to the terminal before testing. In every
browser the window chrome, page UI, and the rest of the desktop captured
normally, so none of the failures below is a permission problem.

## Results

| Browser | Version | Played? | Video area in capture | Verdict |
|---|---|---|---|---|
| Chrome | 152.0.7977.83 | Yes | Blank. Player overlay (ESPN logo, title, transport controls, fullscreen toast) captured; the video plane is solid black with controls hidden and a white/gray gradient with controls showing. | DRM-blocked |
| Safari | 26.6.2 | Yes | Entire `tv.youtube.com` content area is a solid black rectangle; Safari toolbar and tabs captured. Identical across all six frames. | DRM-blocked |
| Firefox | 156.0 | Yes | Broadcast pixels *are* present — ESPN SportsCenter, ticker, graphics all legible. But the video area is pixel-identical across every frame of a burst (0.0% changed pixels over 20 frames at 0.25 s, and over 5 frames at 1 s) while the operator confirmed the video was visibly moving on screen. A fresh frame appears only when the page is otherwise redrawn (reload, navigation). | Stale frame — unusable |

No browser refused to play.

### Firefox detail

Firefox is the only browser that does not blank the protected video plane, but
`screencapture` returns a cached copy of that layer rather than the live
picture. Two consecutive runs four minutes apart produced the same frame and
the same ticker text; a reload produced one new frame which then froze again.
Since a detector needs frames that change as the broadcast changes, this is
equivalent to no capture.

## Decision gate

**All three browsers give unusable frames.** Chrome and Safari blank the video
under DRM; Firefox returns a stale frame. Per the handoff, this branch stops
here: no project code is scaffolded and nothing downstream is started.

Options presented to the operator, awaiting a decision:

1. **Optical capture** — a camera or phone aimed at a second display playing
   the broadcast. Downstream code is unaffected apart from a one-time
   perspective correction; the Phase 2 detectors are coarse enough to tolerate
   it.
2. **Audio-only detection** via a loopback audio device, dropping video
   entirely.
3. **Revisit the source constraint.**

Chosen option: _pending_.
