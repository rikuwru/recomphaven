#!/usr/bin/env python3
"""Send the Sunday newsletter: the week's new projects and new releases.

New projects are the entries in data/recomps.js that weren't there a week ago
(from git history, so the checkout needs it all). New releases are the
projects whose latest release is dated in the last week. Anything the last
newsletter already covered is left out, and nothing is sent in a week with no
news. The Worker (newsletter/worker.js) sends it to everyone signed up.

Off until MAIL_API_URL and MAIL_ADMIN_TOKEN are set (newsletter/README.md).

    python tools/send_digest.py --dry-run --preview digest.html
    python tools/send_digest.py --test you@example.com
    python tools/send_digest.py
"""
import argparse
import datetime as dt
import os
import subprocess
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from build_pages import release_url  # noqa: E402
from mail_api import (SITE, MailAPI, button, email_html, email_text, esc, facts, fmt_date, game_url,  # noqa: E402
                      item_row)
from refresh_stats import DATA, ROOT, listed, load  # noqa: E402

DAYS = 7
MAX_ITEMS = 40  # per section; the rest are a link away on the releases page
STATE_KEY = 'digest'


def entries_at(days_ago):
    """Entries by id as of the last commit at least days_ago days old, or None without history."""
    since = (dt.datetime.now(dt.timezone.utc) - dt.timedelta(days=days_ago)).strftime('%Y-%m-%dT%H:%M:%SZ')
    commit = subprocess.run(['git', 'rev-list', '-1', f'--before={since}', 'HEAD'], cwd=ROOT,
                            capture_output=True, encoding='utf-8').stdout.strip()
    if not commit:
        return None
    text = subprocess.run(['git', 'show', f'{commit}:data/recomps.js'], cwd=ROOT, check=True,
                          capture_output=True, encoding='utf-8').stdout
    with tempfile.TemporaryDirectory() as tmp:
        path = os.path.join(tmp, 'recomps.js')
        with open(path, 'w', encoding='utf-8', newline='') as f:
            f.write(text)
        return {e['id']: e for e in load(path)[3]}


def plural(n, one, many):
    return f'{n} {one if n == 1 else many}'


def first_sentence(text, limit=180):
    s = (text or '').split('. ')[0].rstrip('.') + '.'
    return s if len(s) <= limit else s[:limit - 1].rsplit(' ', 1)[0] + '…'


def build(new, released, also, start, end):
    span = f'{fmt_date(start.isoformat())[:-6]} to {fmt_date(end.isoformat())}'
    parts = [p for p in (plural(len(released), 'new release', 'new releases') if released else '',
                         plural(len(new), 'new project', 'new projects') if new else '') if p]
    subject = f'Re:Haven weekly: {" and ".join(parts)}'
    preheader = ', '.join(f'{e["title"]}' for e in (new + released)[:4]) + ('…' if len(new) + len(released) > 4 else '')

    html = [f'<h1 style="margin:0 0 4px;font-size:22px">This week in recomps</h1>'
            f'<p style="margin:0 0 16px;color:#586074;font-size:14px">{esc(span)}</p>']
    text = [f'This week in recomps ({span})', '']

    def section(title, items, lines_of):
        html.append(f'<h2 style="margin:18px 0 4px;font-size:16px;text-transform:uppercase;letter-spacing:.04em">{esc(title)}</h2>'
                    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0">')
        text.extend([title.upper(), ''])
        for e in items[:MAX_ITEMS]:
            h, t = lines_of(e)
            html.append(item_row(e, h))
            text.append(f'- {e["title"]}')
            text.extend(f'  {x}' for x in t)
            text.append(f'  {game_url(e)}')
        html.append('</table>')
        if len(items) > MAX_ITEMS:
            more = len(items) - MAX_ITEMS
            html.append(f'<p style="font-size:13px;margin:8px 0 0"><a href="{SITE}/releases/">And {more} more on the releases page</a></p>')
            text.append(f'And {more} more: {SITE}/releases/')
        text.append('')

    if new:
        def new_lines(e):
            line1 = f'{e["project"]} by {e["team"]}' if e.get('team') and e['team'] != e['project'] else e['project']
            lines = [esc(line1), esc(facts(e))]
            if e.get('summary'):
                lines.append(esc(first_sentence(e['summary'])))
            return lines, [line1, facts(e)] + ([first_sentence(e['summary'])] if e.get('summary') else [])
        section('New on Re:Haven', new, new_lines)

    if released:
        def release_lines(e):
            line1 = f'{e["project"]} {e["version"]}, {fmt_date(e["versionDate"])}'
            notes = release_url(e)
            link = f' · <a href="{esc(notes)}" style="color:#3d4ad0">Release notes</a>' if notes else ''
            extra = [f'Also covers {" and ".join(also[e["id"]])}'] if e['id'] in also else []
            return ([esc(line1) + link, esc(facts(e))] + [esc(x) for x in extra],
                    [line1, facts(e)] + extra + ([f'Release notes: {notes}'] if notes else []))
        section('New releases', released, release_lines)

    html.append(f'<p style="margin:18px 0 6px">{button(SITE + "/", "See every recomp")}{button(SITE + "/releases/", "All releases", ghost=True)}</p>')
    why = 'You get this because you signed up for the Re:Haven Sunday newsletter.'
    return subject, email_html(subject, preheader, '\n'.join(html), why), email_text('\n'.join(text), why)


def main():
    ap = argparse.ArgumentParser(description='Send the Sunday newsletter.')
    ap.add_argument('--dry-run', action='store_true', help='print what it would send and send nothing')
    ap.add_argument('--preview', metavar='FILE', help='also write the email as an HTML file')
    ap.add_argument('--test', metavar='EMAIL', help='send one copy to this address only')
    ap.add_argument('--days', type=int, default=DAYS, help=f'how far back to look (default {DAYS})')
    args = ap.parse_args()
    sys.stdout.reconfigure(errors='replace')

    api = MailAPI()
    if not api.ready and not args.dry_run:
        print('Not sent: MAIL_API_URL and MAIL_ADMIN_TOKEN are not set (see newsletter/README.md).')
        return

    end = dt.datetime.now(dt.timezone.utc).date()
    start = end - dt.timedelta(days=args.days)
    entries = listed(load(DATA)[3])
    old = entries_at(args.days)
    if old is None:
        print('No data from a week ago in git history (the repo is newer, or the checkout is shallow), '
              'so new projects are left out this time.')
        old = {e['id']: e for e in entries}

    last = api.get(f'/admin/state?key={STATE_KEY}').get('value') if api.ready else None
    done = set((last or {}).get('items') or [])

    new = [e for e in entries if e['id'] not in old and f'new:{e["id"]}' not in done]
    new_ids = {e['id'] for e in new}
    released = [e for e in entries
                if e.get('version') and (e.get('versionDate') or '') >= start.isoformat()
                and e['id'] not in new_ids and f'{e["id"]}@{e["version"]}' not in done]
    new.sort(key=lambda e: ('SABCD'.index(e['quality']), -(e.get('stars') or 0)))
    released.sort(key=lambda e: (e['versionDate'], e.get('stars') or 0), reverse=True)
    # One release that covers two games (Zelda 64: Recompiled, Golden Sun Recompiled) is listed once.
    shown, also, first = [], {}, {}
    for e in released:
        key = (e.get('repo') or e['id'], e['version'])
        if key in first:
            also.setdefault(first[key], []).append(e['title'])
        else:
            first[key] = e['id']
            shown.append(e)

    print(f'{plural(len(new), "new project", "new projects")} and {plural(len(shown), "new release", "new releases")} '
          f'since {start}.')
    for e in new:
        print(f'  new: {e["title"]} ({e["project"]})')
    for e in shown:
        print(f'  release: {e["project"]} {e["version"]} ({e["versionDate"]})')
    if not new and not released:
        print('Nothing new this week: no newsletter.')
        return

    subject, html, text = build(new, shown, also, start, end)
    if args.preview:
        with open(args.preview, 'w', encoding='utf-8', newline='\n') as f:
            f.write(html)
        print(f'Wrote {args.preview}.')
    if args.dry_run:
        print(f'\nSubject: {subject}\n\n{text}\nDry run: nothing sent.')
        return
    if args.test:
        print(api.post('/admin/test', {'to': args.test, 'subject': subject, 'html': html, 'text': text})['message'])
        return

    sent, limited = api.send_list('weekly', subject, html, text)
    print(f'Sent to {plural(sent, "subscriber", "subscribers")}.')
    api.post('/admin/state', {'key': STATE_KEY, 'value': {
        'date': end.isoformat(),
        'items': [f'new:{e["id"]}' for e in new] + [f'{e["id"]}@{e["version"]}' for e in released]}})
    if limited:
        raise SystemExit("Stopped at the Worker's daily email limit (DAILY_LIMIT): not everyone got it. "
                         'Raise the limit, and the Resend plan, to match the number of subscribers.')


if __name__ == '__main__':
    main()
