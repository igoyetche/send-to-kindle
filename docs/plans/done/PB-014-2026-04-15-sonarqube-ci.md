# PB-014: SonarQube CI Workflow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire SonarCloud into the dev workflow via a local scan command and a reusable `/check-pr` global Claude command.

**Architecture:** Three independent deliverables: (1) project-level scan infrastructure (`sonar-project.properties`, lcov coverage, `npm run sonar:local`), (2) CLAUDE.md workflow additions, and (3) a global Claude command at `~/.claude/commands/check-pr.md` that diagnoses any project's PR checks and SonarCloud results on demand.

**Tech Stack:** SonarCloud (free tier), sonar-scanner CLI, Vitest v8 coverage with lcov reporter, GitHub CLI (`gh`).

---

## File Structure

| File | Action | Purpose |
|------|--------|---------|
| `sonar-project.properties` | Create | SonarCloud project key, sources, coverage path |
| `vitest.config.ts` | Modify line 9 | Add `"lcov"` to reporters array |
| `package.json` | Modify scripts | Add `sonar:local` script |
| `.env.example` | Modify | Add `SONAR_TOKEN=` entry |
| `CLAUDE.md` | Modify | Pre-PR checklist item + "Checking a PR" section |
| `docs/STATUS.md` | Modify | Add PB-014 to Active Work |
| `~/.claude/commands/check-pr.md` | Create (outside repo) | Global `/check-pr` command |

---

## Task 1: Local Scan Infrastructure

**Files:**
- Create: `sonar-project.properties`
- Modify: `vitest.config.ts` (line 9)
- Modify: `package.json` (scripts section)
- Modify: `.env.example`

- [ ] **Step 1: Create `sonar-project.properties`**

Create this file at the repo root:

```properties
sonar.projectKey=igoyetche_send-to-kindle
sonar.organization=igoyetche
sonar.sources=src
sonar.tests=test
sonar.javascript.lcov.reportPaths=coverage/lcov.info
sonar.exclusions=**/node_modules/**,dist/**,coverage/**
```

- [ ] **Step 2: Add `lcov` to vitest coverage reporters**

In `vitest.config.ts`, change line 9 from:
```ts
      reporter: ["text", "html"],
```
to:
```ts
      reporter: ["text", "html", "lcov"],
```

- [ ] **Step 3: Add `sonar:local` script to `package.json`**

In the `"scripts"` section, add after the `"test:coverage"` line:
```json
"sonar:local": "npm run test:coverage && sonar-scanner",
```

- [ ] **Step 4: Document `SONAR_TOKEN` in `.env.example`**

Append to `.env.example`:
```
# SonarCloud local scan token — generate at https://sonarcloud.io/account/security
SONAR_TOKEN=
```

- [ ] **Step 5: Verify lcov output is generated**

Run:
```
npm run test:coverage
```

Expected: tests pass and file `coverage/lcov.info` now exists.

```
ls coverage/lcov.info
```

Expected: file is present and non-empty.

- [ ] **Step 6: Commit**

```bash
git add sonar-project.properties vitest.config.ts package.json .env.example
git commit -m "feat: PB-014 add sonar-project.properties, lcov reporter, sonar:local script"
```

---

## Task 2: CLAUDE.md Workflow Integration

**Files:**
- Modify: `CLAUDE.md`
- Modify: `docs/STATUS.md`

- [ ] **Step 1: Add SonarQube step to the pre-PR checklist in `CLAUDE.md`**

Find the pre-PR checklist block. It currently ends with:
```markdown
- [ ] **Final validation:** Run `npm test` and verify all tests pass with no uncommitted changes
- [ ] **Ready for PR:** All documentation reflects final state, no outstanding sync tasks
```

Replace it with:
```markdown
- [ ] **Final validation:** Run `npm test` and verify all tests pass with no uncommitted changes
- [ ] **SonarQube local scan:** Run `npm run sonar:local` and review results at https://sonarcloud.io/project/issues?id=igoyetche_send-to-kindle. Resolve any bugs or vulnerabilities before creating the PR. For hotspots, confirm they are safe.
- [ ] **Ready for PR:** All documentation reflects final state, no outstanding sync tasks
```

- [ ] **Step 2: Add "Checking a PR After Creation" section to `CLAUDE.md`**

Find the `### Pre-PR Checklist` section. Add a new section directly after the checklist block ends (`Only after all items are checked off: create the PR.`):

```markdown
### Checking a PR After Creation

After creating a PR, use `/check-pr` to fetch CI and SonarCloud results for the current branch. The command reports all failing checks, extracts build error details, and parses the SonarCloud bot comment. It proposes fixes but does not act without explicit approval for each issue.
```

- [ ] **Step 3: Add PB-014 to `docs/STATUS.md` Active Work table**

In `docs/STATUS.md`, add a row to the Active Work table:

```markdown
| PB-014 | SonarQube CI Workflow | 🔄 In Progress | CLAUDE.md, docs/specs/ | plans/active/PB-014-sonarqube-ci.md | High |
```

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md docs/STATUS.md
git commit -m "feat: PB-014 add sonar:local pre-PR checklist step and check-pr workflow to CLAUDE.md"
```

---

## Task 3: `/check-pr` Global Command

**Files:**
- Create: `~/.claude/commands/check-pr.md` (outside repo — not git-tracked in paperboy)

- [ ] **Step 1: Create the commands directory if it doesn't exist**

```bash
mkdir -p ~/.claude/commands
```

- [ ] **Step 2: Create `~/.claude/commands/check-pr.md`**

Create the file with this exact content:

```markdown
# Check PR

You are checking the CI and SonarCloud status of the current branch's open PR.
Follow these steps exactly, in order. Do NOT skip steps or act before Step 5.

## Step 1: Identify the PR

Run: `gh pr list --head $(git branch --show-current) --json number,title,url`

If no open PR is found for this branch, report "No open PR found for branch <name>" and stop.
Extract the PR number for use in subsequent steps.

## Step 2: Fetch check statuses

Run: `gh pr checks <number>`

Parse the output and group results into:
- Passing checks (conclusion: success / skipped)
- Failing checks (conclusion: failure / cancelled / timed_out)

If all checks pass, report "All checks passing on PR #<number>" and stop.

## Step 3: Diagnose each failing check

For each failing check, run the appropriate diagnosis:

### CI build failure (check name matches a GitHub Actions job, e.g. "build"):

Run: `gh run list --branch $(git branch --show-current) --json databaseId,status,conclusion --limit 3`

Find the most recent run with conclusion "failure". Extract its `databaseId`.

Run: `gh run view <databaseId> --log-failed`

From the output, extract:
- Which job/step failed
- The exact error message (skip timestamps, runner noise — keep the meaningful lines)

### SonarCloud failure (check name contains "SonarCloud"):

Run: `gh pr view <number> --json comments`

Find the comment where `author.login` is `"sonarqubecloud"`. Parse its `body` field to extract:
- Quality Gate status line (passed / failed)
- Each failed condition: type (Bug, Vulnerability, Security Hotspot, Code Smell), count, and description
- The dashboard URL

## Step 4: Present a structured report

Format the findings as:

    PR #<number>: <title>

    CI Build:      ✅ passed  /  ❌ failed
      → <step that failed>: <error message, 1-3 lines>

    SonarCloud:    ✅ passed  /  ❌ failed
      Quality Gate: <Passed / Failed>
      Failed conditions:
        - [<Type>] <count> — <description>
      Dashboard: <url>

If a check has no diagnosis (e.g. a third-party check), note it as "no log available".

## Step 5: Wait for instructions — do NOT act yet

After presenting the report, ask for instructions on each failing item:

For each CI build failure:
> "I can fix `<error summary>`. Shall I proceed?"

For each SonarCloud issue:
> "How would you like to handle [<Type>] `<description>`?
> (a) fix the code  (b) mark safe on SonarCloud  (c) skip for now"

Wait for explicit confirmation before touching any file or making any commit.
```

- [ ] **Step 3: Verify the command is discoverable**

Open a new Claude Code session (or restart the current one) and type `/check-pr`. Claude should load and follow the playbook above.

Expected: Claude runs `gh pr list --head ...` and proceeds through the steps.

Note: this file lives at `~/.claude/commands/check-pr.md` and is not tracked in this repository. It is available globally across all projects.

---

## Task 4: Documentation Sync

**Files:**
- Modify: `docs/features/active/PB-014-sonarqube-ci.md`
- Move: `docs/features/active/` → `docs/features/done/`
- Move: `docs/plans/backlog/` → `docs/plans/done/`
- Modify: `docs/STATUS.md`
- Modify: `docs/CHANGELOG.md`

- [ ] **Step 1: Mark all acceptance criteria as complete in the feature file**

In `docs/features/active/PB-014-sonarqube-ci.md`, change all `- [ ]` to `- [x]` and update status:

```markdown
**Status:** Complete
**Completed:** 2026-04-14
```

- [ ] **Step 2: Move feature file to done**

```bash
cp docs/features/active/PB-014-sonarqube-ci.md docs/features/done/PB-014-2026-04-14-sonarqube-ci.md
git rm docs/features/active/PB-014-sonarqube-ci.md
git add docs/features/done/PB-014-2026-04-14-sonarqube-ci.md
```

- [ ] **Step 3: Move plan file to done**

```bash
cp docs/plans/backlog/PB-014-sonarqube-ci.md docs/plans/done/PB-014-2026-04-14-sonarqube-ci.md
git rm docs/plans/backlog/PB-014-sonarqube-ci.md
git add docs/plans/done/PB-014-2026-04-14-sonarqube-ci.md
```

- [ ] **Step 4: Update `docs/STATUS.md`**

Move PB-014 from Active Work to Completed:
- Remove the PB-014 row from the Active Work table
- Add to the Completed table:
  ```markdown
  | PB-014 | SonarQube CI Workflow | CLAUDE.md | 2026-04-14 | plans/done/PB-014-2026-04-14-sonarqube-ci.md |
  ```
- Update `> Last updated:` to `2026-04-14`

- [ ] **Step 5: Append to `docs/CHANGELOG.md`**

Add at the top (after the `---` separator, before the previous entry):

```markdown
## 2026-04-14 — PB-014 Complete: SonarQube CI Workflow

### Feature Completed
- **`sonar-project.properties`**: Configures SonarCloud project key (`igoyetche_send-to-kindle`), TypeScript sources, test directory, and lcov coverage path.
- **`npm run sonar:local`**: One-command local scan — runs `test:coverage` (generates `coverage/lcov.info`) then `sonar-scanner`. Results appear on SonarCloud dashboard without a GitHub push.
- **`/check-pr` global command**: `~/.claude/commands/check-pr.md` — reusable across all projects. Fetches CI check statuses via `gh pr checks`, extracts build errors via `gh run view --log-failed`, parses the SonarCloud bot comment. Reports findings and waits for per-issue instructions before acting.
- **CLAUDE.md**: Pre-PR checklist gains a SonarQube scan step; new "Checking a PR After Creation" section documents the `/check-pr` command.

### No Spec Changes
No changes to `docs/specs/main-spec.md` — this feature affects the development workflow only, not the application behaviour.

---
```

- [ ] **Step 6: Final validation**

Run:
```
npm test
```

Expected: 293 passing, 3 skipped. No failures.

- [ ] **Step 7: Commit**

```bash
git add docs/features/done/PB-014-2026-04-14-sonarqube-ci.md
git add docs/plans/done/PB-014-2026-04-14-sonarqube-ci.md
git add docs/STATUS.md docs/CHANGELOG.md
git commit -m "chore: PB-014 documentation sync — feature and plan archived, changelog updated"
```
