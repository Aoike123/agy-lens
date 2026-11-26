"""Resample a ~3.44x arena painting onto the 400-wide native pixel grid (dev-only).

Each native pixel takes the most common colour in the centre 60% of its source block
(colours quantised to 5 bits per channel for the vote, the original colour of the winning
bucket is averaged), so pixel clusters stay crisp instead of being blurred by resampling.
The 223-row result is cropped to 210 rows, keeping the duel floor at the same place.

Usage: python native-arena.py <src.webp> <dst.png>   (called by pack-share-assets.py)
"""
import sys

import numpy as np
from PIL import Image

NATIVE_W, NATIVE_H = 400, 210


def native_arena(src_path: str) -> Image.Image:
    src = np.asarray(Image.open(src_path).convert("RGB")).astype(np.int32)
    sh, sw, _ = src.shape
    scale = sw / NATIVE_W
    th = round(sh / scale)
    out = np.zeros((th, NATIVE_W, 3), dtype=np.uint8)
    for ty in range(th):
        y0, y1 = ty * scale, (ty + 1) * scale
        ya, yb = int(y0 + (y1 - y0) * 0.2), max(int(y0 + (y1 - y0) * 0.8), int(y0 + (y1 - y0) * 0.2) + 1)
        for tx in range(NATIVE_W):
            x0, x1 = tx * scale, (tx + 1) * scale
            xa, xb = int(x0 + (x1 - x0) * 0.2), max(int(x0 + (x1 - x0) * 0.8), int(x0 + (x1 - x0) * 0.2) + 1)
            block = src[ya:min(yb, sh), xa:min(xb, sw)].reshape(-1, 3)
            keys = (block[:, 0] >> 3) << 10 | (block[:, 1] >> 3) << 5 | (block[:, 2] >> 3)
            vals, counts = np.unique(keys, return_counts=True)
            win = vals[np.argmax(counts)]
            out[ty, tx] = block[keys == win].mean(axis=0).round().astype(np.uint8)
    top = (th - NATIVE_H) // 2
    return Image.fromarray(out[top:top + NATIVE_H])


if __name__ == "__main__":
    native_arena(sys.argv[1]).save(sys.argv[2], optimize=True)
