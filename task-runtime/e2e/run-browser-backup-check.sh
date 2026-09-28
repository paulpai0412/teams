#!/usr/bin/env bash
# Trusted host browser check; arguments relocate with the staged candidate.
set -euo pipefail
if [[ $# -lt 2 || $# -gt 3 || ($# -eq 3 && "$3" != combined) ]]; then
  echo 'usage: run-browser-backup-check.sh WORKSPACE EVIDENCE_DIR [combined]' >&2
  exit 2
fi
script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
windows_node=$(cmd.exe /d /c where node 2>/dev/null | tr -d '\r' | head -n 1)
[[ -n "$windows_node" ]] || {
  echo 'Windows Node.js not found' >&2
  exit 1
}
node_path=$(wslpath -u "$windows_node")
extra=()
if [[ $# -eq 3 ]]; then extra=(combined); fi
exec "$node_path" "$(wslpath -w "$script_dir/browser-todo-backup-check.mjs")" \
  "$(wslpath -w "$1")" "$(wslpath -w "$2")" "${extra[@]}"
