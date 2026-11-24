"""Key and export the complete Flow clip with its original timing."""
import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageOps

if len(sys.argv) != 2:
    sys.exit('Usage: finish-idle.py art-raw/idle/<role>-<stage> (full source clip only)')
folder = Path(sys.argv[1])
source = Image.open(folder / ('flow-anchored-original.gif' if folder.name == 'knight-late' else 'flow.gif'))
frames, delays, boxes = [], [], []
for i in range(source.n_frames):
    source.seek(i)
    delays.append(source.info['duration'])
    rgb = np.array(source.convert('RGB'))
    r, g, b = rgb.astype(int).transpose(2, 0, 1)
    excess = np.minimum(r, b) - g
    background = (excess > 65) & (r > 115) & (b > 115)
    fringe = (excess > 5) & (abs(r-b) < 3*excess+16)
    rgb[:, :, 0][fringe] = (r-excess)[fringe]
    rgb[:, :, 2][fringe] = (b-excess)[fringe]
    rgb[background] = 0
    frame = Image.fromarray(rgb)
    frame.putalpha(Image.fromarray((~background).astype('uint8')*255))
    frames.append(frame)
    boxes.append(frame.getbbox())
left, top = np.min(boxes, axis=0)[:2]
right, bottom = np.max(boxes, axis=0)[2:]
assert min(left, top, source.width-right, source.height-bottom) > 3, 'Sprite touches frame edge'
box = tuple(map(int, (left-3, top-3, right+3, bottom+3)))
frames = [frame.crop(box) for frame in frames]
w,h = frames[0].size
samples = Image.new('RGB',(w*8,h),'#343941')
for k in range(8):
    frame = frames[k*(len(frames)-1)//7]
    samples.paste(frame,(w*k,0),frame)
samples.thumbnail((960,240))
samples.save(folder/'review.png')
palette = samples.quantize(colors=255)
indexed = []
for frame in frames:
    image = frame.convert('RGB').quantize(palette=palette,dither=Image.Dither.NONE)
    image.paste(255,mask=ImageOps.invert(frame.getchannel('A')))
    indexed.append(image)
path = folder/'idle.gif'
candidate = folder/'idle.pending.gif'
indexed[0].save(candidate,save_all=True,append_images=indexed[1:],duration=delays,loop=0,
                disposal=2,transparency=255,optimize=False)
with Image.open(candidate) as check:
    encoded_delays = []
    for i in range(check.n_frames):
        check.seek(i)
        encoded_delays.append(check.info['duration'])
    assert encoded_delays == delays, 'Frame timing differs from source'
candidate.replace(path)
print(json.dumps(dict(role=folder.name,frames=len(frames),duration_ms=sum(delays),crop=box)))
