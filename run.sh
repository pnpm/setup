#! /bin/sh
# shellcheck disable=SC2155,SC2088
export HOME="$(pwd)"
export INPUT_VERSION=latest-11
export INPUT_DEST='~/pnpm.temp'
export INPUT_RUNTIME='node@lts'
export INPUT_CACHE=false
export INPUT_CACHE_DEPENDENCY_PATH=pnpm-lock.yaml
export INPUT_PACKAGE_JSON_FILE=package.json
exec node dist/index.js
