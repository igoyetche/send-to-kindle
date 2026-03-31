# PB-010: Safe npm Packages

**Status:** Backlog
**Date:** 2026-03-31

## Motivation

Recent supply chain attacks have pushed compromised packages to the npm registry. As a project maintainer, I want confidence that no high or critical vulnerability enters the dependency tree — either through a direct upgrade or a transitive dependency update.

## Scope

Add `npm audit --audit-level=high` enforcement at two points:
- Husky pre-commit hook (local developer gate)
- GitHub Actions CI workflow (shared pipeline gate)

## Acceptance Criteria

- [ ] `npm run audit:ci` script exists and exits non-zero when high/critical vulnerabilities are present
- [ ] Pre-commit hook runs `npm run audit:ci` and blocks commits on failure
- [ ] GitHub Actions CI workflow runs `npm run audit:ci` and blocks merges on failure
- [ ] Remediation path is documented (what to do when audit fails)

## Out of Scope

- Runtime sandboxing
- Behaviour-based supply chain scanning (Socket.dev)
- Automated dependency update bots
