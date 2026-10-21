#!/usr/bin/env python3
"""Post new releases to a Discord channel.

Compares data/recomps.js with the last committed version (git HEAD) and
posts each project whose latest release changed, as long as that release is
from the last few days. The nightly refresh runs it just before it commits.

It's off until DISCORD_WEBHOOK_URL is set. In Discord: Server Settings >
Integrations > Webhooks > New Webhook, pick the channel, Copy Webhook URL.
Then on GitHub: Settings > Secrets and variables > Actions > New repository
secret, named DISCORD_WEBHOOK_URL. Without it the script only prints what it
would post.

    python tools/announce_releases.py --dry-run
"""
import argparse
import datetime as dt
import json
import os
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from build_pages import CONSOLES, SITE, STAGES, TIER_COLORS, TIERS, slug_of  # noqa: E402
from refresh_stats import DATA, ROOT, listed, load  # noqa: E402

RECENT_DAYS = 3  # older releases that turn up late (a fixed repo link, say) aren't news
EMBEDS_PER_MESSAGE = 10  # Discord's limit


def committed_entries():
    """Entries as of git HEAD, by id."""
    text = subprocess.run(['git', 'show', 'HEAD:data/recomps.js'], cwd=ROOT, check=True,
                          capture_output=True, encoding='utf-8').stdout
    with tempfile.TemporaryDirectory() as tmp:
        path = os.path.join(tmp, 'recomps.js')
        with open(path, 'w', encoding='utf-8', newline='') as f:
            f.write(text)
        return {e['id']: e for e in load(path)[3]}


def embed(e):
    console = CONSOLES.get(e['console'], {}).get('label', e['console'])
    lines = [f'{e["title"]} · {console}',
             f'{e["quality"]} tier ({TIERS[e["quality"]]["label"]}) · {STAGES[e["stage"]]["label"]}']
    if e.get('repo'):
        notes = e['repo'].rstrip('/') + '/releases' if 'github.com/' in e['repo'] else e['repo']
        lines.append(f'[Release notes]({notes})')
    out = {
        'title': f'{e.get("project") or e["title"]} {e["version"]}'[:256],
        'url': f'{SITE}/games/{slug_of(e["title"])}/',
        'description': '\n'.join(lines),
        'color': int(TIER_COLORS[e['quality']].lstrip('#'), 16),
        'timestamp': f'{e["versionDate"]}T00:00:00Z',
        'footer': {'text': 'Recomp Haven'},
    }
    if e.get('cover'):
        out['thumbnail'] = {'url': f'{SITE}/{e["cover"]}'}
    return out


def post(url, payload):
    body = json.dumps(payload).encode()
    for attempt in range(4):
        req = urllib.request.Request(url, data=body, method='POST', headers={
            'Content-Type': 'application/json', 'User-Agent': 'recomphaven-announce'})
        try:
            with urllib.request.urlopen(req, timeout=30):
                return
        except urllib.error.HTTPError as err:
            if err.code != 429 or attempt == 3:
                raise SystemExit(f'Discord said HTTP {err.code}: {err.read().decode("utf-8", "replace")[:200]}')
            time.sleep(float(json.loads(err.read() or b'{}').get('retry_after', 2)) + 0.5)


def main():
    ap = argparse.ArgumentParser(description='Post new releases to a Discord channel.')
    ap.add_argument('--dry-run', action='store_true', help='print what would be posted and post nothing')
    args = ap.parse_args()
    sys.stdout.reconfigure(errors='replace')

    old = committed_entries()
    entries = listed(load(DATA)[3])
    since = (dt.datetime.now(dt.timezone.utc).date() - dt.timedelta(days=RECENT_DAYS)).isoformat()
    new = [e for e in entries
           if e['id'] in old and e.get('version') and (e.get('versionDate') or '') >= since
           and (e['version'], e['versionDate']) != (old[e['id']].get('version'), old[e['id']].get('versionDate'))]
    new.sort(key=lambda e: (e['versionDate'], e.get('stars') or 0))

    print(f'{len(new)} new release{"" if len(new) == 1 else "s"} since the last commit.')
    for e in new:
        print(f'  {e.get("project") or e["title"]} {e["version"]} ({e["versionDate"]})')

    url = os.environ.get('DISCORD_WEBHOOK_URL', '').strip()
    if not new:
        return
    if args.dry_run or not url:
        print('Not posted: ' + ('dry run.' if args.dry_run else 'DISCORD_WEBHOOK_URL is not set.'))
        return
    for i in range(0, len(new), EMBEDS_PER_MESSAGE):
        post(url, {'username': 'Recomp Haven', 'avatar_url': f'{SITE}/assets/icons/icon-192.png',
                   'embeds': [embed(e) for e in new[i:i + EMBEDS_PER_MESSAGE]]})
    print('Posted to Discord.')


if __name__ == '__main__':
    main()
