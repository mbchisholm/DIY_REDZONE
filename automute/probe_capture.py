#!/usr/bin/env python3
"""Phase 0 probe: does full-screen capture of YouTube TV return real frames?

Standalone, throwaway. Uses macOS's built-in `screencapture` so nothing needs
installing. Captures every attached display, once and then as a short burst,
into /tmp/probe/<browser>/. Prints the mean brightness of each PNG as a rough
hint (a DRM-blocked video area drags the mean down, but eyeball the images —
that is the real test).

Usage:
    python3 probe_capture.py --browser chrome
    python3 probe_capture.py --browser safari --burst 10 --interval 0.5
"""

import argparse
import platform
import subprocess
import sys
import time
from pathlib import Path

OUT_ROOT = Path("/tmp/probe")


def display_count() -> int:
    """Count attached displays via system_profiler (falls back to 1)."""
    try:
        out = subprocess.run(
            ["system_profiler", "SPDisplaysDataType"],
            capture_output=True, text=True, timeout=20, check=True,
        ).stdout
        n = sum(1 for line in out.splitlines() if "Resolution:" in line)
        return max(n, 1)
    except Exception:
        return 1


def capture(paths: list[Path]) -> None:
    """One `screencapture` call; with N paths it writes one PNG per display."""
    cmd = ["screencapture", "-x", "-t", "png", *map(str, paths)]
    subprocess.run(cmd, check=True, timeout=30)


def mean_brightness(path: Path) -> float | None:
    try:
        from PIL import Image, ImageStat
    except ImportError:
        return None
    with Image.open(path) as im:
        return ImageStat.Stat(im.convert("L")).mean[0]


def report(path: Path) -> None:
    b = mean_brightness(path)
    size = path.stat().st_size
    hint = ""
    if b is not None:
        hint = f"  mean brightness {b:6.1f}/255"
        if b < 20:
            hint += "  <-- nearly all black"
    print(f"  wrote {path}  ({size // 1024} KB){hint}")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--browser", required=True,
                    choices=["chrome", "safari", "firefox"],
                    help="which browser is playing YouTube TV (used for the output folder)")
    ap.add_argument("--burst", type=int, default=5, help="frames in the burst (default 5)")
    ap.add_argument("--interval", type=float, default=1.0,
                    help="seconds between burst frames (default 1.0)")
    ap.add_argument("--delay", type=float, default=3.0,
                    help="seconds to wait before the first capture so you can "
                         "bring the browser to the front (default 3)")
    args = ap.parse_args()

    if platform.system() != "Darwin":
        print("This probe uses macOS `screencapture`; run it on the Mac.", file=sys.stderr)
        return 2

    out_dir = OUT_ROOT / args.browser
    out_dir.mkdir(parents=True, exist_ok=True)
    for old in out_dir.glob("*.png"):
        old.unlink()

    n_disp = display_count()
    print(f"macOS {platform.mac_ver()[0]}, {n_disp} display(s), output -> {out_dir}")
    print(f"Make sure YouTube TV is playing and visible. Capturing in {args.delay:g}s...")
    time.sleep(args.delay)

    # Single full-screen shot.
    print("Single capture:")
    single = [out_dir / f"single_display{d}.png" for d in range(1, n_disp + 1)]
    capture(single)
    for p in single:
        report(p)

    # Short burst — catches the case where only some frames are blanked.
    print(f"Burst of {args.burst} at {args.interval:g}s intervals:")
    for i in range(1, args.burst + 1):
        frame = [out_dir / f"burst_{i:02d}_display{d}.png" for d in range(1, n_disp + 1)]
        capture(frame)
        for p in frame:
            report(p)
        if i < args.burst:
            time.sleep(args.interval)

    print()
    print(f"Done. Open the PNGs:  open {out_dir}")
    print("Look at the YouTube TV video area in each image: broadcast, or black?")
    return 0


if __name__ == "__main__":
    sys.exit(main())
