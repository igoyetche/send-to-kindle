# PB-009: Watch Folder

**Status:** Active
**Date:** 2026-03-31

## Motivation

Users want a "set and forget" way to send Markdown files to their Kindle. Rather than running CLI commands for each file, they drop `.md` files into a folder and the watcher handles conversion and delivery automatically.

## Scope

**Phase 1 (this feature):**
- `paperboy watch` foreground watcher command
- Template service configs in `scripts/service-templates/`
- Documented one-liner install per OS

**Phase 2 (follow-up):**
- `paperboy watch install/uninstall/status` automated service management

## Acceptance Criteria

- [ ] `paperboy watch` starts a foreground watcher on the configured `WATCH_FOLDER`
- [ ] `.md` files dropped into the folder are converted to EPUB and sent to Kindle
- [ ] Processed files are moved to `WATCH_FOLDER/sent/`
- [ ] Failed files are moved to `WATCH_FOLDER/error/` with `.error.txt`
- [ ] Transient SMTP failures are retried up to 3 times with exponential backoff
- [ ] `paperboy watch --help` shows watcher usage
- [ ] Existing `.md` files in the folder are processed on startup
- [ ] Graceful shutdown on SIGINT/SIGTERM
- [ ] Service template configs for Windows, macOS, Linux
