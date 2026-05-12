# Releasing

This package publishes to npm via GitHub Actions on tag push, using **npm
trusted publishing** (OIDC). Local credentials are never the path of trust:
the workflow's identity, not a long-lived token, is what npm validates.

## One-time setup

### 1. First publish (bootstrap)

Trusted publishing can only be configured on a package that already exists on
npm. So the very first publish has to use a regular npm access token.

```bash
# In a fresh shell, with no NPM_TOKEN set:
npm login                          # opens browser, signs you in
npm publish --access public        # publishes 0.1.0 (or whatever's current)
```

You can also do this via the workflow with a temporary token — generate a
granular token at https://www.npmjs.com/settings/<your-user>/tokens, scope it
to **publish**, scope it to **this package only**, give it a short expiry,
add it to the repo as the `NPM_TOKEN` secret, tag and push. Either path is
fine; the token-based mode is meant to be temporary.

### 2. Configure the trusted publisher on npmjs.com

1. Go to `https://www.npmjs.com/package/@astami/claude-code-bridge/access` (or
   `Manage` → `Settings` → `Publishing access`).
2. Under **Trusted publishers**, click **Add trusted publisher**.
3. Fill in:
   - **Publisher**: GitHub Actions
   - **Organization or user**: your GitHub username/org
   - **Repository name**: `claude-code-bridge`
   - **Workflow filename**: `publish.yml`
   - **Environment name**: `npm-publish` (must match the `environment:` line
     in `.github/workflows/publish.yml`)
4. Save.

### 3. Create the `npm-publish` GitHub environment

This gates each publish behind a manual approval, which is the easiest way to
add a human check before anything ships.

1. In the GitHub repo: **Settings → Environments → New environment**.
2. Name it `npm-publish` (must match exactly).
3. Optional but recommended: enable **Required reviewers** and add yourself.
   Without this, anyone with push access who can land a tag can publish.

### 4. Remove the bootstrap token

Once steps 1–3 are done and a tag-driven publish has succeeded:

- Delete the `NPM_TOKEN` repo secret (Settings → Secrets and variables → Actions).
- Revoke or let expire the granular token at npmjs.com.

## Cutting a release

1. Update `version` in `package.json` and add a section to `CHANGELOG.md`.
2. Commit on `main`:
   ```bash
   git commit -am "chore: release v0.2.0"
   git push
   ```
3. Tag and push:
   ```bash
   git tag v0.2.0 -m "v0.2.0"
   git push --tags
   ```
4. The Publish workflow runs and pauses at the `npm-publish` environment
   waiting for your approval. Approve it from the Actions run page.
5. After approval the workflow:
   - asserts the tag matches `package.json` version
   - runs `npm ci`, `npm run lint`, `npm test`, `npm run build`
   - runs `npm publish --provenance --access public` (auth via OIDC)
   - creates a GitHub Release named after the tag

## Dry run

Use the workflow's manual trigger with `dry_run: true` to run the full
pipeline including `npm publish --dry-run`. Nothing is uploaded but the
tarball is produced and validated, and you can verify the OIDC handshake.
You can also dry-run locally:

```bash
npm publish --dry-run
```

## Why trusted publishing

A few concrete things you get versus a long-lived NPM_TOKEN secret:

- No secret to rotate, scope, expire, or leak. The auth lives only for the
  duration of one workflow run.
- The published package carries **provenance**: npm records that this exact
  tarball came from this exact commit on this exact workflow run, signed by
  GitHub's OIDC issuer. Consumers can audit it.
- Compromised repo write access cannot ship a release on its own — the
  `npm-publish` environment's required-reviewer rule still gates approval.

## Yanking a bad release

`npm deprecate @astami/claude-code-bridge@x.y.z "broken — use x.y.z+1"` is
preferred over `npm unpublish`, since unpublish breaks downstream consumers
without warning. Cut a patch release with the fix, then deprecate the bad
version.
