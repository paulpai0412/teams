#!/usr/bin/env bash
# Trusted, credential-free checker for the disposable record-codec E2E.
# The candidate is untrusted: only its app/ bytes are mounted, read-only, with
# no network, home directory, host /proc or host environment in the sandbox.
set -euo pipefail
if [[ $# -ne 2 || ("$1" != smoke && "$1" != regression) ]]; then
  echo 'usage: run-review-product-check.sh smoke|regression .' >&2
  exit 2
fi
mode=$1
candidate=$(realpath -e -- "$2")
[[ -d "$candidate/app" && ! -L "$candidate/app" ]] || exit 2
fixture=$(realpath -e -- "$(dirname -- "$0")/fixtures/review-product-revision")
node_bin=$(realpath -e -- "$(command -v node)")
exec bwrap --unshare-all --die-with-parent --clearenv \
  --setenv HOME /tmp --setenv PATH /bin \
  --ro-bind /lib /lib --ro-bind /lib64 /lib64 --ro-bind /usr/lib /usr/lib \
  --dir /bin --ro-bind "$node_bin" /bin/node \
  --dir /work --ro-bind "$candidate/app" /work/app \
  --ro-bind "$fixture/$mode.mjs" /work/check.mjs \
  --tmpfs /tmp --dev /dev --proc /proc --chdir /work \
  /bin/node /work/check.mjs
