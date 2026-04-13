# PB-019: Image Download Compatibility for Protected and CDN-Hosted Images

**Status:** Active — Design
**Design Started:** 2026-04-13
**Branch:** `pb-019-image-download-compatibility`
**Date:** 2026-04-13

## Motivation

Images from many real-world article sources fail to download silently. Investigation of a specific failure — https://dl.acm.org/doi/10.1145/3779312 — reveals two distinct root causes that affect a wide class of image hosts, not just ACM.

### Root Cause 1 — Missing browser-compatible request headers

The image downloader (`ImageProcessor.fetchWithTimeout`) sends bare `fetch()` requests with no headers whatsoever. Node.js native `fetch` sends no `User-Agent` in this configuration. Publishers, academic sites, and any host protected by Cloudflare, AWS WAF, or hotlink-protection middleware will respond with `403 Forbidden` before the image data is even considered. Both direct attempts to reach dl.acm.org returned `HTTP 403` for exactly this reason.

### Root Cause 2 — Redirects are unconditionally rejected

When a server responds with any 3xx status, the current code throws `"Redirect not supported"` and the image is counted as failed. This was an intentional placeholder in PB-016 (`// Don't follow redirects for now - just fail`) to defer the SSRF-safe implementation. Many CDNs and academic publishers use redirect chains — a canonical image URL resolves through one or more redirects before reaching the actual file on a CDN edge node. Every such image silently disappears from the delivered EPUB.

### Combined impact

An article clipped from dl.acm.org (or similar publisher/news site) produces an EPUB with all images missing, even though the images are publicly accessible in a browser. The user has no indication that headers or redirects were the cause — the failure log shows only generic `HTTP 403` or `Redirect not supported` messages.

## Scope

- Add browser-compatible request headers (`User-Agent`, `Accept`) to all image download requests so WAF/CDN bot-detection passes
- Implement safe HTTP redirect following: follow redirect chains up to a reasonable depth, with SSRF protection applied at each hop (reject redirects to private/loopback IP ranges)
- The fix must not relax the existing SSRF protections — only make redirect following safe rather than absent

## Out of Scope

- Authenticated or cookie-gated images (paywalled content — already NG-2 in PB-016 spec)
- Configurable User-Agent string (use a sensible fixed default)
- Proxy support
- Changes to timeout, retry, or size-limit logic

## Acceptance Criteria

- [ ] Images from dl.acm.org article pages download successfully (returns actual image bytes, not `HTTP 403`)
- [ ] Images served behind a redirect chain (1–5 hops) are downloaded successfully and embedded in the EPUB
- [ ] Redirects to private IPv4 ranges (10.x, 172.16–31.x, 192.168.x, 127.x) and loopback addresses are rejected with a clear error — SSRF protection is preserved
- [ ] Redirects to non-HTTP/HTTPS protocols continue to be rejected
- [ ] Redirect depth is capped (e.g., max 5 hops); exceeding the cap fails that image gracefully without halting conversion
- [ ] All existing image-downloading tests continue to pass (no regression)
- [ ] New tests cover: successful download with redirect, redirect to private IP rejected, redirect depth exceeded, User-Agent header present on outgoing requests
- [ ] TypeScript compiles with zero errors in strict mode
