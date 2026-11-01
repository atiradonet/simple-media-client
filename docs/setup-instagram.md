# Instagram setup

This guide gets you from an Instagram account to a live feed: a Meta app, a token, the first dry run, and the first real run. Allow about 30 minutes. Meta renames dashboard menus often, so if a label below doesn't match, look for the closest one. Meta's [Get Started page](https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/get-started) is the current source.

## 1. Make the account professional

The API only works with Business and Creator accounts. In the Instagram app, go to **Settings > Account type and tools** and switch to a professional account. A personal account can't use this action.

## 2. Create a Meta app

Each influencer has their own app. Your token and data never go through anyone else.

1. Go to [developers.facebook.com/apps](https://developers.facebook.com/apps) and create an app.
2. Choose the **Business** type.
3. In the app's dashboard, add the **Instagram** product.

An app used only by accounts you own or manage stays on Standard Access, so it doesn't need App Review.

## 3. Generate a token

1. In the dashboard, open **Instagram > API setup with Instagram business login**.
2. If your account isn't listed, add it. You may need to give it the Instagram Tester role under **App roles**, then accept the invite in Instagram under **Settings > Apps and websites**.
3. Click **Generate token** next to the account and log in to Instagram.
4. Copy the token.

Tokens from the dashboard are long-lived and last 60 days. The action refreshes the token on each run; see [Token refresh](../README.md#token-refresh).

## 4. Add the secret

In your site repo, go to **Settings > Secrets and variables > Actions > New repository secret**. Name it `INSTAGRAM_TOKEN` and paste the token. The action's messages use this name, and it's the one the action writes to when it stores a refreshed token.

## 5. Optional: let the action store refreshed tokens

Without this, you may have to replace the token by hand about every 46 days.

1. Create a [fine-grained personal access token](https://github.com/settings/personal-access-tokens/new).
2. Limit it to your site repo, and give it **Secrets: Read and write** and nothing else.
3. Add it to the repo as a secret named `FEED_SECRETS_TOKEN`.
4. Uncomment the `secrets_token` line in your workflow.

This token has an expiry date of its own. When it runs out, the run fails and says it couldn't store the token.

## 6. Add the workflow and config

Copy these two files into your site repo:

- [`examples/workflow.yml`](../examples/workflow.yml) to `.github/workflows/feed.yml`
- [`examples/simple-media.yml`](../examples/simple-media.yml) to `simple-media.yml`, then edit it. At a minimum, change `site.title`, `site.contact_email` and `site.profile_url`.

Under **Settings > Pages**, set the source to **Deploy from a branch**.

## 7. Live smoke test

Do this once, by hand. Automated tests can't reach Instagram, so this is the only check of the live API.

1. Go to **Actions > feed > Run workflow**, tick **dry_run**, and run it.
2. Open the run's summary. Check that **Fetched** isn't 0 and **New** matches `fetch.backfill`, or the number of posts you have if that's lower.
3. In the log, look at the `new:` lines. Check that the categories look right. **If every post lands in your fallback category even though the captions contain your hashtags, captions aren't coming back from the API.** Meta's reference marks `caption` as unavailable with Instagram Login, though the field is still requested. In that case only `media` rules can work, so see [Classification](../README.md#classification).
4. Run the workflow again without **dry_run**.
5. Check that a commit named `feed: +N new, -0 removed (instagram)` appeared.
6. Wait a minute, then open `https://<user>.github.io/<repo>/feed/`.
7. Open a post and follow **View on Instagram**.

Three things are unconfirmed until someone runs this against a real account: whether captions and `media_product_type` come back, what the refresh returns, and whether the Pages build step works with `GITHUB_TOKEN`. The third shows up as a failed last step in the run. [Open an issue](https://github.com/atiradonet/simple-media-client/issues) with what you find, leaving out the token and any real post data.

## Troubleshooting

| Message | What to do |
|---|---|
| `Token expired or invalid` | Generate a new token (step 3) and update the secret (step 4). |
| `The access token expires on <date>` | Same, or set up step 5. Today's update was still published. |
| `Could not refresh the access token` | Normal on a token's first day: a token must be 24 hours old before it can be refreshed. If it continues after that, generate a new token. |
| `ImageMagick is not installed` | Add the install step from the example workflow. |
| `git push failed` … `contents: write` | Add `permissions: contents: write` to the workflow. |
| `Could not store the refreshed token` | Check that `FEED_SECRETS_TOKEN` hasn't expired and has Secrets write access. |
