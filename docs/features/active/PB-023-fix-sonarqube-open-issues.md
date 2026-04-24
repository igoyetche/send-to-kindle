# PB-023 — Fix SonarQube Open Issues

**Status:** Active
**Priority:** Medium
**Ticket:** PB-023

## Motivation

SonarQube reports 10 open code-smell issues across the codebase. None are bugs or vulnerabilities, but they include 3 CRITICAL-severity items and represent technical debt that should be cleared to keep the quality gate green and the codebase clean.

## Scope

Fix all 10 currently open SonarQube issues:

| Severity | File | Rule | Message |
|----------|------|------|---------|
| CRITICAL | `src/application/cli.ts` | S3776 | Cognitive Complexity 18 > 15 |
| CRITICAL | `src/application/cli.ts:132` | S3735 | Remove use of `void` operator |
| CRITICAL | `src/application/cli.ts:220` | S3735 | Remove use of `void` operator |
| MAJOR | `docs/modularity-review/2026-04-01/modularity-review.html:477` | S7761 | Prefer `.dataset` over `setAttribute(…)` |
| MAJOR | `docs/modularity-review/2026-04-01/modularity-review.html:483` | S7761 | Prefer `.dataset` over `getAttribute(…)` |
| MAJOR | `test/domain/device-registry.test.ts:73` | S4623 | Remove redundant `undefined` argument |
| MINOR | `src/infrastructure/mailer/smtp-mailer.ts:4` | S3863 | Duplicate import of `../../domain/values/index.js` |
| MINOR | `src/infrastructure/mailer/smtp-mailer.ts:5` | S3863 | Duplicate import of `../../domain/values/index.js` |
| MINOR | `src/domain/device-registry.ts:62` | S7735 | Unexpected negated condition |
| INFO | `src/domain/values/email-address.ts:12` | S1135 | Unresolved TODO comment |

## Acceptance Criteria

- [ ] `sonar list issues -p paperboy` reports zero open issues
- [ ] `npm test` passes with no regressions
- [ ] `npm run build` compiles cleanly with no TypeScript errors
