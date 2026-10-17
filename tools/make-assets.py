"""Turns the PNG masters in art-src/ into the dashboard's WebP images in assets/ (needs Pillow).

    python tools/make-assets.py
"""
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "art-src"
OUT = ROOT / "assets"

# name: (width, height) displayed at up to this size (2x for sharp screens)
SIZES = {
    "logo-mark": (256, 256),
    "login-hero": (1200, 800),
    "empty-conversations": (480, 480),
    "empty-agents": (480, 480),
    "empty-channels": (480, 480),
    "avatar-http": (128, 128),
    "avatar-mcp": (128, 128),
    "avatar-script": (128, 128),
}

OUT.mkdir(exist_ok=True)
for name, size in SIZES.items():
    src = SRC / f"{name}.png"
    if not src.exists():
        print(f"- {name}: no master yet")
        continue
    img = Image.open(src).convert("RGB")
    img = img.resize(size, Image.LANCZOS)
    dest = OUT / f"{name}.webp"
    img.save(dest, "WEBP", quality=82, method=6)
    print(f"ok {dest.name} {size[0]}x{size[1]} {dest.stat().st_size // 1024} KB")

# A small favicon from the logo
logo = SRC / "logo-mark.png"
if logo.exists():
    Image.open(logo).convert("RGB").resize((64, 64), Image.LANCZOS).save(OUT / "favicon.png", optimize=True)
    print("ok favicon.png 64x64")
