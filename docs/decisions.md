# Decisions

Findings from section 17 of `BRIEF.md` and choices made where the brief left room. Checked 2026-10-30 against live docs. Where live docs and the brief disagree, live docs win and the difference is noted here.

## 17.1 Instagram API contract

Source: Meta "Instagram Platform" docs (`instagram-api-with-instagram-login/get-started`, `reference/instagram-media`).

- Host: `graph.instagram.com`. Current version in examples: `v26.0`. We pin the version in one constant (`API_VERSION` in `src/providers/instagram.js`).
- Media edge: `GET /{version}/me/media`. `/me` resolves to the token's account. Pagination uses `paging.cursors.after` and `paging.next`.
- `media_type`: `IMAGE`, `VIDEO`, `CAROUSEL_ALBUM`.
- `media_product_type`: `AD`, `FEED`, `STORY`, `REELS`.
- `thumbnail_url`: documented as present on `VIDEO` only.
- `media_url`: may be omitted for videos with copyrighted or licensed audio. Docs say to fall back to `thumbnail_url` or `permalink`.
- Carousels: docs do not say whether the album's `media_url` is the cover. We use the album's `media_url`; if absent, the item is rejected (no `children` call in v1, to keep one request per page).

**Difference from the brief.** The IG Media reference marks `caption` and `media_product_type` as "Available for Instagram API with Facebook Login only". The brief assumes both are available with Instagram Login. Decision:
- Request both fields anyway. Treat both as optional in the adapter.
- Missing `caption` → empty caption (media rules and fallback still classify the item).
- Missing `media_product_type` on a `VIDEO` → classify as `reel` when the permalink path contains `/reel/`, else `video`.
- **Open:** the live smoke test (section 14.8) must confirm whether captions come back. If they don't, keyword and hashtag rules never match, which the README must then say plainly.

Errors (standard Graph error shape `{"error": {"message", "type", "code", "error_subcode", "fbtrace_id"}}`; the Instagram error-code page returned 404 on 2026-10-30, so codes come from Graph API conventions):
- `code: 190` → expired or invalid token → actionable message, no retry.
- HTTP 429, HTTP 5xx, and Graph throttling codes `4`, `17`, `32`, `613` → retry (1 s, 4 s, 16 s), then fail. The throttling codes are an addition to the brief: Graph often reports throttling as HTTP 400 with one of these codes.
- Any other 4xx → fail immediately.

### Adapter choices (M3)

- **Fail the run** (malformed response, nothing written): body is not JSON, no `data` list, or an entry lacks `id`, `media_type`, `permalink`, or a valid ISO 8601 `timestamp`.
- **Skip the item with a warning** (run continues): ID outside `^[A-Za-z0-9_-]{1,64}$`; permalink not on `https://www.instagram.com/` or `https://instagram.com/`; `media_product_type: STORY`; unknown `media_type`; no usable https thumbnail URL.
- **Videos and Reels use `thumbnail_url` only.** Their `media_url` is the video file, and the brief says never to download video. A video with no `thumbnail_url` is skipped.
- **Pagination builds the next URL from `paging.cursors.after`** instead of following `paging.next`, so the token only goes to a URL we constructed. Skipped entries count toward `fetch.limit`.
- **Network failures** (fetch throws) retry on the same schedule as 429/5xx.
- **Fixture mode** (`fixture_dir`) swaps `fetch` for a file reader: `<last path segment>[-after-<cursor>].json` for API calls, and `https://fixtures.invalid/<path>` for thumbnails.

## 17.2 Token refresh semantics

Source: `reference/refresh_access_token`.

- `GET https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token=…`
- Token must be at least 24 hours old and unexpired.
- Response: `{ "access_token", "token_type": "bearer", "expires_in": <seconds> }`, about 60 days.
- Not documented: whether the old token stays valid, and any refresh rate limit.

Rechecked 2026-11-02. The docs still don't say whether the old token survives a refresh, or set a refresh limit, and they document no way to look up a token's expiry. Third-party write-ups disagree on whether the old token keeps working. The docs' sample response shows a different string from the sample request.

Decision: assume nothing, and handle every answer. Each non-dry run calls refresh after a successful fetch:

- **Same string returned:** the secret is already extended. Expiry is now + `expires_in`.
- **New string, `secrets_token` set:** stored with `gh secret set`, over stdin. `gh` is on every GitHub-hosted runner and does the sealed-box encryption the API requires, so this needs no crypto dependency (Node has no XSalsa20).
- **New string, no `secrets_token`:** it can't be saved, and the old token may not have been extended. `index.json` gets a `token` record: a 16-hex-character SHA-256 fingerprint of the secret, and first-seen + `expires_in` as a worst-case expiry. The date never moves while the fingerprint matches, so this adds one commit and no daily diffs. Rotating the secret changes the fingerprint and restarts the count. If the old token actually was extended, the cost is an unneeded rotation every 46 days.
- **Refresh fails:** a warning, not a failure. It's normal for a token under 24 hours old, and fetching media has already proved the token works. If the old token stops working, the next fetch fails with the code 190 message.
- **14 days or fewer left, or the store failed:** the run fails *after* pushing, so a token problem doesn't cost that day's update. The example workflow's Pages step uses `!cancelled()` so it still runs.

Dry runs and fixture runs don't refresh: a refresh may rotate the token, and a dry run changes nothing.

**Open:** the live smoke test (14.8) shows which of these cases Instagram actually takes.

## 17.3 Pages rebuild on bot pushes

Source: GitHub docs, "GITHUB_TOKEN" concept page: commits pushed with `GITHUB_TOKEN` "do not trigger a GitHub Pages build". Only `workflow_dispatch` and `repository_dispatch` are exempt from the no-recursion rule.

Decision: the action sets an output `changed` (`true`/`false`). The example workflow then:
- **Deploy from branch:** calls `POST /repos/{repo}/pages/builds` with `gh api` when `changed == 'true'` (needs `pages: write`).
- **Actions-based Pages:** runs `actions/upload-pages-artifact` + `actions/deploy-pages` in the same workflow.

**Open:** Pages isn't enabled on this repo, so e2e can't exercise the build request. The live smoke test (14.8) confirms it works with `GITHUB_TOKEN`.

## 17.4 ImageMagick on `ubuntu-latest`

Source: `actions/runner-images` Ubuntu 24.04 readme. ImageMagick is **not** listed.

Decision: the action does not install packages itself. Installing them would add network calls beyond the provider API, which section 2.2 rules out. The example workflow adds:

```yaml
- run: sudo apt-get update && sudo apt-get install -y imagemagick
```

Cost: roughly 20–40 s of runner time per run, free on a public repo. Preflight looks for `magick` (ImageMagick 7), then `convert` (ImageMagick 6, which Ubuntu ships). It fails with that exact install line if neither is found, and falls back to JPEG if the WebP coder is missing.

**Confirmed on a real runner (e2e, 2026-10-30):** `apt-get install imagemagick` gives ImageMagick 6.9.12 with a WebP encoder (`WEBP* rw+`, libwebp 1.3.2).

### Thumbnail choices (M4)

- **Shrink only, never enlarge** (`-resize 480x>`). A source narrower than `thumbnails.width` keeps its width; upscaling adds bytes and blur.
- **Only JPEG, PNG and WebP inputs**, detected from magic bytes. The decoder is named explicitly (`jpeg:file[0]`), so a hostile download cannot reach ImageMagick's SVG, MSL or text decoders. Anything else fails the item.
- **Download cap: 15 MB** (declared `Content-Length` and actual bytes). One attempt; a failed download fails the run, and the next daily run tries again.
- **`max_bytes`** applies to the 480 px image: quality steps down by 10 to a floor of 30, then the item fails. For WebP, each retry also passes `-define webp:target-size=<95% of max_bytes>`. The 96 px image uses the configured quality.
- **Finding (2026-10-30, ubuntu-24.04 runner, ImageMagick 6.9.12 + libwebp 1.3.2): `-quality` has no effect on WebP output.** Quality 75 and 30 produced byte-identical files, with JPEG or PNG input, before or after the input, and through a pipe. JPEG quality works normally. `-define webp:target-size=N` does work (8,000 requested, 7,768 delivered), so `max_bytes` is enforced through it. Consequence: on ImageMagick 6, `thumbnails.quality` does not affect WebP; on ImageMagick 7 (local macOS) it does. The README must say so.
- **`-auto-orient` before `-strip`**, so rotation survives metadata removal.
- No `-limit` flags: their units differ between ImageMagick 6 and 7. Ubuntu's `policy.xml` limits plus the 15 MB cap bound memory use.
- Output is byte-identical for identical input (checked by test), which keeps reruns diff-free.

## 17.5 Action runtime

Source: GitHub docs, metadata syntax. `runs.using` supports `node20` and `node24`. We use `node24`.

## 17.6 Meta development-mode rules

Source: Instagram Platform overview.

- Standard Access is the default and covers apps that serve only the developer's own accounts or accounts with a role on the app. Advanced Access (App Review + Business Verification) applies to apps serving accounts the developer doesn't own or manage. A per-influencer app used only by that influencer fits Standard Access.
- The overview states no specific storage or caching rules. It defers to Meta Platform Terms and Developer Policies, and notes CDN URLs stop serving deleted media. Our daily deletion sync (section 11, step 4) removes items deleted on Instagram that are still inside the fetch window.
- **Open:** the README points influencers to Meta's current Platform Terms and Developer Policies. This is not legal advice.

## 17.7 Scheduled-workflow inactivity rule

Source: GitHub docs, "Disabling and enabling a workflow". Scheduled workflows in public repos are disabled after 60 days without repository activity. The docs don't define activity. Per the brief, we don't rely on bot commits counting. The README documents `gh workflow enable`.

## Rendering choices (M5)

- **Default light colors darkened for WCAG AA.** The brief's light `muted` (`#7a6f63`, 4.21:1 on paper) and `accent` (`#d9542b`, 3.43:1) fall short of 4.5:1 for normal text, and the brief requires AA for the defaults. New defaults keep the hues: `muted #6b6157` (5.19:1) and `accent #b5441d` (4.73:1). Dark-mode defaults already pass and are unchanged. A test checks all six text colors.
- **CSP meta on every page:** `default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'`. The browser then enforces self-containment even if an escaping bug slipped through. Also `referrer: no-referrer`.
- **Other people's `@handles` are removed from captions** before display (section 3: never publish other people's usernames). Email addresses stay.
- **Dates render as ISO `yyyy-mm-dd` (UTC).** `Intl` output depends on the ICU data in the Node version, which would break byte-identical output across runner upgrades.
- **Titles:** first non-empty caption line without hashtags, cut at a word near 80 characters; empty → "Photo from 2026-10-27" (Reel, Video, Photo set). Page `<title>` adds the date to keep titles unique.
- **Index thumbnails use `alt=""`.** They sit inside a link whose text is the post title, so a non-empty alt would make screen readers say the title twice. Item pages use the caption excerpt, or "Photo" / "Video thumbnail".
- **Item pages are rendered once,** when the item is ingested. The 480 px image lives only inside that page, so a later theme or site-title change restyles `index.html` and the legal pages, but not existing item pages. To restyle everything, delete the feed folder and let the next run backfill.
- **Category order on the index:** config categories in file order, then the fallback, then categories that only older items still carry (alphabetical). Empty groups are not shown.
- **html-validate:** `html-validate:recommended`, with `doctype-style` set to lowercase (the brief specifies `<!doctype html>`) and `long-title` off (an SEO preference, not part of the HTML standard).
- **Size budget:** an item page with a thumbnail at `max_bytes` (40,000) and a 2,200-character plain caption is about 59 KB, under the 60 KB budget. A caption made almost entirely of `&` or `<` (each escaped to 4–5 characters) can exceed it. Accepted as an edge case.

## State and commit choices (M6)

- **A post is new only if it's at least as new as the feed's oldest item.** Taken literally, section 11 step 3 would add the posts backfill left out on the very next run, which breaks idempotence (14.3 test 2) and backfill itself. The same rule stops posts dropped by `max_items` from coming back.
- **When no item of this provider survives, the feed backfills again.** This includes every item being deleted.
- **`backfill: 0` keeps the feed empty.** An empty state has no marker for "started on this day", so nothing is ever added. Literal reading of the brief; the README must say so.
- **Skipped posts don't count as deleted.** A post the adapter skipped (say, a missing thumbnail) still exists on Instagram.
- **Deletion only touches the run's provider,** so a future `manual` item is never removed by an Instagram run.
- **`index.json` is validated on load.** Each `page` must be exactly `p/<provider>-<id>.html`, because prunes delete that path. A bad file fails the run with a plain message.
- **An index entry whose page file is gone is dropped,** and counts as removed. This is what the deletion page promises: delete an old post's page from the repo. A post still inside the fetch window comes back on the next run, so it must be deleted on Instagram too.
- **Only a lost race gets the rebase retry.** A remote hook or branch protection ("remote rejected") fails at once. A rebase conflict aborts and fails. Tested against a shallow clone, since `actions/checkout` makes one.
- **A detached checkout fails** with a plain message rather than guessing a branch.
- **Git runs without the `INPUT_*` variables,** so hooks and credential helpers never see the token. `gh` gets only `PATH`, `HOME` and `GH_TOKEN`.
- **E2E pushes to a scratch branch** and deletes it, so `main` never receives fixture data.

## Other choices

- **Reclassification (README item 7):** existing items keep their category. v1 adds no `reclassify` flag. To reclassify, delete `feed/index.json` and the item pages; the next run backfills. Simplest option; documented in the README.
- **YAML parser:** `yaml` (eemeli/yaml), bundled into `dist/`. It reports line numbers for parse errors and has no dependencies.
