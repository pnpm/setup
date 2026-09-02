# Setup pnpm with runtime

Install pnpm **and** a JavaScript runtime (Node.js, Bun, or Deno) in a single GitHub Actions step.

pnpm ships a self-contained release binary — the action downloads it for the runner's platform from the npm registry, refusing anything whose npm signature or checksum does not check out (no Node.js or npm needed) and then uses `pnpm runtime set` to install the requested runtime. The runtime binary is placed on `PATH` for subsequent steps, replacing the need for `actions/setup-node`, `oven-sh/setup-bun`, or `denoland/setup-deno`. `pnpm install` runs automatically when a `package.json` is present.

> [!NOTE]
> `pnpm/setup@v2` installs pnpm v11 and newer only — it relies on pnpm's self-contained release binaries and the `pnpm runtime` command, both available from v11. `v1` installed pnpm through npm and could set up pnpm 10; if you need pnpm 10 or older, use [`pnpm/action-setup`](https://github.com/pnpm/action-setup) instead.
>
> One caveat: pnpm v11 publishes no binary for Intel macOS (`darwin-x64`); use v12 or newer on Intel macOS runners.

If your `package.json` declares `devEngines.runtime`, the action picks up every runtime and version from there automatically — no inputs required.

Only one version of each runtime can be installed globally. If a runtime name is declared more than once, the action emits a GitHub warning annotation and installs the last declared version while retaining the position of its first declaration.

## Inputs

| Name | Description |
|------|-------------|
| `version` | Version of pnpm to install: an exact version, a semver range (`^12.0.0`), or a dist-tag (`next-12`). Must resolve to v11 or newer. Optional when `packageManager` or `devEngines.packageManager` is set in `package.json`. |
| `dest` | Where to store pnpm files. Defaults to `~/setup-pnpm`. |
| `runtime` | Runtime spec, in `<name>` or `<name>@<version>` form (e.g. `node@22`, `node@lts`, `bun@latest`, `deno@2`). Supported names: `node`, `bun`, `deno`. When the version is omitted, falls back to `devEngines.runtime` in `package.json`, then to `lts` (for `node`) / `latest`. If the input itself is omitted, the action installs every entry in `devEngines.runtime` from `package.json`. |
| `node-version-file` | File containing the Node.js version to install, relative to `working-directory`. Supports plain files such as `.node-version` and `.nvmrc`, plus the `node` or `nodejs` entry in `.tool-versions`. An explicit version in `runtime` takes precedence. |
| `cache` | Cache the pnpm store directory and restore it before installing the runtimes. Default: `false`. |
| `cache-dependency-path` | Path(s) to the pnpm lockfile, used to compute the cache key. Relative to `GITHUB_WORKSPACE`. Defaults to `pnpm-lock.yaml` inside `working-directory`. |
| `working-directory` | Directory the project lives in, relative to `GITHUB_WORKSPACE`. Config is read from the manifest there, `pnpm install` runs there, and `node-version-file` plus the default `cache-dependency-path` resolve relative to it. Default: `.`. |
| `package-json-file` | **Deprecated** — use `working-directory`. Still honoured on its own; the directory containing the file becomes the working directory. |
| `install` | Run `pnpm install` after setup. Default: `true`. Set to `false` for jobs that only need pnpm itself (e.g. `pnpm audit`, lockfile-only regeneration). |
| `require-lockfile` | Fail unless a `pnpm-lock.yaml` already describes the install; runs `pnpm install --frozen-lockfile`. Default: `false`. |
| `token` | No longer used. pnpm is fetched from the npm registry and verified against npm's signature, so the action makes no GitHub API request. Kept so workflows that pass it keep working. |

## Outputs

| Name | Description |
|------|-------------|
| `dest` | Expanded path of `dest`. |
| `bin-dest` | Directory containing the `pnpm` / `pnpx` binaries. |
| `runtime-name` | Name of the first installed runtime, or empty string if none was installed. |
| `runtime-version` | Resolved version of the first installed runtime, or empty string if none was installed. |
| `runtimes` | JSON array of every installed runtime in declaration order, as `{ "name": string, "version": string }` objects. Returns `[]` when none were installed. |
| `cache-hit` | Whether the pnpm store cache matched the exact primary key. |

## Usage

### Install pnpm + Node.js via `devEngines.runtime`

```json
// package.json
{
  "packageManager": "pnpm@12.0.0",
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
      - uses: actions/checkout@v7
      - uses: pnpm/setup@v2
      - run: node --version
      - run: pnpm test
```

`pnpm install` runs automatically because the workspace has a `package.json`.

### Install Node.js from a version file

```yaml
- uses: pnpm/setup@v2
  with:
    node-version-file: .node-version
```

Plain version files must contain one selector. `.nvmrc` comments are accepted,
and common nvm selectors are translated to pnpm's equivalents: `node` and
`stable` become `latest`, `lts/*` becomes `lts`, and `lts/<name>` becomes the
LTS name. In `.tool-versions`, the first version after `node` or `nodejs` is
used. Values that pnpm cannot install, such as `system`, `path:...`, and
`ref:...`, fail the setup step.

When no `runtime` input is present, the file adds Node.js and leaves any Bun or
Deno declarations in `devEngines.runtime` intact. `runtime: node` takes its
version from the file, while `runtime: node@22` remains authoritative.

### Matrix: test on multiple Node versions

```yaml
jobs:
  test:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        node: [22, 24, 26]
    steps:
      - uses: actions/checkout@v7
      - uses: pnpm/setup@v2
        with:
          runtime: node@${{ matrix.node }}
      - run: pnpm test
```

### Install Bun or Deno

```yaml
- uses: pnpm/setup@v2
  with:
    runtime: bun@latest

- uses: pnpm/setup@v2
  with:
    runtime: deno@2
```

### A project in a subdirectory

When the project is not at the repository root — a site in `docs/`, an app in
`web/` — point the action at it:

```yaml
- uses: pnpm/setup@v2
  with:
    working-directory: docs
    cache: true
```

`pnpm install` then runs in `docs`, `packageManager` and `devEngines` are read
from `docs/package.json`, `node-version-file` resolves from `docs`, and the
cache key comes from `docs/pnpm-lock.yaml`.
Set `cache-dependency-path` yourself and it stays relative to the repository
root, as it has always been — only its default follows the working directory.
Without this the install runs at the repository root,
where pnpm finds no manifest, prints `Already up to date` and exits `0` having
installed nothing — a green setup step followed by a confusing failure later.

A project *inside* a pnpm workspace does not need this. pnpm locates the
workspace root by walking up from wherever it starts, so an install anywhere in
the workspace installs the whole workspace. Reach for `working-directory` when
the project's own root is not the repository root.

### Cache the pnpm store

```yaml
- uses: pnpm/setup@v2
  with:
    cache: true
```

The cache is restored before the runtimes are installed, so a cached runtime
does not need to be downloaded again. Cache keys include both the requested
runtime selectors and the versions actually installed. Reordering
`devEngines.runtime` does not change the key — the same set of runtimes
produces the same store.

### Lockfile verification cache

pnpm v11 and newer check every lockfile entry before installing it — that each
entry pins an integrity hash, that a pinned tarball URL matches the registry's
own metadata, and, where configured, your `minimumReleaseAge` and `trustPolicy`
policies. The verdict is memoized in a sub-kilobyte file, so an unchanged
lockfile is not re-checked against the registry.

The action restores and saves that file on every run, independently of the
`cache` input, because a job that starts without it pays for the check every
time. On a repository with ~2000 lockfile entries and a warm store:

| | without the log | with it |
| --- | --- | --- |
| `minimumReleaseAge` + `trustPolicy` | 13.5s | 1.5s |
| no policies configured | 6.7s | 1.6s |

Reusing a verdict is not a weaker check: pnpm re-verifies whenever the lockfile
content changes, and whenever the recorded policy is looser than the one now
configured.

The log is uploaded as soon as the install that produced it finishes, not at
the end of the job, so nothing the job runs afterwards — its tests, its build,
any later step — can alter what other jobs restore. Dependency lifecycle
scripts are the exception, since they run inside the install itself, ahead of
the upload: pnpm refuses to run them unless the repository allow-lists the
package through `allowBuilds`, and a package on that list can already run code
in the job.

Before uploading, the action checks that the log grew the way an install grows
it: every record that predated the install still there, and no more new records
than installs it ran. A dependency's script that slips an extra record in is
caught by that, and the log is not cached — the next job re-verifies, which
costs seconds and nothing else.

A job that installs in a step of its own rather than through this action is
saved at the end of the job instead, since that is the first moment the log is
known to be complete. The record count cannot be bounded there, so only the
"nothing disappeared" half of the check applies.

### Require a lockfile

```yaml
- uses: pnpm/setup@v2
  with:
    require-lockfile: true
```

Fails unless `pnpm-lock.yaml` already describes the install, and runs
`pnpm install --frozen-lockfile` when it does. If no lockfile is found — in
`working-directory` or above it, the way pnpm searches — the action fails
before running pnpm, saying so directly rather than through an install that
was never going to succeed.

This is narrower than it sounds, and worth understanding before reaching for
it. pnpm refuses to update an *existing* lockfile when it detects CI, and
GitHub Actions always sets `CI`, so an out-of-date lockfile already fails a
plain install — on pnpm 11 and 12 alike. What that default does not do is
require a lockfile to exist: with none at all, `pnpm install` resolves from
the registry, writes one and exits `0`. Set `require-lockfile` when a missing
lockfile should fail the job instead of silently installing unpinned
dependencies.

### Skip `pnpm install`

For jobs that only need pnpm itself — e.g. `pnpm audit`, lockfile-only regeneration — set `install: false`:

```yaml
- uses: pnpm/setup@v2
  with:
    install: false
- run: pnpm audit
```

## How it works

1. The action resolves the requested version (exact, range, or dist-tag) against the npm registry, then downloads the matching self-contained release archive for the runner's platform (`pnpm-<os>-<arch>.tar.gz`, or `pnpm-win32-<arch>.zip` on Windows) from pnpm's GitHub releases. It verifies the archive against the SHA-256 digest GitHub publishes for the asset, extracts the `pnpm` executable (and, for pnpm builds that need it, its bundled `dist/`), and links the `pnpx`, `pn`, and `pnx` aliases into `dest`. No Node.js or npm is involved.
2. `PNPM_HOME` is exported and `dest` plus `$PNPM_HOME/bin` are added to `PATH`.
3. The action runs `pnpm runtime set <name> <version> -g` for every requested runtime, which downloads them into `$PNPM_HOME/bin` and makes them available to later workflow steps. It then disables context-aware shims for every installed runtime; see [Context-aware global shims](#context-aware-global-shims).
4. If a `package.json` exists in the workspace, the action runs `pnpm install` (unless `install: false` is set). When runtimes were installed, `--no-runtime` is appended because the action has already processed `devEngines.runtime`.

### Context-aware global shims

pnpm 12 links global runtime bins as context-aware shims: running `node` inside a project switches to the version that project pins in `devEngines.runtime`, fetching it on demand. In a workflow that is rarely what you want — a matrix job asking for `node@22` would run the repository's pinned version instead, and even when the two versions agree pnpm materializes a second copy outside `$PNPM_HOME`.

So whenever the action installs a runtime, it exports `PNPM_CONFIG_GLOBAL_SHIMS` with that runtime disabled (`{"node":false}`), leaving every other runtime at pnpm's defaults. To keep the switching behaviour, set the variable yourself — the action never overwrites a value the workflow already provides:

```yaml
- uses: pnpm/setup@v2
  env:
    PNPM_CONFIG_GLOBAL_SHIMS: '{"node":"auto"}'
  with:
    runtime: node@22
```

## License

[MIT](./LICENSE)
