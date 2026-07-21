#! /bin/sh
# shellcheck disable=SC2155,SC2088
# Input env var names mirror how the Actions runner encodes them: INPUT_ +
# uppercased input name, hyphens preserved. Hyphenated names are not valid
# shell identifiers, so they are passed via `env`.
export HOME="$(pwd)"
exec env \
  INPUT_VERSION=next-12 \
  INPUT_DEST='~/pnpm.temp' \
  INPUT_RUNTIME='node@lts' \
  INPUT_CACHE=false \
  'INPUT_CACHE-DEPENDENCY-PATH=pnpm-lock.yaml' \
  'INPUT_PACKAGE-JSON-FILE=package.json' \
  INPUT_INSTALL=true \
  node dist/index.js
