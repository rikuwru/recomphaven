"""Builds the deployable site into _site/.

It copies the static files, then generates:

- games/<slug>/index.html: one page per game. When a game has several projects,
  the page compares them side by side and recommends one.
- assets/share/<slug>.jpg: a 1200x630 preview image per game, used by Discord,
  Reddit and other sites when someone shares the link. assets/share/home.jpg is
  the same kind of image for the front page.
- releases/index.html and feed.xml: every project's latest release, newest
  first, as a page and as an RSS feed.
- sitemap.xml and robots.txt.

Usage:
    python tools/build_pages.py              # writes _site/
    python -m http.server -d _site 8000      # preview it at http://localhost:8000

.github/workflows/deploy-pages.yml runs it on every deploy. It needs Pillow, and
the fonts in tools/fonts (SIL Open Font License).

Projects for the same game are grouped by title. A trailing note in brackets
doesn't count, unless it's a year: "Daytona USA (Arcade)" and "Daytona USA
(XBLA)" share a page, while "Sonic the Hedgehog (2006)" gets its own. slugOf()
in app.js must give the same slugs.

The recommended project is the best tier, then the furthest stage, then the most
GitHub stars. To override that, set "pick": true on an entry. To replace the
generated reason, add "pickNote": "...".
"""
import argparse
import datetime as dt
import hashlib
import html
import json
import os
import re
import shutil
import sys
import unicodedata
from collections import defaultdict
from email.utils import format_datetime
from urllib.parse import quote, urlencode

from PIL import Image, ImageDraw, ImageFilter, ImageFont

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from refresh_stats import DATA, ROOT, load  # noqa: E402

SITE = 'https://recomphaven.com'
# giscus (https://giscus.app): ratings and comments on game pages, kept as GitHub Discussions in
# this repo, one thread per project. Off until category_id is filled in (README: "Ratings and
# comments"); tools/track_ratings.py averages the scores people post there.
GISCUS = {'repo': 'rikuwru/recomphaven', 'repo_id': 'R_kgDOVMUa9g',
          'category': 'Ratings and comments', 'category_id': 'DIC_kwDOVMUa9s4DIxXc'}
COMMENTS_ON = bool(GISCUS['repo_id'] and GISCUS['category_id'])
# Steam-style reviews above the comments: a score, a written review and a Submit button, posted to the
# project's thread as the reviewer, after a GitHub sign-in through the newsletter Worker's GitHub App
# (newsletter/README.md: "Review sign-in"). False puts back the buttons that copy "Score: N/10".
REVIEWS_ON = True
REVIEW_MIN = 20  # the shortest review, in characters
# GoatCounter site code (the "recomphaven" in recomphaven.goatcounter.com), or '' for no
# visit counting. It counts the visits that rank Trending; see tools/track_visits.py.
GOATCOUNTER = 'recomphaven'
# The newsletter Worker's address (newsletter/README.md), or '' to leave the sign-up forms out.
# RH_MAIL_API overrides it, for trying the forms against a test Worker.
MAIL_API = os.environ.get('RH_MAIL_API') or 'https://recomphaven-mail.intooblivion-riku.workers.dev'
SUBMIT_URL = 'https://github.com/rikuwru/recomphaven/issues/new?template=submit-a-game.yml'
FEEDBACK_URL = 'https://github.com/rikuwru/recomphaven/issues/new?template=feedback.yml'
BUG_URL = 'https://github.com/rikuwru/recomphaven/issues/new?template=bug-report.yml'
REPO_URL = 'https://github.com/rikuwru/recomphaven'
STATIC = ['index.html', 'favicon.ico', 'styles.css', 'app.js', 'game.js', 'assets', 'data']
FONTS = os.path.join(ROOT, 'tools', 'fonts')

with open(os.path.join(ROOT, 'data', 'tables.js'), encoding='utf-8') as _f:
    _text = _f.read()
TABLES = json.loads(_text[_text.index('{', _text.index('RECOMPHAVEN_TABLES')):].rstrip().rstrip(';'))
CONSOLES, STAGES, TIERS = TABLES['consoles'], TABLES['stages'], TABLES['tiers']
FEATURES, OS, PLATFORM_SOURCE = TABLES['features'], TABLES['os'], TABLES['platformSource']
STAGE_ORDER, TIER_ORDER = list(STAGES), list(TIERS)

# What the "Recommended" reason says a project has.
FEATURE_PHRASES = {
    'widescreen': 'widescreen', 'high-fps': 'high frame rates', 'mods': 'mod support',
    'mod-manager': 'a mod manager', 'ray-tracing': 'ray tracing', 'multiplayer': 'multiplayer',
    'online': 'online play', 'keyboard-mouse': 'keyboard and mouse controls', 'keyboard': 'keyboard controls',
    'steam-deck': 'Steam Deck support',
}
PLAYABLE = {'S', 'A', 'B'}

# Share-card colours: the site's dark theme (styles.css).
INK = {
    'bg': (14, 16, 23), 'scan': (19, 21, 29), 'surface': (22, 25, 36), 'fg': (232, 234, 242),
    'muted': (151, 157, 179), 'accent': (143, 154, 255), 'tier-ink': (26, 26, 26),
}
TIER_COLORS = {'S': '#ff7f7f', 'A': '#ffbf7f', 'B': '#ffdf7f', 'C': '#ffff7f', 'D': '#bfff7f'}
STAGE_COLORS = {'released': '#4cc47f', 'beta': '#3fc7c1', 'development': '#e3a63c', 'abandoned': '#7d8398'}

TODAY = dt.datetime.now(dt.timezone.utc).date()
esc = html.escape


# ── Grouping and picking ─────────────────────────────────

def base_title(title):
    """The title without a trailing note in brackets, unless the note is a year."""
    return re.sub(r'\s*\((?!\d{4}\))[^)]*\)\s*$', '', title)


def slug_of(title):
    s = unicodedata.normalize('NFKD', base_title(title)).encode('ascii', 'ignore').decode().lower()
    s = re.sub(r"['.]", '', s)
    return re.sub(r'[^a-z0-9]+', '-', s).strip('-')


def rank(e):
    return TIER_ORDER.index(e['quality']), STAGE_ORDER.index(e['stage']), -(e.get('stars') or 0), e['id']


def group(entries):
    by_slug = defaultdict(list)
    for e in entries:
        by_slug[slug_of(e['title'])].append(e)
    games = []
    for slug, es in sorted(by_slug.items()):
        es.sort(key=rank)
        pick = next((e for e in es if e.get('pick')), es[0])
        ranked = [pick] + [e for e in es if e is not pick]
        consoles = list(dict.fromkeys(e['console'] for e in ranked))
        years = [e['year'] for e in ranked if e.get('year')]
        games.append({
            'slug': slug,
            'name': es[0]['title'] if len(es) == 1 else base_title(pick['title']),
            'entries': ranked,
            'pick': pick,
            'consoles': consoles,
            'year': min(years) if years else None,
            'updated': max((e.get('updated') or '' for e in es), default='') or None,
        })
    return games


def and_list(items):
    items = list(items)
    return items[0] if len(items) == 1 else ', '.join(items[:-1]) + ' and ' + items[-1]


def pick_label(game):
    return 'Recommended' if game['pick']['quality'] in PLAYABLE else 'Best bet so far'


def reason(game):
    """One or two sentences on why the pick beat the rest, from the data alone."""
    pick, rest = game['pick'], game['entries'][1:]
    if pick.get('pickNote'):
        return pick['pickNote']
    other, n = rest[0], len(game['entries'])
    tier = f"{pick['quality']} ({TIERS[pick['quality']]['label']})"
    stage = STAGES[pick['stage']]['label'].lower()
    if pick.get('pick') and rank(pick) > rank(other):
        first = f'Picked by hand from the {n} projects here.'
    elif rank(pick)[0] < rank(other)[0]:
        first = (f'Rated {tier}, the highest of the {n} projects here.' if n > 2
                 else f"Rated {tier}, above {other['project']} at {other['quality']}.")
    elif rank(pick)[1] < rank(other)[1]:
        first = (f"Rated {pick['quality']} like {other['project']}, but further along: "
                 f"{stage}, against {STAGES[other['stage']]['label'].lower()}.")
    elif (pick.get('stars') or 0) > (other.get('stars') or 0):
        first = (f"Level with {other['project']} on rating and stage, with the bigger following on GitHub "
                 f"({fmt_stars(pick.get('stars'))} stars to {fmt_stars(other.get('stars'))}).")
    else:
        first = f"Level with {other['project']} on rating and stage."

    feats = [FEATURE_PHRASES[f] for f in pick.get('features') or [] if f in FEATURE_PHRASES]
    if 'keyboard and mouse controls' in feats and 'keyboard controls' in feats:
        feats.remove('keyboard controls')
    systems = [OS[k]['label'] for k in pick.get('platforms') or []]
    second = f'It has {and_list(feats[:4])}' if feats else ''
    if systems:
        second += (', and runs on ' if second else 'It runs on ') + and_list(systems)
    second += '.' if second else ''
    if pick['quality'] not in PLAYABLE:
        second += ' None of these projects is fully playable yet.'
    if pick['stage'] == 'abandoned':
        second += ' Work on it has stopped.'
    return f'{first} {second.strip()}'.strip()


# ── Formatting (mirrors app.js) ──────────────────────────

def fmt_date(d):
    if not d:
        return ''
    x = dt.date.fromisoformat(d)
    return f'{x:%b} {x.day}, {x.year}'


def fmt_stars(n):
    if n is None:
        return '—'
    if n >= 1000:
        return f'{n / 1000:.{0 if n >= 10000 else 1}f}'.removesuffix('.0') + 'k'
    return str(n)


def activity(e):
    if not e.get('updated'):
        return 'unknown'
    n = (TODAY - dt.date.fromisoformat(e['updated'])).days
    return 'active' if n <= 60 else 'quiet' if n <= 180 else 'stalled'


def console_of(key):
    return CONSOLES.get(key) or {'label': key, 'short': str(key).upper(), 'color': '#555'}


STOPWORDS = {'the', 'of', 'and', 'a', 'an', 'to', 'in'}


def initials(title):
    words = [w for w in re.split(r'[^A-Za-z0-9]+', re.sub(r'\s*\([^)]*\)\s*$', '', title))
             if w and w.lower() not in STOPWORDS]
    return ''.join(w[0] for w in words[:2]).upper()


def ctag(key):
    c = console_of(key)
    return f'<span class="ctag" style="--c:{c["color"]}" title="{esc(c["label"])}">{esc(c["short"])}</span>'


def os_icon(k):
    return f'<svg class="os-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="{OS[k]["path"]}"/></svg>'


def stage_pill(e):
    return f'<span class="stage" data-stage="{e["stage"]}">{esc(STAGES[e["stage"]]["label"])}</span>'


def backdrop_html(slug):
    """A game page's backdrop: the pictures in assets/backdrops/<slug>/, in name order, out of focus
    behind the page. game.js fades from one to the next, each drifting left and zooming in a little."""
    folder = os.path.join(ROOT, 'assets', 'backdrops', slug)
    if not os.path.isdir(folder):
        return ''
    names = sorted(n for n in os.listdir(folder) if n.lower().endswith(('.webp', '.jpg', '.jpeg', '.png')))
    if not names:
        return ''
    slides = ''.join(f'<div class="backdrop__slide{" is-on" if i == 0 else ""}" '
                     f'style="background-image:url(&quot;../../assets/backdrops/{quote(slug)}/{quote(n)}&quot;)"></div>'
                     for i, n in enumerate(names))
    return f'<div class="backdrop" aria-hidden="true">{slides}</div>\n'


def cover_html(e, alt):
    c = console_of(e['console'])
    if not e.get('cover'):
        return (f'<span class="cover cover--lg cover--none" style="--c:{c["color"]}" aria-hidden="true">'
                f'{esc(initials(e["title"]))}</span>')
    return (f'<figure class="d-cover" style="--c:{c["color"]}" data-initials="{esc(initials(e["title"]))}">'
            f'<img src="../../{esc(e["cover"])}" alt="{esc(alt)}" decoding="async"></figure>')


# ── Game page ────────────────────────────────────────────

PENCIL = ('<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16v4Zm10-14 4 4" '
          'fill="none" stroke="currentColor" stroke-width="2.2" stroke-linejoin="round"/></svg>')
BELL = ('<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path d="M6 16V11a6 6 0 0 1 12 0v5l2 2H4l2-2Zm4 4h4" '
        'fill="none" stroke="currentColor" stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round"/></svg>')


def mail_meta():
    return f'<meta name="rh-mail" content="{esc(MAIL_API)}">\n' if MAIL_API else ''


def newsletter_button(root):
    """The masthead's Newsletter button, to the sign-up box on the front page (index.html has its own)."""
    if not MAIL_API:
        return ''
    return (f'<a class="submit-btn feedback-btn mail-btn" href="{root}#newsletter" aria-label="Newsletter" '
            'title="Get the week\'s new and updated recomps by email every Sunday">\n'
            '        <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M3 6h18v12H3zM3 7l9 6 9-6" '
            'fill="none" stroke="currentColor" stroke-width="2.2" stroke-linejoin="round"/></svg>\n'
            '        <span>Newsletter</span>\n      </a>\n      ')


def follow_form(e):
    """Update alerts for one project: a button and the form it opens (game.js sends it)."""
    form_id = f'follow-{e["id"]}'
    return (f'<button class="btn btn--ghost" type="button" data-follow-toggle aria-expanded="false" aria-controls="{esc(form_id)}">'
            f'{BELL}Get update emails</button>'
            f'<form class="mail-form mail-form--follow" id="{esc(form_id)}" data-mail-form data-recomp="{esc(e["id"])}" hidden>'
            f'<p class="mail-form__lead">Email me as soon as {esc(e["project"])} puts out a new release.</p>'
            '<div class="mail-form__row"><input type="email" name="email" required autocomplete="email" placeholder="you@example.com" '
            'aria-label="Your email address"><button class="btn" type="submit">Follow</button></div>'
            '<label class="mail-form__check"><input type="checkbox" name="weekly"> Also send me the Sunday newsletter</label>'
            '<input class="mail-form__hp" type="text" name="website" tabindex="-1" autocomplete="off" aria-hidden="true">'
            '<p class="mail-form__status" role="status"></p></form>')


def trend_tag(e):
    """Whether people rate it better since its latest release (tools/track_ratings.py), as in app.js."""
    t = e.get('scoreTrend')
    if t is None:
        return ''
    since = esc(e.get('scoreTrendSince') or 'the latest release')
    kind = 'up' if t > 0 else 'down' if t < 0 else 'flat'
    sign = '▲ +' if t > 0 else '▼ −' if t < 0 else '= '
    return (f' <span class="trend trend--{kind}" title="Average score since {since} compared with before it">'
            f'{sign}{abs(t):.1f} since {since}</span>')


def card(e, game, rows):
    multi = len(game['entries']) > 1
    t = TIERS[e['quality']]
    edition = re.search(r'\(([^)]*)\)\s*$', e['title']) if multi else None
    sub = [x for x in (e.get('team') if e.get('team') != e['project'] else None,
                       edition.group(1) if edition and not edition.group(1).isdigit() else None) if x]
    ai = '<span class="ai" title="The project discloses substantial AI-generated code">AI</span>' if e.get('ai') else ''
    badge = f'<span class="gp-badge">{pick_label(game)}</span>' if multi and e is game['pick'] else ''
    muted = '<span class="muted">{}</span>'.format
    small = ' <span class="small muted">{}</span>'.format

    def fact(label, value):
        return f'<div class="gp-cell gp-fact"><span class="gp-k">{label}</span><div class="gp-v">{value}</div></div>'

    def text(label, value):
        return f'<div class="gp-cell gp-text"><span class="gp-k">{label}</span>{value}</div>'

    cells = [
        f'<div class="gp-cell gp-card__head">{badge}<h3 class="gp-card__title">{esc(e["project"])}</h3>'
        f'<p class="game__sub">{esc(" · ".join(sub))}{ai}</p></div>',
        f'<div class="gp-cell gp-verdict"><span class="tier" data-tier="{e["quality"]}">{e["quality"]}</span>'
        f'<div><strong>{esc(t["label"])}</strong><span>{esc(t["text"])}</span></div></div>',
    ]
    for row in rows:
        if row == 'console':
            cells.append(fact('Console', f'{ctag(e["console"])} {esc(console_of(e["console"])["label"])}'))
        elif row == 'stage':
            cells.append(fact('Stage', stage_pill(e)))
        elif row == 'os':
            if e.get('platforms'):
                note = PLATFORM_SOURCE.get(e.get('platformsFrom'))
                chips = ''.join(f'<span class="os-chip">{os_icon(k)}{OS[k]["label"]}</span>' for k in e['platforms'])
                title = f' title="{esc(note)}"' if note else ''
                cells.append(fact('Runs on', f'<span class="os-chips"{title}>{chips}</span>'))
            else:
                cells.append(fact('Runs on', muted('Not stated by the project')))
        elif row == 'features':
            feats = ''.join(f'<span class="feat">{esc(FEATURES.get(f, f))}</span>' for f in e.get('features') or [])
            cells.append(fact('Features', f'<div class="feats">{feats}</div>' if feats else muted('None listed')))
        elif row == 'release':
            if e.get('version') or e.get('versionDate'):
                when = small(esc(fmt_date(e['versionDate']))) if e.get('versionDate') else ''
                cells.append(fact('Latest release', f'<span class="mono">{esc(e.get("version") or "Release")}</span>{when}'))
            else:
                cells.append(fact('Latest release', muted('No release yet')))
        elif row == 'activity':
            a = activity(e)
            when = small(esc(fmt_date(e['updated']))) if e.get('updated') else ''
            cells.append(fact('Last activity', f'<span class="act act--{a}">{a.capitalize()}</span>{when}'))
        elif row == 'score':
            if e.get('userScore') is not None:
                n = e.get('userScoreCount') or 0
                cells.append(fact('User score', f'<span class="mono">{e["userScore"]:.1f}</span> / 10'
                                  + small(f'{n} {"rating" if n == 1 else "ratings"}') + trend_tag(e)))
            else:
                cells.append(fact('User score', f'<a href="#comments" data-rate="{esc(e["id"])}">Be the first to rate it</a>'
                                  if COMMENTS_ON else muted('No ratings yet')))
        elif row == 'stars':
            stars = e.get('stars')
            gain = small(f'+{e["starsWeek"]:,} this week') if e.get('starsWeek') else ''
            cells.append(fact('GitHub stars', f'<span class="mono">{stars:,}</span>{gain}' if stars is not None else muted('—')))
        elif row == 'toolchain':
            tool = 'Custom or unlisted' if e['toolchain'] == 'Custom' else e['toolchain']
            cells.append(fact('Toolchain', f'<span class="mono">{esc(tool)}</span>'))
        elif row == 'summary':
            cells.append(text('About this project', f'<p>{esc(e["summary"])}</p>' if e.get('summary') else ''))
        elif row == 'requires':
            cells.append(text('What you need', f'<p>{esc(e["requires"])}</p>' if e.get('requires')
                              else '<p class="muted">Not stated</p>'))

    link = e.get('repo') or e.get('website')
    correction = FEEDBACK_URL + '&' + urlencode({
        'title': f'[Feedback]: {e["title"]}', 'game': e['title'],
        'details': f'About {e["project"]}{f" ({link})" if link else ""}:\n\n'})
    links = []
    if e.get('repo'):
        links.append(f'<a class="btn" href="{esc(e["repo"])}" target="_blank" rel="noopener" data-visit="{esc(e["id"])}">Repository ↗</a>')
    if e.get('website'):
        links.append(f'<a class="btn btn--ghost" href="{esc(e["website"])}" target="_blank" rel="noopener" data-visit="{esc(e["id"])}">Website ↗</a>')
    links.append(f'<a class="btn btn--ghost" href="{esc(correction)}" target="_blank" rel="noopener" '
                 f'title="Something wrong or out of date? Opens the feedback form on GitHub with this game filled in">'
                 f'{PENCIL}Suggest a correction</a>')
    if MAIL_API:
        links.append(follow_form(e))
    cells.append(f'<div class="gp-cell gp-links">{"".join(links)}</div>')

    cls = 'gp-card is-pick' if badge else 'gp-card'
    return (f'<article class="{cls}" id="{esc(e["id"])}" style="--rows:{len(cells)}">\n        '
            + '\n        '.join(cells) + '\n      </article>')


def page(game, share_url, snapshot):
    es, pick, name, slug = game['entries'], game['pick'], game['name'], game['slug']
    multi = len(es) > 1
    consoles = [console_of(k) for k in game['consoles']]

    rows = ['console'] if len(game['consoles']) > 1 else []
    rows += ['stage', 'os', 'features', 'release', 'activity', 'score', 'stars', 'toolchain']
    rows += [r for r in ('summary', 'requires') if any(e.get(r) for e in es)]

    if multi:
        title = f'{name}: {len(es)} recomps compared'
        description = (f'{len(es)} projects bring {name} to PC. {pick_label(game)}: {pick["project"]} '
                       f'({pick["quality"]} tier, {STAGES[pick["stage"]]["label"].lower()}). '
                       'Compare their stage, quality, systems and features.')
        lede = f"{len(es)} projects bring {esc(name)} to PC. Here's how they compare, and which one to start with."
    else:
        e = pick
        title = f'{name} · {e["project"]}'
        by = f' by {e["team"]}' if e.get('team') and e['team'] != e['project'] else ''
        description = (f'{e["project"]}{by}: {STAGES[e["stage"]]["label"].lower()}, rated {e["quality"]} '
                       f'({TIERS[e["quality"]]["label"]}) on Recomp Haven. ' + (e.get('summary') or ''))
        lede = (f'{esc(e["project"])}{esc(by)}: {esc(STAGES[e["stage"]]["label"].lower())}, '
                f'rated {e["quality"]} ({esc(TIERS[e["quality"]]["label"])}).')
    if len(description) > 200:
        description = description[:197].rsplit(' ', 1)[0].rstrip(',.:;') + '…'

    meta_bits = [esc(' / '.join(c['label'] for c in consoles))]
    meta_bits += [str(game['year'])] if game['year'] else []
    meta_bits += [esc(pick['developer'])] if pick.get('developer') else []
    meta_bits += [esc(pick['genre'])] if pick.get('genre') else []
    crumbs = '<a href="../../">All recomps</a>'
    if len(game['consoles']) == 1:
        crumbs += f'<span aria-hidden="true">/</span><a href="../../?console={game["consoles"][0]}">{esc(consoles[0]["label"])}</a>'
    cover_entry = pick if pick.get('cover') else next((e for e in es if e.get('cover')), pick)

    pick_html = ''
    if multi:
        by = f' <span class="gp-by">by {esc(pick["team"])}</span>' if pick.get('team') and pick['team'] != pick['project'] else ''
        pick_html = f'''
  <section class="gp-pick" aria-labelledby="gp-pick-title">
    <span class="tier" data-tier="{pick['quality']}">{pick['quality']}</span>
    <div class="gp-pick__text">
      <span class="gp-label">{pick_label(game)}</span>
      <h2 id="gp-pick-title"><a href="#{esc(pick['id'])}">{esc(pick['project'])}</a>{by}</h2>
      <p>{esc(reason(game))}</p>
    </div>
    {f'<a class="btn" href="{esc(pick["repo"])}" target="_blank" rel="noopener" data-visit="{esc(pick["id"])}">Repository ↗</a>' if pick.get('repo') else
     f'<a class="btn" href="{esc(pick["website"])}" target="_blank" rel="noopener" data-visit="{esc(pick["id"])}">Website ↗</a>' if pick.get('website') else ''}
  </section>

  <h2 class="gp-h2">Every project, side by side</h2>'''

    cards = '\n      '.join(card(e, game, rows) for e in es)
    missing = SUBMIT_URL + '&' + urlencode({'game': name})
    body = f'''  <nav class="crumbs" aria-label="Breadcrumb">{crumbs}</nav>

  <section class="gp-hero">
    {cover_html(cover_entry, f'Box art for {name}')}
    <div class="gp-hero__text">
      <div class="d-head__meta">{''.join(ctag(k) for k in game['consoles'])}<span>{' · '.join(meta_bits)}</span></div>
      <h1 class="gp-title">{esc(name)}</h1>
      <p class="gp-lede">{lede}</p>
    </div>
  </section>
{pick_html}
  <div class="gp-compare{'' if multi else ' gp-compare--one'}">
      {cards}
  </div>

{playthrough_html(game)}{comments_html(game)}
  <p class="gp-missing">Know another project for {esc(name)}? <a href="{esc(missing)}" target="_blank" rel="noopener">Submit it</a>.</p>'''
    return document(title=title, description=description, path=f'games/{slug}/', share_url=share_url,
                    image_alt=f'{name} on Recomp Haven: {pick["project"]}, {pick["quality"]} tier',
                    body=body, snapshot=snapshot, visit=None if multi else pick['id'], backdrop=backdrop_html(slug))


def comments_html(game):
    """Ratings and comments: a giscus thread per project (term = the project's id) and a switcher
    when the game has several projects. Above the thread, a review form (a score, a review and
    Submit) when REVIEWS_ON, or else a 1 to 10 picker that copies "Score: N/10" for the comment
    box. game.js drives the switcher, the form or picker, and the theme."""
    if not COMMENTS_ON:
        return ''
    es, pick = game['entries'], game['pick']
    names = [e['project'] for e in es]

    def label(e):  # two projects with the same name get their team added
        team = e.get('team')
        return f'{e["project"]} ({team})' if names.count(e['project']) > 1 and team else e['project']
    tabs = ''
    if len(es) > 1:
        tabs = ('\n    <div class="gp-tabs" role="tablist" aria-label="Which project">'
                + ''.join(f'<button type="button" role="tab" aria-selected="{"true" if e is pick else "false"}" '
                          f'data-term="{esc(e["id"])}">{esc(label(e))}</button>' for e in es)
                + '</div>')
    scores = ''.join(f'<button type="button" data-score="{n}" aria-pressed="false">{n}</button>' for n in range(1, 11))
    it = 'a project' if len(es) > 1 else 'it'
    if REVIEWS_ON and MAIL_API:
        intro = (f'To rate {it}, pick a score out of 10, write a few words about how it plays and press Submit. '
                 'The first time, you’ll sign in with GitHub. Each person’s latest score counts towards the User '
                 'score, which updates once a day. To comment or reply without a score, use the box under the reviews.')
        rate = f'''
    <form class="gp-rate gp-review" data-review-form data-api="{esc(MAIL_API)}" data-term="{esc(pick['id'])}" data-min="{REVIEW_MIN}" novalidate>
      <p class="gp-review__title">Review <strong data-review-name>{esc(label(pick))}</strong></p>
      <span class="gp-k" id="rate-label">Your score</span>
      <div class="gp-rate__buttons" role="group" aria-labelledby="rate-label">{scores}</div>
      <label class="gp-k" for="review-text">Your review</label>
      <textarea id="review-text" name="review" rows="5" maxlength="5000" aria-describedby="review-count"
        placeholder="What works, what doesn’t, what you played it on…"></textarea>
      <div class="gp-review__foot">
        <span class="gp-review__count small muted" id="review-count">At least {REVIEW_MIN} characters</span>
        <button class="btn" type="submit" disabled>Submit review</button>
      </div>
      <p class="gp-review__who small muted" hidden>Signed in as <strong></strong> · <button type="button" class="gp-review__signout" data-review-signout>Sign out</button></p>
      <p class="mail-form__status gp-review__status" aria-live="polite"></p>
    </form>'''
    else:
        intro = (f'Sign in with GitHub to comment or reply. To rate {it}, start your comment with a score out of 10: '
                 "pick one below to copy it, then paste it into the comment box. Each person's latest score counts "
                 'towards the User score, which updates once a day.')
        rate = f'''
    <div class="gp-rate">
      <span class="gp-k" id="rate-label">Your score</span>
      <div class="gp-rate__buttons" role="group" aria-labelledby="rate-label">{scores}</div>
      <p class="gp-rate__status small muted" aria-live="polite"></p>
    </div>'''
    g = GISCUS
    return f'''
  <section class="gp-comments" id="comments" aria-labelledby="comments-title">
    <h2 class="gp-h2" id="comments-title">Ratings and comments</h2>
    <p class="gp-comments__intro">{intro}</p>{tabs}{rate}
    <div class="giscus"></div>
    <script src="https://giscus.app/client.js" data-repo="{g['repo']}" data-repo-id="{g['repo_id']}"
      data-category="{esc(g['category'])}" data-category-id="{g['category_id']}" data-mapping="specific"
      data-term="{esc(pick['id'])}" data-strict="1" data-reactions-enabled="1" data-emit-metadata="0"
      data-input-position="top" data-theme="preferred_color_scheme" data-lang="en" data-loading="lazy"
      crossorigin="anonymous" async></script>
  </section>
'''


def analytics_tag():
    """GoatCounter's counter, when GOATCOUNTER is set. It counts nothing on localhost."""
    if not GOATCOUNTER:
        return ''
    return (f'<script data-goatcounter="https://{GOATCOUNTER}.goatcounter.com/count" '
            'async src="https://gc.zgo.at/count.js"></script>\n')


def analytics_note():
    if not GOATCOUNTER:
        return ''
    return (f'  <p>Visits to each project are counted with <a href="https://www.goatcounter.com/">GoatCounter</a>, '
            'without cookies or personal data, to rank Trending.</p>\n')


def document(*, title, description, path, share_url, image_alt, body, snapshot, visit=None, backdrop=''):
    """A whole page in the site's header and footer. path is from the site root, like "games/pt/".
    visit: the id of a project to count a visit for when the page opens. backdrop: backdrop_html()."""
    root = '../' * path.count('/')
    url = f'{SITE}/{path}'
    body_attr = f' data-visit="{esc(visit)}"' if visit else ''
    return f'''<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>{esc(title)} · Recomp Haven</title>
<meta name="description" content="{esc(description)}">
<link rel="canonical" href="{url}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Recomp Haven">
<meta property="og:title" content="{esc(title)}">
<meta property="og:description" content="{esc(description)}">
<meta property="og:url" content="{url}">
<meta property="og:image" content="{esc(share_url)}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:alt" content="{esc(image_alt)}">
<meta name="twitter:card" content="summary_large_image">
<link rel="alternate" type="application/rss+xml" title="Recomp Haven: latest releases" href="{SITE}/feed.xml">
<link rel="icon" href="{root}favicon.ico" sizes="16x16 32x32 48x48">
<link rel="icon" type="image/png" sizes="32x32" href="{root}assets/icons/icon-32.png">
<link rel="icon" type="image/png" sizes="192x192" href="{root}assets/icons/icon-192.png">
<link rel="apple-touch-icon" href="{root}assets/icons/apple-touch-icon.png">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Archivo:wght@400;500;600;700&family=Big+Shoulders+Display:wght@700;800;900&family=JetBrains+Mono:wght@400;500;600&display=swap">
<link rel="stylesheet" href="{root}styles.css">
{mail_meta()}{analytics_tag()}</head>
<body{body_attr}>
{backdrop}<a class="skip" href="#main">Skip to the content</a>

<header class="masthead masthead--slim">
  <div class="wrap masthead__top">
    <a class="home-link" href="{root}"><img src="{root}assets/logo.png" alt="Re:Haven, back to every recomp" width="1615" height="338"></a>
    <div class="masthead__actions">
      {newsletter_button(root)}<a class="submit-btn feedback-btn" href="{FEEDBACK_URL}" target="_blank" rel="noopener" aria-label="Send feedback" title="Feedback on a game's summary or tier, or ideas to make the site better (opens a form on GitHub)">
        <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M5 4h14a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-8l-5 4v-4H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Z" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linejoin="round"/></svg>
        <span>Send feedback</span>
      </a>
      <a class="submit-btn" href="{SUBMIT_URL}" target="_blank" rel="noopener" aria-label="Submit a game" title="Suggest a missing recomp, decomp or port (opens a form on GitHub)">
        <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg>
        <span>Submit a game</span>
      </a>
      <button id="theme-toggle" class="icon-btn" type="button" aria-label="Switch to dark theme">
        <svg class="i-moon" viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path fill="currentColor" d="M20.4 14.6A8.5 8.5 0 0 1 9.4 3.6a.75.75 0 0 0-1-.9A10 10 0 1 0 21.3 15.6a.75.75 0 0 0-.9-1Z"/></svg>
        <svg class="i-sun" viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><circle cx="12" cy="12" r="4.5" fill="currentColor"/><path stroke="currentColor" stroke-width="2" stroke-linecap="round" d="M12 1.8v2.4M12 19.8v2.4M1.8 12h2.4M19.8 12h2.4M4.8 4.8l1.7 1.7M17.5 17.5l1.7 1.7M4.8 19.2l1.7-1.7M17.5 6.5l1.7-1.7"/></svg>
      </button>
    </div>
  </div>
</header>

<main id="main" class="wrap gp" tabindex="-1">
{body}
</main>

<footer class="wrap footer">
  <p>Every recomp on this list needs your own legally obtained copy of the game. Recomp Haven links to projects and hosts no game files.</p>
  <p>Data snapshot <time datetime="{snapshot}">{fmt_date(snapshot)}</time>. Repository stats from GitHub; tiers and stages are Recomp Haven's own. Box art belongs to each game's publisher. <a href="{root}">See every recomp</a> · <a href="{root}releases/">Latest releases</a> · <a href="{SITE}/feed.xml">RSS feed</a> · <a href="{FEEDBACK_URL}" target="_blank" rel="noopener">Send feedback</a> · <a href="{BUG_URL}" target="_blank" rel="noopener">Report a bug</a> · <a href="{REPO_URL}" target="_blank" rel="noopener">Source code</a> (MIT License; built with AI help).</p>
{analytics_note()}</footer>

<script src="{root}game.js"></script>
</body>
</html>
'''


# ── Featured playthrough ─────────────────────────────────

YOUTUBE_RE = re.compile(r'(?:youtu\.be/|youtube(?:-nocookie)?\.com/(?:watch\?(?:.*&)?v=|embed/|shorts/|live/))([\w-]{11})')
PLAY_ICON = ('<svg viewBox="0 0 68 48" width="68" height="48" aria-hidden="true"><path d="M66.5 7.7a8.5 8.5 0 0 0-6-6C55.2.3 34 .3 '
             '34 .3s-21.2 0-26.5 1.4a8.5 8.5 0 0 0-6 6C.1 13 .1 24 .1 24s0 11 1.4 16.3a8.5 8.5 0 0 0 6 6C12.8 47.7 34 47.7 34 47.7s21.2 '
             '0 26.5-1.4a8.5 8.5 0 0 0 6-6C67.9 35 67.9 24 67.9 24s0-11-1.4-16.3Z" fill="#e00"/><path d="M45 24 27 14v20z" fill="#fff"/></svg>')


def youtube_id(url):
    m = YOUTUBE_RE.search(url or '')
    return m.group(1) if m else None


def playthrough_html(game):
    """A "Featured playthrough" section under the project cards for each project that has one: a
    thumbnail that game.js turns into YouTube's no-cookie player only when pressed."""
    picks = [(e, youtube_id(e.get('playthrough'))) for e in game['entries']]
    picks = [(e, vid) for e, vid in picks if vid]
    if not picks:
        return ''
    multi = len(game['entries']) > 1
    figures = []
    for e, vid in picks:
        label = f' · {esc(e["project"])}' if multi else ''
        figures.append(
            f'<figure class="video">\n'
            f'      <button type="button" class="video__play" data-youtube="{vid}" '
            f'aria-label="Play the featured playthrough of {esc(e["project"])}">\n'
            f'        <img src="https://i.ytimg.com/vi/{vid}/hqdefault.jpg" alt="" loading="lazy">{PLAY_ICON}\n'
            f'      </button>\n'
            f'      <figcaption><a href="https://www.youtube.com/watch?v={vid}" target="_blank" rel="noopener">'
            f'Watch on YouTube ↗</a>{label}</figcaption>\n'
            f'    </figure>')
    return ('  <section class="gp-video" id="playthrough" aria-labelledby="playthrough-title">\n'
            '    <h2 id="playthrough-title">Featured playthrough</h2>\n    '
            + '\n    '.join(figures) + '\n  </section>\n')


# ── Release feed ─────────────────────────────────────────

RSS_ICON = ('<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><circle cx="5" cy="19" r="2.2" fill="currentColor"/>'
            '<path d="M4 11a9 9 0 0 1 9 9M4 4a16 16 0 0 1 16 16" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg>')


def releases(entries):
    """Each project's latest release, newest first (the data keeps only the latest)."""
    return sorted((e for e in entries if e.get('versionDate')),
                  key=lambda e: (e['versionDate'], e.get('stars') or 0), reverse=True)


def release_url(e):
    if 'github.com/' in (e.get('repo') or ''):
        return e['repo'].rstrip('/') + '/releases'
    return e.get('repo') or e.get('website')


def releases_page(entries, share_url, snapshot):
    items = releases(entries)
    month_ago = (TODAY - dt.timedelta(days=30)).isoformat()
    recent = sum(1 for e in items if e['versionDate'] >= month_ago)

    months = []
    for e in items:
        d = dt.date.fromisoformat(e['versionDate'])
        if not months or months[-1][0] != (d.year, d.month):
            months.append(((d.year, d.month), f'{d:%B} {d.year}', []))
        months[-1][2].append(e)

    sections = []
    for (year, month), label, es in months:
        rows = []
        for e in es:
            d = dt.date.fromisoformat(e['versionDate'])
            c = console_of(e['console'])
            if e.get('cover'):
                cover = (f'<span class="cover cover--sm" data-initials="{esc(initials(e["title"]))}" style="--c:{c["color"]}">'
                         f'<img src="../{esc(e["cover"])}" alt="" loading="lazy" decoding="async"></span>')
            else:
                cover = (f'<span class="cover cover--sm cover--none" style="--c:{c["color"]}" aria-hidden="true">'
                         f'{esc(initials(e["title"]))}</span>')
            notes = release_url(e)
            notes = (f'<a class="rl-notes" href="{esc(notes)}" target="_blank" rel="noopener" data-visit="{esc(e["id"])}">Release notes ↗</a>'
                     if notes else '<span></span>')
            rows.append(f'''      <li class="rl-row">
        <time class="rl-date" datetime="{e['versionDate']}">{d:%b} {d.day}</time>
        {cover}
        <div class="rl-main">
          <a class="rl-title" href="../games/{slug_of(e['title'])}/">{esc(e['project'])}</a>
          <span class="rl-version mono">{esc(e.get('version') or 'Release')}</span>
          <span class="game__sub">{esc(e['title'])} · {esc(c['label'])}</span>
        </div>
        <span class="rl-stage">{stage_pill(e)}</span>
        <span class="tier" data-tier="{e['quality']}" title="{esc(e['quality'] + ': ' + TIERS[e['quality']]['label'])}">{e['quality']}</span>
        {notes}
      </li>''')
        sections.append(f'''  <section class="rl-month" aria-labelledby="m-{year}-{month:02}">
    <h2 class="gp-h2" id="m-{year}-{month:02}">{label}</h2>
    <ol class="rl-list">
''' + '\n'.join(rows) + '''
    </ol>
  </section>''')

    body = f'''  <nav class="crumbs" aria-label="Breadcrumb"><a href="../">All recomps</a></nav>

  <header class="rl-head">
    <div class="gp-hero__text">
      <h1 class="gp-title">Latest releases</h1>
      <p class="gp-lede">The newest release of every project on Recomp Haven, newest first.
        {recent} {'project' if recent == 1 else 'projects'} released something in the last 30 days.</p>
    </div>
    <a class="btn btn--ghost" href="../feed.xml">{RSS_ICON} RSS feed</a>
  </header>

''' + '\n\n'.join(sections)
    return document(title='Latest releases', description=(
        'The newest releases of every game recompilation, decompilation and native port on Recomp Haven, '
        'newest first. Subscribe with RSS.'), path='releases/', share_url=share_url,
        image_alt='Recomp Haven: The Sanctuary for Native Game Ports.', body=body, snapshot=snapshot)


def feed(entries, limit=50):
    """RSS 2.0. Each item's guid is the project and version, so a reader shows each release once."""
    items = []
    for e in releases(entries)[:limit]:
        when = dt.datetime.fromisoformat(e['versionDate']).replace(tzinfo=dt.timezone.utc)
        c = console_of(e['console'])
        notes = release_url(e)
        about = (f'<p><strong>{esc(e["title"])}</strong> ({esc(c["label"])}): {e["quality"]} tier '
                 f'({esc(TIERS[e["quality"]]["label"])}), {esc(STAGES[e["stage"]]["label"].lower())}.</p>'
                 + (f'<p>{esc(e["summary"])}</p>' if e.get('summary') else '')
                 + (f'<p><a href="{esc(notes)}">Release notes</a></p>' if notes else ''))
        version = e.get('version') or ''
        items.append(f'''  <item>
    <title>{esc(f"{e['project']} {version}".strip())} · {esc(e['title'])}</title>
    <link>{SITE}/games/{slug_of(e['title'])}/</link>
    <guid isPermaLink="false">recomphaven:{esc(e['id'])}@{esc(version or e['versionDate'])}</guid>
    <pubDate>{format_datetime(when)}</pubDate>
    <description>{esc(about)}</description>
  </item>''')
    return f'''<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
<channel>
  <title>Recomp Haven: latest releases</title>
  <link>{SITE}/releases/</link>
  <atom:link href="{SITE}/feed.xml" rel="self" type="application/rss+xml"/>
  <description>New releases of game recompilations, decompilations and native ports, from Recomp Haven.</description>
  <language>en</language>
  <lastBuildDate>{format_datetime(dt.datetime.now(dt.timezone.utc))}</lastBuildDate>
''' + '\n'.join(items) + '''
</channel>
</rss>
'''


# ── Share cards ──────────────────────────────────────────

W, H, PAD = 1200, 630, 64
_fonts = {}


def font(name, size):
    key = (name, size)
    if key not in _fonts:
        _fonts[key] = ImageFont.truetype(os.path.join(FONTS, name + '.ttf'), size)
    return _fonts[key]


DISPLAY, BOLD, MEDIUM = 'BigShouldersDisplay-ExtraBold', 'Archivo-Bold', 'Archivo-Medium'


def canvas():
    im = Image.new('RGB', (W, H), INK['bg'])
    d = ImageDraw.Draw(im)
    for y in range(3, H, 4):  # the masthead's scanlines
        d.line([(0, y), (W, y)], fill=INK['scan'])
    return im, d


def wrap(text, f, width):
    lines, cur = [], ''
    for word in text.split():
        trial = f'{cur} {word}'.strip()
        if not cur or f.getlength(trial) <= width:
            cur = trial
        else:
            lines.append(cur)
            cur = word
    return lines + [cur]


def clip(text, f, width):
    if f.getlength(text) <= width:
        return text
    while text and f.getlength(text + '…') > width:
        text = text[:-1]
    return text.rstrip() + '…'


def spaced(d, xy, text, f, fill, tracking):
    x, y = xy
    for ch in text:
        d.text((x, y), ch, font=f, fill=fill, anchor='ls')
        x += f.getlength(ch) + tracking


def rounded(im, radius):
    mask = Image.new('L', im.size, 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, im.size[0] - 1, im.size[1] - 1], radius, fill=255)
    return mask


def paste_cover(base, e, box):
    """Box art fitted inside box (x0, y0, x1, y1) with a soft shadow; initials when there's none."""
    x0, y0, x1, y1 = box
    bw, bh = x1 - x0, y1 - y0
    path = os.path.join(ROOT, e['cover']) if e.get('cover') else None
    if path and os.path.exists(path):
        art = Image.open(path).convert('RGB')
        scale = min(bw / art.width, bh / art.height)
        art = art.resize((max(1, round(art.width * scale)), max(1, round(art.height * scale))), Image.LANCZOS)
        x, y = x0 + (bw - art.width) // 2, y0 + (bh - art.height) // 2
        shadow = Image.new('L', (art.width + 60, art.height + 60), 0)
        ImageDraw.Draw(shadow).rounded_rectangle([30, 36, art.width + 30, art.height + 36], 12, fill=150)
        shadow = shadow.filter(ImageFilter.GaussianBlur(14))
        base.paste((0, 0, 0), (x - 30, y - 30), shadow)
        base.paste(art, (x, y), rounded(art, 10))
        return
    side = min(bw, bh, 420)
    x, y = x0 + (bw - side) // 2, y0 + (bh - side) // 2
    tile = Image.new('RGB', (side, side), console_of(e['console'])['color'])
    td = ImageDraw.Draw(tile)
    td.text((side / 2, side / 2), initials(e['title']), font=font(DISPLAY, side // 3), fill='#ffffff', anchor='mm')
    base.paste(tile, (x, y), rounded(tile, 14))


def tier_tile(d, xy, size, tier):
    x, y = xy
    d.rounded_rectangle([x, y, x + size, y + size], 12, fill=TIER_COLORS[tier])
    f = font(DISPLAY, round(size * 0.78))
    l, t, r, b = f.getbbox(tier, anchor='ls')
    d.text((x + (size - (r - l)) / 2 - l, y + (size - (b - t)) / 2 - t), tier, font=f, fill=INK['tier-ink'], anchor='ls')


def logo(height):
    im = Image.open(os.path.join(ROOT, 'assets', 'logo.png')).convert('RGBA')
    return im.resize((round(im.width * height / im.height), height), Image.LANCZOS)


def game_card(game, out):
    pick, es = game['pick'], game['entries']
    multi = len(es) > 1
    im, d = canvas()
    paste_cover(im, pick if pick.get('cover') else next((e for e in es if e.get('cover')), pick), (PAD, PAD, 464, H - PAD))

    x, right = 520, W - PAD
    width = right - x
    mark = logo(46)
    im.paste(mark, (x - round(mark.width * 42 / 1615), PAD), mark)
    d.text((right, PAD + 34), 'recomphaven.com', font=font(BOLD, 24), fill=INK['accent'], anchor='rs')

    # Title: as big as fits in three lines above the meta line, but on fewer lines
    # when that costs little size ("P.T. (Silent Hills)" stays on one line).
    top, limit = 150, 384
    best = {}
    for n in (1, 2, 3):
        for size in range(108, 46, -4):
            f = font(DISPLAY, size)
            lines = wrap(game['name'], f, width)
            if len(lines) <= n and all(f.getlength(ln) <= width for ln in lines) and n * size * 0.98 <= limit - top:
                best[n] = size
                break
    biggest = max(best.values(), default=48)
    size = next((best[n] for n in (1, 2, 3) if best.get(n, 0) >= biggest * 0.82), 48)
    f = font(DISPLAY, size)
    lines = wrap(game['name'], f, width)
    lh = round(size * 0.98)
    y = top + size * 0.8
    for ln in lines[:3]:
        d.text((x, y), clip(ln, f, width), font=f, fill=INK['fg'], anchor='ls')
        y += lh
    meta = ' · '.join([' / '.join(console_of(k)['label'] for k in game['consoles'])]
                      + ([str(game['year'])] if game['year'] else []) + ([pick['genre']] if pick.get('genre') else []))
    d.text((x, y - lh + size * 0.2 + 40), clip(meta, font(MEDIUM, 26), width), font=font(MEDIUM, 26), fill=INK['muted'], anchor='ls')

    # The verdict: tier tile, then what it is.
    tile = 120
    ty = H - PAD - tile
    tier_tile(d, (x, ty), tile, pick['quality'])
    tx = x + tile + 26
    label = pick_label(game) if multi else STAGES[pick['stage']]['label']
    color = INK['accent'] if multi else STAGE_COLORS[pick['stage']]
    spaced(d, (tx, ty + 30), label.upper(), font(BOLD, 21), color, 2.2)
    d.text((tx, ty + 76), clip(pick['project'], font(BOLD, 40), right - tx), font=font(BOLD, 40), fill=INK['fg'], anchor='ls')
    # Tier and stage, then the project count, shortened until it fits.
    tier = TIERS[pick['quality']]['label']
    if multi:
        stage = STAGES[pick['stage']]['label'].replace('Playable beta', 'Beta')
        options = [f'{tier} · {stage} · {len(es)} projects compared', f'{tier} · {stage} · {len(es)} projects', f'{tier} · {stage}']
    else:
        by = f'by {pick["team"]}' if pick.get('team') and pick['team'] != pick['project'] else ''
        options = [f'{tier} · {by}', tier] if by else [tier]
    f = font(MEDIUM, 25)
    detail = next((o for o in options if f.getlength(o) <= right - tx), options[-1])
    d.text((tx, ty + 114), clip(detail, f, right - tx), font=f, fill=INK['muted'], anchor='ls')

    im.save(out, 'JPEG', quality=86, optimize=True, progressive=True)


def home_card(entries, games, out):
    im, d = canvas()
    mark = logo(104)
    im.paste(mark, (PAD - round(mark.width * 42 / 1615), 92), mark)
    f = font(MEDIUM, 32)
    y = 92 + 104 + 62
    for ln in wrap('The Sanctuary for Native Game Ports.', f, 330):  # breaks after "for"
        d.text((PAD, y), ln, font=f, fill=INK['fg'], anchor='ls')
        y += 42

    # The four stage counts, two by two.
    for i, st in enumerate(STAGE_ORDER):
        x, y = PAD + (i % 2) * 290, 452 + (i // 2) * 100
        n = str(sum(1 for e in entries if e['stage'] == st))
        d.text((x, y), n, font=font(DISPLAY, 76), fill=INK['fg'], anchor='ls')
        lx = x + font(DISPLAY, 76).getlength(n) + 16
        d.ellipse([lx, y - 22, lx + 12, y - 10], fill=STAGE_COLORS[st])
        d.text((lx + 20, y - 8), STAGES[st]['label'], font=font(BOLD, 23), fill=INK['muted'], anchor='ls')

    # Box art from the best-loved top-tier games.
    top = sorted((g['pick'] for g in games if g['pick'].get('cover') and g['pick']['quality'] in ('S', 'A')),
                 key=lambda e: -(e.get('stars') or 0))[:6]
    cw, ch, gap = 150, 200, 16
    gx, gy = W - PAD - 3 * cw - 2 * gap, 92
    for i, e in enumerate(top):
        cx, cy = gx + (i % 3) * (cw + gap), gy + (i // 3) * (ch + gap)
        cell = Image.new('RGB', (cw, ch), INK['surface'])
        art = Image.open(os.path.join(ROOT, e['cover'])).convert('RGB')
        s = min((cw - 12) / art.width, (ch - 12) / art.height)
        art = art.resize((round(art.width * s), round(art.height * s)), Image.LANCZOS)
        cell.paste(art, ((cw - art.width) // 2, (ch - art.height) // 2))
        im.paste(cell, (cx, cy), rounded(cell, 10))
    d.text((W - PAD, H - PAD + 6), 'recomphaven.com', font=font(BOLD, 26), fill=INK['accent'], anchor='rs')
    im.save(out, 'JPEG', quality=86, optimize=True, progressive=True)


def versioned(path, rel):
    """Absolute URL with a content hash, so link previews refresh when the card changes."""
    with open(path, 'rb') as f:
        return f'{SITE}/{rel}?v={hashlib.sha1(f.read()).hexdigest()[:10]}'


# ── Main ─────────────────────────────────────────────────

def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    ap.add_argument('--out', default=os.path.join(ROOT, '_site'), help='output folder (default: _site)')
    args = ap.parse_args()
    out = os.path.abspath(args.out)
    if out == ROOT or ROOT.startswith(out + os.sep):
        sys.exit(f'refusing to build into {out}: it would delete the repo')

    _, _, meta, entries = load(DATA)
    # Pages and cards name every project; fall back to the repo's name, then the game's.
    entries = [dict(e, project=e.get('project') or (e.get('repo') or '').rstrip('/').rsplit('/', 1)[-1] or e['title'])
               for e in entries]
    games = group(entries)
    snapshot = meta.get('snapshot') or TODAY.isoformat()

    if os.path.exists(out):
        shutil.rmtree(out)
    os.makedirs(out)
    for name in STATIC:
        src = os.path.join(ROOT, name)
        (shutil.copytree if os.path.isdir(src) else shutil.copy2)(src, os.path.join(out, name))

    share_dir = os.path.join(out, 'assets', 'share')
    os.makedirs(share_dir)
    home = os.path.join(share_dir, 'home.jpg')
    home_card(entries, games, home)
    home_url = versioned(home, 'assets/share/home.jpg')
    with open(os.path.join(out, 'index.html'), encoding='utf-8') as f:
        index = f.read()
    with open(os.path.join(out, 'index.html'), 'w', encoding='utf-8', newline='\n') as f:
        f.write(index.replace(f'{SITE}/assets/share/home.jpg', home_url)
                .replace('</head>', analytics_tag()
                         + ('<meta name="rh-comments" content="on">\n' if COMMENTS_ON else '') + mail_meta() + '</head>', 1)
                .replace('</footer>', analytics_note() + '</footer>', 1))

    os.makedirs(os.path.join(out, 'releases'))
    with open(os.path.join(out, 'releases', 'index.html'), 'w', encoding='utf-8', newline='\n') as f:
        f.write(releases_page(entries, home_url, snapshot))
    with open(os.path.join(out, 'feed.xml'), 'w', encoding='utf-8', newline='\n') as f:
        f.write(feed(entries))

    for game in games:
        img = os.path.join(share_dir, game['slug'] + '.jpg')
        game_card(game, img)
        folder = os.path.join(out, 'games', game['slug'])
        os.makedirs(folder)
        with open(os.path.join(folder, 'index.html'), 'w', encoding='utf-8', newline='\n') as f:
            f.write(page(game, versioned(img, f'assets/share/{game["slug"]}.jpg'), snapshot))

    latest = releases(entries)
    urls = [(f'{SITE}/', snapshot), (f'{SITE}/releases/', latest[0]['versionDate'] if latest else snapshot)]
    urls += [(f'{SITE}/games/{g["slug"]}/', g['updated'] or snapshot) for g in games]
    with open(os.path.join(out, 'sitemap.xml'), 'w', encoding='utf-8', newline='\n') as f:
        f.write('<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n')
        f.writelines(f'  <url><loc>{u}</loc><lastmod>{d}</lastmod></url>\n' for u, d in urls)
        f.write('</urlset>\n')
    with open(os.path.join(out, 'robots.txt'), 'w', encoding='utf-8', newline='\n') as f:
        f.write(f'User-agent: *\nAllow: /\n\nSitemap: {SITE}/sitemap.xml\n')

    multi = sum(1 for g in games if len(g['entries']) > 1)
    print(f'{len(entries)} recomps, {len(games)} game pages ({multi} comparing several projects) -> {out}')


if __name__ == '__main__':
    main()
