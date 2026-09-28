#!/usr/bin/env bash
# Trusted checks: candidate code runs without home, credentials, network or writes.
set -euo pipefail
if [[ $# -ne 2 || ! "$1" =~ ^(codec|groups|combined)$ ]]; then
  echo 'usage: run-multi-task-merge-check.sh codec|groups|combined .' >&2
  exit 2
fi
here=$(realpath -e -- "$(dirname -- "$0")")
if [[ "$1" != combined ]]; then
  exec bash "$here/run-branch-recovery-check.sh" "$1" "$2"
fi
candidate=$(realpath -e -- "$2")
[[ -d "$candidate/app" && ! -L "$candidate/app" ]] || exit 2
node_bin=$(realpath -e -- "$(command -v node)")
exec bwrap --unshare-all --die-with-parent --clearenv \
  --setenv HOME /tmp --setenv PATH /bin \
  --ro-bind /lib /lib --ro-bind /lib64 /lib64 --ro-bind /usr/lib /usr/lib \
  --dir /bin --ro-bind "$node_bin" /bin/node \
  --dir /work --ro-bind "$candidate/app" /work/app \
  --ro-bind "$here/fixtures/multi-task-merge/combined.mjs" /work/combined.mjs \
  --tmpfs /tmp --dev /dev --proc /proc --chdir /work \
  /bin/node /work/combined.mjs
