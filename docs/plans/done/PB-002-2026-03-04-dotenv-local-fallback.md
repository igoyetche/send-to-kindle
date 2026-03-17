# PB-002: dotenv Local Fallback — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Load a `.env` file automatically when running locally, with environment variables (container-injected) always taking precedence.

**Architecture:** Add `dotenv` as a runtime dependency. Import it at the very top of `src/index.ts` before any config is read. Because `dotenv` never overrides existing env vars by default, container deployments are unaffected — their OS-level env vars win automatically.

**Tech Stack:** Node.js, `dotenv` npm package, TypeScript ESM

---

### Task 1: Update spec

**Files:**
- Modify: `docs/spec.md` — FR-13 and C-5

**Step 1: Update FR-13**

In `docs/spec.md`, replace the FR-13 line:

```
- **FR-13**: The system must be configurable with: Kindle delivery email address, sender email address, SMTP host/port/credentials, and a default author name
```

With:

```
- **FR-13**: The system must be configurable with: Kindle delivery email address, sender email address, SMTP host/port/credentials, and a default author name. When running locally, configuration may be provided via a `.env` file in the project root; environment variables always take precedence over `.env` values
```

**Step 2: Update C-5**

Replace:

```
- **C-5**: The system relies on an external SMTP provider for email delivery; it does not implement its own mail transfer agent
```

With:

```
- **C-5**: The system relies on an external SMTP provider for email delivery; it does not implement its own mail transfer agent
- **C-8**: For local development, the system must support loading configuration from a `.env` file as a fallback. Environment variables set by the container runtime always take precedence; `.env` is never loaded in production containers where env vars are already injected
```

**Step 3: Commit**

```bash
git add docs/spec.md
git commit -m "docs: add dotenv local fallback to spec (FR-13, C-8)"
```

---

### Task 2: Install dotenv

**Files:**
- Modify: `package.json` (via npm install)

**Step 1: Install the package**

```bash
npm install dotenv
```

Expected: `dotenv` appears under `dependencies` in `package.json`.

**Step 2: Verify types are bundled**

`dotenv` ships its own TypeScript types — no `@types/dotenv` needed. Confirm:

```bash
ls node_modules/dotenv/types
```

Expected: `index.d.ts` present.

**Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: add dotenv dependency"
```

---

### Task 3: Wire dotenv in the composition root

**Files:**
- Modify: `src/index.ts` — add import at top

**Step 1: Add the import**

At the very top of `src/index.ts`, before any other import, add:

```typescript
import 'dotenv/config';
```

The full top of the file should look like:

```typescript
import 'dotenv/config';
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
// ... rest of imports unchanged
```

**Why first?** Node.js executes side-effect imports in order. `dotenv/config` must populate `process.env` before `loadConfig()` reads from it.

**Step 2: Verify TypeScript compiles**

```bash
npm run build
```

Expected: exits with code 0, no errors.

**Step 3: Commit**

```bash
git add src/index.ts
git commit -m "feat: load .env file as config fallback for local development"
```

---

### Task 4: Smoke-test locally

**Step 1: Copy example env**

```bash
cp .env.example .env
```

**Step 2: Fill in real or dummy values in `.env`**

At minimum set all required vars so `loadConfig()` does not throw:

```
KINDLE_EMAIL=test@kindle.com
SENDER_EMAIL=test@gmail.com
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=test@gmail.com
SMTP_PASS=dummy
```

**Step 3: Run the server**

```bash
npm run dev
```

Expected: server starts with `"Send to Kindle MCP server started (stdio)"` log line. No `Missing required environment variable` error.

**Step 4: Confirm precedence — env var wins over .env**

```bash
KINDLE_EMAIL=override@kindle.com npm run dev 2>&1 | head -5
```

Expected: server starts without error. The `override@kindle.com` value is used (not the one in `.env`).

---

### Task 5: Update CLAUDE.md

**Files:**
- Modify: `CLAUDE.md` — Setup section

**Step 1: Add dotenv note to Setup**

Find the Setup section and add a note after `npm install`:

```markdown
## Setup

```bash
npm install
```

Copy `.env.example` to `.env` and fill in your credentials for local development:

```bash
cp .env.example .env
```

> `.env` is only loaded when running locally. In Docker, environment variables are injected at container runtime and take precedence automatically.
```

**Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: document .env local development setup"
```
