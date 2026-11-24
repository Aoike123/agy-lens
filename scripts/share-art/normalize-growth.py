"""Rebuild the current sprites on the novice's measured 100-cell square grid."""
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = Path(__file__).resolve().parents[2]
ART = ROOT / 'art-src'
CHAR = ART / 'characters'  # characters/<key>/{original-mid,original-late}.webp -> mid.png / late.png
PREVIEW = ROOT / 'art-review/handoff'
KEYS = 'alchemist berserker bard knight mage monk novice diver kite surveyor clockmaker dancer glassblower'.split()
LABELS = '炼金术士 狂战士 01吟游诗人 02骑士 03法师 04苦行僧 05新手 06海港潜水匠 07纸鸢信使 08雪岭测绘师 09钟楼修表匠 10盐路刀舞者 11玻璃吹制师'.split()


def expand(mask, radius):
    return np.asarray(Image.fromarray(mask.astype('uint8') * 255).filter(
        ImageFilter.MaxFilter(2 * radius + 1))) > 0


def remove_spill(rgb, background):
    # Only inspect foreground adjoining keyed pixels, including enclosed holes.
    r, g, b = rgb.transpose(2, 0, 1).astype(int)
    edge = expand(background, 2) & ~background
    excess = np.minimum(r, b) - g
    fringe = edge & (excess > 8) & (np.abs(r - b) < 3 * excess + 16)
    # Remove the common magenta contribution from both channels. Real blue or
    # warm shading retains its blue/red difference instead of turning grey.
    rgb[:, :, 0][fringe] = (r - excess)[fringe]
    rgb[:, :, 2][fringe] = (b - excess)[fringe]


def normalize(path):
    rgb = np.array(Image.open(path).convert('RGB'))
    h, w = rgb.shape[:2]
    if h != w:
        raise ValueError(f'Expected square sprite: {path}')
    r, g, b = rgb.transpose(2, 0, 1).astype(int)
    bg = (np.minimum(r, b) > 140) & (np.minimum(r, b) - g > 100) & (np.abs(r - b) < 95)
    remove_spill(rgb, bg)
    coords = np.clip(((np.arange(100)[:, None] + np.array([.25, .5, .75])) * w / 100).astype(int), 0, w-1)
    samples = rgb[coords[:, None, :, None], coords[None, :, None, :]].reshape(100, 100, 9, 3)
    masks = bg[coords[:, None, :, None], coords[None, :, None, :]].reshape(100, 100, 9)
    pixels = np.zeros((100, 100, 4), dtype='uint8')
    opaque = masks.sum(2) < 5
    for y, x in zip(*np.where(opaque)):
        choices = samples[y, x, ~masks[y, x]].astype(int)
        pixels[y, x, :3] = choices[np.abs(choices - np.median(choices, axis=0)).sum(1).argmin()]
    pixels[:, :, 3] = opaque * 255
    remove_spill(pixels[:, :, :3], ~opaque)
    assert opaque.any() and not opaque.all()
    return Image.fromarray(pixels)


def main():
    font = ImageFont.truetype('C:/Windows/Fonts/msyh.ttc', 16)
    pairs = []
    finals = []
    for key, label in zip(KEYS, LABELS):
        folder = CHAR / key
        mature = normalize(folder / 'original-late.webp')
        mature.save(folder / 'late.png')
        if key == 'novice':
            mature.save(folder / 'starter-male.png')
        else:
            finals.append((label, mature))
        source = folder / 'original-mid.webp'
        if key != 'novice' and source.exists():
            early = normalize(source)
            early.save(folder / 'mid.png')
            pairs.append((label, early, mature))
    sheet = Image.new('RGB', (1060,744), '#343941')
    draw = ImageDraw.Draw(sheet)
    for i,(label,pic) in enumerate(finals):
        row = 0 if i<4 else 1 if i<8 else 2
        x = 112+210*(i%4)
        y = 8+244*row
        large = pic.resize((200,200),Image.Resampling.NEAREST)
        sheet.paste(large,(x,y),large)
        draw.text((x+100,y+204),label,font=font,fill='white',anchor='mt')
    sheet.save(PREVIEW/'final-form-100.png')
    for page in range((len(pairs)+5)//6):
        sheet = Image.new('RGB',(900,660),'#343941')
        draw = ImageDraw.Draw(sheet)
        for i,(label,early,mature) in enumerate(pairs[page*6:page*6+6]):
            x,y = i%2*450,i//2*220
            for dx,pic in [(12,early),(229,mature)]:
                large=pic.resize((180,180),Image.Resampling.NEAREST)
                sheet.paste(large,(x+dx,y+4),large)
            draw.text((x+212,y+186),label+'   过渡期 → 最终',font=font,fill='white',anchor='mt')
        sheet.save(PREVIEW/f'transition-review-{page+1}.png')
    female = normalize(CHAR / 'novice' / 'original-starter-female.webp')
    female.save(CHAR / 'novice' / 'starter-female.png')
    sheet = Image.new('RGB', (440, 240), '#343941')
    draw = ImageDraw.Draw(sheet)
    for i, (key, label) in enumerate([('male', '男性新手'), ('female', '女性新手')]):
        with Image.open(CHAR / 'novice' / f'starter-{key}.png') as sprite:
            large = sprite.resize((200, 200), Image.Resampling.NEAREST)
        sheet.paste(large, (10+220*i, 4), large)
        draw.text((110+220*i, 208), label, font=font, fill='white', anchor='mt')
    sheet.save(PREVIEW / 'starter-review.png')
    print(f'2 starter sprites, {len(pairs)} midgame sprites, {len(finals)} late-game sprites')


if __name__ == '__main__':
    main()
