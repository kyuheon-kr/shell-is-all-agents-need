import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

export function validateVersion(actual, requested) {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(requested ?? '') || actual !== requested) {
    throw new Error(`Requested stable version must match package.json (${actual})`);
  }
}

async function publicVersion(name, version) {
  const response = await fetch(`https://registry.npmjs.org/${encodeURIComponent(name)}/${version}`, {
    headers: { 'cache-control': 'no-cache' }, signal: AbortSignal.timeout(15_000),
  });
  if (response.status === 404) return undefined;
  if (!response.ok) throw new Error(`npm registry returned HTTP ${response.status}`);
  return response.json();
}

async function main() {
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
  validateVersion(pkg.version, process.env.RELEASE_VERSION);
  const mode = process.argv[2];
  if (mode === 'validate') return;
  const run = (command, args) => execFileSync(command, args, { encoding: 'utf8' }).trim();
  const tag = `v${pkg.version}`;
  if (mode === 'prepare') {
    const sha = run('git', ['rev-parse', 'HEAD']);
    const tags = run('git', ['tag', '--list', tag]);
    if (tags && run('git', ['rev-parse', `${tag}^{}`]) !== sha) throw new Error(`${tag} already points to a different commit`);
    const destination = process.env.RUNNER_TEMP;
    if (!destination) throw new Error('RUNNER_TEMP is required');
    const npmCli = process.env.npm_execpath;
    if (npmCli) execFileSync(process.execPath, [npmCli, 'pack', '--pack-destination', destination], { stdio: 'inherit' });
    else execFileSync('npm', ['pack', '--pack-destination', destination], { stdio: 'inherit' });
    const tarball = join(destination, `${pkg.name}-${pkg.version}.tgz`);
    const integrity = `sha512-${createHash('sha512').update(readFileSync(tarball)).digest('base64')}`;
    const published = await publicVersion(pkg.name, pkg.version);
    if (published && published.dist?.integrity !== integrity) throw new Error(`npm ${pkg.version} already contains a different artifact; prepare a new version`);
    appendFileSync(process.env.GITHUB_OUTPUT, `tarball=${tarball}\nintegrity=${integrity}\npublished=${Boolean(published)}\n`);
  } else if (mode === 'finish') {
    let published;
    for (let attempt = 0; attempt < 24; attempt++) {
      published = await publicVersion(pkg.name, pkg.version);
      if (published) break;
      await delay(10_000);
    }
    if (!published || published.dist?.integrity !== process.env.RELEASE_INTEGRITY) throw new Error('Published artifact is not yet available or its integrity differs; rerun this workflow');
    const existing = JSON.parse(run('gh', ['api', `repos/${process.env.GH_REPO}/releases`, '--paginate', '--slurp'])).flat();
    if (existing.some(release => release.tag_name === tag)) return;
    console.log(run('gh', ['release', 'create', tag, '--target', process.env.GITHUB_SHA,
      '--title', tag, '--generate-notes', '--notes', `Install: npm install -g ${pkg.name}@${pkg.version}`]));
  } else throw new Error('Expected validate, prepare, or finish');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
