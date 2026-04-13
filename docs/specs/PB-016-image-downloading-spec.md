# PB-016: Online Image Downloading — System Spec

> Updated 2026-04-13 via feature: PB-019 image download compatibility

## 1. Problem Statement

Markdown content sent through Paperboy frequently contains image references pointing to online resources — CDN-hosted photos, blog illustrations, diagrams. A real-world sample article (`2026-04-08-high-agency-in-30-minutes-george-mack.md`) contains 20+ remote image URLs. Today, these images either silently fail during EPUB generation (crashing the entire conversion if any single download fails) or produce EPUB files with image formats that Kindle devices cannot render (e.g., AVIF, WebP). The result is either a failed delivery or a document with broken/missing images — both unacceptable for a reading experience.

The underlying library (`epub-gen-memory`) already downloads images referenced in HTML `<img>` tags, but Paperboy does not configure its download options and performs no format compatibility checks. This spec defines the requirements for making image downloading reliable, resilient, and Kindle-compatible.

## 2. Goals and Non-Goals

### Goals

- G-1: Remote images referenced in Markdown content are downloaded and embedded in the generated EPUB so they display on Kindle without an internet connection
- G-2: Image downloads are resilient — a single failed image does not prevent the rest of the document from being delivered
- G-3: Images are delivered in formats that Kindle can render (JPEG, PNG, GIF, BMP)
- G-4: The user has visibility into which images succeeded and which failed, without disrupting the delivery flow

### Non-Goals

- NG-1: No image editing, cropping, or watermark removal
- NG-2: No support for authenticated or paywalled image URLs (images behind login are out of scope). Browser-compatible request headers (FR-14) pass bot-detection and hotlink protection but do not constitute authentication — login-gated images remain out of scope.
- NG-3: No local/relative image path resolution (only `http://` and `https://` URLs)
- NG-4: No OCR or automatic alt-text generation for images
- NG-5: No image compression quality tuning exposed to the user — sensible defaults only
- NG-6: No support for `<picture>` elements or `srcset` — only standard `<img src="...">` references
- NG-7: No support for sites protected by Cloudflare Bot Management or similar TLS-fingerprint-based bot detection. Browser-compatible HTTP headers (FR-14) bypass basic hotlink protection and User-Agent checks but cannot bypass TLS fingerprinting. Sites like dl.acm.org that use Cloudflare Bot Management will continue to return HTTP 403. A future feature may add a `curl --impersonate` fallback for this class of sites.

## 3. Users and Actors

| Actor | Description | Interaction |
| --- | --- | --- |
| **MCP Client / CLI User** | Submits Markdown content containing `![alt](https://...)` image references | No change in interaction — images are handled transparently during conversion |
| **Image Host (CDN)** | Serves image files over HTTPS | Receives HTTP GET requests for image resources during conversion |
| **epub-gen-memory** | EPUB generation library used internally | Downloads images from HTML content and embeds them in the EPUB package |
| **Kindle Device** | Renders the final EPUB | Must receive images in a supported format (JPEG, PNG, GIF, BMP) |

## 4. Functional Requirements

### Image Downloading

- **FR-1**: The system must download images referenced via `http://` or `https://` URLs in `<img src="...">` tags within the HTML produced from Markdown parsing
- **FR-2**: Image downloads must have a per-image timeout of 15 seconds (configurable via `IMAGE_FETCH_TIMEOUT_MS` environment variable, default `15000`)
- **FR-3**: Failed image downloads must be retried up to 2 times before being considered failed
- **FR-4**: Image downloads must be batched (concurrent downloads limited to a reasonable batch size) to avoid overwhelming the source server or the local network

### Graceful Degradation

- **FR-5**: If an image download fails (timeout, HTTP error, DNS failure), the conversion must continue — the failed image must be omitted from the EPUB rather than failing the entire document
- **FR-6**: When one or more images fail to download, the system must include a count of failed images in the delivery response (e.g., `"3 of 20 images could not be downloaded"`)
- **FR-7**: Failed image URLs must be logged at `warn` level with the URL and failure reason

### Format Compatibility

- **FR-8**: Images in formats not supported by Kindle (AVIF, WebP, TIFF, SVG) must be converted to JPEG before being embedded in the EPUB
- **FR-9**: Images already in Kindle-compatible formats (JPEG, PNG, GIF, BMP) must be embedded as-is without re-encoding
- **FR-10**: Format detection must use the actual image bytes (magic bytes / file signature), not the URL file extension or HTTP Content-Type header alone, since CDN URLs frequently omit extensions or return generic MIME types

### Image Size Management

- **FR-11**: Images exceeding 5 MB individually must be skipped and reported as a warning — they are likely unoptimized source files not suitable for e-reader delivery
- **FR-12**: If the total downloaded image payload exceeds 100 MB, image downloading must stop for remaining images and the document must be delivered with the images already downloaded, along with a warning

### Request Compatibility

- **FR-14**: Image download requests must include browser-compatible HTTP headers (`User-Agent`, `Accept`, `Accept-Language`) so that WAF-protected and hotlink-protected image hosts serve the asset rather than returning `403 Forbidden`
- **FR-15**: The system must follow HTTP redirects (status codes 301, 302, 303, 307, 308) up to a maximum of 5 hops per image; exceeding this limit fails that image gracefully without halting conversion
- **FR-16**: Before following any redirect, the redirect target URL must be validated: the hostname must resolve to a public IP address; redirects to private or loopback IP ranges (RFC 1918, link-local, IPv6 loopback) must be rejected to prevent SSRF attacks
- **FR-17**: The existing per-image timeout budget covers the entire redirect chain — not each hop independently

### Response Enrichment

- **FR-13**: The delivery success response must include an `imageStats` summary when the source content contained images:
  - `total`: number of images found in the source
  - `downloaded`: number successfully downloaded and embedded
  - `failed`: number that could not be downloaded or converted
  - `skipped`: number skipped due to size limits

## 5. Non-Functional Requirements

- **NFR-1 — Performance**: Image downloading should not increase total conversion time beyond 90 seconds for documents with up to 50 images, assuming adequate network connectivity
- **NFR-2 — Security**: Downloaded image content must pass through the existing `sanitize-html` pipeline — no executable content or scripts embedded via image payloads
- **NFR-3 — Security**: Image downloading must not follow redirects to non-HTTP(S) protocols (e.g., `file://`, `data:`, `ftp://`) to prevent SSRF-style attacks
- **NFR-4 — Observability**: Each image download attempt must be logged at `debug` level (URL, size, format, duration). Summary stats logged at `info` level after all downloads complete
- **NFR-5 — Compatibility**: Output EPUB must remain valid EPUB 3.0 with embedded images conforming to EPUB content document specifications (JPEG, PNG, GIF, SVG core media types — with SVG converted to avoid Kindle rendering issues)

## 6. Constraints

- **C-1**: The existing `ContentConverter` port signature (`toEpub(title, content, author)`) must not change — image handling is an internal concern of the converter implementation
- **C-2**: Image format conversion (AVIF/WebP → JPEG) requires a processing library. The implementation must use a dependency that works on both x86_64 and ARM64 (to maintain Dockerfile portability per NFR-7 of main spec)
- **C-3**: `epub-gen-memory` v1.1.2 is the current EPUB generation library and already has image downloading support with `fetchTimeout`, `retries`, `batchSize`, and `ignoreFailedDownloads` options
- **C-4**: Amazon's Send to Kindle service accepts EPUB attachments up to 50 MB — the system must not produce EPUBs that exceed this limit due to embedded images

## 7. Key Scenarios

### Scenario 1: Article with images converts and delivers successfully

1. User sends a Markdown article containing 20 `![...](https://...)` image references
2. Paperboy parses the Markdown to HTML, producing `<img src="https://...">` tags
3. During EPUB generation, all 20 images are downloaded from their respective CDNs
4. 18 images are JPEG/PNG and are embedded as-is; 2 are AVIF and are converted to JPEG
5. The EPUB is generated with all 20 images embedded
6. Email is sent; document appears on Kindle with all images visible
7. Response: `"Sent 'High Agency in 30 Minutes' (4.2 MB) — 20 images embedded"`

### Scenario 2: Some images fail to download

1. User sends a Markdown article with 15 image references
2. During EPUB generation, 12 images download successfully, 3 fail (2 timeout, 1 returns 404)
3. The 3 failed images are omitted from the EPUB; the remaining 12 are embedded
4. The EPUB is generated and delivered
5. Response: `"Sent 'Article Title' (2.1 MB) — 12 of 15 images embedded (3 could not be downloaded)"`
6. Warnings logged: each failed URL with reason

### Scenario 3: Image in unsupported format

1. Markdown content references an AVIF image: `![Photo](https://cdn.example.com/photo.avif)`
2. The system downloads the image, detects AVIF format via magic bytes
3. The image is converted from AVIF to JPEG
4. The JPEG version is embedded in the EPUB
5. The image displays correctly on the Kindle device

### Scenario 4: Markdown with no images

1. User sends a text-only Markdown document (no `![...]()` references)
2. Conversion proceeds exactly as today — no image downloading, no additional latency
3. Response does not include `imageStats` (no images to report on)
4. Zero change in behavior for existing text-only workflows

## 8. Open Questions

- **OQ-1**: Should Paperboy resize large-dimension images (e.g., 4000x3000px originals) to a Kindle-appropriate resolution (e.g., max 1600px width)? This would reduce EPUB file size but adds processing complexity and a dependency on an image manipulation library. If format conversion is already required, resizing could piggyback on the same library.
- **OQ-2**: Should there be a `--no-images` CLI flag (and MCP parameter) to skip image downloading entirely for users who want text-only delivery or faster conversion?
- **OQ-3**: When an image fails, should Paperboy insert a text placeholder (e.g., `[Image: alt text]`) in the EPUB where the image would have been, or just omit the `<img>` tag entirely?
- **OQ-4**: Should image downloading respect `Cache-Control` headers or implement any local caching for repeated conversions of the same document? (Probably not — this is a single-user tool and caching adds complexity for little benefit.)

## 9. Success Criteria

- **SC-1**: The sample file `2026-04-08-high-agency-in-30-minutes-george-mack.md` (20+ remote images) converts to an EPUB with all images visible on a Kindle device
- **SC-2**: A document with a mix of JPEG, PNG, and AVIF images produces a valid EPUB with all images in Kindle-compatible formats
- **SC-3**: A document where 5 out of 20 images return HTTP 404 still converts and delivers successfully with the remaining 15 images embedded
- **SC-4**: A text-only Markdown document converts with no performance regression compared to current behavior
- **SC-5**: The delivery response communicates image download results (total, downloaded, failed, skipped) when images are present

## 10. Context and References

- `docs/specs/main-spec.md` — Main system spec; FR-4 through FR-6 define current conversion requirements
- `src/infrastructure/converter/markdown-epub-converter.ts` — Current converter implementation (no image options configured)
- `epub-gen-memory` README — Documents `fetchTimeout`, `retries`, `batchSize`, `ignoreFailedDownloads` options for image handling
- `docs/md-input-samples/2026-04-08-high-agency-in-30-minutes-george-mack.md` — Real-world sample with 20+ remote AVIF images
- [Amazon Send to Kindle: supported formats](https://www.amazon.com/sendtokindle) — EPUB size limits and supported image formats
- [EPUB 3.0 core media types](https://www.w3.org/TR/epub-33/#sec-core-media-types) — JPEG, PNG, GIF, SVG are core media types for EPUB images
