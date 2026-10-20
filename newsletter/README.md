# Newsletter and update alerts

Two kinds of email, both sign-up only:

- **The Sunday newsletter**: one email every Sunday with the projects that put out a release that week and the projects new to the list. The sign-up box is near the bottom of the front page, and the **Newsletter** button at the top of every page goes straight to it.
- **Update alerts**: **Get update emails** on a project's card (on its game page, or in its details on the front page) emails that person as soon as the project puts out a new release. The check runs every hour, so alerts arrive within about an hour of the release.

Everyone confirms by email before anything is sent, and every email has a one-click unsubscribe and a link to a page where people manage what they get. Someone who turns everything off is deleted, and sign-ups never confirmed are deleted after three days.

## How it fits together

| Piece | What it does |
|---|---|
| `newsletter/worker.js` | A [Cloudflare Worker](https://developers.cloudflare.com/workers/) with a D1 database. It takes sign-ups from the site, sends the confirmation emails, serves the confirm, manage and unsubscribe pages, and sends emails for the two jobs below through [Resend](https://resend.com). It's one file with no dependencies, so it's pasted into the Cloudflare dashboard. |
| `tools/send_digest.py` | Writes the Sunday newsletter from `data/recomps.js` and has the Worker send it. Runs from `.github/workflows/newsletter.yml` at 15:00 UTC on Sundays. |
| `tools/send_alerts.py` | Checks GitHub for a new release of every followed project, the same way the site's Latest release is picked, and has the Worker email their followers. Runs from `.github/workflows/update-alerts.yml` every hour. |
| `MAIL_API` in `tools/build_pages.py` | The Worker's address. While it's empty, the site shows no sign-up forms. |

Email addresses live only in the Worker's D1 database, never in this repository.

## Setting it up

You need free accounts at Resend and Cloudflare. It takes about 20 minutes, most of it waiting for DNS.

### 1. Resend (sends the emails)

1. Sign up at [resend.com](https://resend.com).
2. Open **Domains → Add Domain** and enter `recomphaven.com`. Resend shows a few DNS records (DKIM and SPF). Add each one where the domain's DNS is managed (the same place that points recomphaven.com at GitHub Pages), then click **Verify DNS Records**. It can take a few minutes to an hour.
3. Open **API Keys → Create API Key**. Give it **Sending access** for `recomphaven.com`, and copy the key (it starts with `re_`). Resend shows it only once.

### 2. Cloudflare (runs the Worker and stores sign-ups)

1. Sign up at [dash.cloudflare.com](https://dash.cloudflare.com). The free plan is enough, and the domain doesn't need to move to Cloudflare.
2. **Storage & Databases → D1 SQL Database → Create**. Name it `recomphaven-mail`. The Worker creates its own tables the first time it runs.
3. **Compute (Workers) → Workers & Pages → Create → Start with Hello World**. Name it `recomphaven-mail` and click **Deploy**.
4. Click **Edit code**, delete everything in `worker.js`, paste in the whole of `newsletter/worker.js` from this repo, and click **Deploy**.
5. Back on the Worker, open **Bindings → Add binding → D1 database**. Variable name `DB`, database `recomphaven-mail`. Save.
6. Open **Settings → Variables and Secrets** and add two of type **Secret**:
   - `RESEND_API_KEY`: the key from Resend.
   - `ADMIN_TOKEN`: a long random password that lets the GitHub jobs use the Worker. Make one with `python -c "import secrets; print(secrets.token_urlsafe(32))"` and keep it for step 3.
7. Copy the Worker's address from its overview, like `https://recomphaven-mail.yourname.workers.dev`. Opening it should take you to recomphaven.com.

### 3. GitHub (runs the two jobs)

Open the repo's **Settings → Secrets and variables → Actions** and add two **repository secrets**:

- `MAIL_API_URL`: the Worker's address.
- `MAIL_ADMIN_TOKEN`: the same value as `ADMIN_TOKEN`.

### 4. Turn on the forms

Put the Worker's address in `MAIL_API` near the top of `tools/build_pages.py`, then commit and push. The next deploy shows the newsletter box, the Newsletter link and the **Get update emails** buttons.

### 5. Try it

1. Sign up on the site with your own address, and click the link in the email.
2. On GitHub, open **Actions → Sunday newsletter → Run workflow**, put your address under "Send one test copy", and run it. It sends this week's newsletter to you only, marked [Test].
3. Follow a project you know updates often. **Actions → Update alerts** runs every hour; its first check of a project only notes the current release, and the next new release emails you.

## Review sign-in

Game pages can take Steam-style reviews: pick a score, write at least 20 characters, press **Submit review**. The first time, the visitor signs in with GitHub through this Worker, and the review is posted as their own comment in the project's thread (the same one giscus shows), starting with `Score: N/10`, so `tools/track_ratings.py` counts it as before. The Worker also starts a project's thread the first time someone reviews it, since only you and apps can start threads in the category. It needs a GitHub App of your own, made once:

1. On GitHub, open **Settings → Developer settings → GitHub Apps → New GitHub App** and fill in:
   - **GitHub App name**: anything free, like `Recomp Haven Reviews`. Reviewers see it when they sign in.
   - **Homepage URL**: `https://recomphaven.com`
   - **Callback URL**: `https://recomphaven-mail.intooblivion-riku.workers.dev/auth/callback`
   - Leave **Expire user authorization tokens** ticked, and **Request user authorization (OAuth) during installation** and **Enable Device Flow** unticked.
   - **Webhook**: untick **Active**.
   - **Permissions → Repository permissions → Discussions**: **Read and write**. Leave everything else at No access.
   - **Where can this GitHub App be installed?**: **Only on this account**.
2. Press **Create GitHub App**. On the page that opens, copy the **Client ID**, press **Generate a new client secret** and copy the secret (GitHub shows it once), then scroll down and press **Generate a private key**, which downloads a `.pem` file.
3. In the app's menu on the left, open **Install App**, install it on your account, and pick **Only select repositories → recomphaven**.
4. In Cloudflare, open the Worker's **Settings → Variables and Secrets** and add:
   - `GH_CLIENT_ID` (plain text): the Client ID.
   - `GH_CLIENT_SECRET` (secret): the client secret.
   - `GH_PRIVATE_KEY` (secret): open the `.pem` file in Notepad and paste all of it, the `BEGIN` and `END` lines too. Then delete the file, or keep it somewhere private.
5. Paste the current `newsletter/worker.js` over the Worker's code and **Deploy** (see Updating the Worker below).
6. Set `REVIEWS_ON = True` near the top of `tools/build_pages.py`, then commit and push. The next deploy puts the form on every game page.
7. Try it: review a game, check the comment shows up under the game and in the repo's Discussions tab, then delete the comment on GitHub. Delete only the comment, not the whole discussion: the Worker remembers each project's thread. Ask someone with another GitHub account to try one too. If GitHub shows them an error instead of the sign-in page, change step 1's **Where can this GitHub App be installed?** to **Any account**; it still only works on this repo.

Sign-ins last 8 hours and are kept in the visitor's browser. The token can only read and write discussions on repos where the app is installed, which is only this one, and anyone can revoke it at [github.com/settings/apps/authorizations](https://github.com/settings/apps/authorizations). Each GitHub account can submit up to 30 reviews a day. To remove a review, hide or delete the comment on GitHub, as before.

## Limits

Resend's free plan sends 100 emails a day and 3,000 a month. The Worker counts every email and stops at `DAILY_LIMIT` (100 unless you set it), so a Sunday newsletter to more than about 90 people would stop part way. Confirmation emails are capped at `CONFIRM_LIMIT` (40) a day, so a burst of sign-ups can't use up the day. When the list grows, move Resend to a paid plan and add `DAILY_LIMIT` as a plain-text variable on the Worker with the new limit.

Sign-ups are also limited to 20 a day from one network, and to one confirmation email every two minutes per address. A hidden form field catches simple bots.

Other optional Worker variables (plain text, under **Settings → Variables and Secrets**):

- `MAIL_FROM`: the sender, `Re:Haven <news@recomphaven.com>` unless you set it. It must be on the domain verified in Resend.
- `ALLOWED_ORIGINS`: the sites allowed to send sign-ups, `https://recomphaven.com` unless you set it. Add others separated by commas, like `https://recomphaven.com,http://localhost:8000` to try the forms on your computer.

## Updating the Worker

After a change to `newsletter/worker.js`, open the Worker's **Edit code** again, paste the new file over the old one, and **Deploy**. Subscribers, follows and settings stay where they are.

## Running the jobs by hand

```bash
python tools/send_digest.py --dry-run --preview digest.html   # what this week's newsletter would say; no sending
python tools/send_alerts.py --dry-run                          # what changed since the last check; needs MAIL_API_URL and MAIL_ADMIN_TOKEN
```
