# simple-media-client — Development Brief

Audience: Claude Code, building this repo from scratch.
Owner: atiradonet (GitHub). Repo: `simple-media-client`.
Status of this document: decisions are settled unless listed under "Verify before building" (section 17). Where this brief and the live docs for a third-party API disagree, the live docs win; record the difference in `docs/decisions.md`.

---

## 1. Purpose

A reusable GitHub Action that turns an influencer's Instagram activity into a small, self-contained static feed inside their GitHub Pages repo. It runs once a day on GitHub's runners, with no server, no database, and no AI agent in the loop. It pulls the account's latest posts, skips anything already seen, sorts new items into categories using editable rules, renders each item as a standalone HTML file, prunes stale items, and commits the result. GitHub Pages publishes the commit.

The goal is awareness and "liveliness" for a buddy site, not click-through or engagement. Cost target: zero on a public repo.

Instagram is first. The design must make a second provider (TikTok, YouTube, and so on) a matter of writing one adapter.

## 2. Non-negotiable decisions

1. **Deliverable is a GitHub Action** (JavaScript action, bundled), published from this repo and consumed with `uses: atiradonet/simple-media-client@v1`. It is not a hosted service.
2. **Unmanaged.** Plain deterministic script. No LLM calls in the default path. No network calls except the provider API (and the GitHub push). Same input produces byte-identical output.
3. **Deterministic classifier** driven by an editable `simple-media.yml`: hashtags, keywords, and media type map to categories. First match wins, in file order. Anything unmatched goes to the fallback category. An LLM classifier may exist later as an opt-in module; it is out of scope for v1.
4. **The repo is the only state.** No external storage. `feed/index.json` holds what has been seen.
5. **Poll, don't listen.** No webhooks in v1. Instagram offers no webhook for the owner's own new posts anyway.
6. **Daily schedule plus manual run** (`workflow_dispatch`). No keep-alive hack. GitHub disables scheduled workflows in public repos after 60 days without repository activity; the README documents `gh workflow enable` as the fix.
7. **Public repo assumption.** Free runner minutes, free Pages. Private repos work but are not the target.
8. **Per-influencer Meta app and credentials.** Each influencer's data flows from Instagram into their own repo. This project never receives, proxies, or stores anyone's tokens or data.
9. **Storage stays tiny.** Thumbnails only (never full media), resized, with a hard per-image byte cap and a rolling window of items.
10. **Self-contained output.** Every generated HTML file works offline: no external scripts, stylesheets, fonts, or images. No client-side JavaScript is required for any page to work.
11. **Minimal dependencies.** Runtime dependency allowed: a YAML parser, bundled into `dist/`. Everything else uses Node built-ins and the `node:test` runner. Ask before adding anything else.

## 3. Scope

### v1 (this brief)
- Instagram adapter (Instagram API with Instagram Login; Business or Creator accounts only).
- Config loader and validator.
- Deterministic classifier.
- Thumbnail pipeline.
- HTML renderer: item pages, index page, privacy page, data-deletion page.
- State, dedupe, prune, rolling window, commit.
- Access-token refresh handling.
- Dry-run mode and fixture mode.
- Full test suite and CI.
- README with end-to-end setup.

### Phase 2 (design for it, don't build it)
- `manual` provider: a phone share (iOS Shortcut or similar) fires `repository_dispatch` with a URL and an optional note; the same classifier and renderer handle it. The item model must already allow `provider: "manual"`.
- Companion template repo (`simple-media-site-template`) with the workflow, config, and legal pages pre-wired.
- Second social provider.
- Optional LLM classifier module.

### Out of scope
- Likes, reposts, shares, or saved posts. Instagram exposes no API for them. Do not scrape, and do not add any credential-based login flow.
- Comments, mentions, DMs, and any other people's usernames or text. Do not store or publish them.
- Webhooks and any always-on infrastructure.
- Embedding Instagram's own widget (it loads Meta's JavaScript and breaks self-containment).

## 4. Repository layout

```
simple-media-client/
  action.yml
  package.json
  src/
    main.js                 # entrypoint: orchestrates a run
    config.js               # load + validate simple-media.yml
    classify.js             # compile rules once, classify items
    normalize.js            # text normalization, hashtag extraction
    state.js                # read/write index.json, dedupe, prune
    render/
      item.js
      index.js
      legal.js
      theme.js              # design tokens, CSS string
      escape.js
    thumbs.js               # fetch + resize + encode
    git.js                  # commit and push
    log.js                  # logging with secret redaction
    providers/
      index.js              # registry: name -> adapter
      instagram.js
      (later: manual.js)
  dist/                     # bundled build output, committed
  test/
    unit/
    integration/
    fixtures/
      instagram/            # recorded API responses (sanitized)
      config/
      golden/               # expected HTML output
  docs/
    decisions.md
    setup-instagram.md
  examples/
    simple-media.yml
    workflow.yml
  .github/workflows/
    ci.yml
    e2e.yml
  BRIEF.md
  README.md
```

Bundle with `@vercel/ncc` (dev dependency) into `dist/`. CI fails if `dist/` is stale.

## 5. Consumer experience

The influencer's site repo adds one workflow and one config file.

```yaml
# .github/workflows/feed.yml
name: feed
on:
  schedule:
    - cron: "17 6 * * *"      # daily, UTC; avoid minute 0
  workflow_dispatch:
    inputs:
      dry_run:
        type: boolean
        default: false

permissions:
  contents: write

concurrency:
  group: feed
  cancel-in-progress: false

jobs:
  feed:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: atiradonet/simple-media-client@v1
        with:
          provider: instagram
          token: ${{ secrets.INSTAGRAM_TOKEN }}
          dry_run: ${{ inputs.dry_run || 'false' }}
```

### Action inputs
| Input | Required | Default | Notes |
|---|---|---|---|
| `provider` | yes | | `instagram` in v1 |
| `token` | yes | | Provider access token. Mask it in logs. |
| `config` | no | `simple-media.yml` | Path in the site repo |
| `dry_run` | no | `false` | Fetch, classify, and render in memory; print a summary; write nothing; no commit |
| `secrets_token` | no | | Fine-grained PAT with Secrets write on this repo, used only to store a refreshed access token (see section 11) |
| `fixture_dir` | no | | Test use only: read provider responses from disk instead of the network |

## 6. Configuration: `simple-media.yml`

Editable by a non-developer. Example:

```yaml
provider: instagram

site:
  title: "Brini Bruni"
  description: "What Brini is up to."
  language: en
  profile_url: "https://www.instagram.com/example/"
  contact_email: "hello@brinibruni.com"      # shown on the privacy and deletion pages
  theme:
    paper: "#f3ede2"
    ink: "#1c1814"
    muted: "#7a6f63"
    accent: "#d9542b"
    paper_dark: "#14110f"
    ink_dark: "#f1e9dc"
    muted_dark: "#8f8374"
    accent_dark: "#f0714a"

output:
  dir: feed
  max_items: 200

fetch:
  limit: 50          # newest items requested per run
  backfill: 20       # items written when index.json is empty

thumbnails:
  width: 480
  tiny_width: 96
  format: webp       # fallback: jpeg
  quality: 75
  max_bytes: 40000   # per 480px image; re-encode smaller until it fits

fallback: Everyday

categories:
  - name: Travel
    hashtags: [travel, wanderlust]
    keywords: [airport, flight, hotel, road trip]

  - name: Food
    hashtags: [foodie, recipe]
    keywords: [dinner, brunch, coffee]

  - name: Video
    media: [reel, video]
```

### Validation rules
- Unknown top-level keys: error (catches typos).
- `fallback` required and non-empty.
- Category `name` required, unique (case-insensitive), 1 to 40 characters.
- A category needs at least one of `hashtags`, `keywords`, `media`.
- `media` values must be one of `photo`, `video`, `reel`, `carousel`.
- `hashtags` entries are stored without `#`; strip a leading `#` if the user typed one.
- Numeric bounds: `max_items` 1 to 2000, `fetch.limit` 1 to 100, `backfill` 0 to `fetch.limit`, `thumbnails.width` 64 to 1080.
- Theme colors must be valid `#rgb` or `#rrggbb`.
- On any failure, exit non-zero with a plain message that names the key path and, where the parser provides it, the line. No stack traces. No partial run, no commit.

## 7. Data model

### Normalized item (provider-neutral)
```json
{
  "id": "17895695668004550",
  "provider": "instagram",
  "permalink": "https://www.instagram.com/p/…/",
  "caption": "airport lounge #travel",
  "timestamp": "2026-10-29T18:22:10.000Z",
  "type": "photo | video | reel | carousel",
  "thumbnail_url": "https://…"
}
```
The adapter maps provider fields to this shape. IDs must match `^[A-Za-z0-9_-]{1,64}$` or the item is rejected (they become file names).

### `feed/index.json`
```json
{
  "version": 1,
  "items": [
    {
      "id": "…",
      "provider": "instagram",
      "timestamp": "…",
      "type": "reel",
      "category": "Travel",
      "title": "airport lounge",
      "permalink": "…",
      "page": "p/instagram-<id>.html",
      "tn": "data:image/webp;base64,…"
    }
  ]
}
```
- `items` sorted by `timestamp` descending, ties broken by `id`. JSON written with sorted keys and two-space indent so reruns produce no diff.
- Never write a build or "generated at" timestamp anywhere in outputs. Idempotence depends on it.

### Output files
```
feed/index.json
feed/index.html
feed/privacy.html
feed/data-deletion.html
feed/p/<provider>-<id>.html
```
- The 480 px thumbnail is embedded in the item page as a `data:` URI. No separate image files exist, so storage is not duplicated.
- The 96 px thumbnail (`tn`) lives in `index.json` and is used by `index.html`.
- Estimated cost per item: roughly 40 KB. A 200-item window is about 8 MB.

## 8. Classifier

`classify.js` compiles the config once per run, then classifies each item.

**Normalization** (`normalize.js`), applied to caption text and to every rule term:
1. Unicode NFKC, then NFD, strip combining marks (so "Café" matches "cafe").
2. Lowercase.
3. Collapse whitespace.

**Hashtag extraction:** regex over the normalized caption, Unicode-aware (`#` followed by letters, digits, or underscore). Exact-token match against rule hashtags. No prefix matching (`#travelgram` does not match `travel`).

**Keyword matching:** one precompiled regex per category, with Unicode-aware word boundaries and regex-escaped terms. Multi-word terms match with flexible whitespace. Keywords match against the caption with hashtags removed, to avoid double-counting.

**Media matching:** the normalized `type`.

**Decision procedure:**
1. Walk categories in file order.
2. A category matches if any hashtag, keyword, or media rule hits.
3. The first matching category wins. Stop.
4. No match: assign `fallback`.

Properties to guarantee: deterministic, order-controlled by the file, no scoring, no weights, empty caption is valid (media rules and fallback still work), runtime linear in `items × rules` and fast enough that a hundred items take well under a millisecond per item.

## 9. Instagram adapter

> Verify every endpoint, field name, and version against current Meta docs before coding (section 17). The shapes below reflect my understanding, not a confirmed contract.

- API: Instagram API with Instagram Login (host `graph.instagram.com`). Business or Creator accounts only; Basic Display API is gone.
- Fetch: `GET /me/media` with fields for id, caption, media type, media product type, media URL, thumbnail URL, permalink, and timestamp; page with `limit = fetch.limit`. Follow pagination only up to `fetch.limit` total items.
- Type mapping to the normalized vocabulary:
  - image → `photo`
  - video with Reels product type → `reel`
  - other video → `video`
  - carousel album → `carousel`
  - Stories are not returned by this edge and are ignored.
- Thumbnail source: `thumbnail_url` when present (videos, Reels); otherwise `media_url`. For carousels use the cover image. Confirm the field behavior.
- Errors:
  - HTTP 429 and 5xx: retry up to three times with exponential backoff (1 s, 4 s, 16 s), then fail the run.
  - Expired or invalid token (Meta error code for OAuth failure): fail with an actionable message ("Token expired or invalid; regenerate it and update the INSTAGRAM_TOKEN secret").
  - Any malformed response: fail the run. Never commit partial data.
- Injectable `fetch` function so tests never touch the network.
- Never log the token, full request URLs containing it, or raw response bodies.

## 10. Thumbnails

- Download each new item's thumbnail from the provider CDN URL (URLs are temporary, so download at ingest; never hotlink).
- Resize with ImageMagick as installed on `ubuntu-latest` (call via `child_process.execFile`, never a shell string). Output: 480 px wide (`thumbnails.width`) and 96 px wide (`tiny_width`), WebP at `quality`; fall back to JPEG if WebP encode is unavailable.
- Enforce `max_bytes`: if the 480 px output exceeds it, lower quality in steps until it fits, with a floor; if it still doesn't fit, fail that item with a clear message (and fail the run; no partial commits).
- Strip metadata (EXIF) from outputs.
- Preflight: at startup, check ImageMagick availability and WebP support; fail early with a precise message if missing.
- Videos: thumbnail only. Never download video files.

## 11. State, pruning, and token handling

### Per-run algorithm
1. Load and validate config. Load `feed/index.json` (empty state if absent).
2. Fetch up to `fetch.limit` newest items from the adapter.
3. **New items:** fetched IDs absent from state. On an empty state, keep only the newest `backfill` items.
4. **Deleted items:** state items whose `timestamp` falls inside the fetched time window (newer than or equal to the oldest fetched item) but whose ID was not returned. Remove them. Items older than the window are not treated as deleted; they age out via `max_items`.
5. Classify and render new items; build thumbnails.
6. Apply `max_items`: drop the oldest items and their pages beyond the cap.
7. Rewrite `index.json`, `index.html`, and the legal pages. Write only files whose bytes changed.
8. If any file changed, commit and push. Otherwise exit cleanly with "no changes".

### Commit step
- Use the `git` CLI; identity `github-actions[bot]`.
- One commit per run with a message like `feed: +2 new, -0 removed (instagram)`.
- Add only files under `output.dir`.
- No force pushes. If the push is rejected because of a race, fetch, rebase once, and retry once; otherwise fail.
- The workflow's `concurrency` group prevents overlapping runs.

### Access-token refresh
Long-lived Instagram tokens expire after about 60 days and must be refreshed before then. The catch: a workflow's own `GITHUB_TOKEN` cannot write repository secrets.

Plan:
1. Each run calls the provider's token-refresh endpoint when the token is old enough to refresh (confirm the minimum age and semantics in the docs).
2. If `secrets_token` is provided, store the new token with the GitHub API (`gh secret set` equivalent) and mask it in logs.
3. If `secrets_token` is not provided, track expiry from the refresh response and, when 14 days or fewer remain, fail the run with a message that names the date and the rotation steps. A failed scheduled run notifies the repo owner by email, which is the warning channel.
4. Record the finding on refresh semantics (does the old token stay valid? is daily refresh allowed?) in `docs/decisions.md`.

## 12. Rendering

Reuse the design language of the existing `brinibruni.com` page: warm "paper" background, ink-black serif text (`ui-serif`, Palatino, Georgia), monospace small-caps labels, a single burnt-orange accent, automatic dark mode through `prefers-color-scheme`, `prefers-reduced-motion` respected. Colors come from `site.theme` with these defaults. CSS is one inline `<style>` string from `render/theme.js`.

Requirements for every generated page:
- `<!doctype html>`, `<html lang>`, `<meta charset="utf-8">`, viewport meta, `<meta name="color-scheme" content="light dark">`, a unique `<title>`, and a meta description.
- Semantic landmarks (`header`, `main`, `nav`, `footer`), a single `h1`, correct heading order.
- Images have meaningful `alt` text (a short caption excerpt, or "Photo" / "Video thumbnail" when the caption is empty).
- All text from captions and config is HTML-escaped. Escaping lives in `render/escape.js` and is covered by tests.
- External links (the Instagram permalink, profile URL) use `rel="noopener noreferrer"` and open in the same tab.
- No external subresources of any kind. No JavaScript is required; if any enhancement script is ever added it must degrade gracefully.
- Category navigation on the index uses plain in-page anchors, no JS.
- Layout works from 320 px wide to desktop; no horizontal scroll.
- Contrast meets WCAG AA in both color schemes for default theme values.

Pages:
- **Item page:** category label, date, caption, embedded 480 px thumbnail, a "View on Instagram" link, a link back to the index.
- **Index page:** items grouped by category (category order follows the config), newest first inside each group, each entry showing the 96 px thumbnail, title, date, and link to its page. Include a short intro line from `site.description`.
- **Privacy page** and **data-deletion page:** plain-language templates covering what the site shows (public posts from the account holder's own Instagram account), that the site stores captions and small thumbnails, how to request removal (email from `site.contact_email`, and the account holder can delete a post on Instagram, after which the next daily run removes it), and that no visitor data is collected by this feed. Meta expects a privacy policy and deletion route for live apps. Flag in the README that the text is a starting point, not legal advice.

## 13. Logging and observability

- Structured, human-readable log lines: counts fetched, new, removed, kept, bytes written.
- Use GitHub Actions annotations (`::notice`, `::warning`, `::error`) for the summary and for token-expiry warnings.
- Write a run summary to `$GITHUB_STEP_SUMMARY` (a small table).
- `log.js` redacts the token and anything matching token patterns from every line. Test it.

## 14. Testing

Test runner: `node:test` with `node:assert/strict`. Coverage via `c8` (dev dependency). Target at least 90 percent line coverage on `src/`, with 100 percent on `classify.js`, `normalize.js`, `config.js`, `state.js`, and `render/escape.js`. No test may touch the real network or require real credentials.

### 14.1 Unit tests
**Config (`config.js`)**
- Valid minimal config passes; full example config passes.
- Each validation rule in section 6 has a failing case with an exact expected message.
- Typo in a top-level key is rejected.
- Leading `#` on hashtags is stripped.

**Normalization and classification (`normalize.js`, `classify.js`)**
- Table-driven cases: caption, type, expected category. Include:
  - hashtag hit, keyword hit, media-only hit, no hit → fallback
  - first-match-wins and reordering the file changes the result
  - accent folding ("Café" ↔ "cafe"), case folding, Unicode hashtags
  - exact hashtag matching (`#travelgram` does not match `travel`)
  - multi-word keywords with irregular whitespace
  - keyword inside another word does not match ("art" must not match "party")
  - regex metacharacters in keywords (`c++`, `q&a`) are escaped correctly
  - empty and whitespace-only captions
  - very long caption (over 2,200 characters)
- Determinism: classifying the same input twice, and in shuffled order, gives the same result per item.

**State (`state.js`)**
- Dedupe: known IDs are skipped.
- First-run backfill keeps only the newest N.
- Deleted-item detection: an ID missing inside the fetched time window is removed; an ID older than the window is kept.
- `max_items` drops the oldest and reports their pages for deletion.
- Sort order and tie-breaking are stable.
- `index.json` serialization is byte-stable across runs.

**Rendering (`render/*`)**
- Golden-file tests: fixed input produces byte-identical expected HTML (stored in `test/fixtures/golden/`). Update goldens only through an explicit script, never automatically.
- Escaping: captions containing `<script>`, quotes, ampersands, and `javascript:` text render inert.
- Empty caption produces valid alt text and a valid title.
- Theme override changes only the intended CSS variables.
- No generated file contains a build timestamp.

**Thumbnails (`thumbs.js`)**
- Resize output dimensions and format are correct for a fixture image.
- `max_bytes` enforcement: an oversized image is re-encoded smaller; an impossible case fails with the expected message.
- EXIF is stripped.
- Preflight failure produces the expected message (stub the tool lookup).

**Logging (`log.js`)**
- The token never appears in any output stream, including error paths and thrown error messages.

### 14.2 Adapter tests
- Recorded, sanitized Instagram responses in `test/fixtures/instagram/` (photo, Reel, carousel, video, empty caption, pagination, malformed JSON, expired-token error, 429, 500).
- Mock `fetch` is injected. Assert the exact field list requested, type mapping, thumbnail source selection, pagination limit, and ID validation.
- Retry behavior: 429 and 5xx retry three times with the backoff schedule (use fake timers), then fail; 4xx other than 429 fail immediately.
- Token errors map to the actionable message.

### 14.3 Integration tests
Run the real entrypoint against a temporary git repo (created per test, with a local bare remote), the mock provider, and fixture images.
1. **First run:** empty repo → backfill count written, one commit, expected file tree.
2. **Idempotence:** second run with identical API data → no commit, no file changes.
3. **New post:** add one item to the fixture → exactly one new page, index updated, one commit.
4. **Deleted post:** remove an in-window item from the fixture → its page deleted, index updated.
5. **Rolling window:** exceed `max_items` → oldest pages removed.
6. **Dry run:** nothing written, nothing committed, summary printed.
7. **Failure atomicity:** inject a thumbnail failure on the second of three new items → no files written, no commit.
8. **Push race:** simulate a rejected push → one rebase retry, then success or a clear failure.
9. **Config error:** invalid config → non-zero exit, no repo changes.
10. **Token near expiry** (when `secrets_token` is absent) → run fails with the documented message and date.

### 14.4 Output validity tests
- Validate every generated HTML file against the HTML standard with a validator (for example `html-validate`, or the Nu validator via `vnu-jar` if Java is acceptable in CI). Zero errors required.
- Self-containment check: parse each page and assert no `src`, `href`, or CSS `url()` points to an external origin, except the explicit "View on Instagram" and profile anchors.
- Accessibility smoke check: images have `alt`, one `h1` per page, landmarks present, `lang` set.
- Size budgets: item page under 60 KB, `index.html` under a limit derived from `max_items`, each thumbnail under `max_bytes`. Fail CI when exceeded.
- Contrast check on the default theme tokens, both color schemes.

### 14.5 Security tests
- Path traversal: an item with an ID like `../x` is rejected before any file operation.
- Injection: hostile captions and config strings (script tags, attribute breakouts, `</style>`) cannot break out of their context.
- Shell safety: no code path interpolates user data into a shell string; assert by test that `execFile` receives argument arrays.
- Secret hygiene: grep the test run's captured logs for the fake token; zero hits.

### 14.6 CI for this repo (`.github/workflows/ci.yml`)
On every pull request and push:
1. Install, lint (ESLint with a minimal config), run unit, adapter, integration, and validity tests.
2. Rebuild `dist/` and fail if `git diff --exit-code dist` shows changes.
3. Upload the coverage report as an artifact.

### 14.7 End-to-end in a real runner (`.github/workflows/e2e.yml`)
- Runs the action from this repo with `uses: ./` against a scratch fixture repo, using `fixture_dir` so no real token is needed.
- Confirms on a real `ubuntu-latest` runner that ImageMagick resizes and encodes WebP, that the commit and push work with the default `GITHUB_TOKEN`, and that the workflow's `permissions` block is sufficient.
- Also checks whether a push made by `GITHUB_TOKEN` triggers a Pages deployment (see section 17, item 3).

### 14.8 Manual live smoke test (documented, not automated)
Procedure in `docs/setup-instagram.md`: add the real token as a secret, run the workflow manually with `dry_run: true`, read the summary, then run it once for real, and confirm the page appears on the live site. Never commit real tokens, real API responses, or real personal data to fixtures; sanitize anything recorded from the live API.

## 15. Milestones and acceptance criteria

| # | Milestone | Done when |
|---|---|---|
| M0 | Scaffold: repo layout, `action.yml`, ncc build, CI, test harness, dry-run and fixture plumbing | CI green on an empty action that prints a summary |
| M1 | Config loader and validator | All config tests pass; error messages reviewed for clarity |
| M2 | Normalizer and classifier | Table-driven tests pass; 100 percent coverage on those files |
| M3 | Instagram adapter and retry logic | Fixture-driven tests pass; endpoints checked against live docs and noted in `docs/decisions.md` |
| M4 | Thumbnail pipeline | Resize, cap, strip, and preflight tests pass; confirmed on a real runner via e2e |
| M5 | Renderer: item, index, legal pages, theme | Golden files and validity tests pass; HTML validator reports zero errors |
| M6 | State, prune, window, commit, token handling | All integration tests (14.3) pass |
| M7 | Docs and release | README and setup guide complete; e2e green; tag `v1.0.0` and move the `v1` tag |

Work milestone by milestone. Commit in small steps with clear messages. Keep the test suite green at every commit.

## 16. README requirements

Written in direct, plain prose: no filler openers, no stacked qualifiers, active voice. The README covers:
1. What it does and what it does not do (no likes, shares, or reposts; why).
2. Prerequisites: Creator or Business Instagram account, a Meta developer app with Instagram API with Instagram Login, adding the account as a tester, generating a long-lived token.
3. Install: copy the workflow, add the secret, add `simple-media.yml`, enable Pages.
4. Config reference with the full example and every key explained.
5. How classification works, with the ordering rule and two worked examples.
6. Token refresh and the 14-day warning behavior.
7. Operations: how to run manually, how dry run works, how to re-enable a disabled schedule (`gh workflow enable`), how to remove an item, how to change categories and re-classify (a note: existing items keep their category unless a documented `reclassify` command or flag is added; decide and document).
8. Limits and costs: storage per item, window size, Pages limits (1 GB site, soft bandwidth cap), why a public repo is assumed.
9. Privacy and compliance notes, with an explicit "not legal advice" line and a pointer to Meta's current platform terms.

## 17. Verify before building

Claude Code: check each of these, and record the result in `docs/decisions.md` before depending on it.
1. **Instagram API contract:** host, versioned paths, field names, media-type and product-type values, pagination, thumbnail behavior for videos, Reels, and carousels, and error codes (especially expired tokens).
2. **Token refresh semantics:** minimum token age, whether the old token stays valid after refresh, whether daily refresh is allowed, and the refresh response shape.
3. **Pages rebuild on bot pushes:** whether a commit pushed with the default `GITHUB_TOKEN` triggers the Pages deployment for both "deploy from branch" and Actions-based Pages. If not, choose and document a fix (for example a deploy step in the workflow, or a documented alternative credential).
4. **ImageMagick on `ubuntu-latest`:** installed, with WebP support. If not, decide between installing it in the action or a fallback encoder, and document the cost.
5. **Action runtime:** the currently supported Node runtime value for `action.yml`.
6. **Meta development-mode rules:** whether App Review applies to a single-account development-mode app, and Meta's current Instagram-specific rules on storing, caching, and displaying content (the Platform Terms link out to Developer Docs that were not reviewed while writing this brief).
7. **Scheduled-workflow inactivity rule:** whether commits made by the workflow itself count as repository activity. The brief assumes they may not; do not rely on them.

## 18. Working agreement

- Ask before adding any runtime dependency or changing a decision in section 2.
- Keep functions small and pure where possible; side effects (network, disk, git, subprocess) live at the edges so tests can stub them.
- Prefer clarity over cleverness. Comment the why, not the what.
- Never log or commit secrets. Never commit real API payloads.
- When a requirement is ambiguous, pick the simplest option that satisfies the section 2 decisions, note it in `docs/decisions.md`, and continue.
- Report at the end of each milestone: what was built, test results, and any item from section 17 resolved or still open.
