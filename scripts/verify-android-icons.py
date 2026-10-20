#!/usr/bin/env python3
"""Check the actual APK launcher resources, not just the source icon directory."""
import io
import re
from pathlib import Path
import subprocess
import sys
import zipfile

from PIL import Image
from importlib.util import module_from_spec, spec_from_file_location

root = Path(__file__).resolve().parents[1]
sys.dont_write_bytecode = True
spec = spec_from_file_location("android_brand_icons", root / "scripts/android-brand-icons.py")
brand = module_from_spec(spec)
spec.loader.exec_module(brand)
pwa = Image.open(root / "public/icons/icon-maskable-dark-512.png")
apk = Path(sys.argv[1])
variant = sys.argv[2]
resources = subprocess.check_output(["aapt", "dump", "--values", "resources", str(apk)], text=True)
entries = {}
config = ""
lines = resources.splitlines()
for index, line in enumerate(lines):
    match = re.match(r"\s+config (.+):$", line)
    if match:
        config = match[1]
    match = re.search(r"resource 0x[0-9a-f]+ [^:]+:mipmap/(ic_launcher\w*):", line)
    if match and index + 1 < len(lines):
        value = re.search(r'\(string8\) "([^"]+)"', lines[index + 1])
        if value:
            entries[(config, match[1])] = value[1]
with zipfile.ZipFile(apk) as archive:
    for source in (root / "src-tauri/icons/android").glob("mipmap-*/*.png"):
        density = source.parent.name
        entry = entries.get((density.removeprefix("mipmap-"), source.stem))
        if not entry:
            raise SystemExit(f"Missing APK brand resource: {density}/{source.name}")
        actual = Image.open(io.BytesIO(archive.read(entry))).convert("RGBA")
        expected = Image.open(source).convert("RGBA")
        size = {"mdpi": 48, "hdpi": 72, "xhdpi": 96, "xxhdpi": 144, "xxxhdpi": 192}[density.removeprefix("mipmap-")]
        legacy, foreground = brand.launcher_images(pwa, size)
        branded = foreground if source.stem == "ic_launcher_foreground" else legacy
        if expected.size != branded.size or expected.tobytes() != branded.tobytes():
            raise SystemExit(f"Android icon differs from dark PWA brand: {source.name}")
        if actual.size != expected.size or actual.tobytes() != expected.tobytes():
            raise SystemExit(f"APK launcher icon differs from brand source: {entry}")
    adaptive = entries.get(("anydpi-v26", "ic_launcher"))
    if not adaptive:
        raise SystemExit("Missing adaptive launcher resource")
    archive.getinfo(adaptive)

badging = subprocess.check_output(["aapt", "dump", "badging", str(apk)], text=True)
if f"application: label='TJUClaw' icon='{adaptive}'" not in badging:
    raise SystemExit("APK application does not use the branded adaptive launcher")
print(f"Verified {variant} APK branded launcher and all density/round/foreground images")
