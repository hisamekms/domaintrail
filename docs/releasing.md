# Releasing

Releases go to npm through [staged publishing](https://docs.npmjs.com/staged-publishing): the Release workflow
(`.github/workflows/release.yml`) tests, builds and stages the package, and nothing is public until a maintainer
approves it with 2FA.

## Each release

1. Bump the version, commit and tag, then push:

   ```bash
   npm version patch   # or minor / major; commits and creates the vX.Y.Z tag
   git push --follow-tags
   ```

2. Wait for the Release workflow to finish. It checks the tag against `package.json`, builds, type-checks, tests,
   smoke-tests the CLI on Node and runs `npm stage publish`. Its job summary repeats the approval step below.
3. **Approve the staged version** — it is not published until you do. Either:
   - open the package's **Staged Packages** tab on npmjs.com and approve it there, or
   - from a terminal:

     ```bash
     npm stage list domaintrail
     npm stage approve <stage-id>   # asks for 2FA
     ```

   To drop a bad build instead, run `npm stage reject <stage-id>`.
4. Check that the new version is on <https://www.npmjs.com/package/domaintrail>.

## One-time setup

Needed once, before the first tagged release.

- Publish the first version (0.1.0) by hand with `npm publish --access public`, because only packages that
  already exist on the registry can be staged.
- Register the npm trusted publisher (package Settings → Trusted Publisher → GitHub Actions): user `hisamekms`, repository
  `domaintrail`, workflow `release.yml`, no environment, allowed actions **npm stage publish only**.
- Enable 2FA on the npm account, since approving a staged version requires it.
