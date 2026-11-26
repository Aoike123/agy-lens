"""Pack approved share-card art into the shipped plugin folder (dev-only tool).

Reads art-src/roster.json and writes sidecars/agy-lens/share-art/:
  characters/<id>/idle-<stage>.webp   every 4th frame of the 24 fps idle -> 48 frames at 6 fps,
                                      lossless animated WebP, full 8 s loop kept intact
  characters/<id>/still-<stage>.png   frame 0 of the same idle (used by exported PNG/SVG cards)
  arenas/<id>.png                     resampled onto the 400x210 native grid (native-arena.py)

Usage: python scripts/share-art/pack-share-assets.py [--step 4] [--only knight]
Needs Pillow (see requirements.txt). Re-run after any art-src change; `npm test` checks the output.
"""
import argparse
import io
import json
import sys
from pathlib import Path

from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent))
from importlib import import_module

native_arena = import_module("native-arena").native_arena

ROOT = Path(__file__).resolve().parents[2]
SRC = ROOT / "art-src"
OUT = ROOT / "sidecars" / "agy-lens" / "share-art"


def pack_idle(src: Path, dst_anim: Path, dst_still: Path, step: int, fps: int) -> tuple[int, int]:
    im = Image.open(src)
    n = getattr(im, "n_frames", 1)
    frames = []
    for i in range(0, n, step):
        im.seek(i)
        frames.append(im.convert("RGBA").copy())
    duration = round(1000 / fps)
    buf = io.BytesIO()
    frames[0].save(buf, "WEBP", save_all=True, append_images=frames[1:], duration=duration,
                   loop=0, lossless=True, method=6, quality=100)
    dst_anim.write_bytes(buf.getvalue())
    still = io.BytesIO()
    frames[0].save(still, "PNG", optimize=True)
    dst_still.write_bytes(still.getvalue())
    return len(frames), len(buf.getvalue())


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--step", type=int, default=4)
    ap.add_argument("--only", default=None)
    ap.add_argument("--arenas-only", action="store_true")
    args = ap.parse_args()
    roster = json.loads((SRC / "roster.json").read_text(encoding="utf-8"))
    src_fps = roster["grid"]["idleFps"]
    fps = src_fps // args.step
    total = 0
    for ch in roster["characters"]:
        cid = ch["id"]
        if args.arenas_only or (args.only and cid != args.only):
            continue
        out_dir = OUT / "characters" / cid
        out_dir.mkdir(parents=True, exist_ok=True)
        for stage, meta in ch["stages"].items():
            if "idle" not in meta:
                continue
            src = SRC / "characters" / cid / f"idle-{stage}.webp"
            frames, size = pack_idle(src, out_dir / f"idle-{stage}.webp", out_dir / f"still-{stage}.png", args.step, fps)
            total += size
            print(f"{cid}/{stage}: {frames} frames @ {fps} fps, {size / 1024:.0f} KB")
    if not args.only:
        arena_dir = OUT / "arenas"
        arena_dir.mkdir(parents=True, exist_ok=True)
        for aid in roster["arenas"]:
            dst = arena_dir / f"{aid}.png"
            native_arena(str(SRC / "arenas" / f"{aid}.webp")).save(dst, optimize=True)
            total += dst.stat().st_size
            print(f"arena {aid}: {dst.stat().st_size / 1024:.0f} KB")
    print(f"total {total / 1024 / 1024:.1f} MB -> {OUT}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
