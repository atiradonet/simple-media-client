# simple-media-client

A GitHub Action that turns an Instagram account's posts into a small static feed in your GitHub Pages repo. It runs once a day on GitHub's runners, with no server, no database and no AI.

**Using this action requires a paid license.** See [License](#license).

Each run fetches the latest posts, skips those it has seen, sorts new ones into categories using rules you edit, writes one HTML page per post, removes deleted and old posts, and commits the result.

```yaml
- uses: atiradonet/simple-media-client@v1
  with:
    provider: instagram
    token: ${{ secrets.INSTAGRAM_TOKEN }}
```

## What it doesn't do

- **No likes, reposts, shares or saved posts.** Instagram has no API for them. This action doesn't scrape and has no login flow.
- **No comments, mentions or DMs.** Other people's words and usernames aren't stored or published, and `@handles` are removed from captions.
- **No full-size media.** It keeps two small thumbnails per post and never downloads video files.
- **No Stories.**
- **No instant updates.** Instagram has no webhook for your own new posts, so the feed updates daily, or whenever you run it by hand.
- **No Instagram embeds.** They load Meta's JavaScript. Pages here load nothing from other sites and need no JavaScript.

## Prerequisites

- A paid license for this action. See [License](#license).
- An Instagram Business or Creator account. Personal accounts can't use the API.
- A Meta developer app of your own, using Instagram API with Instagram Login, with your account added as a tester.
- A long-lived access token.
- A GitHub repo with Pages enabled.

[docs/setup-instagram.md](docs/setup-instagram.md) covers all of this step by step, including a first test run.

## Install

1. Copy [`examples/workflow.yml`](examples/workflow.yml) to `.github/workflows/feed.yml` in your site repo.
2. Add your token as a repository secret named `INSTAGRAM_TOKEN`.
3. Copy [`examples/simple-media.yml`](examples/simple-media.yml) to `simple-media.yml` in the repo root and edit it.
4. Under **Settings > Pages**, choose **Deploy from a branch**.
5. Run the workflow from the **Actions** tab.

Your feed appears at `https://<user>.github.io/<repo>/feed/`.

The example workflow does two things the short snippet above doesn't:

- **It installs ImageMagick,** which `ubuntu-latest` doesn't include. This takes about 20–40 seconds per run.
- **It requests a Pages build.** Pushes made with `GITHUB_TOKEN` don't trigger one by themselves.

If your Pages source is **GitHub Actions** rather than a branch, replace that last step with `actions/upload-pages-artifact` and `actions/deploy-pages`, and add `id-token: write` to the permissions.

### Action inputs

| Input | Required | Default | Notes |
|---|---|---|---|
| `provider` | yes | | `instagram` |
| `token` | yes | | The access token. Masked in logs. |
| `config` | no | `simple-media.yml` | Path in your repo. |
| `dry_run` | no | `false` | Fetch, classify and render in memory, print a summary, write nothing. |
| `secrets_token` | no | | Fine-grained PAT with Secrets write on this repo. See [Token refresh](#token-refresh). |
| `fixture_dir` | no | | For testing only. Reads API responses from disk. |

The action has one output: `changed` is `true` if the run pushed a commit.

## Configuration

`simple-media.yml` in full:

```yaml
provider: instagram

site:
  title: "Brini Bruni"
  description: "What Brini is up to."
  language: en
  profile_url: "https://www.instagram.com/example/"
  contact_email: "hello@brinibruni.com"
  theme:
    paper: "#f3ede2"
    ink: "#1c1814"
    muted: "#6b6157"
    accent: "#b5441d"
    paper_dark: "#14110f"
    ink_dark: "#f1e9dc"
    muted_dark: "#8f8374"
    accent_dark: "#f0714a"

output:
  dir: feed
  max_items: 200

fetch:
  limit: 50
  backfill: 20

thumbnails:
  width: 480
  tiny_width: 96
  format: webp
  quality: 75
  max_bytes: 40000

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

Only `site.title`, `site.contact_email` and `fallback` are required. Anything misspelled or out of range stops the run with a message naming the key, and nothing is committed.

| Key | Default | Meaning |
|---|---|---|
| `provider` | | Optional. If set, it must match the workflow's `provider` input. |
| `site.title` | | Shown at the top of every page. |
| `site.description` | | Intro line on the index page. |
| `site.language` | `en` | Language tag for the pages, such as `en` or `pt-BR`. |
| `site.profile_url` | | Your profile, linked from the index. Must be `https://`. |
| `site.contact_email` | | Shown on the privacy and data-deletion pages. It's public. |
| `site.theme.*` | as above | Colors, as `#rgb` or `#rrggbb`. The `_dark` values apply in dark mode. The defaults meet WCAG AA contrast; your own colors aren't checked. |
| `output.dir` | `feed` | Folder for the feed. The action only ever commits inside it. |
| `output.max_items` | `200` | Most posts to keep, 1–2000. The oldest go first. |
| `fetch.limit` | `50` | Newest posts to request per run, 1–100. Deleted posts are only noticed within this range. |
| `fetch.backfill` | `20` | Posts to add when the feed is empty, 0 to `fetch.limit`. With `0`, the feed stays empty for good, because every run sees an empty feed. |
| `thumbnails.width` | `480` | Width of the image on a post's page, 64–1080. Images are never enlarged. |
| `thumbnails.tiny_width` | `96` | Width of the index thumbnail. |
| `thumbnails.format` | `webp` | `webp` or `jpeg`. Falls back to JPEG, with a warning, if WebP isn't available. |
| `thumbnails.quality` | `75` | Encoding quality. On Ubuntu's ImageMagick 6 this has no effect on WebP, only on JPEG. |
| `thumbnails.max_bytes` | `40000` | Size cap for the `width` image. The action re-encodes smaller to fit, and fails the run if it can't. |
| `fallback` | | Category for posts no rule matches. |
| `categories[].name` | | Unique, 1–40 characters. |
| `categories[].hashtags` | | Exact hashtags. A leading `#` is optional. |
| `categories[].keywords` | | Words or phrases found in the caption. |
| `categories[].media` | | Any of `photo`, `video`, `reel`, `carousel`. |

Each category needs at least one of `hashtags`, `keywords` or `media`.

## Classification

Rules are checked in file order, and **the first category that matches wins**. There are no scores or weights. A post that matches nothing goes to `fallback`.

A category matches if any of its rules hits:

- **Hashtags** match whole tags: `#travelgram` doesn't match `travel`.
- **Keywords** match whole words outside hashtags: `art` doesn't match `party`.
- **Media** matches the post type.

Case and accents are ignored, so `Café` matches `cafe`.

Two examples using the config above:

- **A photo captioned "Dinner at the airport #foodie" goes to Travel.** It matches Food too, through `dinner` and `#foodie`, but Travel comes first in the file and `airport` hits.
- **A Reel captioned "Sunday pasta #recipe" goes to Food,** not Video, because Food comes first. To put every Reel in Video, move Video to the top.

**Check this after your first run.** Meta's reference lists `caption` as unavailable with Instagram Login. The action requests it anyway. If it doesn't come back, hashtag and keyword rules can't match, and only `media` rules and `fallback` will work. The [smoke test](docs/setup-instagram.md#7-live-smoke-test) shows you which is the case.

## Token refresh

Instagram tokens last 60 days. A token can be refreshed once it's 24 hours old, and each real run tries. Dry runs don't. What happens next depends on the response, because Meta doesn't document whether a refresh returns the same token string or whether the old one survives.

| Instagram returns | `secrets_token` set? | Result |
|---|---|---|
| The same token string | either | The token is extended. Nothing else to do. |
| A new token string | yes | The action stores it in the `INSTAGRAM_TOKEN` secret. |
| A new token string | no | The new token can't be saved, so the action assumes the current one expires 60 days after it first saw that response. It records that date in `index.json`, with a short one-way fingerprint of the token, never the token itself. |

**The 14-day warning:** when 14 days or fewer remain, the run fails with a message naming the date and the steps to fix it. GitHub emails you about the failed run, which is the warning. The feed is still updated and published first. Without `secrets_token`, in the new-string case, expect this about every 46 days.

To fix it, generate a new token and update the secret. The action sees the change and starts counting again.

If the token has already expired, the run fails with `Token expired or invalid`, and nothing is written.

## Operations

**Run by hand:** go to **Actions > feed > Run workflow**, or:

```bash
gh workflow run feed.yml
```

**Dry run:** tick **dry_run** in the same form. The action fetches, classifies and renders, and builds thumbnails. It prints what it would do, then writes and commits nothing and doesn't refresh the token.

```bash
gh workflow run feed.yml -f dry_run=true
```

**Re-enable a disabled schedule:** GitHub disables scheduled workflows in public repos after 60 days without repository activity. Don't count on the action's own commits to prevent this. GitHub emails a warning first. To turn it back on:

```bash
gh workflow enable feed.yml
```

**Remove a post:**

- **Within your latest `fetch.limit` posts:** delete it on Instagram. The next run removes it here.
- **Older than that:** delete its file from `feed/p/` and commit. The next run removes it from the index.

Deleting only the file doesn't work for a recent post, because the next run sees it on Instagram and adds it back.

**Change categories:** new rules apply to new posts only. Existing posts keep their category, and there's no `reclassify` command. To reclassify, delete `feed/index.json` and `feed/p/`, then run the workflow. This rebuilds the newest `fetch.backfill` posts, and older ones won't come back.

**Change the theme or site title:** `index.html` and the legal pages update on the next run. Existing post pages don't, because each is written once. To restyle those too, rebuild the same way.

## Limits and costs

- **License:** using the action requires a paid license. The items below are the separate running costs.
- **Storage:** about 40 KB per post, so the default 200-post window is about 8 MB. Git history grows as posts come and go, but slowly.
- **Runner time:** under a minute a day, and GitHub doesn't charge for it on a public repo. A private repo works too, but uses your Actions minutes, and Pages on a private repo needs a paid plan.
- **[GitHub Pages limits](https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits):** 1 GB published site, a soft limit of 100 GB of bandwidth per month, and a soft limit of 10 builds per hour. One commit a day is well inside these.
- **Network:** the action only contacts the Instagram API and its image CDN, and GitHub for the push and, if you set `secrets_token`, for storing the token.

## Privacy and compliance

**This section and the generated pages aren't legal advice.** The privacy and data-deletion pages are a starting point. Check that they fit your situation.

- The feed shows public posts from your own account, and stores captions, dates, links and thumbnails.
- It collects nothing about visitors: no cookies, analytics or tracking. GitHub Pages may keep its own server logs.
- Your repo is public, so everything the feed stores can be read there, including in git history after a post is removed.
- Meta expects live apps to have a privacy policy and a deletion route. The generated pages are meant to fill those, at `feed/privacy.html` and `feed/data-deletion.html`.
- You're responsible for following Meta's current [Platform Terms](https://developers.facebook.com/terms/) and [Developer Policies](https://developers.facebook.com/devpolicy/).

## License

This is commercial software, and the source being public doesn't make it open source. To use, run, copy, modify or distribute it, including through `uses:` in a workflow, you need a paid license granted in writing by atiradonet. To request one, [open an issue](https://github.com/atiradonet/simple-media-client/issues). The full terms are in [LICENSE](LICENSE). Bundled third-party components keep their own licenses, listed in [dist/licenses.txt](dist/licenses.txt).

## Development

```bash
npm ci
```

```bash
npm run lint
```

```bash
npm run coverage
```

```bash
npm run build
```

Tests need ImageMagick and git, and never touch the real network. `dist/` is committed, and CI fails if it's stale. `npm run golden:update` rewrites the expected HTML; review the diff before committing. Design decisions and API findings are in [docs/decisions.md](docs/decisions.md).

Adding a provider means writing one module in `src/providers/` and one line in `src/providers/index.js`.
