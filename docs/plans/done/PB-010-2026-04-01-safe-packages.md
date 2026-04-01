# Safe npm Packages Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Block commits and CI builds when any high or critical npm vulnerability is detected in the dependency tree.

**Architecture:** Add a single `audit:ci` npm script (`npm audit --audit-level=high`) and invoke it in two places: the existing Husky pre-commit hook and a new GitHub Actions CI workflow. No new dependencies introduced.

**Tech Stack:** npm audit (built-in), Husky (already configured), GitHub Actions

---

### Task 1: Add `audit:ci` script to `package.json`

**Files:**
- Modify: `package.json`

- [x] **Step 1: Add the script**

In `package.json`, add `"audit:ci"` to the `scripts` block, after `"lint:fix"`:

```json
"lint:fix": "eslint --fix src test",
"audit:ci": "npm audit --audit-level=high"
```

- [x] **Step 2: Verify the script runs**

```bash
npm run audit:ci
```

Expected: exits 0 (no high/critical vulnerabilities found). If it exits non-zero, run `npm audit` to see the full report and resolve before continuing.

- [x] **Step 3: Commit**

```bash
git add package.json
git commit -m "chore: add audit:ci script to enforce npm audit --audit-level=high"
```

---

### Task 2: Add audit step to Husky pre-commit hook

**Files:**
- Modify: `.husky/pre-commit`

Current contents:
```sh
npm exec lint-staged
npm test
```

- [x] **Step 1: Append the audit step**

Add `npm run audit:ci` as the last line of `.husky/pre-commit`:

```sh
npm exec lint-staged
npm test
npm run audit:ci
```

- [x] **Step 2: Verify the hook runs on commit**

Stage any trivial change (e.g., add a blank line to `package.json`, then remove it):

```bash
git add package.json
git commit -m "test: verify audit hook runs"
```

Expected: the commit succeeds and you see audit output in the hook log. If the audit finds vulnerabilities at high/critical level, the commit is aborted — fix them before continuing.

Revert the trivial change if you made one:
```bash
git reset HEAD~1
git checkout package.json
```

- [x] **Step 3: Commit**

```bash
git add .husky/pre-commit
git commit -m "chore: add npm audit check to pre-commit hook"
```

---

### Task 3: Create GitHub Actions CI workflow

**Files:**
- Create: `.github/workflows/ci.yml`

- [x] **Step 1: Create the workflows directory**

```bash
mkdir -p .github/workflows
```

- [x] **Step 2: Write the workflow file**

Create `.github/workflows/ci.yml` with this exact content:

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  build:
    runs-on: ubuntu-latest

    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Set up Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '22'
          cache: 'npm'

      - name: Install dependencies
        run: npm ci

      - name: Audit dependencies
        run: npm run audit:ci

      - name: Run tests
        run: npm test
```

- [x] **Step 3: Verify the file is valid YAML**

```bash
node -e "const fs = require('fs'); console.log('OK:', fs.existsSync('.github/workflows/ci.yml'))"
```

Expected: `OK: true`

- [x] **Step 4: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: add GitHub Actions workflow with npm audit and test steps"
```

---

### Task 4: Sync docs and open PR

**Files:**
- Modify: `docs/features/backlog/PB-010-safe-packages.md` → move to `docs/features/active/PB-010-safe-packages.md`
- Modify: `docs/STATUS.md`

- [x] **Step 1: Move feature doc to active**

```bash
mv docs/features/backlog/PB-010-safe-packages.md docs/features/active/PB-010-safe-packages.md
```

- [x] **Step 2: Update STATUS.md**

In `docs/STATUS.md`, move PB-010 from Backlog to Active Work and mark phase as 🔄 In Progress:

```markdown
## Active Work

| Code | Feature | Phase | Specs Affected | Plan | Status |
|------|---------|-------|---|---|---|
| PB-010 | Safe npm Packages | 🔄 In Progress | — | plans/active/PB-010-safe-packages.md | High |
```

- [x] **Step 3: Move plan to active**

```bash
mv docs/plans/backlog/PB-010-safe-packages.md docs/plans/active/PB-010-safe-packages.md
```

- [x] **Step 4: Commit**

```bash
git add docs/features/active/PB-010-safe-packages.md docs/features/backlog/PB-010-safe-packages.md docs/plans/active/PB-010-safe-packages.md docs/plans/backlog/PB-010-safe-packages.md docs/STATUS.md
git commit -m "docs: move PB-010 to active, update STATUS.md"
```

- [x] **Step 5: Open PR**

Use the `superpowers:finishing-a-development-branch` skill to open a PR from `feature/PB-010-safe-packages` → `main`.
