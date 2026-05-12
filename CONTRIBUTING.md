# Contributing

Thanks for considering a contribution.

## Ground rules

This bridge is intentionally small and intentionally minimal. The acceptance bar:

1. **No MCP-specific knowledge in the bridge.** The bridge is a pure ferry. If a feature requires the bridge to know what an Asana or HubSpot or any specific MCP is, the feature belongs in the *caller* or in the MCP itself, not here.
2. **No defaults that lower security.** Anything that widens the permission surface (more env vars passed through, broader path acceptance, looser bypass policy) must be opt-in via a documented env var and have a test that verifies the default still rejects it.
3. **No shell.** All subprocess invocations use `spawn(..., { shell: false })` with arguments as an array. Reviewers will reject PRs that compose argv via string interpolation.
4. **Tests cover both the happy path and the rejection path.** For any new validator, security check, or input parser, a test must verify the rejection cases — not just that the accept case works.
5. **No committed scratchpads.** No `CHECKPOINT-*.md`, no `BUGFIX-*.md`, no `*.bak`, no debug JSON dumps. Keep working notes in your PR description or a draft.

## How to run

```bash
npm install
npm run lint    # tsc --noEmit
npm test        # node:test + tsx
npm run build
```

CI runs the same three commands on Node 20 and 22 against every PR.

## Reporting security issues

Please open a private security advisory on GitHub rather than a public issue. The bridge runs in the trust boundary between a prompt-driven MCP client and a code-executing subprocess, so issues here matter.
