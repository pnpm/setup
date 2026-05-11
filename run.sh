#! /bin/sh
# shellcheck disable=SC2155,SC2088
export HOME="$(pwd)"
export INPUT_VERSION=latest-11
export INPUT_DEST='~/pnpm.temp'
export INPUT_RUN_INSTALL=null
export INPUT_RUNTIME=node
export INPUT_RUNTIME_VERSION=lts
exec node dist/index.js
