# Recomp Haven: notes for Claude

Recomp Haven (recomphaven.com) is a static site that tracks game static recompilations, decompilations and the
native ports built from them. It's maintained by rikuwru with Claude's help. Read this before changing anything.

## Ground rules

- **Ask before every commit and every push.** A push to `main` deploys the live site within a few minutes.
- **Pull first.** The nightly "Refresh data" workflow commits stats to `main`, so run `git pull --ff-only` before
  editing `data/recomps.js`, and again before pushing.
- **S tier is rikuwru's call.** Never move a project into or out of S on your own; suggest it and let them decide.
- **Write your own text.** Summaries are written fresh from each project's own README. Never copy text from other
  catalogs or sites.
- **No game files, ever.** The site links to projects and hosts no ROMs, discs or game data.
- **Game-page media stays out of this repo.** The pictures behind game pages and their theme music live in the
  separate public repo `rikuwru/recomphaven-media` (working copy in `media/`, ignored here; sharp picture sources in
  `backdrop-sources/`, blurred into it by `tools/blur_backdrops.py`), listed in
  `data/media.js`. Downloaded music goes in `music/` (also ignored); `tools/shrink_music.py` makes the published
  copies and sets their volume. rikuwru accepted the takedown risk for that repo; don't add media here instead.
- Leave the newsletter Worker (`newsletter/`) and its secrets alone unless asked.

## What gets listed

Only true static recompilations, decompilations (and byte-exact disassemblies), and native ports compiled from them.
Check every project on its own repository before adding it. **Skip:**

- compatibility layers that run x86 console code directly: PS4/PS5 ports built on shadPS4-style runtimes, and Xbox
  "loader" ports that run the original `.xbe` code as-is
- emulators, emulator cores wrapped in a launcher, and hybrids that still emulate most of the game
- engine reimplementations, remakes and clean-room rewrites that don't use the game's own code
- ports of officially released or leaked source code
- launchers for another project, and Android or platform forks of a project that's already listed
- projects with no sign they play yet (setup kits whose README and releases only talk about builds)
- utility cartridges and anything that isn't a game

Exceptions rikuwru chose: **P.T. PC Port** stays (toolchain `Reimplementation`); **R.E.L.I.V.E.** and **Metaforce**
count as `Decompilation`. Complete decomps that only rebuild the original ROM are listed at **D**, stage
`development`, but when a game has both, the playable PC port matters more.

## Tiers and stages

| Tier | Stage | When |
|---|---|---|
| S | released | Hand-picked by rikuwru: the definitive way to play the game |
| A | released | Stable 1.0 or later, playable start to finish |
| B | beta | Playable builds (0.x, or no release yet) with known gaps |
| C | development | Tagged pre-release builds that boot and partly play |
| D | development | Not playable yet, no public build, or a ROM-only decomp |
| D | abandoned | Repository deleted, taken down or archived as cancelled |

When a README contradicts the version number (a "1.0" that only plays the first level), trust the README.

## Credits

Whenever you add a game someone submitted (a GitHub issue) or suggested (Reddit and similar, relayed by rikuwru),
add them to `data/credits.js` in the same change: GitHub users get `"site": "github"` and "Submitted …", Reddit users
`"site": "reddit"` and "Suggested …". Credit people whose feature ideas get built, too. Skip rikuwru's own account.

Data sources are credited in the `index.html` footer and the README: Recompendium (MIT, the base data), plus
recomp.fyi and the Quiver Launcher catalog, which were used to find projects.

## How the site is put together

- `data/recomps.js`: every project, **one JSON object per line**. The comment at the top lists every field. Read
  and write it only through `load()` and `dump()` in `tools/refresh_stats.py`, never by hand-editing the JSON
  layout.
- `data/tables.js`: consoles, genres, stages, tiers, features and OS icons. A new console needs an entry here, and
  for box art a line in `SYSTEMS` in `tools/fetch_covers.py`.
- `data/credits.js`: the Thanks list. `index.html`, `app.js`, `styles.css`: the site itself.
- `tools/build_pages.py` builds `_site/`: the site plus one page per game (projects with the same `title` share a
  game page, so titles must match exactly), share images, the releases page, the feed and the sitemap. The deploy
  workflow runs it; you run it to check your work.
- Nightly (`refresh-data.yml`): stars, last push and versions (`refresh_stats.py`), the game-files check
  (`check_roms.py`, which hides projects that hand out ROMs via `romFiles` until they stop), covers, platforms,
  features, star history, visits, ratings, and release announcements. Don't clear `romFiles` by hand.

Use the repo's virtual environment (it has Pillow). On Windows, set `PYTHONIOENCODING=utf-8`, or Python crashes
printing emoji and accented names.

```bash
python -m venv .venv && .venv/Scripts/pip install pillow   # first time only
.venv/Scripts/python tools/build_pages.py
```

## Adding a project

1. Read its README and releases, and decide from the rules above whether it belongs and which tier and stage fit.
2. Add the entry with a small script that calls `load()`, appends a dict, and calls `dump()`. Fill: `id` (unique
   kebab-case), `title` (the game's official name; match an existing entry's title exactly for the same game),
   `project`, `console`, `year`, `developer`, `genre` (use one of the existing genres), `stage`, `quality`,
   `toolchain` (an existing name such as N64Recomp, ReXGlue, PSXRecomp, Decompilation; `Custom` for a one-off
   recompiler), `team`, `repo`, `website`, `version` and `versionDate` (newest release whose tag has a number),
   `started` (repository created), `updated` (last push), `stars`, `features`, `ai` (true when the project says AI
   wrote a substantial part), `summary`, `requires`, `added` (today, YYYY-MM-DD), plus `"inputFrom": "manual"` and
   `"modManagerFrom": "manual"`. `planned` comes from `tools/detect_planned.py --only <id>`.
   `languages` comes from `tools/detect_languages.py --only <id> --verbose`; check its evidence, and set
   `"languagesFrom": "manual"` when it's wrong.
3. Covers: run `tools/fetch_covers.py --only <id>` and look at the image. It sometimes picks the wrong game or
   platform; fix that by setting `coverFrom` to `"libretro:<exact box art name>"` or `"wikipedia:<page title>"`
   and running again with `--force`.
4. Platforms: run `tools/detect_platforms.py --only <id> --verbose`. It guesses from release file names, then the
   README, and README guesses can be wrong ("Linux is planned" style text). When it's wrong, set `platforms` by
   hand with `"platformsFrom": "manual"`.
5. Credit the submitter, rebuild, open the local site (`python -m http.server -d _site`) and check the entry, its
   details panel and its game page. Then ask before committing.

The GitHub API allows only 60 requests an hour without a token. For bulk checks, read the repository page, the raw
README (`raw.githubusercontent.com`) and the `releases.atom` and `commits.atom` feeds instead.

## Writing summaries

One to three plain sentences: how it's built (recompiler or decomp), what works today, what it adds (widescreen,
frame rates, mods), and which systems it runs on. Say plainly when something isn't finished. No hype, no "amazing".
`requires` says what the player must supply: their own copy of the game and the exact version or region, plus
anything unusual such as a BIOS or build tools.
