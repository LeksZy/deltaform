/** Build a fresh allowlisted source archive; never copy local account state. */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { copyFileSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const stage = mkdtempSync(join(tmpdir(), 'deltaform-showcase-'));
const destination = join(stage, 'deltaform');
const reviewedFiles = [
  '.gitignore', '.env.example', 'README.md', 'package.json', 'package-lock.json',
  'tsconfig.json', 'vite.config.ts', 'index.html',
  'docs/STRATEGY.md', 'docs/MATH.md', 'docs/SIMULATION.md',
  'docs/ARCHITECTURE.md', 'docs/DEMO.md', 'docs/RUNBOOK.md',
  'docs/VALIDATION.md', 'docs/VERIFICATION.md', 'docs/ROADMAP.md',
  'docs/PUBLICATION.md', 'docs/SOURCES.md', 'docs/VENUES.md',
  'docs/BYBIT_API.md', 'docs/MULTI_ASSET_VENUES.md',
  'docs/REALIZED_VOLATILITY.md', 'docs/DEPENDENCIES.md', 'docs/dependency-audit.json',
  'docs/UI_QA.md', 'docs/order-recovery.md', 'docs/venue-verification.json',
  'docs/showcase/paper-overview.jpg',
  'docs/showcase/paper-options-review.jpg',
  'docs/showcase/paper-payoff.jpg',
];
const sourceFolders = [
  { directory: 'src', extensions: ['.ts', '.tsx', '.css'] },
  { directory: 'server', extensions: ['.ts'] },
  { directory: 'tests', extensions: ['.ts'] },
  { directory: 'scripts', extensions: ['.ts'] },
];

function collect(directory: string, extensions: string[]): string[] {
  const files: string[] = [];
  for (const name of readdirSync(join(root, directory)).sort()) {
    const relative = `${directory}/${name}`;
    const stat = lstatSync(join(root, relative));
    if (stat.isSymbolicLink()) throw new Error(`Refusing symlink: ${relative}`);
    if (stat.isDirectory()) files.push(...collect(relative, extensions));
    else if (stat.isFile() && extensions.includes(extname(name))) files.push(relative);
  }
  return files;
}

try {
  const example = readFileSync(join(root, '.env.example'), 'utf8');
  for (const name of ['BYBIT_API_KEY', 'BYBIT_API_SECRET', 'AGENT_ENCRYPTION_KEY']) {
    if (!new RegExp(`^${name}=\\s*$`, 'm').test(example)) throw new Error(`Example must keep ${name} blank`);
  }
  if (!/^ENABLE_LIVE_EXECUTION=false\s*$/m.test(example)) throw new Error('Example must disable live execution');

  const files = [...new Set([...reviewedFiles, ...sourceFolders.flatMap(folder => collect(folder.directory, folder.extensions))])].sort();
  const manifest: { path: string; sha256: string }[] = [];
  for (const relative of files) {
    const source = join(root, relative);
    if (!lstatSync(source).isFile()) throw new Error(`Refusing non-file: ${relative}`);
    const output = join(destination, relative);
    mkdirSync(dirname(output), { recursive: true });
    copyFileSync(source, output);
    manifest.push({ path: relative, sha256: createHash('sha256').update(readFileSync(source)).digest('hex') });
  }
  writeFileSync(join(destination, 'SHOWCASE_MANIFEST.json'), JSON.stringify({
    project: 'Deltaform', publicDemo: 'synthetic-paper-only', files: manifest,
    excluded: ['credentials', 'account databases and exports', 'internal prompts', 'historical live screenshots', 'Git history', 'dependencies and builds'],
  }, null, 2) + '\n');

  // Build in an empty temporary directory so old archive entries cannot survive.
  const temporaryArchive = join(stage, 'deltaform-showcase.zip');
  execFileSync('zip', ['-q', '-r', temporaryArchive, 'deltaform'], { cwd: stage });
  const releases = resolve(root, 'releases');
  mkdirSync(releases, { recursive: true });
  const archive = join(releases, 'deltaform-showcase.zip');
  copyFileSync(temporaryArchive, archive);
  console.log(`Prepared ${files.length} reviewed files plus manifest: ${archive}`);
} finally {
  rmSync(stage, { recursive: true, force: true });
}
