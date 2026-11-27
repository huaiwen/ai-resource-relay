#!/bin/sh
set -eu

version=v1.0.0-rc.51
directory=${RELAY_INSTALL_DIR:-"${XDG_STATE_HOME:-$HOME/.local/state}/ai-resource-relay"}
case "$(uname -s):$(uname -m)" in
  Linux:x86_64)
    asset="new-api-$version"
    digest=a42f4559790021ffec8a609182cf142b430f822cf420270105422c800c519157 ;;
  Linux:aarch64|Linux:arm64)
    asset="new-api-arm64-$version"
    digest=e02b8643e65910a0115452e5f7a43ee2fd30672ebcd6c7d49428e06746260c81 ;;
  *) printf '%s\n' 'The pinned upstream release requires Linux amd64 or arm64.' >&2; exit 1 ;;
esac

umask 077
mkdir -p "$directory"
directory=$(cd "$directory" && pwd)
binary="$directory/$asset"
if [ -x "$binary" ] && printf '%s  %s\n' "$digest" "$binary" | sha256sum -c --status; then
  printf '%s\n' "$binary"
  exit 0
fi
download=$(mktemp "$directory/.new-api.XXXXXX")
trap 'rm -f "$download"' EXIT
trap 'exit 1' HUP INT TERM
curl --fail --silent --show-error --location --retry 2 --max-time 180 \
  "https://github.com/QuantumNous/new-api/releases/download/$version/$asset" -o "$download"
printf '%s  %s\n' "$digest" "$download" | sha256sum -c --status
chmod 700 "$download"
mv -f "$download" "$binary"
printf '%s\n' "$binary"
