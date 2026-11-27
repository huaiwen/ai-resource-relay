#!/bin/sh
set -eu

: "${SESSION_SECRET:?Provide a persistent random SESSION_SECRET from your secret manager}"
if [ "${#SESSION_SECRET}" -lt 32 ]; then
  printf '%s\n' 'SESSION_SECRET must contain at least 32 characters.' >&2
  exit 1
fi

base=$(dirname "$0")
binary=$("$base/install-new-api.sh")
state=${RELAY_DATA_DIR:-"${XDG_STATE_HOME:-$HOME/.local/state}/ai-resource-relay/gateway"}
umask 077
mkdir -p "$state"
cd "$state"
export HOST=127.0.0.1 PORT="${PORT:-3000}" SESSION_SECRET
export SQLITE_PATH="$PWD/gateway.sqlite" TRUSTED_PROXIES="${TRUSTED_PROXIES:-none}"
export DEFAULT_LANGUAGE="${DEFAULT_LANGUAGE:-zh-CN}"
exec "$binary" --log-dir "$PWD/logs"
