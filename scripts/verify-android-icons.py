#!/usr/bin/env python3
"""Check the actual APK launcher resources, not just the source icon directory."""
import io
import re
from pathlib import Path
import subprocess
import sys
import zipfile

from PIL import Image

root = Path(__file__).resolve().parents[1]
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
