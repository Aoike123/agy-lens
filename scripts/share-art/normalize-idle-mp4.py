"""Snap the second-batch idle animations to the approved character sprite grid."""
from io import BytesIO
from pathlib import Path
import struct

import numpy as np
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[2]
ART = ROOT / 'art-src'
RAW = ROOT / 'art-raw'  # art-raw/idle/<role>-<stage>/: keyed source clips and the 720x1280 board
OUT = ROOT / 'docs/handoff'
ROLES = {'surveyor': '雪岭测绘师', 'clockmaker': '钟楼修表匠',
         'dancer': '盐路刀舞者', 'glassblower': '玻璃吹制师'}
CELL = (192, 128)
BASELINE = 114
# Neutral-pose landmarks on the 100px masters: crown x/y, exclusive sole y.
# Both starter bodies measure about 90 grid pixels from crown to sole.
BODY_HEIGHT = 90
BODY_ANCHORS = {
    'surveyor': ((53, 7, 96), (53, 8, 96)),
    'clockmaker': ((53, 4, 99), (52, 5, 99)),
    'dancer': ((54, 6, 98), (53, 6, 98)),
    'glassblower': ((50, 9, 93), (50, 9, 93)),
}


def idle_output(role):
    """Final 192x128 idle for an idle role such as 'bard-mid' or 'novice-male-starter'."""
    if role.startswith('novice-') and role.endswith('-starter'):
        return ART / 'characters' / 'novice' / f"idle-starter-{role.split('-')[1]}.webp"
    cls, stage = role.rsplit('-', 1)
    return ART / 'characters' / cls / f'idle-{stage}.webp'


def chunk(tag, data):
    return tag + struct.pack('<I', len(data)) + data + bytes(len(data) % 2)


def uint24(value):
    return int(value).to_bytes(3, 'little')


def save_sequence(path, frames, delays):
    # Write explicit frames: some WebP encoders merge identical idle poses.
    w, h = frames[0].size
    data = bytearray(b'WEBP' + chunk(b'VP8X', b'\x12\0\0\0' + uint24(w-1) + uint24(h-1))
                     + chunk(b'ANIM', bytes(6)))
    for frame, delay in zip(frames, delays, strict=True):
        buf = BytesIO()
        frame.save(buf, 'WEBP', lossless=True, method=1)
        data.extend(chunk(b'ANMF', bytes(6) + uint24(w-1) + uint24(h-1)
                          + uint24(delay) + b'\x02' + buf.getvalue()[12:]))
    path.write_bytes(b'RIFF' + struct.pack('<I', len(data)) + data)
    with Image.open(path) as check:
        assert check.n_frames == len(delays)
        for i, duration in enumerate(delays):
            check.seek(i)
            check.load()
            assert check.info['duration'] == duration


def sample_cells(im, pitch, origin):
    # Same 3-by-3 majority coverage and representative colour as normalize-growth.
    src = np.pad(np.asarray(im.convert('RGBA')), ((1,1),(1,1),(0,0)))
    axes = []
    for size, start, limit in zip(CELL, origin, im.size):
        coords = np.floor(start + (np.arange(size)[:, None] + [.25,.5,.75])*pitch).astype(int)
        axes.append(np.clip(coords+1, 0, limit+1))
    xs, ys = axes
    samples = src[ys[:,None,:,None], xs[None,:,None,:]].reshape(CELL[1],CELL[0],9,4)
    coverage = samples[:,:,:,3] >= 128
    solid = coverage.sum(axis=2) >= 5
    pixel = np.zeros((CELL[1],CELL[0],4), dtype=np.uint8)
    colors = samples[solid,:,:3].astype('int16')
    valid = coverage[solid]
    sorted_colors = np.sort(np.where(valid[:,:,None], colors, 256), axis=1)
    n = valid.sum(axis=1)
    rows = np.arange(len(n))
    median2 = sorted_colors[rows,(n-1)//2] + sorted_colors[rows,n//2]
    delta = abs(2*colors-median2[:,None]).sum(axis=2)
    pixel[solid,:3] = colors[rows,np.where(valid,delta,10000).argmin(axis=1)]
    pixel[solid,3] = 255
    return Image.fromarray(pixel)


def normalize(role, stage):
    folder = RAW/'idle'/f'{role}-{stage}'
    master = Image.open(ART/'characters'/role/(stage+'.png')).convert('RGBA')
    mx, my, mr, mb = master.getbbox()
    board = np.asarray(Image.open(folder/(folder.name+'.png')).convert('RGB'))
    y, x = np.where(np.any(board != [255,0,255],axis=2))
    pitch, remainder = divmod(int(x.max()-x.min()+1), mr-mx)
    assert remainder == 0 and pitch*(mb-my) == y.max()-y.min()+1
    frames, delays = [], []
    with Image.open(folder/'idle-24fps.webp') as src:
        first = src.convert('RGBA').getbbox()
        head_x, crown, sole = BODY_ANCHORS[role][int(stage == 'late')]
        # Register the master to the neutral frame; scale by body height only.
        grid_pitch = pitch*(sole-crown)/BODY_HEIGHT
        head_source_x = first[0]+pitch*(head_x-mx)
        sole_source_y = first[3]+pitch*(sole-mb)
        origin = (head_source_x-grid_pitch*CELL[0]/2, sole_source_y-grid_pitch*BASELINE)
        for i in range(src.n_frames):
            src.seek(i)
            rgba = src.convert('RGBA')
            l,t,r,b = rgba.getbbox()
            assert origin[0] <= l and origin[1] <= t
            assert r <= origin[0]+grid_pitch*CELL[0] and b <= origin[1]+grid_pitch*CELL[1]
            frames.append(sample_cells(rgba,grid_pitch,origin))
            delays.append(src.info['duration'])
    assert len(frames)==192 and sum(delays)==8000
    save_sequence(idle_output(f'{role}-{stage}'),frames,delays)
    print(role, stage, 'body scale', round(pitch/grid_pitch, 3), flush=True)
    return frames,delays


def main():
    font = ImageFont.truetype('C:/Windows/Fonts/msyh.ttc',16)
    pages = [Image.new('RGB',(960,532),'#343941') for _ in range(192)]
    timing = None
    for col,(role,label) in enumerate(ROLES.items()):
        for row,stage in enumerate(('mid','late')):
            frames,delays = normalize(role,stage)
            if timing is not None:
                assert timing == delays
            timing = delays
            for f,page in zip(frames,pages):
                box=(36,0,156,124)
                l,t,r,b=f.getbbox()
                assert l>=box[0] and r<=box[2] and b<=box[3]
                im=f.crop(box).resize((240,248),Image.Resampling.NEAREST)
                page.paste(im,(240*col,266*row),im)
                ImageDraw.Draw(page).text((240*col+120,266*row+242),
                    label+' · '+('中期' if row==0 else '后期'),font=font,anchor='mt',fill='white')
    save_sequence(OUT/'idle-roster-grid-24fps.webp',pages,timing)
    pages[96].save(OUT/'idle-roster-grid-check.png')


if __name__ == '__main__':
    main()
