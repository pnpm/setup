# Setup pnpm with runtime

Install pnpm **and** a JavaScript runtime (Node.js, Bun, or Deno) in a single GitHub Actions step.

The action installs pnpm from the standalone `@pnpm/exe` package (no system Node.js required) and then uses `pnpm runtime set` to install the requested runtime. The runtime binary is placed on `PATH` for subsequent steps, replacing the need for `actions/setup-node`, `oven-sh/setup-bun`, or `denoland/setup-deno`.

If your `package.json` declares `devEngines.runtime`, the action picks up the runtime and version from there automatically — no inputs required.

## Inputs

| Name | Description |
|------|-------------|
| `version` | Version of pnpm to install. Optional when `packageManager` is set in `package.json`. |
| `dest` | Where to store pnpm files. Defaults to `~/setup-pnpm`. |
| `runtime` | `node`, `bun`, or `deno`. Optional — defaults to `devEngines.runtime` in `package.json`. |
| `runtime_version` | Version to install (e.g. `22`, `lts`, `latest`, `^24.4.0`). Falls back to `devEngines.runtime` version, then to `lts` (for `node`) or `latest`. |
| `run_install` | If specified, run `pnpm install`. See [action-setup docs](https://github.com/pnpm/action-setup#run_install) for the schema. |
| `cache` | Cache the pnpm store directory. Default: `false`. |
| `cache_dependency_path` | Path(s) to the pnpm lockfile, used to compute the cache key. Default: `pnpm-lock.yaml`. |
| `package_json_file` | Path to `package.json` (relative to `GITHUB_WORKSPACE`). Default: `package.json`. |

## Outputs

| Name | Description |
|------|-------------|
| `dest` | Expanded path of `dest`. |
| `bin_dest` | Directory containing the `pnpm` / `pnpx` binaries. |
| `runtime` | Name of the installed runtime, or empty string if none was installed. |
| `runtime_version` | Resolved version of the installed runtime, or empty string if none was installed. |

## Usage

### Install pnpm + Node.js via `devEngines.runtime`

```json
// package.json
{
  "packageManager": "pnpm@11.0.4",
  "devEngines": {
    "runtime": { "name": "node", "version": "^22.0.0", "onFail": "download" }
  }
}
```

```yaml
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
      - uses: pnpm/action-setup-runtime@v1
      - run: node --version
      - run: pnpm install
      - run: pnpm test
```

### Matrix: test on multiple Node versions

```yaml
jobs:
  test:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        node: [20, 22, 24]
    steps:
      - uses: actions/checkout@v6
      - uses: pnpm/action-setup-runtime@v1
        with:
          runtime: node
          runtime_version: ${{ matrix.node }}
      - run: pnpm install
      - run: pnpm test
```

### Install Bun or Deno

```yaml
- uses: pnpm/action-setup-runtime@v1
  with:
    runtime: bun
    runtime_version: latest

- uses: pnpm/action-setup-runtime@v1
  with:
    runtime: deno
    runtime_version: '2'
```

### Cache the pnpm store

```yaml
- uses: pnpm/action-setup-runtime@v1
  with:
    cache: true
- run: pnpm install
```

## How it works

1. The action installs `@pnpm/exe` (a Node.js-bundled standalone build of pnpm) into `dest`, then self-updates to the requested pnpm version.
2. `PNPM_HOME` is exported and `$PNPM_HOME/bin` is added to `PATH`.
3. The action runs `pnpm runtime set <name> <version> -g`, which downloads the requested runtime into `$PNPM_HOME/bin` — making `node`, `bun`, or `deno` available to later workflow steps.

## License

[MIT](./LICENSE.md)
