# Setup pnpm with runtime

Install pnpm **and** a JavaScript runtime (Node.js, Bun, or Deno) in a single GitHub Actions step.

Since v12, pnpm is a standalone executable — the action downloads the native binary for the runner's platform directly from the npm registry (no Node.js or npm needed) and then uses `pnpm runtime set` to install the requested runtime. The runtime binary is placed on `PATH` for subsequent steps, replacing the need for `actions/setup-node`, `oven-sh/setup-bun`, or `denoland/setup-deno`. `pnpm install` runs automatically when a `package.json` is present.

> [!NOTE]
> This action installs pnpm v12 and newer only. To install pnpm 11 or older (which are Node.js programs, not standalone executables), use [`pnpm/action-setup`](https://github.com/pnpm/action-setup) instead.

If your `package.json` declares `devEngines.runtime`, the action picks up the runtime and version from there automatically — no inputs required.

## Inputs

| Name | Description |
|------|-------------|
| `version` | Version of pnpm to install: an exact version, a semver range (`^12.0.0`), or a dist-tag (`next-12`). Must resolve to v12 or newer. Optional when `packageManager` or `devEngines.packageManager` is set in `package.json`. |
| `dest` | Where to store pnpm files. Defaults to `~/setup-pnpm`. |
| `runtime` | Runtime spec, in `<name>` or `<name>@<version>` form (e.g. `node@22`, `node@lts`, `bun@latest`, `deno@2`). Supported names: `node`, `bun`, `deno`. When the version is omitted, falls back to `devEngines.runtime` in `package.json`, then to `lts` (for `node`) / `latest`. If the input itself is omitted, the action reads `devEngines.runtime` from `package.json`. |
| `cache` | Cache the pnpm store directory. Default: `false`. |
| `cache-dependency-path` | Path(s) to the pnpm lockfile, used to compute the cache key. Default: `pnpm-lock.yaml`. |
| `package-json-file` | Path to `package.json` (relative to `GITHUB_WORKSPACE`). Default: `package.json`. |
| `install` | Run `pnpm install` after setup. Default: `true`. Set to `false` for jobs that only need pnpm itself (e.g. `pnpm audit`, lockfile-only regeneration). |

## Outputs

| Name | Description |
|------|-------------|
| `dest` | Expanded path of `dest`. |
| `bin-dest` | Directory containing the `pnpm` / `pnpx` binaries. |
| `runtime-name` | Name of the installed runtime, or empty string if none was installed. |
| `runtime-version` | Resolved version of the installed runtime, or empty string if none was installed. |

## Usage

### Install pnpm + Node.js via `devEngines.runtime`

```json
// package.json
{
  "packageManager": "pnpm@12.0.0-alpha.17",
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
      - uses: pnpm/setup@v1
      - run: node --version
      - run: pnpm test
```

`pnpm install` runs automatically because the workspace has a `package.json`.

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
      - uses: pnpm/setup@v1
        with:
          runtime: node@${{ matrix.node }}
      - run: pnpm test
```

### Install Bun or Deno

```yaml
- uses: pnpm/setup@v1
  with:
    runtime: bun@latest

- uses: pnpm/setup@v1
  with:
    runtime: deno@2
```

### Cache the pnpm store

```yaml
- uses: pnpm/setup@v1
  with:
    cache: true
```

### Skip `pnpm install`

For jobs that only need pnpm itself — e.g. `pnpm audit`, lockfile-only regeneration — set `install: false`:

```yaml
- uses: pnpm/setup@v1
  with:
    install: false
- run: pnpm audit
```

## How it works

1. The action resolves the requested version (exact, range, or dist-tag) against the npm registry, downloads the `@pnpm/exe.<os>-<arch>` tarball for the runner's platform, verifies its integrity, and places the `pnpm` executable (plus the `pnpx`, `pn`, and `pnx` aliases) into `dest`. No Node.js or npm is involved.
2. `PNPM_HOME` is exported and `dest` plus `$PNPM_HOME/bin` are added to `PATH`.
3. The action runs `pnpm runtime set <name> <version> -g`, which downloads the requested runtime into `$PNPM_HOME/bin` — making `node`, `bun`, or `deno` available to later workflow steps.
4. If a `package.json` exists in the workspace, the action runs `pnpm install` (unless `install: false` is set). When the `runtime` input is set, `--no-runtime` is appended so the just-installed runtime isn't shadowed by a different version declared in `devEngines.runtime`.

## License

[MIT](./LICENSE)
