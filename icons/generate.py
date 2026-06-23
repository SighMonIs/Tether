from PIL import Image, ImageDraw
import math, os

SIZES = [16, 32, 48, 96, 128, 256, 512]
ACCENT = (99, 102, 241)
WHITE  = (255, 255, 255)

def rounded_rect_mask(size, radius):
    mask = Image.new("L", (size, size), 0)
    d = ImageDraw.Draw(mask)
    d.rounded_rectangle([0, 0, size - 1, size - 1], radius=radius, fill=255)
    return mask

def draw_icon(size):
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    radius = round(size * 0.219)

    bg = Image.new("RGBA", (size, size), ACCENT + (255,))
    mask = rounded_rect_mask(size, radius)
    img.paste(bg, mask=mask)

    draw = ImageDraw.Draw(img)

    cx   = size / 2
    top  = size * 0.188
    bot  = size * 0.773
    armY = size * 0.391
    armW = size * 0.203
    lw   = max(2, round(size * 0.066))
    dot  = size * 0.070

    # vertical line
    draw.line([(cx, top), (cx, bot)], fill=WHITE, width=lw)

    # arrowhead — draw as thick polyline using multiple offsets for rounded joins
    pts = [(cx - armW, armY), (cx, top), (cx + armW, armY)]
    draw.line(pts, fill=WHITE, width=lw, joint="curve")

    # dot at bottom
    draw.ellipse(
        [cx - dot, bot - dot, cx + dot, bot + dot],
        fill=WHITE
    )

    return img

os.makedirs(os.path.dirname(__file__) or ".", exist_ok=True)

for s in SIZES:
    icon = draw_icon(s)
    path = os.path.join(os.path.dirname(__file__), f"tether-icon-{s}.png")
    icon.save(path, "PNG")
    print(f"  {path}")

print("Done.")
