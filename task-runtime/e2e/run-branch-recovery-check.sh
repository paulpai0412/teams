#!/usr/bin/env bash
# Trusted check; untrusted candidate bytes are read-only, without home/network/env.
set -euo pipefail
if [[ $# -ne 2 || ! "$1" =~ ^(encode|decode|codec|groups)$ ]]; then
  echo 'usage: run-branch-recovery-check.sh encode|decode|codec|groups .' >&2
  exit 2
fi
phase=$1
candidate=$(realpath -e -- "$2")
[[ -d "$candidate/app" && ! -L "$candidate/app" ]] || exit 2
fixture=$(realpath -e -- "$(dirname -- "$0")/fixtures/branch-recovery")
node_bin=$(realpath -e -- "$(command -v node)")
exec bwrap --unshare-all --die-with-parent --clearenv \
  --setenv HOME /tmp --setenv PATH /bin \
  --ro-bind /lib /lib --ro-bind /lib64 /lib64 --ro-bind /usr/lib /usr/lib \
  --dir /bin --ro-bind "$node_bin" /bin/node \
  --dir /work --ro-bind "$candidate/app" /work/app \
  --ro-bind "$fixture/check.mjs" /work/check.mjs \
  --tmpfs /tmp --dev /dev --proc /proc --chdir /work \
  /bin/node /work/check.mjs "$phase"
