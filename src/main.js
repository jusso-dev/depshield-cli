import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const DEFAULTS = {
  releaseAgeDays: 7,
  npmAllowGit: 'root',
  npmAllowRemote: 'root',
  pinExact: true,
  strictPeerDeps: true,
  lockfileLint: true,
  ci: true,
  devcontainer: false,
  packageManagers: 'auto',
};

const LOCKS = {
  npm: ['package-lock.json', 'npm-shrinkwrap.json'],
  pnpm: ['pnpm-lock.yaml'],
  bun: ['bun.lock', 'bun.lockb'],
};

export async function main(argv) {
  const { command, opts } = parseArgs(argv);
  if (!command || opts.help) return printHelp();

  const root = path.resolve(opts.path ?? process.cwd());
  const projects = opts.recursive ? await findProjects(root) : [root];
  if (projects.length === 0) throw new Error(`No package.json projects found under ${root}`);

  if (command === 'check') return checkProjects(projects, opts);
  if (command === 'apply' || command === 'init') return applyProjects(projects, opts);

  throw new Error(`Unknown command: ${command}`);
}

function parseArgs(argv) {
  const opts = { ...DEFAULTS, dryRun: false, recursive: false, verbose: false };
  const [command, ...rest] = argv;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--help' || a === '-h') opts.help = true;
    else if (a === '--path') opts.path = rest[++i];
    else if (a === '--recursive' || a === '-r') opts.recursive = true;
    else if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--verbose') opts.verbose = true;
    else if (a === '--release-age-days') opts.releaseAgeDays = Number(rest[++i]);
    else if (a === '--pm') opts.packageManagers = rest[++i];
    else if (a === '--npm-allow-git') opts.npmAllowGit = rest[++i];
    else if (a === '--npm-allow-remote') opts.npmAllowRemote = rest[++i];
    else if (a === '--no-lockfile-lint') opts.lockfileLint = false;
    else if (a === '--no-ci') opts.ci = false;
    else if (a === '--devcontainer') opts.devcontainer = true;
    else if (a === '--no-pin-exact') opts.pinExact = false;
    else throw new Error(`Unknown option: ${a}`);
  }
  if (!Number.isFinite(opts.releaseAgeDays) || opts.releaseAgeDays < 0) {
    throw new Error('--release-age-days must be a non-negative number');
  }
  if (!['all', 'none', 'root'].includes(opts.npmAllowGit)) throw new Error('--npm-allow-git must be all, none, or root');
  if (!['all', 'none', 'root'].includes(opts.npmAllowRemote)) throw new Error('--npm-allow-remote must be all, none, or root');
  return { command, opts };
}

async function findProjects(root) {
  const out = [];
  async function walk(dir) {
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    if (entries.some((e) => e.isFile() && e.name === 'package.json')) out.push(dir);
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (['node_modules', '.git', 'dist', 'build', 'coverage', '.next', '.turbo'].includes(e.name)) continue;
      await walk(path.join(dir, e.name));
    }
  }
  await walk(root);
  return out;
}

async function detectPackageManagers(projectDir, requested) {
  if (requested && requested !== 'auto') return new Set(requested.split(',').map((s) => s.trim()).filter(Boolean));
  const pms = new Set();
  const pkg = await readJson(path.join(projectDir, 'package.json'));
  if (pkg.packageManager?.startsWith('pnpm')) pms.add('pnpm');
  if (pkg.packageManager?.startsWith('npm')) pms.add('npm');
  if (pkg.packageManager?.startsWith('bun')) pms.add('bun');
  for (const [pm, files] of Object.entries(LOCKS)) for (const f of files) if (await exists(path.join(projectDir, f))) pms.add(pm);
  return pms.size ? pms : new Set(['npm', 'pnpm', 'bun']);
}

async function applyProjects(projects, opts) {
  for (const projectDir of projects) {
    const pms = await detectPackageManagers(projectDir, opts.packageManagers);
    const changes = [];
    if (pms.has('npm')) changes.push(...await npmChanges(projectDir, opts));
    if (pms.has('pnpm')) changes.push(...await pnpmChanges(projectDir, opts));
    if (pms.has('bun')) changes.push(...await bunChanges(projectDir, opts));
    changes.push(...await packageJsonChanges(projectDir, pms, opts));
    if (opts.ci) changes.push(...await ciChanges(projectDir, pms));
    if (opts.devcontainer) changes.push(...await devcontainerChanges(projectDir));
    await applyChanges(projectDir, changes, opts);
  }
}

async function checkProjects(projects, opts) {
  let failures = 0;
  for (const projectDir of projects) {
    const pms = await detectPackageManagers(projectDir, opts.packageManagers);
    console.log(`\n${rel(projectDir)} (${[...pms].join(', ')})`);
    const checks = [];
    if (pms.has('npm')) checks.push(['.npmrc hardening', await hasFileWith(projectDir, '.npmrc', ['min-release-age', 'ignore-scripts=true', 'allow-git'])]);
    if (pms.has('pnpm')) checks.push(['pnpm workspace hardening', await hasFileWith(projectDir, 'pnpm-workspace.yaml', ['minimumReleaseAge', 'trustPolicy', 'blockExoticSubdeps'])]);
    if (pms.has('bun')) checks.push(['bunfig hardening', await hasFileWith(projectDir, 'bunfig.toml', ['minimumReleaseAge', 'trustedDependencies'])]);
    checks.push(['lockfile committed', await hasAny(projectDir, Object.values(LOCKS).flat())]);
    checks.push(['CI clean install workflow', await exists(path.join(projectDir, '.github/workflows/depshield.yml'))]);
    for (const [name, ok] of checks) {
      console.log(`${ok ? '✓' : '✖'} ${name}`);
      if (!ok) failures++;
    }
  }
  if (failures) process.exitCode = 1;
}

async function npmChanges(projectDir, opts) {
  const days = opts.releaseAgeDays;
  const content = [
    '# Managed by depshield-cli. Review before changing.',
    `min-release-age=${days}`,
    'ignore-scripts=true',
    `allow-git=${opts.npmAllowGit}`,
    `allow-remote=${opts.npmAllowRemote}`,
    'strict-allow-scripts=true',
    opts.pinExact ? 'save-exact=true' : null,
    opts.strictPeerDeps ? 'strict-peer-deps=true' : null,
    'audit=true',
    '',
  ].filter(Boolean).join('\n');
  return [upsertFile(path.join(projectDir, '.npmrc'), content)];
}

async function pnpmChanges(projectDir, opts) {
  const minutes = Math.round(opts.releaseAgeDays * 24 * 60);
  const existing = await readText(path.join(projectDir, 'pnpm-workspace.yaml'));
  const workspace = existing && !existing.includes('packages:') ? existing.trim() + '\n' : existing;
  const hardening = [
    '# Managed by depshield-cli. pnpm uses minutes for minimumReleaseAge.',
    `minimumReleaseAge: ${minutes}`,
    'minimumReleaseAgeStrict: true',
    'minimumReleaseAgeIgnoreMissingTime: false',
    'trustPolicy: no-downgrade',
    'blockExoticSubdeps: true',
    'verifyStoreIntegrity: true',
    'strictStorePkgContentCheck: true',
    'managePackageManagerVersions: true',
    '',
  ].join('\n');
  const next = mergeYamlLike(workspace, hardening, ['minimumReleaseAge','minimumReleaseAgeStrict','minimumReleaseAgeIgnoreMissingTime','trustPolicy','blockExoticSubdeps','verifyStoreIntegrity','strictStorePkgContentCheck','managePackageManagerVersions']);
  return [upsertFile(path.join(projectDir, 'pnpm-workspace.yaml'), next)];
}

async function bunChanges(projectDir, opts) {
  const seconds = Math.round(opts.releaseAgeDays * 24 * 60 * 60);
  const content = [
    '# Managed by depshield-cli. Bun uses seconds for minimumReleaseAge.',
    '[install]',
    `minimumReleaseAge = ${seconds}`,
    'scripts = false',
    '',
    '# Explicit trustedDependencies disables Bun dependency lifecycle scripts unless allowed in package.json.',
    '',
  ].join('\n');
  return [upsertFile(path.join(projectDir, 'bunfig.toml'), content)];
}

async function packageJsonChanges(projectDir, pms, opts) {
  const file = path.join(projectDir, 'package.json');
  const pkg = await readJson(file);
  pkg.scripts ??= {};
  if (opts.lockfileLint) {
    const lockfile = pms.has('npm') ? 'package-lock.json' : pms.has('bun') ? 'bun.lock' : null;
    if (lockfile) {
      pkg.scripts['security:lockfile'] = `npx lockfile-lint --path ${lockfile} --allowed-hosts npm --validate-https --validate-package-names --validate-integrity`;
    }
  }
  pkg.scripts['security:install'] = installCommand(pms, true);
  pkg.scripts['security:check'] = 'node -e "console.log(\'Review dependency diffs; avoid broad update commands; keep lockfiles committed.\')"';
  pkg.trustedDependencies ??= ['__depshield_no_bun_default_trust__'];
  pkg.devEngines ??= {};
  pkg.devEngines.packageManager = { name: [...pms][0] ?? 'npm', onFail: 'warn' };
  return [upsertFile(file, JSON.stringify(pkg, null, 2) + '\n')];
}

function installCommand(pms, ci = false) {
  if (pms.has('pnpm')) return ci ? 'pnpm install --frozen-lockfile' : 'pnpm install';
  if (pms.has('bun')) return ci ? 'bun install --frozen-lockfile' : 'bun install';
  return ci ? 'npm ci' : 'npm install';
}

async function ciChanges(projectDir, pms) {
  const workflow = `name: Dependency safety\n\non:\n  pull_request:\n  push:\n    branches: [main, master]\n\njobs:\n  deps:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n      - uses: actions/setup-node@v4\n        with:\n          node-version: 22\n          cache: ${pms.has('pnpm') ? 'pnpm' : 'npm'}\n      - run: corepack enable\n      - run: ${installCommand(pms, true)}\n      - run: npm run security:lockfile --if-present\n`;
  return [upsertFile(path.join(projectDir, '.github/workflows/depshield.yml'), workflow)];
}

async function devcontainerChanges(projectDir) {
  const config = {
    name: 'hardened-node-dev',
    image: 'mcr.microsoft.com/devcontainers/javascript-node:1-22-bookworm',
    features: {},
    postCreateCommand: 'corepack enable && npm config set ignore-scripts true && npm config set min-release-age 7',
    remoteUser: 'node'
  };
  return [upsertFile(path.join(projectDir, '.devcontainer/devcontainer.json'), JSON.stringify(config, null, 2) + '\n')];
}

function upsertFile(file, content) { return { file, content }; }

async function applyChanges(projectDir, changes, opts) {
  console.log(`\n${opts.dryRun ? 'Would harden' : 'Hardened'} ${rel(projectDir)}`);
  for (const change of changes) {
    const old = await readText(change.file);
    if (old === change.content) {
      if (opts.verbose) console.log(`  = ${rel(change.file)}`);
      continue;
    }
    console.log(`  ${opts.dryRun ? '~' : '✓'} ${rel(change.file)}`);
    if (!opts.dryRun) {
      await fs.mkdir(path.dirname(change.file), { recursive: true });
      await fs.writeFile(change.file, change.content);
    }
  }
}

function mergeYamlLike(existing, block, managedKeys) {
  if (!existing) return block;
  const lines = existing.split(/\r?\n/).filter((line) => !managedKeys.some((k) => line.trim().startsWith(`${k}:`)) && !line.includes('Managed by depshield-cli'));
  return `${lines.join('\n').trim()}\n\n${block}`;
}

async function readJson(file) { return JSON.parse(await fs.readFile(file, 'utf8')); }
async function readText(file) { try { return await fs.readFile(file, 'utf8'); } catch { return ''; } }
async function exists(file) { try { await fs.access(file); return true; } catch { return false; } }
async function hasAny(dir, files) { for (const f of files) if (await exists(path.join(dir, f))) return true; return false; }
async function hasFileWith(dir, file, needles) { const t = await readText(path.join(dir, file)); return needles.every((n) => t.includes(n)); }
function rel(p) { return path.relative(process.cwd(), p) || '.'; }

function printHelp() {
  console.log(`depshield - bootstrap safer JS dependency defaults\n\nUsage:\n  depshield apply --path ./project [--dry-run] [--recursive]\n  depshield check --path ./project [--recursive]\n\nOptions:\n  --release-age-days N     Default: 7\n  --pm auto|npm,pnpm,bun   Default: auto\n  --npm-allow-git MODE     all | root | none. Default: root\n  --npm-allow-remote MODE  all | root | none. Default: root\n  --no-lockfile-lint       Do not add lockfile-lint script\n  --no-ci                  Do not add GitHub Actions workflow\n  --devcontainer           Add a hardened devcontainer starter\n  --dry-run                Show changes without writing\n`);
}
