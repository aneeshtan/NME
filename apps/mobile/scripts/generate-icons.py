#!/usr/bin/env python3
"""
Generates the app icons from the same glyph the web client uses.

Kept as a script rather than as three checked-in binaries with no provenance:
icons need regenerating whenever the brand colour moves, and a PNG in a
repository tells you nothing about how to reproduce it.

    pip install Pillow && python3 scripts/generate-icons.py

Three outputs, because the platforms want genuinely different things:

  icon.png           1024x1024, **no alpha channel**. App Store Connect rejects
                     an icon that has one, even when every pixel is opaque, so
                     this is written as RGB rather than RGBA. Full-bleed and
                     square: iOS applies its own corner mask, and pre-rounding
                     the artwork leaves visible dark corners once it does.

  adaptive-icon.png  Android's foreground layer, transparent, with the glyph
                     inside the safe zone. Android crops adaptive icons to
                     whatever shape the launcher prefers — circle, squircle,
                     teardrop — and anything outside the centre 66% can be cut.

  splash-icon.png    Transparent, smaller, sits on a solid background colour.
"""

from PIL import Image, ImageDraw

SIZE = 1024

# The brand ramp, matching the mark on the project site.
START = (59, 130, 246)   # #3b82f6
END = (124, 58, 237)     # #7c3aed


def gradient(size: int) -> Image.Image:
    """Diagonal blue-to-violet ramp, drawn per-row along the diagonal."""
    base = Image.new('RGB', (size, size))
    pixels = base.load()
    assert pixels is not None
    for y in range(size):
        for x in range(size):
            # Position along the top-left → bottom-right diagonal, 0..1.
            t = (x + y) / (2 * (size - 1))
            pixels[x, y] = (
                round(START[0] + (END[0] - START[0]) * t),
                round(START[1] + (END[1] - START[1]) * t),
                round(START[2] + (END[2] - START[2]) * t),
            )
    return base


def play_glyph(size: int, scale: float) -> Image.Image:
    """
    The play triangle, with rounded corners, as a white mask.

    Rounded joins come from stroking the outline with a round-joined line and
    filling the interior — Pillow's polygon has no corner radius of its own.
    """
    mask = Image.new('L', (size, size), 0)
    draw = ImageDraw.Draw(mask)

    height = size * scale
    width = height * 0.87
    radius = height * 0.1

    # Nudged right of centre: a triangle's centre of area sits left of where the
    # eye puts it, so a mathematically centred play button looks off-centre.
    cx = size / 2 + width * 0.09
    cy = size / 2

    points = [
        (cx - width / 2, cy - height / 2),
        (cx + width / 2, cy),
        (cx - width / 2, cy + height / 2),
    ]

    # Inset so the stroke widens the shape back out to the intended size rather
    # than beyond it.
    inset = []
    for px, py in points:
        inset.append((px + (cx - px) * radius / (width / 2) * 0.55,
                      py + (cy - py) * radius / (height / 2) * 0.55))

    draw.polygon(inset, fill=255)
    # The first point is repeated *and* the second: a joint is only drawn
    # between consecutive segments, so closing the path with `inset[0]` alone
    # leaves the starting vertex as a line cap rather than a corner — one
    # square notch among two rounded corners.
    draw.line(inset + [inset[0], inset[1]], fill=255, width=int(radius * 2), joint='curve')
    return mask


def main() -> None:
    out = 'assets'

    # ── iOS: full bleed, opaque, no alpha channel ──
    icon = gradient(SIZE)
    icon.paste((255, 255, 255), mask=play_glyph(SIZE, 0.42))
    icon.save(f'{out}/icon.png')

    # ── Android adaptive foreground: transparent, inside the safe zone ──
    adaptive = Image.new('RGBA', (SIZE, SIZE), (0, 0, 0, 0))
    adaptive.paste((255, 255, 255, 255), mask=play_glyph(SIZE, 0.30))
    adaptive.save(f'{out}/adaptive-icon.png')

    # ── Splash: the same glyph, sitting on a solid background ──
    splash = Image.new('RGBA', (SIZE, SIZE), (0, 0, 0, 0))
    splash.paste((255, 255, 255, 255), mask=play_glyph(SIZE, 0.26))
    splash.save(f'{out}/splash-icon.png')

    for name in ('icon.png', 'adaptive-icon.png', 'splash-icon.png'):
        with Image.open(f'{out}/{name}') as image:
            print(f'{name:20} {image.size[0]}x{image.size[1]} {image.mode}')


if __name__ == '__main__':
    main()
