#!/usr/bin/env bash
set -euo pipefail

workspace=${1:?workspace required}
evidence_dir=${2:?evidence directory required}
script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
windows_node=$(cmd.exe /d /c where node 2>/dev/null | tr -d '\r' | head -n 1)
[[ -n "$windows_node" ]] || {
  echo "Windows Node.js not found" >&2
  exit 1
}
node_path=$(wslpath -u "$windows_node")
exec "$node_path" \
  "$(wslpath -w "$script_dir/browser-todo-check.mjs")" \
  "$(wslpath -w "$workspace")" \
  "$(wslpath -w "$evidence_dir")"
