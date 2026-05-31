# depshield-cli

`depshield-cli` is a small, dependency-free Node.js CLI for bootstrapping safer JavaScript package-manager defaults in npm, pnpm, and Bun projects.

It is intended for project owners who want a quick, reviewable way to add dependency supply-chain guardrails:

- delay freshly published package versions before they can be installed
- reduce automatic dependency lifecycle script execution
- restrict Git and remote tarball dependencies for npm projects
- add lockfile and clean-install checks to CI
- add repeatable `security:*` scripts to `package.json`
- optionally scaffold a hardened devcontainer starter

The generated files are deliberately plain text so the result is easy to inspect, tune, and commit.

## Credit

The security advice behind this tool was inspired by Better Stack's YouTube coverage of npm supply-chain attacks, especially this timestamped Better Stack video: [https://www.youtube.com/watch?v=Wq6yMdt11LM&t=121s](https://www.youtube.com/watch?v=Wq6yMdt11LM&t=121s).

That Better Stack guidance highlights practical defenses such as committed lockfiles, clean installs in CI, package release-age delays, and restricting dependency lifecycle scripts. `depshield-cli` packages those ideas into a repeatable CLI workflow for JavaScript projects. The related Better Stack Community write-up, [Anatomy of a Supply Chain Attack: The Axios NPM Breach](https://betterstack.com/community/guides/scaling-nodejs/axios-npm-supply-chain-attack/) by Stanley Ulili, is also useful background.

## Requirements

- Node.js 18 or newer
- A target project with a `package.json`
- Git, if you want to review and commit the generated changes
- Current npm, pnpm, or Bun versions that support the hardening settings you enable

Package-manager security settings evolve. If your installed package manager ignores or warns about a generated setting, upgrade the package manager or adjust the generated file before committing it.

## Quick Start

From this repository:

```bash
node ./bin/depshield.js apply --path /path/to/project --dry-run
node ./bin/depshield.js apply --path /path/to/project
node ./bin/depshield.js check --path /path/to/project
```

For the current directory:

```bash
node ./bin/depshield.js apply --path . --dry-run
node ./bin/depshield.js apply --path .
```

For many projects under one directory:

```bash
node ./bin/depshield.js apply --path ~/code --recursive --dry-run
node ./bin/depshield.js apply --path ~/code --recursive
```

Always run with `--dry-run` first, then inspect the final diff:

```bash
git diff
git status --short
```

## Install For Local Development

Link the CLI while developing it:

```bash
npm link
depshield apply --path /path/to/project --dry-run
depshield check --path /path/to/project
```

You can remove the link later with:

```bash
npm unlink -g depshield-cli
```

## Commands

### `apply`

Writes the recommended hardening files and package scripts.

```bash
depshield apply --path ./project
```

Use `--dry-run` to preview file changes without writing:

```bash
depshield apply --path ./project --dry-run
```

### `init`

Alias for `apply`.

```bash
depshield init --path ./project --dry-run
```

### `check`

Checks whether expected hardening files and CI workflow are present.

```bash
depshield check --path ./project
```

`check` exits non-zero when any check fails, so it can be used in CI.

### Help

Run the CLI with no command, or add `--help` after a command:

```bash
depshield
depshield apply --help
```

## Options

| Option | Default | Description |
| --- | --- | --- |
| `--path <dir>` | current working directory | Target project directory or recursive search root. |
| `--recursive`, `-r` | `false` | Find every child directory with a `package.json`. Skips common generated directories like `node_modules`, `.git`, `dist`, `build`, `coverage`, `.next`, and `.turbo`. |
| `--dry-run` | `false` | Print the files that would change without writing them. |
| `--verbose` | `false` | Show unchanged managed files during `apply`. |
| `--release-age-days <n>` | `7` | Minimum package age before install. Converted to each package manager's expected unit. |
| `--pm <value>` | `auto` | Package managers to configure. Use `auto` or a comma-separated list such as `npm`, `pnpm`, `bun`, or `npm,pnpm`. |
| `--npm-allow-git <mode>` | `root` | npm `allow-git` mode: `all`, `root`, or `none`. |
| `--npm-allow-remote <mode>` | `root` | npm `allow-remote` mode: `all`, `root`, or `none`. |
| `--no-lockfile-lint` | enabled | Do not add the `security:lockfile` script. |
| `--no-ci` | enabled | Do not create `.github/workflows/depshield.yml`. |
| `--devcontainer` | disabled | Add `.devcontainer/devcontainer.json` with hardened Node defaults. |
| `--no-pin-exact` | enabled | Do not set npm `save-exact=true`. |

## Package Manager Detection

With `--pm auto`, `depshield-cli` detects package managers from:

- the `packageManager` field in `package.json`
- lockfiles such as `package-lock.json`, `npm-shrinkwrap.json`, `pnpm-lock.yaml`, `bun.lock`, or `bun.lockb`

If no package-manager signal is found, it configures npm, pnpm, and Bun. This is useful for a new project, but existing teams may prefer being explicit:

```bash
depshield apply --path ./project --pm npm --dry-run
depshield apply --path ./project --pm pnpm --dry-run
depshield apply --path ./project --pm bun --dry-run
depshield apply --path ./project --pm npm,pnpm --dry-run
```

## Generated Files

Depending on the detected or requested package managers, `apply` can create or update:

| File | Purpose |
| --- | --- |
| `.npmrc` | Adds npm release-age gating, lifecycle-script restrictions, Git and remote dependency restrictions, exact-save defaults, audit defaults, and strict peer dependency behavior. |
| `pnpm-workspace.yaml` | Adds pnpm release-age gating, trust policy, exotic subdependency blocking, store integrity checks, and package manager version management. Existing workspace package globs are preserved. |
| `bunfig.toml` | Adds Bun install hardening, including release-age gating and disabled install scripts. |
| `package.json` | Adds `security:install`, `security:check`, and optionally `security:lockfile`; adds Bun `trustedDependencies` starter data; adds `devEngines.packageManager`. |
| `.github/workflows/depshield.yml` | Adds a clean install workflow for pushes and pull requests, then runs the lockfile check when available. |
| `.devcontainer/devcontainer.json` | Only when `--devcontainer` is passed. Adds a starter Node devcontainer with hardened npm defaults. |

`package.json` is rewritten with two-space JSON formatting. Review the diff before committing.

## What Gets Added

### Release-age gating

The default `--release-age-days 7` tells package managers to avoid newly published package versions for seven days. This reduces exposure to fast-moving package hijacks where malicious versions are discovered and removed shortly after publication.

The CLI converts the value per package manager:

- npm: days in `.npmrc`
- pnpm: minutes in `pnpm-workspace.yaml`
- Bun: seconds in `bunfig.toml`

Example with a three-day delay:

```bash
depshield apply --path ./project --release-age-days 3 --dry-run
```

### Lifecycle script restrictions

Dependency lifecycle scripts are a common execution path for malicious packages. `depshield-cli` configures package-manager defaults to reduce automatic script execution and starts Bun projects with an explicit `trustedDependencies` list.

Some legitimate packages need install scripts for native builds or generated assets. Treat those as explicit approvals: review the package, pin versions, and document the exception.

### Lockfile hygiene

For npm and Bun projects, `depshield-cli` can add:

```json
"security:lockfile": "npx lockfile-lint --path package-lock.json --allowed-hosts npm --validate-https --validate-package-names --validate-integrity"
```

The exact lockfile name is selected from the detected package manager. The script uses `npx`; teams that require fully pinned tooling can add `lockfile-lint` as a dev dependency and adjust the script.

### Clean install workflow

The generated GitHub Actions workflow:

- checks out the repository
- sets up Node 22
- enables Corepack
- runs the package manager's clean install command
- runs `npm run security:lockfile --if-present`

Generated install commands are:

| Package manager | CI install command |
| --- | --- |
| pnpm | `pnpm install --frozen-lockfile` |
| Bun | `bun install --frozen-lockfile` |
| npm | `npm ci` |

## Recommended Workflow

1. Start with a dry run.

   ```bash
   depshield apply --path ./project --dry-run
   ```

2. Apply the changes.

   ```bash
   depshield apply --path ./project
   ```

3. Review every changed file.

   ```bash
   git diff
   ```

4. Run the target project's install and tests.

   ```bash
   npm run security:install
   npm test
   ```

5. Run the depshield check.

   ```bash
   depshield check --path ./project
   ```

6. Commit the reviewed changes.

   ```bash
   git add .
   git commit -m "Add dependency supply-chain hardening"
   ```

## Common Recipes

### Harden an npm project only

```bash
depshield apply --path ./project --pm npm --dry-run
depshield apply --path ./project --pm npm
```

### Harden a pnpm monorepo

```bash
depshield apply --path ./repo --pm pnpm --dry-run
depshield apply --path ./repo --pm pnpm
```

If you want to apply settings to every package project under a larger directory:

```bash
depshield apply --path ./workspace --recursive --pm pnpm --dry-run
```

### Use a shorter release quarantine

```bash
depshield apply --path ./project --release-age-days 3 --dry-run
```

### Disable GitHub Actions generation

```bash
depshield apply --path ./project --no-ci --dry-run
```

### Skip lockfile-lint script generation

```bash
depshield apply --path ./project --no-lockfile-lint --dry-run
```

### Add a devcontainer starter

```bash
depshield apply --path ./project --devcontainer --dry-run
depshield apply --path ./project --devcontainer
```

### Block npm Git and remote tarball dependencies more aggressively

```bash
depshield apply --path ./project --pm npm --npm-allow-git none --npm-allow-remote none --dry-run
```

## Limitations

`depshield-cli` is a bootstrap tool, not a full software composition analysis platform.

It does not:

- prove that dependencies are safe
- scan packages for malware
- rotate npm, GitHub, cloud, or CI secrets
- configure OIDC trusted publishing
- replace manual review of dependency diffs
- guarantee every generated package-manager setting is supported by old package-manager versions

Use it as one layer alongside lockfile review, dependency update discipline, vulnerability scanning, secret hygiene, least-privilege CI tokens, and short-lived publishing credentials.

## Developing This CLI

Available package scripts:

```bash
npm start -- apply --path . --dry-run
npm run check
npm run apply:dry
```

Direct local commands:

```bash
node ./bin/depshield.js
node ./bin/depshield.js apply --path . --dry-run
node ./bin/depshield.js check --path .
```

The CLI entry point is [`bin/depshield.js`](./bin/depshield.js). The implementation lives in [`src/main.js`](./src/main.js).

## License

MIT
