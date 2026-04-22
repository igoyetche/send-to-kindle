# PB-014: SonarQube CI — Design

**Status:** Design
**Date:** 2026-04-14

---

## Goal

Close the quality feedback loop around SonarCloud at two points: before a PR is created (local scan) and after a PR is created (on-demand diagnosis via a reusable Claude command).

---

## Architecture Overview

Three independent deliverables that compose into a single workflow:

```
[dev loop]
  code changes
    → npm run sonar:local        (local scan → SonarCloud dashboard)
    → review + fix
    → git push + gh pr create

[post-PR loop, on demand]
  /check-pr
    → gh pr checks               (CI + SonarCloud statuses)
    → gh run view --log-failed   (build error details)
    → gh pr view --json comments (SonarCloud bot comment)
    → structured report → user decides → Claude acts
```

---

## Part 1: Local Scan Infrastructure (project-specific)

### `sonar-project.properties` (repo root)

Tells `sonar-scanner` where sources, tests, and coverage live:

```properties
sonar.projectKey=paperboy
sonar.organization=igoyetche
sonar.sources=src
sonar.tests=test
sonar.javascript.lcov.reportPaths=coverage/lcov.info
sonar.exclusions=**/node_modules/**,dist/**,coverage/**
```

The project key and organization must match the SonarCloud project created via the GitHub App.

### Vitest config (`vitest.config.ts`)

Add `lcov` to the coverage reporters array so `coverage/lcov.info` is generated alongside the existing `text` and `html` outputs:

```ts
reporter: ["text", "html", "lcov"]
```

### `package.json` — new script

```json
"sonar:local": "npm run test:coverage && sonar-scanner"
```

Runs coverage first (generates `coverage/lcov.info`), then sonar-scanner reads it during analysis.

**Prerequisites for the developer:**
- `sonar-scanner` installed globally: `npm install -g sonar-scanner`
- `SONAR_TOKEN` set in `.env` (account token from SonarCloud → My Account → Security)

### `.env.example`

Add:
```
# SonarCloud local scan — generate at https://sonarcloud.io/account/security
SONAR_TOKEN=
```

---

## Part 2: `/check-pr` Global Command

**File:** `~/.claude/commands/check-pr.md`

This is a global Claude Code command — available in every project by invoking `/check-pr`. It gives Claude a step-by-step playbook for diagnosing a PR's CI and SonarCloud results.

### Playbook (contents of `check-pr.md`)

The file is a Claude Code slash command — plain markdown that Claude reads and follows when `/check-pr` is invoked.

**Step 1 — Identify the PR**

Run `gh pr list --head $(git branch --show-current) --json number,title,url`. If no PR is found, report "No open PR found for this branch" and stop.

**Step 2 — Fetch check statuses**

Run `gh pr checks <number>`. Parse the output into passing checks and failing checks.

**Step 3 — Diagnose each failing check**

For a CI build failure (e.g., check named "build"):
- Run `gh run list --branch $(git branch --show-current) --json databaseId,status,conclusion --limit 1` to get the run ID
- Run `gh run view <run-id> --log-failed` to extract the error
- Summarise: which step failed and what the error says

For a SonarCloud failure (check named "SonarCloud Code Analysis"):
- Run `gh pr view <number> --json comments`
- Find the comment whose author login is `sonarqubecloud`
- Parse it to extract: quality gate status, each failed condition (type + count + description), and the dashboard URL

**Step 4 — Present a structured report**

    PR #<number>: <title>

    CI Build:   ✅ passed  /  ❌ failed
      → <error summary>

    SonarCloud: ✅ passed  /  ❌ failed
      Quality Gate: <status>
      Failed conditions:
        - [Hotspot] 1 — Expanding archive files is security-sensitive
        - [Bug] 2 — ...
      Dashboard: <url>

**Step 5 — Wait for instructions**

Do NOT make any changes yet. For each issue ask:
- Build failure: "I can fix `<specific error>`. Shall I proceed?"
- SonarCloud issue: "How would you like to handle [type] `<description>`? (a) fix the code  (b) mark safe on SonarCloud  (c) skip for now"

Only act after receiving explicit instructions for each issue.

### Why a global command (not a project skill)

A global command at `~/.claude/commands/` is available in every Claude Code session without any project setup. It relies only on `gh` CLI (authenticated) and standard git — both of which are present in any development environment. No project-specific configuration is read or required.

---

## Part 3: CLAUDE.md Workflow Integration

### Pre-PR Checklist addition

Add after the existing `npm test` step:

```markdown
- [ ] **SonarQube local scan:** Run `npm run sonar:local` and review results at
      https://sonarcloud.io/project/issues?id=paperboy.
      Resolve any bugs or vulnerabilities before creating the PR.
      For hotspots, confirm they are safe before proceeding.
```

### New section: "Checking a PR"

Add a new section to CLAUDE.md documenting the on-demand flow:

```markdown
## Checking a PR After Creation

After creating a PR, use `/check-pr` to fetch CI and SonarCloud results for
the current branch. The command reports all failing checks, extracts build
error details, and parses the SonarCloud bot comment. It proposes fixes but
does not act without explicit approval for each issue.
```

---

## File Changes Summary

| File | Change |
|------|--------|
| `sonar-project.properties` | New — SonarCloud project configuration |
| `vitest.config.ts` | Add `"lcov"` to coverage reporters |
| `package.json` | Add `sonar:local` script |
| `.env.example` | Add `SONAR_TOKEN=` entry |
| `CLAUDE.md` | Add pre-PR checklist item + "Checking a PR" section |
| `docs/features/backlog/PB-014-sonarqube-ci.md` | Delete (moved to active) |
| `docs/features/active/PB-014-sonarqube-ci.md` | New — feature active |
| `~/.claude/commands/check-pr.md` | New global command (outside repo) |

---

## Setup Requirements

For the local scan to work, the developer needs:
1. `sonar-scanner` installed globally: `npm install -g sonar-scanner`
2. `SONAR_TOKEN` set in `.env` (generated at SonarCloud → My Account → Security → Generate Token)

These are one-time setup steps documented in `.env.example`.

---

## Out of Scope

- Blocking merges on quality gate failure
- Auto-monitoring after PR creation (on-demand only)
- Claude autonomously marking hotspots as safe
- Self-hosted SonarQube
- Custom quality profiles
