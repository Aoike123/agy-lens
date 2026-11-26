"""Import portrait Flow MP4s and key complete idle loops onto the starter grid."""
import argparse
import importlib.util
from fractions import Fraction
from pathlib import Path
import shutil
import subprocess

from PIL import Image, ImageChops

spec = importlib.util.spec_from_file_location("idle_grid", Path(__file__).with_name("normalize-idle-mp4.py"))
grid = importlib.util.module_from_spec(spec)
spec.loader.exec_module(grid)

# Neutral-frame landmarks measured on a 144x256 proxy: head center X, crown Y,
# sole Y (exclusive). Tool tips, packs and long hair are excluded from height.
POSES = {
    "novice-male-starter": ("26fe64d0", 66, 66, 193),
    "novice-female-starter": ("2dc13e8f", 66, 66, 191),
    "alchemist-mid": ("87d71898", 75, 66, 190),
    "alchemist-late": ("ca55b8c2", 81, 66, 190),
    "bard-mid": ("e6608843", 66, 62, 193),
    "bard-late": ("1c43bf29", 67, 63, 193),
    "knight-mid": ("582adf86", 82, 59, 197),
    "knight-late": ("884b2f82", 83, 60, 198),
    "berserker-mid": ("54218b18", 75, 65, 192),
    "berserker-late": ("ab3b658e", 69, 65, 192),
    "mage-mid": ("347379d1", 74, 59, 197),
    "mage-late": ("e39aa08b", 77, 70, 188),
    "monk-mid": ("2491c276", 93, 76, 180),
    "monk-late": ("7bc070f0", 92, 84, 186),
    "diver-mid": ("bf8665e4", 65, 62, 194),
    "diver-late": ("6383f1a8", 67, 63, 194),
    "kite-mid": ("c4371d9a", 75, 80, 187),
    "kite-late": ("40b5e85c", 74, 88, 177),
}


def key_frame(rgb):
    r, g, b = rgb.split()
    excess = ImageChops.subtract(ImageChops.darker(r, b), g)
    background = ImageChops.darker(excess.point(lambda v: 255 if v > 65 else 0),
                                   ImageChops.darker(r, b).point(lambda v: 255 if v > 115 else 0))
    spill = excess.point(lambda v: v if v > 5 else 0)
    return Image.merge("RGBA", (ImageChops.subtract(r, spill), g,
                                ImageChops.subtract(b, spill), ImageChops.invert(background)))


def convert(role, pose, args):
    tag, head, crown, sole = pose
    src, = args.source.glob(f"*{tag}.mp4")
    archive = grid.RAW / "flow-mp4" / "batch-1"
    archive.mkdir(parents=True, exist_ok=True)
    original = archive / f"{role}-{tag}.mp4"
    if src.resolve() != original.resolve():
        shutil.copyfile(src, original)
    packets = subprocess.check_output([args.ffmpeg, "-v", "error", "-i", str(original),
        "-map", "0:v:0", "-c", "copy", "-f", "framecrc", "-"], text=True).splitlines()
    assert "#dimensions 0: 720x1280" in packets
    timebase = Fraction(next(line.split(":")[1].strip() for line in packets if line.startswith("#tb ")))
    timestamps = sorted(int(line.split(",")[2])*timebase for line in packets if line.startswith("0,"))
    assert timestamps == [Fraction(i,24) for i in range(192)]
    pitch = 5*(sole-crown)/grid.BODY_HEIGHT
    origin = (5*head-pitch*grid.CELL[0]/2, 5*sole-pitch*grid.BASELINE)
    frames = []
    issues = []
    with subprocess.Popen([args.ffmpeg, "-v", "error", "-i", str(original), "-f", "rawvideo",
                           "-pix_fmt", "rgb24", "-"], stdout=subprocess.PIPE) as decoder:
        for i in range(192):
            raw = decoder.stdout.read(720*1280*3)
            frame = key_frame(Image.frombytes("RGB", (720,1280), raw))
            l,t,r,b = frame.getbbox()
            if min(l,t,720-r,1280-b) <= 0:
                issues.append((i,"source edge"))
            if l < origin[0] or t < origin[1] or r > origin[0]+192*pitch or b > origin[1]+128*pitch:
                issues.append((i,"outside cell"))
            frames.append(grid.sample_cells(frame, pitch, origin))
        assert decoder.stdout.read(1) == b"" and decoder.wait() == 0
    if issues:
        print(role, "hold:", len(issues), issues[:8], flush=True)
        return
    delays = [round((i+1)*1000/24)-round(i*1000/24) for i in range(192)]
    grid.save_sequence(grid.idle_output(role), frames, delays)
    print(role, "ok", flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("source",type=Path)
    parser.add_argument("--ffmpeg",default="ffmpeg")
    args = parser.parse_args()
    for role, pose in POSES.items():
        convert(role, pose, args)
