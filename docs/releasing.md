# Development and releases

Use a task branch, commit and push it, then open a pull request against `main`:

```sh
git switch -c fix/example
git push -u origin HEAD
gh pr create --base main
gh pr checks --watch
gh pr merge --squash --delete-branch
```

The `CI required` check requires Linux and Windows type checks, unit tests, builds, real Zellij integration tests, and installed-package smoke tests. Branch protection requires a PR, an up-to-date branch, resolved conversations, and this check. It applies to administrators too; force pushes and branch deletion are disabled. For this solo-maintained repository, a second person's approval is optional.

Merging ordinary changes never publishes a package. `package.json` is the runtime version source; `npm version` updates it and the lockfile together.

## Prepare a release

With Node 24+, npm, Git, and an authenticated GitHub CLI, start from a clean, current `main` checkout:

```sh
git switch main
git pull --ff-only
npm ci
npm run release:prepare -- patch
```

Choose `patch`, `minor`, or `major`. The command creates `release/vX.Y.Z`, updates both version files, commits, pushes, and opens a PR. It refuses to start from a dirty or outdated checkout, or while the current version is still awaiting publication. Review and merge that PR after its CI passes.

## Publish when needed

Run **Actions → Release → Run workflow**, selecting `main` and entering the version from the merged PR. Leave `dry_run` enabled for a preview. To publish, run again with `dry_run=false`:

```sh
gh workflow run release.yml --ref main -f version=X.Y.Z -F dry_run=true
gh workflow run release.yml --ref main -f version=X.Y.Z -F dry_run=false
```

The workflow validates the version, reruns Linux and Windows CI for that commit, packs the package, publishes to npm with OIDC and provenance, waits for the public artifact's integrity to match, then creates `vX.Y.Z` and a GitHub Release with generated notes. It rejects existing versions or tags containing different content. A rerun can finish a release whose npm publish succeeded before a later step failed. Failed publication or registry propagation does not create a release tag.

## One-time repository setup

- Protect `main`: require PRs and `CI required` from GitHub Actions; require an up-to-date branch; enforce for administrators; disable force pushes and deletion. Enable squash merging and automatic head-branch deletion.
- Create the GitHub environment `npm` and allow deployments only from `main`.
- Configure npm Trusted Publisher for package `shell-is-all-agents-need`: GitHub owner `kyuheon-kr`, repository `shell-is-all-agents-need`, workflow **`release.yml`**, environment **`npm`**, and allow direct publishing. No npm token secret is needed. See [npm's instructions](https://docs.npmjs.com/trusted-publishers/).

Installing `gh` and approving its initial browser login are local setup steps. npm Trusted Publisher changes can require a separate npm 2FA approval.
