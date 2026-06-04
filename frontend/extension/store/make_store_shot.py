"""
Turn a raw screenshot into an Edge/Chrome store-listing screenshot:
1280x800 (or 640x400), 24-bit JPEG (no alpha), screenshot centered on white.

Usage:
    python make_store_shot.py <input_image> [--small]

Outputs <input_stem>_1280x800.jpg (or _640x400.jpg with --small) next to this script.
"""
import sys
from pathlib import Path
from PIL import Image

SIZE = (1280, 800)
SMALL = (640, 400)
PAD = 0.92  # leave a little white margin around the screenshot


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)

    src = Path(sys.argv[1])
    if not src.exists():
        print(f"Not found: {src}")
        sys.exit(1)

    size = SMALL if "--small" in sys.argv else SIZE

    shot = Image.open(src).convert("RGB")  # convert drops any alpha channel

    # Scale to fit within the padded canvas, preserving aspect ratio.
    max_w, max_h = int(size[0] * PAD), int(size[1] * PAD)
    shot.thumbnail((max_w, max_h), Image.LANCZOS)

    canvas = Image.new("RGB", size, (255, 255, 255))  # RGB = 24-bit, no alpha
    offset = ((size[0] - shot.width) // 2, (size[1] - shot.height) // 2)
    canvas.paste(shot, offset)

    out = src.with_name(f"{src.stem}_{size[0]}x{size[1]}.jpg")
    canvas.save(out, "JPEG", quality=90)
    print(f"Wrote {out} ({size[0]}x{size[1]}, 24-bit JPEG, no alpha)")


if __name__ == "__main__":
    main()
