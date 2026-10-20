# Recomp Haven

A tracker for every game recompilation, released and in progress. Sort and filter by console, genre, quality tier, stage, toolchain, features and activity.

It's a static site: `index.html`, `styles.css`, `app.js`, and the data in `data/recomps.js` and `data/tables.js`. On deploy, `tools/build_pages.py` adds a page and a link-preview image for every game.

**It's open source**, under the [MIT License](LICENSE): read the code, reuse it, and send fixes as pull requests. Found something broken? [Report a bug](https://github.com/rikuwru/recomphaven/issues/new?template=bug-report.yml). Security problems go through [SECURITY.md](SECURITY.md) instead, so they can be fixed before they're public.

## Made with AI help

Recomp Haven is built with AI. Most of its code, tools and documentation, and the project summaries (researched from each project's README and releases), were written with Claude, Anthropic's AI model, working through Claude Code. I (rikuwru) direct it, check and test what it makes, and decide what goes on the site: which projects are listed, their tiers and stages, and how the site works. Commits made this way end with a "Co-Authored-By: Claude" line, so the history shows which ones.

The site holds the projects it lists to the same standard: entries tagged "AI" disclose substantial AI-written code, and anyone can hide them with the "Hide AI-assisted" switch. If a summary or tier looks wrong, [send feedback](https://github.com/rikuwru/recomphaven/issues/new?template=feedback.yml).

## Run it locally

Open `index.html` in a browser, or serve the folder:

```bash
python -m http.server 8765
```

Then visit http://localhost:8765.

The game pages only exist once the site is built. To see them too, build it into `_site/` and serve that instead (needs Pillow: `pip install pillow`):

```bash
python tools/build_pages.py
```

```bash
python -m http.server 8000 -d _site
```

## Deploy

The host runs `python tools/build_pages.py` (with Pillow installed) and publishes the `_site/` folder it writes.

On GitHub Pages, set **Settings → Pages → Source** to **GitHub Actions**. `.github/workflows/deploy-pages.yml` then publishes the site on every push to `main` and after each nightly data refresh. Don't use "Deploy from a branch": the refresh job's commits wouldn't trigger a rebuild. Add your custom domain on the same settings page.

Cloudflare Pages, Netlify and Vercel can connect to the repo instead and deploy on every push, the nightly refresh included. Set the build command to `pip install pillow && python tools/build_pages.py` and the output folder to `_site`.

## Edit the list

Every project is one object in `data/recomps.js`. The comment at the top of that file documents each field. To add a recomp, copy an existing entry, give it a unique `id`, and fill in what you know. Fields you don't know can be `null`.

Quality tiers:

| Tier | Name | Meaning |
|---|---|---|
| S | Definitive | Complete and polished, with enhancements past the original |
| A | Complete | Playable start to finish in a stable release |
| B | Playable | Playable builds with known bugs or missing features |
| C | Rough | Boots and partly plays in tagged pre-release builds |
| D | Experimental | Early research, no public build, or not playable yet |

Stages are `released`, `beta`, `development` and `abandoned`. The site works out activity (Active, Quiet, Stalled) from the `updated` date on its own.

To add a console or feature, update the matching table in `data/tables.js` (`consoles`, `features`). The site and the game-page builder both read it. Genres and toolchains are read from the data.

## Game pages and link previews

Every game gets a page at `recomphaven.com/games/<name>/`, linked from its detail panel on the list. When several projects cover the same game, the page lines them up side by side (stage, tier, systems, features, latest release, activity) and marks one as **Recommended**, with a one-line reason.

- **Which projects share a page:** the ones with the same title. A trailing note in brackets doesn't count, unless it's a year: "Daytona USA (Arcade)" and "Daytona USA (XBLA)" share a page, while "Sonic the Hedgehog (2006)" gets its own.
- **Which one is recommended:** the best tier, then the furthest stage, then the most GitHub stars. When none of them is B tier or better, it's labelled "Best bet so far" instead. To choose by hand, add `"pick": true` to an entry; to write the reason yourself, add `"pickNote": "..."`.
- **Link previews:** each page has a 1200×630 image (box art, tier and the recommended project) that Discord, Reddit and other sites show when someone shares the link. The front page has one too. They're drawn with the fonts in `tools/fonts/` (SIL Open Font License).
- **Search engines:** the build also writes `sitemap.xml` and `robots.txt`.

None of this is committed: it's rebuilt on every deploy, so it follows the data. `_site/` is in `.gitignore`.

### Backdrops and theme music

A-tier and S-tier games have a few pictures drifting and fading behind their page and their details window, and their game page plays the game's main theme quietly, with a mute button. The files are in a separate public repo, [rikuwru/recomphaven-media](https://github.com/rikuwru/recomphaven-media), published by GitHub Pages, so a takedown notice there can't take this site down with it. `data/media.js` lists each game's pictures (with the part of each kept in view in small windows) and its track.

To add or change a game's media:

1. Put the pictures in `media/backdrops/<game page name>/` (a clone of the media repo) and the downloaded song in `music/`. Both folders are ignored here.
2. Add the game to `data/media.js`: its pictures, and for music the downloaded file as `source`, the published name as `file`, a `title` and a `credit`.
3. Run `.venv/Scripts/python tools/shrink_music.py --only <game page name>`. It writes a 96 kbps copy to `media/music/` and sets the track's volume so every game plays at about the same level. It needs `pip install miniaudio lameenc av` once.
4. Commit and push the media repo, then this one.

To try it before pushing, serve the media folder (`python -m http.server 8767 -d media`) and build with `RH_MEDIA_BASE=http://127.0.0.1:8767/`.

## Latest releases and trending

The front page opens with two panels, **Latest releases** and **Trending releases**.

- **Latest releases** lists the newest `version` / `versionDate` in the data, so it updates with the nightly refresh on its own. The build also makes a full list at `/releases/` and an RSS feed at `/feed.xml`. The data only keeps each project's latest release, so a project that ships twice in one day shows its newer version.
- **Trending releases** ranks projects by how many people opened them on Recomp Haven in the last 3 days (`visitsWeek`, see "Counting visits" below), recounted by the nightly refresh so it changes every day, and there's a matching "Trending" sort. Until visits are being counted, it ranks by GitHub stars gained in the last 7 days (`starsWeek`) instead.
- **Stars this week** (the green "+N" next to star counts) come from `tools/track_stars.py`, which counts them each night from GitHub's dated star list. It also saves the nightly totals to `data/stars-history.json` (two weeks of them) as a backup in case GitHub won't list the stars.

### Counting visits

The site sends one event to [GoatCounter](https://www.goatcounter.com/) per project when someone opens its details, opens a game page that has only that project, or follows its repository, website or release-notes link. GoatCounter counts each visitor once per event, so the numbers are close to people rather than clicks. It uses no cookies and keeps no personal data, so the site needs no consent banner. Each night `tools/track_visits.py` reads the last 3 days of counts (`WINDOW_DAYS`) and stores them as `visitsWeek`, a name from when it counted a week.

It's off until you set it up:

1. Sign up at [goatcounter.com](https://www.goatcounter.com/signup) (free for non-commercial sites). The site code you pick becomes your dashboard address, like `recomphaven.goatcounter.com`.
2. Put that code in `GOATCOUNTER` near the top of `tools/build_pages.py`. The next deploy adds GoatCounter's script to every page, and a line about it to the footer.
3. In GoatCounter, open your user menu → **API** → **New API key**, and allow it to read statistics. Copy the key.
4. On GitHub, open the repo's **Settings → Secrets and variables → Actions → New repository secret**. Name it `GOATCOUNTER_TOKEN` and paste the key.

Trending switches to visitors after the first nightly refresh that finds any. GoatCounter's dashboard also shows page views, referrers and the like. Visits from `localhost` aren't counted, so testing locally doesn't skew the numbers.

### Ratings and comments

Each game page ends with **Ratings and comments**: one thread per project, where visitors signed in with GitHub can comment, reply and react. It runs on [giscus](https://giscus.app), which keeps every thread as a GitHub Discussion in this repo, so there's no server to run and you can moderate on GitHub.

To rate a project, people start a comment with a score out of 10, like `Score: 8/10`. Once review sign-in is set up ([newsletter/README.md](newsletter/README.md#review-sign-in)), a review form above the comments does it for them: pick a score, write at least 20 characters, press **Submit review**, and it's posted as their own comment after a GitHub sign-in. Until then, the 1 to 10 buttons copy the score text for people to paste. Each night `tools/track_ratings.py` averages each GitHub account's latest score per project into `userScore` and `userScoreCount`, which fill the **User score** column, its sort, the detail panel and the game pages. Replies and comments without a score don't count. To remove a score, hide the comment on GitHub.

The same script works out each project's **rating trend** (`scoreTrend`, with the release in `scoreTrendSince`): the average score given since its latest release minus the average given before it, counting each account's latest score on each side. It shows as ▲ or ▼ under the user score once at least five people have rated on each side (`MIN_SIDE`), so a project that got low scores for an early build can show it's being rated better now.

It's off until you set it up:

1. On GitHub, open the repo's **Settings → General → Features** and tick **Discussions**.
2. Open the new **Discussions** tab, click the pencil next to **Categories**, then **New category**. Name it exactly `Ratings and comments` and choose the **Announcement** format, so only giscus and you can start threads and everyone else replies in them.
3. Install the giscus app at [github.com/apps/giscus](https://github.com/apps/giscus), for this repository only.
4. Go to [giscus.app](https://giscus.app), type `rikuwru/recomphaven` under Repository, pick the `Ratings and comments` category, and copy the `data-category-id` value from the script it shows.
5. Put that value in `category_id` in `GISCUS` near the top of `tools/build_pages.py`, then commit and push.

The next deploy adds the comments to every game page, and the next nightly refresh starts filling in user scores.

### Posting new releases to Discord

The nightly refresh can post each new release to a Discord channel, with its box art, tier and a link to the game's page. It stays off until you add a webhook:

1. In Discord, open **Server Settings → Integrations → Webhooks → New Webhook**, pick the channel, and click **Copy Webhook URL**.
2. On GitHub, open the repo's **Settings → Secrets and variables → Actions → New repository secret**. Name it `DISCORD_WEBHOOK_URL` and paste the URL.

From the next night on, `tools/announce_releases.py` posts every release that changed since the previous refresh, as long as it's from the last few days. Releases you add by hand in a commit aren't posted. To see what it would post without posting, run `python tools/announce_releases.py --dry-run`.

### Newsletter and update alerts

Visitors can sign up for a Sunday newsletter of the week's new projects and releases, and follow any project to get an email as soon as it puts out a new release. A small Cloudflare Worker keeps the sign-ups and sends the emails through Resend, and two GitHub workflows write them. It stays off, with no sign-up forms on the site, until it's set up: see [newsletter/README.md](newsletter/README.md).

## Keeping the data fresh

Stars, last push and latest release come from GitHub. To refresh them:

```bash
python tools/refresh_stats.py --dry-run
```

`--dry-run` prints what would change and writes nothing. Drop it to update `data/recomps.js`, or add `--limit 10` to check only the first ten repos.

Without a token GitHub allows 60 requests an hour, and a full run needs about 370, so the script waits out the limit and takes hours. Set `GITHUB_TOKEN` to a personal access token (no scopes needed for public repos) and it finishes in a few minutes.

The workflow in `.github/workflows/refresh-data.yml` runs the script every night, or on demand from the Actions tab, and commits `data/recomps.js` when it changed. It only runs once the site is in a GitHub repository, and it uses the built-in token, so there's nothing to set up. On GitHub Pages, the deploy workflow publishes each refresh.

Genres, stages and quality tiers stay manual, and the script never touches them. When GitHub hints that a stage is out of date (an archived repo, a stable 1.0 release, no push in a year), it lists the entry under "Suggested review", which also appears in the workflow's job summary. Moved repos and 404s are listed too, and nothing is deleted.

## Covers

Each game's box art is in `assets/covers/<id>.webp`. The entry's `cover` field points at it, and `coverFrom` says where it came from. To fetch covers for entries that don't have one yet:

```bash
python tools/fetch_covers.py
```

It needs Pillow (`pip install pillow`). The script tries the [libretro thumbnails](https://thumbnails.libretro.com/) server first (the box art RetroArch uses), then the infobox image of the matching English Wikipedia article. Entries with no match show the console's colour and the game's initials instead. The nightly workflow runs it too, so new entries get a cover by the next morning, and the job summary lists them so you can check the picks.

If a cover is wrong or missing, set the entry's `coverFrom` and fetch it again:

- `"libretro:Castlevania (USA)"`: a box art name from the console's folder on thumbnails.libretro.com
- `"wikipedia:Kameo"`: the image on that Wikipedia page
- `"none"`: keep the placeholder

```bash
python tools/fetch_covers.py --only castlevania-64 --force
```

To use your own image, save it under `assets/covers/`, point `cover` at it and set `coverFrom` to `"manual"`. The script never touches those.

## Operating systems

Each entry's `platforms` lists the systems it runs on (`"windows"`, `"linux"`, `"macos"`, `"android"`), and the site's "Runs on" filter and icons read from it. `null` means the project doesn't say. Android counts phones and tablets: an Android build only for the Quest VR headset doesn't. The labels and logos are in `data/tables.js`.

```bash
python tools/detect_platforms.py
```

The script reads the file names on each project's newest GitHub release (for example `-linux-x86_64.AppImage`, `-windows-x64.zip` or `-android-arm64.apk`) and records `"platformsFrom": "release"`. Projects without such downloads fall back to what their README says (`"readme"`), skipping mentions like "Linux is planned" or "no plans for Android". It needs no token or extra packages. By default it only checks entries without platforms and release-based entries whose newest release changed; add `--all` to recheck everything. The nightly workflow runs it too.

If it gets one wrong, set `platforms` yourself and `"platformsFrom": "manual"`; the script never changes those.

## Keyboard, mouse and mod managers

Two "Must have" chips read tags in each entry's `features`:

- **Keyboard/mouse**: `"keyboard-mouse"` when the project says keyboard and mouse both work in the game, or `"keyboard"` when only the keyboard does (for example, the mouse only works in menus).
- **Mod manager**: `"mod-manager"` when community mods can be found and installed through a mod manager or mod site, such as Thunderstore, r2modman, Hedge Mod Manager or an in-game mod browser.

```bash
python tools/detect_features.py
```

The script reads each project's README and its three newest release notes, skipping mentions like "planned" or "controller required". It records how each was decided in `"inputFrom"` and `"modManagerFrom"`: `"github"` when it found something, `"none"` when it didn't. It only checks markers an entry doesn't have yet, so the nightly workflow picks up new entries; add `--all` to recheck everything. To set one by hand, edit `features` and set the marker to `"manual"`; the script never changes those.

## Submissions

The site's "Submit a game" button and the footer link open the GitHub issue form in `.github/ISSUE_TEMPLATE/submit-a-game.yml`. Each submission shows up under the repo's **Issues** tab: check the project, add or fix its entry in `data/recomps.js`, then close the issue.

The **Send feedback** button, the footer link and each game's "Suggest a correction" link open a second form, `.github/ISSUE_TEMPLATE/feedback.yml`, for feedback on a game's summary, tier or details, or on the site itself. Corrections arrive with the game and project filled in, and the form asks how the person would like to be credited.

Bugs in the site have their own form, `.github/ISSUE_TEMPLATE/bug-report.yml` (**Report a bug** in the footer of every page), and security problems are reported privately as described in `SECURITY.md`. For that, turn on **Settings → Security → Private vulnerability reporting** in the repo.

The **Thanks** section near the bottom of the site credits everyone whose submission was added or whose feedback changed the site. Add people to `data/credits.js`, with their GitHub or Reddit username and a few words on what they did.

## Sources and license

The code is under the [MIT License](LICENSE), © 2026 rikuwru.

The base data (project names, statuses, repositories, descriptions and GitHub stats) comes from [Recompendium](https://github.com/nio03/unricopie), used under the MIT License. Its notice is in `data/LICENSE-recompendium.txt` and must stay with the data. Genres, stages, quality tiers and the entries added by hand since are Recomp Haven's own. Many of those entries were found through [recomp.fyi](https://recomp.fyi/) and the [Quiver Launcher](https://quiverlauncher.com/) catalog; each was checked against the project's own repository, and the descriptions are written here. Box art comes from the libretro thumbnails project, Wikipedia and, for a few games, other fan wikis, and belongs to each game's publisher: it isn't covered by the MIT License. The fonts in `tools/fonts/` (used for the link-preview images) are under the SIL Open Font License; their notices are beside them. The first snapshot is from 16 October 2026.

Recomp Haven links to projects and hosts no game files. Every recomp needs your own legally obtained copy of the game.
