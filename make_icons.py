#!/usr/bin/env python3
"""
Generate the app icons. Draws at 4x and downsamples, which is cheaper than
antialiasing by hand and gives clean edges on the ears.

    python make_icons.py
"""

import os

from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
BG = (14, 17, 22)
ACCENT = (77, 163, 255)
DARK = (10, 13, 18)

SS = 4  # supersample factor


def draw_dog(size, glyph_scale=0.62, background=True, radius_frac=0.22):
    """A blocky dog head: ears, muzzle, eyes. Reads at 48px."""
    S = size * SS
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    if background:
        d.rounded_rectangle([0, 0, S - 1, S - 1], radius=int(S * radius_frac), fill=BG)

    g = S * glyph_scale          # glyph box
    cx, cy = S / 2, S / 2
    left, top = cx - g / 2, cy - g / 2

    # ears - two triangles poking above the head
    ear_w, ear_h = g * 0.30, g * 0.34
    d.polygon([(left + g * 0.02, top + ear_h * 1.05),
               (left + ear_w * 0.55, top - g * 0.02),
               (left + ear_w * 1.02, top + ear_h * 1.10)], fill=ACCENT)
    d.polygon([(left + g - g * 0.02, top + ear_h * 1.05),
               (left + g - ear_w * 0.55, top - g * 0.02),
               (left + g - ear_w * 1.02, top + ear_h * 1.10)], fill=ACCENT)

    # head
    head_top = top + g * 0.22
    d.rounded_rectangle([left, head_top, left + g, top + g],
                        radius=int(g * 0.26), fill=ACCENT)

    # eyes
    eye_r = g * 0.062
    eye_y = head_top + g * 0.26
    for ex in (left + g * 0.31, left + g * 0.69):
        d.ellipse([ex - eye_r, eye_y - eye_r, ex + eye_r, eye_y + eye_r], fill=DARK)

    # muzzle
    mw, mh = g * 0.44, g * 0.26
    my = top + g - mh - g * 0.07
    d.rounded_rectangle([cx - mw / 2, my, cx + mw / 2, my + mh],
                        radius=int(mh * 0.42), fill=DARK)
    # nose
    nr = g * 0.052
    d.ellipse([cx - nr, my + mh * 0.20, cx + nr, my + mh * 0.20 + nr * 2], fill=ACCENT)

    return img.resize((size, size), Image.LANCZOS)


def save(img, path):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    img.save(path)
    print(f"  {os.path.relpath(path, HERE)}")


def main():
    # PWA / web icons
    for size in (192, 512):
        save(draw_dog(size), os.path.join(HERE, "www", f"icon-{size}.png"))

    # Android launcher icons
    res = os.path.join(HERE, "android", "app", "src", "main", "res")
    densities = {
        "mdpi": 48, "hdpi": 72, "xhdpi": 96, "xxhdpi": 144, "xxxhdpi": 192,
    }
    for name, size in densities.items():
        icon = draw_dog(size)
        save(icon, os.path.join(res, f"mipmap-{name}", "ic_launcher.png"))
        save(draw_dog(size, radius_frac=0.5), os.path.join(res, f"mipmap-{name}", "ic_launcher_round.png"))
        # Adaptive foreground: glyph only, inside the 66% safe zone, no background.
        fg = draw_dog(int(size * 2.2), glyph_scale=0.42, background=False)
        save(fg, os.path.join(res, f"mipmap-{name}", "ic_launcher_foreground.png"))

    print("\n  icons written")


if __name__ == "__main__":
    main()
