# PB-020: curl --impersonate Fallback for Cloudflare-Protected Images

**Status:** Backlog
**Date:** 2026-04-13

## Motivation

PB-019 added browser-compatible HTTP headers to image downloads, which fixes basic hotlink protection and User-Agent checks. However, sites using Cloudflare Bot Management (e.g., dl.acm.org, some academic publishers) still return HTTP 403 because Cloudflare uses TLS fingerprinting (JA3/JA3N) to detect non-browser clients. Node.js native fetch uses OpenSSL with a different TLS ClientHello signature than Chrome, so the declared User-Agent and the TLS handshake don't match — Cloudflare rejects the request regardless of HTTP headers.

`curl` 8.x added `--impersonate <browser>` support, which mimics a browser's complete TLS profile (cipher suites, extensions, ordering) in addition to HTTP headers. This would allow the image processor to successfully download images from Cloudflare Bot Management-protected hosts.

## Scope

- When `fetch()` returns HTTP 403 from a Cloudflare-protected host (detected by presence of `cf-ray` response header), retry the download using a `curl --impersonate chrome124` subprocess
- Fall back gracefully if curl 8.x is not available (log a debug message, treat as normal failure)
- No change to the happy path (Node.js fetch continues to be used for non-Cloudflare hosts)

## Out of Scope

- Making curl the primary download mechanism
- Authenticated or paywalled images (NG-2 from PB-016)
- Sites using JavaScript challenges (require a headless browser — a different problem class entirely)

## Acceptance Criteria

- [ ] Images from dl.acm.org article pages download successfully when curl 8.x is installed
- [ ] When curl 8.x is not installed, the image fails gracefully with a clear log message indicating the curl fallback was unavailable
- [ ] All existing image-downloading tests continue to pass
- [ ] The curl fallback does not introduce new SSRF risks (the same URL validation must apply)
