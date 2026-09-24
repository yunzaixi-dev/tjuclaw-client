#!/usr/bin/env bash
set -euo pipefail
shopt -s nullglob

packages=(src-tauri/target/release/bundle/deb/*.deb)
if (( $# > 1 )) || { (( $# == 0 )) && (( ${#packages[@]} != 1 )); }; then
  echo "Expected exactly one Debian package to smoke-test" >&2
  exit 1
fi
package="${1:-${packages[0]}}"
test -f "$package"
test "$(dpkg-deb -f "$package" Architecture)" = amd64

extracted="$(mktemp -d)"
log="$(mktemp)"
trap 'rm -rf "$extracted"; rm -f "$log"' EXIT
dpkg-deb -x "$package" "$extracted"
client="$extracted/usr/bin/tjuclaw-client"
test -x "$client"
test -s "$extracted/usr/share/applications/TJUClaw.desktop"
test -s "$extracted/usr/share/icons/hicolor/128x128/apps/tjuclaw-client.png"

GDK_BACKEND=x11 WEBKIT_DISABLE_COMPOSITING_MODE=1 "$client" >"$log" 2>&1 &
app=$!
trap 'kill "$app" 2>/dev/null || true; wait "$app" 2>/dev/null || true; rm -rf "$extracted"; rm -f "$log"' EXIT

for ((attempt = 0; attempt < 30; attempt++)); do
  if ! kill -0 "$app" 2>/dev/null; then
    cat "$log" >&2
    echo "Native application exited before WebKit started" >&2
    exit 1
  fi
  if pgrep -P "$app" -f '/WebKitWebProcess' >/dev/null; then
    sleep 2
    kill -0 "$app"
    echo "Packaged Linux application and WebKit page process are running"
    exit 0
  fi
  sleep 1
done

cat "$log" >&2
echo "WebKit page process did not start within 30 seconds" >&2
exit 1
