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

**Open, settle in M6:** whether refresh returns the same token string. Design so either answer works: if the string is unchanged, the stored secret is already extended; if it changed, store it via `secrets_token` or warn.

## 17.3 Pages rebuild on bot pushes

Source: GitHub docs, "GITHUB_TOKEN" concept page: commits pushed with `GITHUB_TOKEN` "do not trigger a GitHub Pages build". Only `workflow_dispatch` and `repository_dispatch` are exempt from the no-recursion rule.

Decision: the action sets an output `changed` (`true`/`false`). The example workflow then:
- **Deploy from branch:** calls `POST /repos/{repo}/pages/builds` with `gh api` when `changed == 'true'` (needs `pages: write`).
- **Actions-based Pages:** runs `actions/upload-pages-artifact` + `actions/deploy-pages` in the same workflow.

**Open:** the e2e workflow confirms the build request works with `GITHUB_TOKEN`.

## 17.4 ImageMagick on `ubuntu-latest`

Source: `actions/runner-images` Ubuntu 24.04 readme. ImageMagick is **not** listed.

Decision: the action does not install packages itself. Installing them would add network calls beyond the provider API, which section 2.2 rules out. The example workflow adds:

```yaml
- run: sudo apt-get update && sudo apt-get install -y imagemagick
```

Cost: roughly 20–40 s of runner time per run, free on a public repo. Preflight looks for `magick` (ImageMagick 7), then `convert` (ImageMagick 6, which Ubuntu ships). It fails with that exact install line if neither is found, and falls back to JPEG if the WebP coder is missing.

## 17.5 Action runtime

Source: GitHub docs, metadata syntax. `runs.using` supports `node20` and `node24`. We use `node24`.

## 17.6 Meta development-mode rules

Source: Instagram Platform overview.

- Standard Access is the default and covers apps that serve only the developer's own accounts or accounts with a role on the app. Advanced Access (App Review + Business Verification) applies to apps serving accounts the developer doesn't own or manage. A per-influencer app used only by that influencer fits Standard Access.
- The overview states no specific storage or caching rules. It defers to Meta Platform Terms and Developer Policies, and notes CDN URLs stop serving deleted media. Our daily deletion sync (section 11, step 4) removes items deleted on Instagram that are still inside the fetch window.
- **Open:** the README points influencers to Meta's current Platform Terms and Developer Policies. This is not legal advice.

## 17.7 Scheduled-workflow inactivity rule

Source: GitHub docs, "Disabling and enabling a workflow". Scheduled workflows in public repos are disabled after 60 days without repository activity. The docs don't define activity. Per the brief, we don't rely on bot commits counting. The README documents `gh workflow enable`.

## Other choices

- **Reclassification (README item 7):** existing items keep their category. v1 adds no `reclassify` flag. To reclassify, delete `feed/index.json` and the item pages; the next run backfills. Simplest option; documented in the README.
- **YAML parser:** `yaml` (eemeli/yaml), bundled into `dist/`. It reports line numbers for parse errors and has no dependencies.
