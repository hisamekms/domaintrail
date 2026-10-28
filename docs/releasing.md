# Releasing

Releases go to npm through [staged publishing](https://docs.npmjs.com/staged-publishing): the Release workflow
(`.github/workflows/release.yml`) tests, builds and stages the package, and nothing is public until a maintainer
approves it with 2FA. The workflow also creates the version's GitHub Release as a **draft**, with the notes from the
changelogs; a maintainer reviews it and publishes it.

## The changelog

`CHANGELOG.md` (English, the source of truth) and `CHANGELOG.ja.md` (Japanese, the same versions and the same `###`
sections, headed in Japanese: 追加, 変更, 削除, 修正, アップグレード手順) are shipped in the package: users and their AI agents read them in `node_modules/domaintrail/` after
upgrading. They have no `Unreleased` section: entries are written when releasing, in `### Added`, `### Changed`,
`### Removed` or `### Fixed`. A change that breaks models or code also gets steps in `### Upgrading`: what to change in
the `.dt` files and in the code, old → new, with short before / after snippets, so that an agent can follow them.
Internal refactoring and repository tooling get one line at most. `test/changelog.test.ts` checks that the two files
match.

## Each release

1. Write a new `## [X.Y.Z] - YYYY-MM-DD` section in both changelogs from the user-facing changes since the previous tag
   (`git log --first-parent --oneline vW.V.U..main` lists the merges), and add its link at the bottom
   (`[X.Y.Z]: https://github.com/hisamekms/domaintrail/compare/vW.V.U...vX.Y.Z`). **Review both languages before
   tagging**: the notes of the GitHub Release are made from them. Check the notes with:

   ```bash
   bun scripts/release-notes.ts X.Y.Z   # fails if either changelog has no section for X.Y.Z
   ```

   Open a pull request with them (`docs: write the changelog of X.Y.Z`) and squash merge it: `main` takes changes only
   through pull requests.

2. On an up-to-date `main`, bump the version, which commits (`chore(release): X.Y.Z`, `.npmrc`) and tags, and push.
   Only an admin can push this commit, bypassing the ruleset of `main`:

   ```bash
   git switch main && git pull --ff-only
   npm version patch   # or minor / major; commits and creates the vX.Y.Z tag
   git push --follow-tags
   ```

3. Wait for the Release workflow to finish. It checks the tag against `package.json` and that both changelogs have a
   section for the version (and stops before anything is published if not), builds, type-checks, tests, smoke-tests
   the CLI on Node, runs `npm stage publish` and creates the draft GitHub Release. Its job summary repeats the
   approval step below.
4. **Approve the staged version** — it is not published until you do. Either:
   - open the package's **Staged Packages** tab on npmjs.com and approve it there, or
   - from a terminal:

     ```bash
     npm stage list domaintrail
     npm stage approve <stage-id>   # asks for 2FA
     ```

   To drop a bad build instead, run `npm stage reject <stage-id>`.
5. Check that the new version is on <https://www.npmjs.com/package/domaintrail>.
6. **Review and publish the draft GitHub Release**, on the repository's Releases page or with
   `gh release edit vX.Y.Z --draft=false`. It is never published automatically. Its notes are the English section
   with the Japanese one folded under 日本語; if something is wrong, fix the changelogs on `main` and edit the draft to
   match.

## Releases made by hand

The script prints the notes of any version, for a release the workflow did not make (an older version, or a failed
run):

```bash
bun scripts/release-notes.ts 0.4.0 > notes.md
gh release create v0.4.0 --draft --verify-tag --title v0.4.0 --notes-file notes.md
```

## One-time setup

Needed once, before the first tagged release.

- Publish the first version (0.1.0) by hand with `npm publish --access public`, because only packages that
  already exist on the registry can be staged.
- Register the npm trusted publisher (package Settings → Trusted Publisher → GitHub Actions): user `hisamekms`, repository
  `domaintrail`, workflow `release.yml`, no environment, allowed actions **npm stage publish only**.
- Enable 2FA on the npm account, since approving a staged version requires it.
