#!/usr/bin/env python3
"""Generate Android launchers from the same dark maskable icon used by the PWA."""
from pathlib import Path
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]


def launcher_images(source, size):
    legacy = source.convert("RGBA").resize((size, size), Image.Resampling.LANCZOS)
    # Android masks the middle 72/108 dp; preserve the PWA's visual scale there.
    foreground_size = round(size * 108 / 48)
    foreground = Image.new("RGBA", (foreground_size, foreground_size), "#20211f")
    inset_size = round(foreground_size * 72 / 108)
    inset = source.convert("RGBA").resize((inset_size, inset_size), Image.Resampling.LANCZOS)
    offset = (foreground_size - inset_size) // 2
    foreground.paste(inset, (offset, offset))
    return legacy, foreground


def main():
    source = Image.open(ROOT / "public/icons/icon-maskable-dark-512.png")
    target = ROOT / "src-tauri/icons/android"
    for density, size in (("mdpi", 48), ("hdpi", 72), ("xhdpi", 96), ("xxhdpi", 144), ("xxxhdpi", 192)):
        folder = target / f"mipmap-{density}"
        folder.mkdir(parents=True, exist_ok=True)
        legacy, foreground = launcher_images(source, size)
        legacy.save(folder / "ic_launcher.png")
        legacy.save(folder / "ic_launcher_round.png")
        foreground.save(folder / "ic_launcher_foreground.png")
    (target / "values/ic_launcher_background.xml").write_text(
        '<?xml version="1.0" encoding="utf-8"?>\n<resources>\n'
        '  <color name="ic_launcher_background">#20211f</color>\n</resources>\n'
    )


if __name__ == "__main__":
    main()
