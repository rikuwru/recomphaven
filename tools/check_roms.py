#!/usr/bin/env python3
"""Hides projects whose repository hands out game files, until it stops.

For every entry whose repo is on github.com this looks at
  - the files in the repository: a shallow clone without file contents (no API calls), redone
    only after a push, so most nights only a few repositories are fetched
  - the downloads of its latest release (the release page's asset list), redone when the release
    changes
and looks for what can only be the game itself: ROMs and disc images in the formats of the game's
own console (a .z64 for an N64 game, an .iso for a disc console, an .nsp for Switch), and that
console's game programs (an Xbox 360 default.xex, a PS2 SLUS_123.45). Other consoles' formats
don't count, so a 3DS build of a PC game's port or a Game Boy test ROM bundled with an emulator
isn't flagged; neither are files in test, fixture, sample and vendored-library folders, nor
files under 16 KB.

An entry with findings gets `romFiles` (what was found), which hides it from the site, the feed,
Discord and the emails; when a later check finds nothing, the field goes and it's back. A
repository that can't be reached keeps its last result. data/rom-checks.json remembers what was
checked, so unchanged repositories aren't fetched again.

    python tools/check_roms.py --dry-run          # report only
    python tools/check_roms.py --only some-id     # one entry, checked afresh
    python tools/check_roms.py --summary "$GITHUB_STEP_SUMMARY"

A finding that's wrong can be waved through by adding "<entry id>:<path or asset name>" to ALLOW.
"""

import argparse
import datetime as dt
import json
import os
import re
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from refresh_stats import DATA, REPO_RE, ROOT, dump, label, load  # noqa: E402

STATE = os.path.join(ROOT, 'data', 'rom-checks.json')
MIN_SIZE = 16 * 1024
WORKERS = 6

# Formats that are the game itself, by the original console.
DISC = {'iso', 'chd', 'cue', 'mdf', 'nrg', 'ecm', 'ccd', 'cdi', 'gdi'}
FORMATS = {
    'n64': {'z64', 'n64', 'v64', 'ndd'},
    'nes': {'nes', 'fds', 'unf', 'unif'},
    'snes': {'sfc', 'smc', 'fig', 'swc'},
    'gb': {'gb', 'gbc', 'sgb'},
    'gbc': {'gbc', 'gb'},
    'gba': {'gba', 'agb'},
    'vb': {'vb', 'vboy'},
    'nds': {'nds', 'dsi'},
    '3ds': {'3ds', 'cci', 'cia', 'cxi'},
    'megadrive': {'gen', 'smd', 'sgd'},
    '32x': {'32x'},
    'msx': {'mx1', 'mx2', 'rom', 'dsk', 'cas'},
    'msx2': {'mx1', 'mx2', 'rom', 'dsk', 'cas'},
    'gamecube': DISC | {'gcm', 'rvz', 'gcz', 'ciso', 'dol'},
    'wii': DISC | {'wbfs', 'rvz', 'wia', 'gcz', 'ciso', 'wad', 'dol'},
    'wiiu': {'wud', 'wux', 'wua', 'rpx'},
    'switch': {'nsp', 'xci', 'nca'},
    'ps1': DISC | {'pbp'},
    'ps2': DISC | {'cso'},
    'ps3': DISC | {'self', 'sprx'},
    'ps4': {'pkg', 'sprx'},
    'psp': DISC | {'cso', 'pbp', 'prx'},
    'xbox': DISC | {'xbe', 'xiso'},
    'x360': DISC | {'xex', 'god'},
    'xboxone': DISC | {'xvc'},
    'dreamcast': DISC,
    'arcade': {'chd'},
}
# Game programs known by name rather than extension.
PROGRAM = {
    'ps1': re.compile(r'^(s[cl][uep][sm]|slp[sm]|scps|scph)[_-]\d{3}\.\d{2}(;1)?$', re.I),
    'ps2': re.compile(r'^(s[cl][uep][sm]|slp[sm]|scps|scaj|sckc)[_-]\d{3}\.\d{2}(;1)?$', re.I),
    'ps3': re.compile(r'^eboot\.bin$', re.I),
    'ps4': re.compile(r'^eboot\.bin$', re.I),
    'psp': re.compile(r'^eboot\.(bin|pbp)$', re.I),
}
ARCHIVE = re.compile(r'\.(zip|7z|rar|gz|xz|bz2)$', re.I)
# Folders whose files are tests, samples or someone else's library, not the project's own.
SKIP_DIR = re.compile(r'^(tests?|testing|test[-_]?data|test[-_]?roms?|testroms|fixtures?|conformance|samples?'
                      r'|examples?|vendor|third[-_]?party|externals?|deps|submodules?)$', re.I)
# "<entry id>:<path or asset name>" findings checked by hand and allowed.
ALLOW = set()


def is_game_file(name, console):
    """Whether a file or download name is a game image or program for this console."""
    base = urllib.parse.unquote(name.rsplit('/', 1)[-1])
    while ARCHIVE.search(base):  # zelda.z64.zip counts as zelda.z64
        base = ARCHIVE.sub('', base)
    ext = base.rsplit('.', 1)[-1].lower() if '.' in base else ''
    if ext in FORMATS.get(console, ()):
        return True
    program = PROGRAM.get(console)
    return bool(program and program.match(base))


def skipped_path(path):
    parts = path.split('/')
    return any(SKIP_DIR.match(p) for p in parts[:-1]) or parts[-1].lower().startswith(('test', 'sample'))


def git(*args, cwd=None, timeout=300):
    return subprocess.run(['git', *args], cwd=cwd, capture_output=True, text=True, encoding='utf-8',
                          errors='replace', timeout=timeout, env={**os.environ, 'GIT_TERMINAL_PROMPT': '0'})


def repo_findings(url, console):
    """Game files in the repository's default branch, or None when it can't be fetched."""
    with tempfile.TemporaryDirectory() as tmp:
        if git('clone', '--quiet', '--depth', '1', '--filter=blob:none', '--no-checkout', url, tmp).returncode:
            return None
        listing = git('ls-tree', '-r', '--name-only', '-z', 'HEAD', cwd=tmp)
        if listing.returncode:
            return None
        found = []
        for path in filter(None, listing.stdout.split('\0')):
            if not is_game_file(path, console) or skipped_path(path):
                continue
            size = git('cat-file', '-s', f'HEAD:{path}', cwd=tmp)  # fetches just this file
            size = int(size.stdout.strip() or 0) if size.returncode == 0 else 0
            if size < 200:  # a Git LFS pointer names the real size
                text = git('cat-file', '-p', f'HEAD:{path}', cwd=tmp).stdout
                m = re.search(r'^size (\d+)$', text, re.M) if 'git-lfs' in text else None
                size = int(m[1]) if m else size
            if size >= MIN_SIZE:
                found.append(path)
        return found


def release_assets(owner, name, tag):
    """Names of the files attached to a release, or None when the page can't be read."""
    url = f'https://github.com/{owner}/{name}/releases/expanded_assets/{urllib.parse.quote(tag, safe="")}'
    req = urllib.request.Request(url, headers={'User-Agent': 'recomphaven-check-roms'})
    for attempt in range(4):
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                html = resp.read().decode('utf-8', 'replace')
            return sorted({urllib.parse.unquote(a) for a in re.findall(r'/releases/download/[^"/]+/([^"?/]+)', html)})
        except urllib.error.HTTPError as err:
            if err.code == 404:
                return []
            time.sleep(10 * (attempt + 1))
        except (urllib.error.URLError, TimeoutError, ConnectionError):
            time.sleep(5 * (attempt + 1))
    return None


def check(entry, owner, name, old, fresh):
    """This entry's state: what was checked, and what was found."""
    state = dict(old)
    if fresh or state.get('pushed') != entry.get('updated') or 'files' not in state:
        files = repo_findings(f'https://github.com/{owner}/{name}.git', entry['console'])
        if files is not None:
            state.update(pushed=entry.get('updated'), files=files)
    tag = entry.get('version')
    if tag and (fresh or state.get('release') != tag or 'assets' not in state):
        assets = release_assets(owner, name, tag)
        if assets is not None:
            state.update(release=tag, assets=[a for a in assets if is_game_file(a, entry['console'])])
    elif not tag:
        state.update(release=None, assets=[])
    return state


def main():
    ap = argparse.ArgumentParser(description='Hide projects whose repository hands out game files.')
    ap.add_argument('--dry-run', action='store_true', help='report what would change and write nothing')
    ap.add_argument('--only', metavar='ID', help='check one entry afresh')
    ap.add_argument('--summary', metavar='FILE', help='append a Markdown report here (e.g. $GITHUB_STEP_SUMMARY)')
    args = ap.parse_args()
    sys.stdout.reconfigure(errors='replace')

    _, head, meta, entries = load(DATA)
    try:
        states = json.load(open(STATE, encoding='utf-8'))
    except FileNotFoundError:
        states = {}
    targets = [(e, REPO_RE.fullmatch(e.get('repo') or '')) for e in entries]
    targets = [(e, m) for e, m in targets if m and (not args.only or e['id'] == args.only)]
    print(f'Checking {len(targets)} GitHub repos for game files.', flush=True)

    with ThreadPoolExecutor(WORKERS) as pool:
        results = list(pool.map(lambda t: check(t[0], *t[1].groups(), states.get(t[0]['id'], {}), bool(args.only)),
                                targets))

    hidden, shown = [], []
    for (entry, _), state in zip(targets, results):
        states[entry['id']] = state
        found = [f'repository: {p}' for p in state.get('files', [])] + \
                [f'release {state["release"]}: {a}' for a in state.get('assets', [])]
        found = [f for f in found if f'{entry["id"]}:{f.split(": ", 1)[1]}' not in ALLOW]
        if found and found != entry.get('romFiles'):
            if not entry.get('romFiles'):
                hidden.append((entry, found))
            entry['romFiles'] = found
        elif not found and entry.get('romFiles'):
            del entry['romFiles']
            shown.append(entry)

    for entry, found in hidden:
        print(f'  hidden: {label(entry)}: {"; ".join(found)}')
    for entry in shown:
        print(f'  shown again: {label(entry)}')
    still = [e for e in entries if e.get('romFiles') and all(e is not h for h, _ in hidden)]
    print(f'{len(hidden)} newly hidden, {len(shown)} shown again, {len(still)} still hidden.')

    if args.summary:
        with open(args.summary, 'a', encoding='utf-8') as f:
            f.write('\n## Game files check\n\n')
            if not (hidden or shown or still):
                f.write('No repository hands out game files.\n')
            for entry, found in hidden:
                f.write(f'- Hidden: {label(entry, md=True)}: {"; ".join(found)}\n')
            for entry in shown:
                f.write(f'- Shown again: {label(entry, md=True)}\n')
            for entry in still:
                f.write(f'- Still hidden: {label(entry, md=True)}: {"; ".join(entry["romFiles"])}\n')

    if args.dry_run:
        return
    with open(DATA, 'w', encoding='utf-8', newline='') as f:
        f.write(dump(head, meta, entries))
    lines = [f'  {json.dumps(k)}: {json.dumps(v, ensure_ascii=False)}' for k, v in sorted(states.items())]
    with open(STATE, 'w', encoding='utf-8', newline='\n') as f:
        f.write('{\n' + ',\n'.join(lines) + '\n}\n')


if __name__ == '__main__':
    main()
