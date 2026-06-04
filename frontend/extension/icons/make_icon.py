"""
Generate Monitar extension icons: a white 'M' on a rounded brand-blue square.
Outputs icon_16/32/48/128.png next to this script.
"""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

BLUE = (37, 99, 235)      # #2563eb — Monitar brand color
WHITE = (255, 255, 255)
HERE = Path(__file__).resolve().parent

# Render at high resolution, then downscale for crisp edges at every size.
MASTER = 512


def find_bold_font(size):
    for name in ("segoeuib.ttf", "arialbd.ttf", "ariblk.ttf", "arial.ttf"):
        try:
            return ImageFont.truetype(f"C:/Windows/Fonts/{name}", size)
        except OSError:
            continue
    return ImageFont.load_default()


def make_master():
    img = Image.new("RGBA", (MASTER, MASTER), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    # Rounded square background.
    radius = int(MASTER * 0.22)
    draw.rounded_rectangle([0, 0, MASTER - 1, MASTER - 1], radius=radius, fill=BLUE)

    # Centered bold 'M'.
    font = find_bold_font(int(MASTER * 0.62))
    bbox = draw.textbbox((0, 0), "M", font=font)
    w, h = bbox[2] - bbox[0], bbox[3] - bbox[1]
    pos = ((MASTER - w) // 2 - bbox[0], (MASTER - h) // 2 - bbox[1])
    draw.text(pos, "M", font=font, fill=WHITE)
    return img


def main():
    master = make_master()
    for size in (16, 32, 48, 128):
        master.resize((size, size), Image.LANCZOS).save(HERE / f"icon_{size}.png")
        print(f"Wrote icon_{size}.png")


if __name__ == "__main__":
    main()
