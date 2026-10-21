#!/usr/bin/env python3
"""Work out which languages each recomp's game can be played in (Languages, in the details).

Reads each project's README and the notes of its newest release, plus the entry's own "requires"
and "summary", and looks for two kinds of evidence:

- languages named as languages: "English and Japanese text", "a French translation", "subtitles
  in German", "Languages: English, Spanish", No-Intro tags such as "(En,Fr,De)";
- the game versions it plays: "the USA ROM", "NTSC-U", "Majora's Mask (USA)" mean English, "the
  Japanese release", "NTSC-J", "(Japan)" mean Japanese. A PAL or European version alone says
  nothing, since those came in many languages.

Languages turned down or not done yet beside the name ("Japanese isn't supported", "French
translation planned") don't count, nor are README translations or the language the docs are
written in. For every entry with a github.com repo this sets:

    "languages"  e.g. ["English", "Japanese"] (left out when the project doesn't say)

An entry with "languagesFrom": "manual" is never touched. A repository is only read again after
it was pushed to or put out a release (data/language-checks.json remembers when it was last
read). No GitHub API calls. Standard library only.

    python tools/detect_languages.py --dry-run --verbose
    python tools/detect_languages.py --all            # read every repository again
    python tools/detect_languages.py --only some-id
"""

import argparse
import json
import os
import re
import sys
import urllib.error
from concurrent.futures import ThreadPoolExecutor

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from refresh_stats import DATA, ROOT, dump, load  # noqa: E402
from detect_planned import sources, text_of  # noqa: E402
from detect_platforms import REPO_RE  # noqa: E402

STATE = os.path.join(ROOT, 'data', 'language-checks.json')

# The order they're listed in. Names are matched with their capital letter ("Polish", not "polish").
LANGS = {
    'English': r'English',
    'Japanese': r'Japanese|日本語',
    'French': r'French|Français',
    'German': r'German|Deutsch',
    'Spanish': r'Spanish|Español|Castilian',
    'Italian': r'Italian|Italiano',
    'Portuguese': r'Portuguese|Português|pt-BR',
    'Dutch': r'Dutch',
    'Swedish': r'Swedish',
    'Danish': r'Danish',
    'Norwegian': r'Norwegian',
    'Finnish': r'Finnish',
    'Polish': r'Polish',
    'Czech': r'Czech',
    'Slovak': r'Slovak',
    'Hungarian': r'Hungarian',
    'Romanian': r'Romanian',
    'Croatian': r'Croatian',
    'Bulgarian': r'Bulgarian',
    'Greek': r'Greek',
    'Turkish': r'Turkish',
    'Russian': r'Russian|Русский',
    'Ukrainian': r'Ukrainian',
    'Hebrew': r'Hebrew',
    'Arabic': r'Arabic',
    'Hindi': r'Hindi',
    'Thai': r'Thai',
    'Vietnamese': r'Vietnamese',
    'Indonesian': r'Indonesian',
    'Chinese': r'Chinese|中文|简体|繁體|繁体|Mandarin|Cantonese',
    'Korean': r'Korean|한국어',
}
LANG_RE = {k: re.compile(rf'(?<![\w-])(?:{v})(?![\w-])') for k, v in LANGS.items()}
# No-Intro language tags: "(En,Fr,De,Es,It)".
TAG_CODES = {'En': 'English', 'Ja': 'Japanese', 'Fr': 'French', 'De': 'German', 'Es': 'Spanish', 'It': 'Italian',
             'Pt': 'Portuguese', 'Nl': 'Dutch', 'Sv': 'Swedish', 'Da': 'Danish', 'No': 'Norwegian', 'Fi': 'Finnish',
             'Pl': 'Polish', 'Ru': 'Russian', 'Zh': 'Chinese', 'Ko': 'Korean'}
TAGS = re.compile(r'\(((?:%s)(?:,(?:%s))+)\)' % ('|'.join(TAG_CODES), '|'.join(TAG_CODES)))

# A language named in one of these senses is one the game can be played in.
LANG_CONTEXT = re.compile(
    r'\blanguages?\b|\btranslat\w*|\blocali[sz]\w*|\bsubtitle\w*|\btext\b|\bvoices?\b|\bvoice[- ]?(?:over|acting)\b|'
    r'\bdub\w*|\bfonts?\b|\blocales?\b|\bmulti-?lingual\b|\bmulti-?language\b|\bi18n\b|\bdialogue\b|'
    r'\bversions?\b|\breleases?\b|\bROMs?\b|\bISOs?\b|\bdiscs?\b|\bregions?\b|\bedition\b|\bdumps?\b|\bcopy\b|'
    r'\bsupport\w*', re.I)
# ...unless the sentence is about the docs, the community or the people.
NOT_THE_GAME = re.compile(
    r'\breadme\b|\bread this\b|\bin other languages\b|\.md\b|\bdocumentation\b|\bdocs?\b|\bwiki\b|\bguides?\b|'
    r'\bdiscord\b|\bthis (?:document|page|file)\b|\bwritten in\b|\bspeak\w*\b|\bcommunity\b|\bcontributors?\b|'
    r'\bcommits?\b|\bissues?\b|\bforum\b|\bdeveloper\b|\bdeveloped\b|\bstudio\b|\bcompany\b|\bpublishers?\b|'
    r'\bcomposer\b|\bvoiced by\b|\bShepherd\b|\bkeyboard layout\b|\bachievement\w*', re.I)
# A launcher's or tool's own languages aren't the game's, unless the sentence is about the game's.
TOOL = re.compile(r'\blauncher\b|\binterface\b|\bworkshop\b|\bwebsite\b|\binstaller\b|\bsetup\b', re.I)
GAME = re.compile(r"\bgame['’]?s?\b|\bsubtitles?\b|\btext\b|\bvoices?\b|\bdialogue\b|\bdiscs?\b|\bin-game\b|\boptions\b", re.I)
# Near a name: not supported, or not done yet. Within the same clause, a little way before the
# name or further after it ("European and Japanese ROMs will not work").
TURNED_DOWN = re.compile(
    r"\bnot\b|n['’]t\b|\bunsupported\b|\bno\b|\bwithout\b|\bplanned\b|\bwip\b|\btodo\b|\bcoming\b|"
    r"\bfuture\b|\bmissing\b|\bbroken\b|\buntested\b|\bincomplete\b|\bpartial\w*\b|\blater\b|\bdraft\b|"
    r"\bwork in progress\b|\bin progress\b|\bhelp wanted\b|\bwanted\b|\bexcept\b|\bother than\b|\binstead of\b|"
    r"\brefus\w*|\breject\w*|\bturned away\b|\blike the\b|\bwill be\b|\bgoal\b|\bresearch\b", re.I)
BEFORE, AFTER = 45, 90
CLAUSE = re.compile(r';|:\s| but | however|, while |, whereas | — | – ')
ANY_NAME = re.compile('|'.join(f'(?:{v})' for v in LANGS.values()) + r'|\bPAL\b|\bEurope(?:an)?\b|\bUSA?\b|\bJP\b')

# Game versions that settle the language. "US" and "JP" only with a capital, and only next to
# words about the version or in a No-Intro / GoodTools name.
VERSION_WORD = r'(?:versions?|releases?|ROMs?|ISOs?|discs?|copy|copies|dumps?|regions?|editions?|builds? of the game)'
REGIONS = {
    'English': r'USA|US|U\.S\.|NTSC-U(?:/C)?|North American?|American|UK',
    'Japanese': r'Japan(?:ese)?|JP|JPN|NTSC-J',
    'Korean': r'Korea(?:n)?',
}
REGION_RE = {
    k: re.compile(rf'(?<![\w-])(?:{v})(?:/\w+)?(?![\w-])(?:\s+\w+){{0,2}}?\s+{VERSION_WORD}\b|'
                  rf'\b{VERSION_WORD}\s*(?:\((?:{v})\)|:\s*(?:{v})\b)|'
                  rf'\((?:{v})(?:,\s*(?:{v}|Europe|World))*\)')
    for k, v in REGIONS.items()
}
GOOD_TAGS = {'English': re.compile(r'\((?:U|UE|JU|JUE)\)'), 'Japanese': re.compile(r'\((?:J|JU|JUE)\)')}


def turned_down(text, m):
    """Whether a "not" or "planned" near this match, in its own clause, is about it. A "not" that
    goes on to name another language or region ("the US version, not the Japanese one") is about
    that one."""
    if text.lstrip().startswith('|'):
        lo, hi = 0, len(text)  # a table row: the whole row
    else:
        cuts = [c.end() for c in CLAUSE.finditer(text, 0, m.start())]
        nxt = CLAUSE.search(text, m.end())
        lo = max([m.start() - BEFORE] + cuts)
        hi = min(m.end() + AFTER, nxt.start() if nxt else len(text))
    for n in TURNED_DOWN.finditer(text, max(0, lo), max(lo, hi)):
        after = ANY_NAME.search(text, n.end(), n.end() + 25)
        if n.start() > m.end() and after and after.start() > m.end():
            continue
        return True
    return False


def found_in(sentences, title=''):
    """{language: the sentence it came from}."""
    found = {}
    for s in sentences:
        if len(s) > 600:
            continue
        plain = s.replace(title, '') if title else s  # "Japanese" in a game's own name says nothing
        if NOT_THE_GAME.search(plain):
            continue
        for m in TAGS.finditer(plain):
            for code in m[1].split(','):
                found.setdefault(TAG_CODES[code], s)
        for lang, rx in GOOD_TAGS.items():
            if rx.search(plain):
                found.setdefault(lang, s)
        for lang, rx in REGION_RE.items():
            for m in rx.finditer(plain):
                if not turned_down(plain, m):
                    found.setdefault(lang, s)
        if not LANG_CONTEXT.search(plain) or (TOOL.search(plain) and not GAME.search(plain)):
            continue
        for lang, rx in LANG_RE.items():
            for m in rx.finditer(plain):
                if not turned_down(plain, m):
                    found.setdefault(lang, s)
    return found


def ordered(langs):
    return [k for k in LANGS if k in langs]


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    ap.add_argument('--dry-run', action='store_true', help='print what was found, write nothing')
    ap.add_argument('--all', action='store_true', help='read every repository again')
    ap.add_argument('--only', action='append', metavar='ID', help='only these entries (repeatable)')
    ap.add_argument('--verbose', action='store_true', help='print the sentence each language came from')
    args = ap.parse_args()
    sys.stdout.reconfigure(errors='replace')

    _, head, meta, entries = load(DATA)
    try:
        checked = json.load(open(STATE, encoding='utf-8'))
    except FileNotFoundError:
        checked = {}
    todo = []
    for e in entries:
        m = REPO_RE.match(e.get('repo') or '')
        if not m or e.get('languagesFrom') == 'manual' or (args.only and e['id'] not in args.only):
            continue
        mark = f'{e.get("updated")}|{e.get("version")}'
        if args.all or args.only or checked.get(e['id']) != mark:
            todo.append((e, m[1], mark))

    def work(item):
        e, repo, mark = item
        try:
            return item, sources(repo)
        except (urllib.error.URLError, OSError):
            return item, None

    changed = 0
    with ThreadPoolExecutor(6) as pool:
        for (e, repo, mark), got in pool.map(work, todo):
            if got is None:
                print(f'  !  {e["id"]:<40} could not be read')
                continue
            readme, notes = got
            own = text_of(f'{e.get("requires") or ""}\n\n{e.get("summary") or ""}')
            evidence = found_in(readme + notes + own, e['title'])
            new = ordered(evidence)
            checked[e['id']] = mark
            if new != (e.get('languages') or []):
                changed += 1
                print(f'  {e["id"]:<40} languages: {", ".join(new) or "none"}')
                if args.verbose:
                    for lang in new:
                        print(f'       {lang}: {evidence[lang][:200]}')
                if new:
                    e['languages'] = new
                else:
                    e.pop('languages', None)

    print(f'\nRead {len(todo)} repositories; {"would update" if args.dry_run else "updated"} {changed} entries.')
    if args.dry_run:
        return
    with open(DATA, 'w', encoding='utf-8', newline='\n') as f:
        f.write(dump(head, meta, entries))
    lines = [f'  {json.dumps(k)}: {json.dumps(v)}' for k, v in sorted(checked.items())]
    with open(STATE, 'w', encoding='utf-8', newline='\n') as f:
        f.write('{\n' + ',\n'.join(lines) + '\n}\n')


if __name__ == '__main__':
    main()
