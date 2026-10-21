#!/usr/bin/env python3
"""Work out which systems each recomp says it's coming to next (Planned for, beside Runs on).

Reads each project's README and the notes of its newest release, and looks for a system named
near words of a plan: "Linux is next", "macOS and Switch are planned", "a Steam Deck build is
coming soon", "Android on the roadmap". Turned-down plans ("no plans for macOS", "won't support
Linux") don't count, nor do systems it already runs on. For every entry with a github.com repo
this sets:

    "planned"   a list of "windows", "linux", "macos", "android", "switch" (left out when none)

An entry with "plannedFrom": "manual" is never touched. A repository is only read again after it
was pushed to or put out a release (data/planned-checks.json remembers when it was last read).
No GitHub API calls. Standard library only.

    python tools/detect_planned.py --dry-run --verbose
    python tools/detect_planned.py --all            # read every repository again
    python tools/detect_planned.py --only some-id
"""

import argparse
import html
import json
import os
import re
import sys
import urllib.error
from concurrent.futures import ThreadPoolExecutor

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from refresh_stats import DATA, ROOT, dump, load  # noqa: E402
from fetch_covers import http  # noqa: E402
from detect_platforms import OSES, REPO_RE  # noqa: E402

STATE = os.path.join(ROOT, 'data', 'planned-checks.json')
SYSTEM = {
    'windows': re.compile(r'\bwindows\b', re.I),
    'linux': re.compile(r'\blinux\b|steam ?deck|steamos', re.I),
    'macos': re.compile(r'\bmac ?os\b|\bmacos\b|apple silicon|\bmac\b(?!\s*address)|\bos ?x\b', re.I),
    'android': re.compile(r'\bandroid\b(?!\s*\d)', re.I),  # not the Dragon Ball androids
    'switch': re.compile(r'\b(?:Nintendo )?Switch\b'),  # the console's name is capitalised; the verb isn't
}
PLAN = re.compile(
    r"\bplanned\b|\bplans? (?:for|to)\b|\bcoming soon\b|\bcoming (?:later|next)\b|\bsoon to\b|\bis next\b|"
    r"\bare next\b|\bcomes? next\b|\bnext up\b|\bin the future\b|\beventually\b|\broadmap\b|\bupcoming\b|"
    r"\bon the way\b|\bwill (?:be )?(?:added|supported|come|follow|arrive)\b|\bwork in progress\b|\bin progress\b|"
    r"\bwip\b|\bin development\b|\bcoming later\b|\blater this year\b", re.I)
REFUSAL = re.compile(r"\bno plans?\b|\bnot planned\b|\bwon['’]t\b|\bwill not\b|\bnever\b|\bnot going to\b|\bunlikely\b|"
                     r"\bno intention\b|\bout of scope\b|\bdropped\b|\bcancell?ed\b|\bnot (?:currently )?on the roadmap\b|"
                     r"\bnot coming\b|\bmaybe\b|\bmight\b|\bpossibly\b|\bpotentially\b|\bhopefully\b|\bperhaps\b|"
                     r"\b(?:does|do)(?: not|n['’]t) plan\b", re.I)
NEAR = 120  # how close a plan has to be to a system's name, unless the sentence opens with it
REFUSAL_NEAR = 60
LEADING_PLAN = re.compile(r'^\W*(?:planned|coming soon|coming next|roadmap|next|upcoming|future|in progress)\b', re.I)
FILE_NAME = re.compile(r'[\w./-]*roadmap[\w./-]*\.(?:md|txt)', re.I)  # ROADMAP.md is a file, not a plan
LIST_ITEM = re.compile(r'^\s*(?:[-*+]|\d+[.)]|#+|\|)\s?')


def text_of(raw):
    """Sentences from Markdown or HTML. Lines wrapped inside a paragraph are joined again; each
    list item and heading stands on its own."""
    raw = html.unescape(re.sub(r'<(?:br|/?p|/?li|/?h\d|/?ul|/?ol|/?div)[^>]*>', '\n\n', raw))
    raw = re.sub(r'<[^>]+>', '', raw)
    raw = re.sub(r'!\[[^\]]*\]\([^)]*\)|\[([^\]]*)\]\([^)]*\)', r'\1', raw)
    blocks, current = [], []
    for line in raw.splitlines():
        if not line.strip() or LIST_ITEM.match(line):
            if current:
                blocks.append(' '.join(current))
            current = [line.strip()] if line.strip() else []
        else:
            current.append(line.strip())
    if current:
        blocks.append(' '.join(current))
    return [s.strip() for b in blocks for s in re.split(r'(?<=[.!?])\s+', b) if s.strip()]


def sources(repo):
    """(README sentences, newest release notes sentences), or None when GitHub can't be reached."""
    readme = None
    for name in ('README.md', 'readme.md', 'README.txt', 'README'):
        raw = http(f'https://raw.githubusercontent.com/{repo}/HEAD/{name}')
        if raw:
            readme = raw.decode('utf-8', 'replace')
            break
    atom = http(f'https://github.com/{repo}/releases.atom')
    notes = ''
    if atom:
        m = re.search(r'<entry>.*?<content type="html">(.*?)</content>', atom.decode('utf-8', 'replace'), re.S)
        notes = html.unescape(m[1]) if m else ''
    if readme is None and atom is None:
        return None
    return text_of(readme or ''), text_of(notes)


def planned_in(sentences, console):
    """Systems named close to words of a plan (or anywhere in a sentence that opens with one),
    unless the plan is turned down or hedged right beside them."""
    found, evidence = set(), {}
    for s in sentences:
        plain = FILE_NAME.sub('', s)
        if len(plain) > 400 or not PLAN.search(plain):
            continue
        whole = bool(LEADING_PLAN.match(plain))
        for os_name, rx in SYSTEM.items():
            if os_name == 'switch' and console == 'switch':
                continue  # a Switch game's port names the Switch everywhere
            for m in rx.finditer(plain):
                near = plain[max(0, m.start() - NEAR):m.end() + NEAR]
                close = plain[max(0, m.start() - REFUSAL_NEAR):m.end() + REFUSAL_NEAR]
                if (whole or PLAN.search(near)) and not REFUSAL.search(close):
                    found.add(os_name)
                    evidence.setdefault(os_name, s[:160])
    return found, evidence


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    ap.add_argument('--dry-run', action='store_true', help='print what was found, write nothing')
    ap.add_argument('--all', action='store_true', help='read every repository again')
    ap.add_argument('--only', action='append', metavar='ID', help='only these entries (repeatable)')
    ap.add_argument('--verbose', action='store_true', help='print the sentences each plan came from')
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
        if not m or e.get('plannedFrom') == 'manual' or (args.only and e['id'] not in args.only):
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
            found, evidence = planned_in(readme + notes, e['console'])
            new = [o for o in OSES if o in found and o not in (e.get('platforms') or [])]
            checked[e['id']] = mark
            if new != (e.get('planned') or []):
                changed += 1
                print(f'  {e["id"]:<40} planned: {", ".join(new) or "none"}')
                if args.verbose:
                    for o in new:
                        print(f'       {o}: {evidence[o]}')
                if new:
                    e['planned'] = new
                else:
                    e.pop('planned', None)

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
