# Releasing

This project publishes to npm via GitHub Actions on tag push. There is no
manual `npm publish` workflow — local credentials are never the path of trust.

## Prerequisites (one-time setup)

1. **Create an npm automation token** for the publisher account
   (account → access tokens → "Automation"). Save it as a repository secret
   named `NPM_TOKEN`. Granular tokens scoped to this package are preferred over
   classic tokens.
2. **Create a GitHub environment** named `npm-publish` and require approvers if
   you want a human gate before publishing.
3. **Enable npm provenance** on the published package by ensuring the
   workflow has `id-token: write` permission (already in `.github/workflows/publish.yml`).

## Cutting a release

1. Update `version` in `package.json` and add a section to `CHANGELOG.md`.
2. Commit on `main`: `chore: release v0.2.0`.
3. Tag the commit and push: `git tag v0.2.0 -m "v0.2.0"; git push --tags`.
4. The Publish workflow runs:
   - asserts the tag and package.json version match
   - runs `npm ci`, `npm run lint`, `npm test`, `npm run build`
   - runs `npm publish --provenance --access public`
   - creates a GitHub Release named after the tag

## Dry run

Use the workflow's manual trigger with `dry_run: true` to do a full pipeline
including `npm publish --dry-run`. Nothing is uploaded but the tarball is
produced and validated.

## Yanking a bad release

`npm deprecate @astami/claude-code-bridge@x.y.z "broken — use x.y.z+1"` is preferred
over `npm unpublish`, since unpublish breaks downstream consumers without
warning. Cut a patch release with the fix, then deprecate the bad version.
