#!/usr/bin/env python3
"""Email people who follow a project when it puts out a new release.

Asks the Worker (newsletter/worker.js) which projects people follow and the
release each had at the last check, then reads each one's latest release on
GitHub, picked the way tools/refresh_stats.py picks the site's "Latest
release". A different tag is a new release: the Worker records it and emails
that project's followers. The first check of a newly followed project only
records its current release. Runs hourly (.github/workflows/update-alerts.yml).

Off until MAIL_API_URL and MAIL_ADMIN_TOKEN are set (newsletter/README.md).
GITHUB_TOKEN lifts GitHub's limit of 60 requests an hour.

    python tools/send_alerts.py --dry-run
    python tools/send_alerts.py
"""
import argparse
import datetime as dt
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from mail_api import (MailAPI, button, email_html, email_text, esc, facts, fmt_date, game_url,  # noqa: E402
                      item_row)
from refresh_stats import DATA, REPO_RE, FetchError, GitHub, latest_release, listed, load  # noqa: E402


def build(e, rel):
    tag = rel['tag_name']
    name = (rel.get('name') or '').strip()
    date = fmt_date(rel['published_at'][:10])
    who = e['project'] if e['project'] == e['title'] else f'{e["project"]} ({e["title"]})'
    pre = ', marked as a pre-release' if rel.get('prerelease') else ''
    subject = f'{e["project"]} {tag} is out'
    named = f' “{name}”' if name and name != tag else ''

    html = (f'<h1 style="margin:0 0 6px;font-size:21px">{esc(e["project"])} {esc(tag)}</h1>'
            f'<p style="margin:0 0 14px;font-size:15px">A new release of {esc(who)} is out: '
            f'<strong>{esc(tag)}</strong>{esc(named)}, published {esc(date)}{esc(pre)}.</p>'
            '<table role="presentation" width="100%" cellpadding="0" cellspacing="0">'
            + item_row(e, [esc(facts(e))]) + '</table>'
            f'<p style="margin:18px 0 6px">{button(rel["html_url"], "Release notes")}{button(game_url(e), "Game page", ghost=True)}</p>')
    text = (f'A new release of {who} is out: {tag}{named}, published {date}{pre}.\n\n'
            f'{e["title"]}: {facts(e)}\n\nRelease notes: {rel["html_url"]}\nGame page: {game_url(e)}\n')
    why = f'You get this because you follow {e["project"]} on Re:Haven.'
    return subject, email_html(subject, f'{who}: {tag}', html, why), email_text(text, why)


def main():
    ap = argparse.ArgumentParser(description='Email followers about new releases.')
    ap.add_argument('--dry-run', action='store_true', help='check and print, but record and send nothing')
    args = ap.parse_args()
    sys.stdout.reconfigure(errors='replace')

    api = MailAPI()
    if not api.ready:
        print('Nothing checked: MAIL_API_URL and MAIL_ADMIN_TOKEN are not set (see newsletter/README.md).')
        return
    stats = api.get('/admin/stats')
    followed = stats.get('followed') or []
    print(f'{len(followed)} followed projects; {stats.get("sentToday", 0)} of {stats.get("dailyLimit")} emails sent today.')

    by_id = {e['id']: e for e in listed(load(DATA)[3])}
    gh = GitHub(os.environ.get('GITHUB_TOKEN', '').strip())
    alerts = emails = 0
    for f in followed:
        e = by_id.get(f['recomp'])
        m = REPO_RE.fullmatch((e or {}).get('repo') or '')
        if not e or not m:
            continue
        try:
            rel = latest_release(gh.get(f'/repos/{m[1]}/{m[2]}/releases?per_page=10'))
        except FetchError as err:
            print(f'  {e["id"]}: {err}')
            continue
        if not rel or rel['tag_name'] == f.get('tag'):
            continue
        tag = rel['tag_name']
        if args.dry_run:
            print(f'  {e["id"]}: {f.get("tag") or "(not checked yet)"} -> {tag}; would email {f["followers"]}')
            continue
        previous = api.post('/admin/seen', {'recomp': e['id'], 'tag': tag}).get('previous')
        if previous is None:
            print(f'  {e["id"]}: first check, now at {tag}')
            continue
        subject, html, text = build(e, rel)
        sent, limited = api.send_list(f'recomp:{e["id"]}', subject, html, text)
        alerts += 1
        emails += sent
        print(f'  {e["id"]}: {previous} -> {tag}; emailed {sent}')
        if limited:
            raise SystemExit("Stopped at the Worker's daily email limit (DAILY_LIMIT); the rest wait for tomorrow's "
                             'releases and are not resent.')

    print(f'{alerts} new {"release" if alerts == 1 else "releases"}, {emails} {"email" if emails == 1 else "emails"}, '
          f'{gh.calls} GitHub requests '
          f'({dt.datetime.now(dt.timezone.utc):%H:%M} UTC).')


if __name__ == '__main__':
    main()
