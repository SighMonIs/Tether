from PIL import Image, ImageDraw
import os

SIZES  = [16, 32, 48, 96, 128, 256, 512]
ACCENT = (99, 102, 241, 255)
WHITE  = (255, 255, 255, 255)
SCALE  = 4  # supersample factor

def draw_icon_at(size):
    s = size * SCALE
    img  = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    radius = round(s * 0.219)
    draw.rounded_rectangle([0, 0, s - 1, s - 1], radius=radius, fill=ACCENT)

    cx   = s / 2
    top  = s * 0.188
    bot  = s * 0.773
    armY = s * 0.390
    armW = s * 0.200
    lw   = max(3, round(s * 0.066))
    dot  = s * 0.072

    # vertical line
    draw.line([(cx, top), (cx, bot)], fill=WHITE, width=lw)

    # arrowhead left leg
    draw.line([(cx - armW, armY), (cx, top)], fill=WHITE, width=lw)
    # arrowhead right leg
    draw.line([(cx, top), (cx + armW, armY)], fill=WHITE, width=lw)

    # round off the top tip and the two arm ends with filled circles
    cap_r = lw / 2
    for (px, py) in [(cx, top), (cx - armW, armY), (cx + armW, armY), (cx, bot)]:
        draw.ellipse([px - cap_r, py - cap_r, px + cap_r, py + cap_r], fill=WHITE)

    # anchor dot
    draw.ellipse([cx - dot, bot - dot, cx + dot, bot + dot], fill=WHITE)

    return img.resize((size, size), Image.LANCZOS)

out_dir = os.path.dirname(os.path.abspath(__file__))

for s in SIZES:
    icon = draw_icon_at(s)
    path = os.path.join(out_dir, f"tether-icon-{s}.png")
    icon.save(path, "PNG")
    print(f"  {path}")

print("Done.")
