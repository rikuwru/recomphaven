#!/usr/bin/env python3
"""Refresh the GitHub numbers in data/recomps.js.

For every entry whose repo is on github.com this updates `stars`, `updated`
(last push) and `version` / `versionDate` (the newest published release whose
tag has a digit in it; pre-releases count), then sets
RECOMPHAVEN_META.snapshot to today. Entries without such a release keep their
version values.

Genre, stage and quality are editorial calls and are never changed. When
GitHub hints that a stage is out of date, the entry is listed under
"Suggested review" instead.

Standard library only. Set GITHUB_TOKEN to lift the API limit from 60 to
5,000 requests an hour.

    python tools/refresh_stats.py --dry-run --limit 10
    python tools/refresh_stats.py
"""

import argparse
import datetime as dt
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, 'data', 'recomps.js')
API = 'https://api.github.com'

FILE_RE = re.compile(
    r'(?P<head>.*?)window\.RECOMPHAVEN_META = (?P<meta>[^\n]*);\n\n'
    r'window\.RECOMPS = \[\n(?P<body>.*)\n\];\n', re.S)
REPO_RE = re.compile(r'https?://(?:www\.)?github\.com/([^/\s]+)/([^/\s#?]+?)(?:\.git)?/?')
# First "major.minor" in a tag, skipping the tail of dates like 2026.10.16.
VERSION_RE = re.compile(r'(?<!\d)(?<!\d\.)(\d{1,3})\.\d+')
PRERELEASE_RE = re.compile(r'(?<![a-z])(?:alpha|beta|rc|preview)', re.I)
STALE_DAYS = 365
MAX_RETRIES = 5


class FetchError(Exception):
    pass


def load(path):
    with open(path, encoding='utf-8', newline='') as f:
        text = f.read()
    m = FILE_RE.fullmatch(text)
    if not m:
        sys.exit(f'{path}: expected a header comment, RECOMPHAVEN_META, then RECOMPS')
    rows = m['body'].split('\n')
    entries = []
    for i, row in enumerate(rows):
        last = i == len(rows) - 1
        if not (row.startswith('  {') and row.endswith('}' if last else '},')):
            sys.exit(f'{path}: RECOMPS entry {i + 1} is not one object on one line')
        try:
            entries.append(json.loads(row[2:] if last else row[2:-1]))
        except json.JSONDecodeError as err:
            sys.exit(f'{path}: RECOMPS entry {i + 1}: {err}')
    return text, m['head'], json.loads(m['meta']), entries


def listed(entries):
    """The entries the site shows: not the ones hidden for handing out game files (romFiles, set by
    tools/check_roms.py)."""
    return [e for e in entries if not e.get('romFiles')]


def dump(head, meta, entries):
    entries = sorted(entries, key=lambda e: (e['title'].lower(), e['id']))
    rows = ',\n'.join('  ' + json.dumps(e, ensure_ascii=False) for e in entries)
    return (f'{head}window.RECOMPHAVEN_META = {json.dumps(meta, ensure_ascii=False)};\n\n'
            f'window.RECOMPS = [\n{rows}\n];\n')


def retry_delay(err, attempt):
    """(seconds, reason) to wait before retrying an HTTP error, or None."""
    h = err.headers
    if err.code in (403, 429):
        try:
            return int(h['Retry-After']), 'Secondary rate limit'
        except (TypeError, ValueError):
            pass
        if h.get('X-RateLimit-Remaining') == '0' and h.get('X-RateLimit-Reset'):
            return max(int(h['X-RateLimit-Reset']) - time.time(), 0) + 5, 'Rate limit reached'
        if 'rate limit' in err.read().decode('utf-8', 'replace').lower():
            return 60 * 2 ** attempt, 'Secondary rate limit'
        return None
    if err.code >= 500:
        return 5 * 2 ** attempt, f'HTTP {err.code}'
    return None


class GitHub:
    def __init__(self, token):
        self.token = token
        self.calls = 0
        self.headers = {
            'Accept': 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
            'User-Agent': 'recomphaven-refresh-stats',
        }
        if token:
            self.headers['Authorization'] = f'Bearer {token}'

    def get(self, path):
        """Decoded JSON for an API path, or None on 404.

        urllib follows the 301 GitHub sends for a renamed or transferred repo,
        so a move shows up as a full_name that differs from the one asked for.
        """
        for attempt in range(MAX_RETRIES + 1):
            self.calls += 1
            req = urllib.request.Request(API + path, headers=self.headers)
            try:
                with urllib.request.urlopen(req, timeout=30) as resp:
                    return json.load(resp)
            except urllib.error.HTTPError as err:
                if err.code == 404:
                    return None
                delay = retry_delay(err, attempt)
                if delay is None or attempt == MAX_RETRIES:
                    raise FetchError(f'HTTP {err.code} {err.reason}') from None
                wait, reason = delay
            except (urllib.error.URLError, TimeoutError, ConnectionError) as err:
                if attempt == MAX_RETRIES:
                    raise FetchError(str(getattr(err, 'reason', err))) from None
                wait, reason = 5 * 2 ** attempt, 'Network error'
            until = dt.datetime.now(dt.timezone.utc) + dt.timedelta(seconds=wait)
            tip = '' if self.token else ' Set GITHUB_TOKEN to avoid this.'
            shown = f'{wait / 60:.0f} min' if wait >= 90 else f'{wait:.0f} s'
            print(f'  {reason}: waiting {shown}, until {until:%H:%M} UTC.{tip}', flush=True)
            time.sleep(wait)


def latest_release(releases):
    """Newest published release whose tag has a digit in it."""
    best = None
    for rel in releases or []:
        if rel.get('draft') or not rel.get('published_at') or not re.search(r'\d', rel.get('tag_name') or ''):
            continue
        if best is None or rel['published_at'] > best['published_at']:
            best = rel
    return best


def is_stable_1_0(rel):
    m = VERSION_RE.search(rel['tag_name'])
    return (m is not None and int(m[1]) >= 1 and not rel.get('prerelease')
            and not PRERELEASE_RE.search(rel['tag_name']))


def label(entry, md=False):
    return f"**{entry['title']}** (`{entry['id']}`)" if md else f"{entry['title']} [{entry['id']}]"


def plural(n, one, many):
    return f'{n} {one if n == 1 else many}'


def show(value):
    return 'none' if value is None else str(value)


def main():
    ap = argparse.ArgumentParser(description='Refresh GitHub stars, last push and latest release in data/recomps.js.')
    ap.add_argument('--dry-run', action='store_true', help='print what would change and write nothing')
    ap.add_argument('--limit', type=int, metavar='N', help='only check the first N GitHub repos')
    ap.add_argument('--data', default=DATA, help='data file (default: data/recomps.js)')
    ap.add_argument('--summary', metavar='FILE', help='append a Markdown report here (e.g. $GITHUB_STEP_SUMMARY)')
    args = ap.parse_args()
    sys.stdout.reconfigure(errors='replace')

    text, head, meta, entries = load(args.data)
    today = dt.datetime.now(dt.timezone.utc).date()
    token = os.environ.get('GITHUB_TOKEN', '').strip()
    gh = GitHub(token)

    targets = [(e, REPO_RE.fullmatch(e['repo'] or '')) for e in entries]
    targets = [(e, m) for e, m in targets if m]
    total = len(targets)
    if args.limit is not None:
        targets = targets[:args.limit]
    print(f'Checking {len(targets)} of {total} GitHub repos '
          f'({"with GITHUB_TOKEN" if token else "no GITHUB_TOKEN: 60 requests an hour"}).')
    if not token and 2 * len(targets) > 60:
        print(f'  That is about {2 * len(targets)} requests, so expect waits for the hourly limit. '
              'Set GITHUB_TOKEN or use --limit.')

    changed, moved, missing, errors, review = [], [], [], [], []
    checked = 0
    for entry, m in targets:
        owner, name = m.groups()
        try:
            repo = gh.get(f'/repos/{owner}/{name}')
            if repo is None:
                missing.append(entry)
                print(f'  {entry["id"]}: not found (404) at {entry["repo"]}')
                continue
            releases = gh.get(f"/repos/{repo['full_name']}/releases?per_page=10")
        except FetchError as err:
            errors.append((entry, str(err)))
            print(f'  {entry["id"]}: {err}')
            continue
        checked += 1

        if repo['full_name'].lower() != f'{owner}/{name}'.lower():
            moved.append((entry, repo['html_url']))
            print(f'  {entry["id"]}: moved to {repo["html_url"]}')
        new = {'stars': repo['stargazers_count']}
        if repo.get('pushed_at'):
            new['updated'] = repo['pushed_at'][:10]
        rel = latest_release(releases)
        if rel:
            new['version'] = rel['tag_name']
            new['versionDate'] = rel['published_at'][:10]
        diff = [(k, entry[k], v) for k, v in new.items() if entry[k] != v]
        if diff:
            entry.update(new)
            changed.append(entry)
            print(f'  {entry["id"]}: ' + '; '.join(f'{k} {show(a)} -> {show(b)}' for k, a, b in diff))

        if repo.get('archived') and entry['stage'] != 'abandoned':
            review.append((entry, 'repository is archived', 'abandoned'))
        if rel and entry['stage'] in ('beta', 'development') and is_stable_1_0(rel):
            review.append((entry, f"latest release {rel['tag_name']} is 1.0 or later with no pre-release tag", 'released'))

    for entry in entries:
        if entry['updated'] and entry['stage'] != 'abandoned' and not any(r[0] is entry and r[2] == 'abandoned' for r in review):
            days = (today - dt.date.fromisoformat(entry['updated'])).days
            if days > STALE_DAYS:
                review.append((entry, f"no push since {entry['updated']} ({days // 30} months)", 'abandoned'))

    if targets and not checked and errors:
        sys.exit('Every request failed; nothing written.')

    # An entry added by hand without a date gets today's, for "Recently added" and the feed of them.
    for entry in entries:
        entry.setdefault('added', today.isoformat())

    old_snapshot = meta.get('snapshot')
    meta['snapshot'] = today.isoformat()
    new_text = dump(head, meta, entries)

    print()
    print(f'Checked {checked} repos with {gh.calls} API requests; {plural(len(changed), "entry", "entries")} changed.')
    if old_snapshot != meta['snapshot']:
        print(f'  snapshot {show(old_snapshot)} -> {meta["snapshot"]}')
    for title, items in (('Moved (update repo by hand)', [f'{label(e)}: {e["repo"]} -> {url}' for e, url in moved]),
                         ('Not found (404)', [f'{label(e)}: {e["repo"]}' for e in missing]),
                         ('Errors', [f'{label(e)}: {msg}' for e, msg in errors])):
        if items:
            print(f'\n{title}:')
            print('\n'.join(f'  {s}' for s in items))
    print('\nSuggested review (stage, genre and quality are never changed automatically):')
    print('\n'.join(f'  {label(e)}, stage {e["stage"]}: {why} -> suggest {s}' for e, why, s in review) or '  Nothing to review.')
    print()

    if args.dry_run:
        print('Dry run: nothing written.')
    elif new_text != text:
        tmp = args.data + '.tmp'
        with open(tmp, 'w', encoding='utf-8', newline='') as f:
            f.write(new_text)
        os.replace(tmp, args.data)
        print(f'Wrote {os.path.relpath(args.data)}.')
    else:
        print('No changes.')

    if args.summary:
        md = ['## Data refresh', '',
              f'Checked {checked} of {total} GitHub repos; {plural(len(changed), "entry", "entries")} changed'
              f'{" (dry run, nothing written)" if args.dry_run else ""}.', '',
              '### Suggested review', '',
              'Stage, genre and quality are never changed automatically. Edit `data/recomps.js` by hand if you agree.', '']
        md += [f'- {label(e, True)}, stage `{e["stage"]}`: {why}. Suggest `{s}`.' for e, why, s in review] or ['Nothing to review.']
        for title, items in (('Moved repos', [f'- {label(e, True)}: {e["repo"]} → {url}' for e, url in moved]),
                             ('Not found (404)', [f'- {label(e, True)}: {e["repo"]}' for e in missing]),
                             ('Errors', [f'- {label(e, True)}: {msg}' for e, msg in errors])):
            if items:
                md += ['', f'### {title}', ''] + items
        with open(args.summary, 'a', encoding='utf-8') as f:
            f.write('\n'.join(md) + '\n')


if __name__ == '__main__':
    main()
