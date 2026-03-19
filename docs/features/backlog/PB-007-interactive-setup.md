# PB-007: Interactive Setup Wizard

> Status: Backlog
> Created: 2026-03-18
> Completed: —
> Priority: High

## Motivation

After installing Paperboy (`npm install -g`), the user must manually create `~/.paperboy/.env` with 6+ credentials (SMTP host, port, user, password, Kindle email, sender email). There is no guided setup flow — the user has to know the variable names, formats, and file location. This is the biggest friction point in the distribution story.

Both distribution paths need a setup story:
- **Human in terminal** — needs an interactive wizard that prompts for each value
- **Claude via skill** — needs a non-interactive mode that accepts values as flags

## Scope

### In scope

- `paperboy init` subcommand with interactive prompts (TTY mode)
- `paperboy init` with `--non-interactive` flag accepting all values as CLI flags
- Input validation before writing (email format, port is numeric, required fields present)
- Writes `~/.paperboy/.env` with the provided values
- Refuses to overwrite existing `~/.paperboy/.env` without `--force` flag
- Optional `--verify` flag that sends a test document after writing config
- Update SKILL.md with a setup section that uses the non-interactive mode
- `paperboy init --show` to print current config location and status (configured / not configured) without revealing secrets

### Out of scope

- GUI or web-based setup
- OAuth flows for SMTP (app passwords only)
- Multi-user or shared configuration
- Encrypted credential storage
- Editing individual values after initial setup (user edits the file directly or re-runs `init --force`)

## Acceptance Criteria

1. **Interactive mode:** Running `paperboy init` in a TTY prompts for each required value, validates inputs, and writes `~/.paperboy/.env`
2. **Non-interactive mode:** Running `paperboy init --non-interactive --kindle-email ... --sender ... --smtp-host ... --smtp-port ... --smtp-user ... --smtp-pass ...` writes the config without prompts
3. **Validation:** Invalid email addresses and non-numeric ports are rejected with clear error messages before writing
4. **Overwrite protection:** If `~/.paperboy/.env` already exists, `init` exits with a message unless `--force` is passed
5. **Verify flag:** `paperboy init --verify` writes the config and then sends a test EPUB titled "Paperboy Setup Test" to the configured Kindle device
6. **Show flag:** `paperboy init --show` prints whether config exists and its path, without revealing credential values
7. **Skill integration:** SKILL.md includes a setup section instructing Claude to use `--non-interactive` flags, gathering values conversationally before invoking the command
8. **Exit codes:** `init` uses exit code 0 on success, 1 on validation error, 4 on config write failure
9. **No regression:** Existing `paperboy --title ... --file ...` behavior is unchanged
