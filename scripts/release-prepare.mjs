import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export function nextVersion(current, bump) {
  if (!['patch', 'minor', 'major'].includes(bump) || !/^\d+\.\d+\.\d+$/.test(current)) {
    throw new Error('Usage: npm run release:prepare -- patch|minor|major (stable versions only)');
  }
  const [major, minor, patch] = current.split('.').map(Number);
  return bump === 'major' ? `${major + 1}.0.0` : bump === 'minor' ? `${major}.${minor + 1}.0` : `${major}.${minor}.${patch + 1}`;
}

export function prepareRelease({ args, manifest, npmCli, run }) {
  const git = (...args) => run('git', args);
  const version = nextVersion(manifest.version, args[0]);
  if (args.length !== 1) throw new Error('Provide exactly one bump: patch, minor, or major');
  if (git('status', '--porcelain')) throw new Error('Commit or stash your changes before preparing a release');
  if (git('branch', '--show-current') !== 'main') throw new Error('Start from an up-to-date main checkout');
  if (!npmCli) throw new Error('Run through npm run release:prepare');
  run('gh', ['auth', 'status']);
  git('fetch', 'origin', 'main');
  if (git('rev-parse', 'HEAD') !== git('rev-parse', 'origin/main')) throw new Error('Update main with git pull --ff-only first');
  const latest = run(process.execPath, [npmCli, 'view', manifest.name, 'dist-tags.latest', '--prefer-online']);
  if (latest !== manifest.version) throw new Error(`Publish the pending ${manifest.version} release before preparing another (npm latest: ${latest})`);
  const branch = `release/v${version}`;
  git('switch', '-c', branch);
  run(process.execPath, [npmCli, 'version', version, '--no-git-tag-version']);
  git('add', 'package.json', 'package-lock.json');
  git('commit', '-m', `chore: prepare v${version}`);
  git('push', '--set-upstream', 'origin', branch);
  return run('gh', ['pr', 'create', '--base', 'main', '--head', branch,
    '--title', `Release v${version}`, '--body',
    `Prepare version ${version}. The MCP server reads its version from package.json.\n\nRequired Linux and Windows CI must pass before merging. After merge, run the Release workflow on main with version=${version}; preview first, then set dry_run=false to publish.`]);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    console.log(prepareRelease({
      args: process.argv.slice(2), manifest: JSON.parse(readFileSync('package.json', 'utf8')),
      npmCli: process.env.npm_execpath,
      run: (command, args) => execFileSync(command, args, { encoding: 'utf8' }).trim(),
    }));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
