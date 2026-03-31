# PB-010: Safe npm Packages — Design

**Status:** Accepted
**Date:** 2026-03-31

## Summary

Prevent compromised or vulnerable npm packages from entering the project by running `npm audit --audit-level=high` at two enforcement points: the Husky pre-commit hook (developer-local) and a GitHub Actions CI workflow (shared pipeline). Any high or critical vulnerability blocks the commit or CI job.

## Motivation

Recent supply chain attacks have pushed malicious or compromised packages to the npm registry. Even well-maintained projects can inadvertently pull in a vulnerable transitive dependency. Catching this at the earliest possible point — before code is committed — limits blast radius and keeps the dependency tree auditable.

## Approach

**Selected: `npm audit` script enforced in Husky pre-commit + GitHub Actions CI**

`npm audit` is built into npm, requires no new production or dev dependencies, and is fast enough to run on every commit. The `--audit-level=high` flag blocks on high and critical severities while allowing moderate/low advisories through, striking a practical balance between security and developer friction.

## Changes

### 1. `package.json` — new audit script

```json
"audit:ci": "npm audit --audit-level=high"
```

Added to the `scripts` block. Named `audit:ci` to signal it is the canonical audit gate used in both pre-commit and CI contexts.

### 2. `.husky/pre-commit` — append audit step

```sh
npm exec lint-staged
npm test
npm run audit:ci
```

Runs after tests. If the audit finds a high/critical vulnerability, the commit is aborted with a non-zero exit code. The developer must resolve (`npm audit fix`, dependency upgrade, or justified override) before committing.

### 3. `.github/workflows/ci.yml` — new CI workflow

Triggers on `push` and `pull_request` to `main`. Steps:

1. `actions/checkout`
2. `actions/setup-node` (Node 22, npm cache enabled)
3. `npm ci` — clean install from lockfile
4. `npm run audit:ci` — fails job on high/critical vulnerability
5. `npm test` — runs full test suite

This workflow does not exist yet in the repo; it will be created as part of this feature.

## Failure Behaviour

When `npm run audit:ci` exits non-zero:

- **Pre-commit:** Git aborts the commit. The developer sees npm audit output listing the affected packages, severity, and remediation options (`npm audit fix`).
- **CI:** The job step fails, blocking merge. The audit output is visible in the workflow run logs.

## Remediation Path

When a vulnerability is flagged:

1. Run `npm audit fix` — resolves automatically if a non-breaking fix exists.
2. If no fix exists: manually upgrade to a safe version or replace the dependency.
3. If the vulnerability is a false positive or in a dev-only path with no real exposure: document the decision in `docs/CHANGELOG.md` and use `npm audit fix --force` with explicit justification.

There is no `--ignore` or advisory override mechanism added by this feature. Overrides are handled in `package.json` `overrides` field on a case-by-case basis if needed.

## Testing

- The `audit:ci` script can be verified by running `npm run audit:ci` locally.
- The pre-commit hook is exercised by any commit attempt.
- The CI workflow is exercised by any push or pull request to `main`.

No unit tests are needed — this is toolchain configuration, not application logic.

## Out of Scope

- Runtime sandboxing or network restriction of npm packages
- Socket.dev or other behaviour-based supply chain scanning
- `.npmrc` `audit=true` global setting (higher blast radius, not chosen)
- Automated dependency update bots (Dependabot, Renovate)
