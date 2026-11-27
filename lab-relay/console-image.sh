#!/bin/sh
set -eu

base=$(cd "$(dirname "$0")" && pwd)
binary=$("$base/install-new-api.sh")
node=$(node -p 'process.execPath')
context=$(mktemp -d)
trap 'rm -rf "$context"' EXIT
trap 'exit 1' HUP INT TERM

install -D -m 755 "$binary" "$context/rootfs/bin/new-api"
install -D -m 755 "$node" "$context/rootfs/bin/node"
install -D -m 644 "$base/console-container.mjs" "$context/rootfs/app/console-container.mjs"
install -D -m 644 "$base/relay-demo.mjs" "$context/rootfs/app/relay-demo.mjs"
ldd "$binary" "$node" | awk '$3 ~ /^\// { print $3 } $1 ~ /^\// && $1 !~ /:$/ { print $1 }' |
  sort -u | while IFS= read -r library; do
    install -D -m 755 "$library" "$context/rootfs$library"
  done

cat >"$context/Dockerfile" <<'EOF'
FROM scratch
COPY rootfs/ /
WORKDIR /data
ENTRYPOINT ["/bin/node", "/app/console-container.mjs"]
EOF

docker build --network=none --quiet "$context"
