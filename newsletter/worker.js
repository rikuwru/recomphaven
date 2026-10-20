// Re:Haven mail: the Sunday newsletter and per-project update alerts.
//
// A Cloudflare Worker with a D1 database, in one file with no dependencies, so
// it can be pasted into the Cloudflare dashboard. People sign up on
// recomphaven.com (POST /subscribe) and confirm by email (/confirm); every email
// links to /manage and /unsubscribe. GitHub Actions write the emails
// (tools/send_digest.py, tools/send_alerts.py) and hand them to the /admin
// endpoints, which send them through Resend. Setup: newsletter/README.md.
//
// Settings (Worker → Settings → Variables and Secrets, and Bindings):
//   DB              D1 database binding; the tables create themselves
//   RESEND_API_KEY  secret: a Resend API key that can send
//   ADMIN_TOKEN     secret: a long random string, saved on GitHub as MAIL_ADMIN_TOKEN too
//   MAIL_FROM       optional: the sender, default "Re:Haven <news@recomphaven.com>"
//   DAILY_LIMIT     optional: most emails in a UTC day, default 100 (Resend's free plan)
//   CONFIRM_LIMIT   optional: most confirmation emails in a UTC day, default 40
//   ALLOWED_ORIGINS optional: comma-separated sites that may post sign-ups,
//                   default https://recomphaven.com
//
// Reviews on game pages (score, written review, Submit) also go through this Worker: it signs
// people in with a GitHub App and starts a project's discussion thread the first time it's
// reviewed. Setup: newsletter/README.md, "Review sign-in". Settings:
//   GH_CLIENT_ID     the GitHub App's client ID
//   GH_CLIENT_SECRET secret: one of the App's client secrets
//   GH_PRIVATE_KEY   secret: the App's private key, the whole .pem file
//   GH_REPO          optional: default rikuwru/recomphaven
//   GH_CATEGORY      optional: default "Ratings and comments"

const SITE = 'https://recomphaven.com';
const RESEND = 'https://api.resend.com';
const FROM = 'Re:Haven <news@recomphaven.com>';
const PAGE = 50;            // recipients per /admin/send call, sent as one Resend batch
const PENDING_DAYS = 3;     // how long a confirmation link works
const RESEND_WAIT = 2;      // minutes before the same address gets another confirmation
const PER_NETWORK = 20;     // sign-ups a day from one IP address

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS subscribers (
     id INTEGER PRIMARY KEY, email TEXT NOT NULL UNIQUE, token TEXT NOT NULL UNIQUE,
     confirmed INTEGER NOT NULL DEFAULT 0, weekly INTEGER NOT NULL DEFAULT 0,
     created TEXT NOT NULL, last_mail TEXT)`,
  `CREATE TABLE IF NOT EXISTS follows (
     subscriber INTEGER NOT NULL, recomp TEXT NOT NULL, created TEXT NOT NULL,
     PRIMARY KEY (subscriber, recomp))`,
  'CREATE INDEX IF NOT EXISTS follows_recomp ON follows (recomp)',
  `CREATE TABLE IF NOT EXISTS pending (
     code TEXT PRIMARY KEY, subscriber INTEGER NOT NULL, weekly INTEGER NOT NULL,
     recomp TEXT, created TEXT NOT NULL)`,
  // The latest release tag each followed project had at the last check.
  'CREATE TABLE IF NOT EXISTS seen (recomp TEXT PRIMARY KEY, tag TEXT NOT NULL, at TEXT NOT NULL)',
  // Daily counters: "all" emails, "confirm" emails, and sign-ups per hashed IP address.
  'CREATE TABLE IF NOT EXISTS counts (day TEXT NOT NULL, kind TEXT NOT NULL, n INTEGER NOT NULL, PRIMARY KEY (day, kind))',
  // Small values the GitHub jobs keep between runs, like what the last newsletter covered.
  'CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY, value TEXT NOT NULL)',
];

let ready = null;
let catalog = { at: 0, map: null };

export default {
  async fetch(request, env) {
    try {
      if (!ready) ready = env.DB.batch(SCHEMA.map((sql) => env.DB.prepare(sql))).catch((err) => { ready = null; throw err; });
      await ready;
      return await route(request, env);
    } catch (err) {
      console.error(err && err.stack || err);
      return json({ ok: false, message: 'Something went wrong on our side. Please try again later.' }, 500, cors(request, env));
    }
  },
};

async function route(request, env) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, '') || '/';
  const method = request.method;
  if (method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(request, env) });
  if (path === '/subscribe' && method === 'POST') return subscribe(request, env);
  if (path === '/confirm' && method === 'GET') return confirm(url, env);
  if (path === '/manage') return method === 'POST' ? manageAction(request, url, env) : managePage(url, env);
  if (path === '/unsubscribe') return method === 'POST' ? unsubscribeAction(url, env) : unsubscribePage(url, env);
  if (path === '/auth/start' && method === 'GET') return authStart(url, env);
  if (path === '/auth/callback' && method === 'GET') return authCallback(url, env);
  if (path === '/reviews/thread' && method === 'POST') return reviewThread(request, env);
  if (path.startsWith('/admin/')) {
    if (!isAdmin(request, env)) return json({ ok: false, message: 'Not allowed.' }, 401);
    if (path === '/admin/stats' && method === 'GET') return stats(env);
    if (path === '/admin/seen' && method === 'POST') return markSeen(request, env);
    if (path === '/admin/send' && method === 'POST') return sendList(request, url, env);
    if (path === '/admin/test' && method === 'POST') return sendTest(request, url, env);
    if (path === '/admin/state' && method === 'GET') return getState(url, env);
    if (path === '/admin/state' && method === 'POST') return putState(request, env);
  }
  if (path === '/') return Response.redirect(SITE, 302);
  return new Response('Not found', { status: 404 });
}

// ── Helpers ──────────────────────────────────────────────

const now = () => new Date().toISOString();
const today = () => now().slice(0, 10);
const daysAgo = (n) => new Date(Date.now() - n * 864e5).toISOString();
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const one = (env, sql, ...args) => env.DB.prepare(sql).bind(...args).first();
const all = async (env, sql, ...args) => (await env.DB.prepare(sql).bind(...args).all()).results;
const run = (env, sql, ...args) => env.DB.prepare(sql).bind(...args).run();

function randomToken(bytes = 18) {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return btoa(String.fromCharCode(...a)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function sha256(text) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers } });
}

const siteOrigins = (env) => (env.ALLOWED_ORIGINS || SITE).split(',').map((s) => s.trim()).filter(Boolean);

function cors(request, env) {
  const origin = request.headers.get('Origin') || '';
  if (!siteOrigins(env).includes(origin)) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

function isAdmin(request, env) {
  const want = env.ADMIN_TOKEN || '';
  const got = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  if (want.length < 20 || got.length !== want.length) return false;
  let diff = 0;
  for (let i = 0; i < want.length; i++) diff |= want.charCodeAt(i) ^ got.charCodeAt(i);
  return diff === 0;
}

async function bump(env, kind, n = 1) {
  await run(env, 'INSERT INTO counts (day, kind, n) VALUES (?, ?, ?) ON CONFLICT (day, kind) DO UPDATE SET n = n + excluded.n',
    today(), kind, n);
}

async function used(env, kind) {
  const row = await one(env, 'SELECT n FROM counts WHERE day = ? AND kind = ?', today(), kind);
  return row ? row.n : 0;
}

// The same slugs as slug_of() in tools/build_pages.py and slugOf() in app.js.
const slugOf = (title) => title.replace(/\s*\((?!\d{4}\))[^)]*\)\s*$/, '').normalize('NFKD').replace(/[^\x00-\x7f]/g, '')
  .toLowerCase().replace(/['.]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

// Every project on the site by id, read from the live data file and kept for ten minutes.
async function recomps() {
  if (catalog.map && Date.now() - catalog.at < 10 * 60 * 1000) return catalog.map;
  const res = await fetch(`${SITE}/data/recomps.js`, { cf: { cacheTtl: 600 } });
  if (!res.ok) {
    if (catalog.map) return catalog.map;
    throw new Error(`data/recomps.js: HTTP ${res.status}`);
  }
  const map = new Map();
  for (const line of (await res.text()).split('\n')) {
    if (!line.startsWith('  {"id": ')) continue;
    try {
      const e = JSON.parse(line.trim().replace(/,$/, ''));
      map.set(e.id, { title: e.title, project: e.project || e.title, slug: slugOf(e.title) });
    } catch { /* a line that isn't a whole entry */ }
  }
  catalog = { at: Date.now(), map };
  return map;
}

const projectName = (p) => (p.project === p.title ? p.title : `${p.project} (${p.title})`);

// ── Sending (Resend) ─────────────────────────────────────

async function resend(env, path, payload) {
  const res = await fetch(RESEND + path, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (res.ok) return { ok: true };
  const detail = (await res.text()).slice(0, 300);
  console.error(`Resend ${path}: HTTP ${res.status} ${detail}`);
  return { ok: false, status: res.status, detail };
}

function message(env, m) {
  const out = { from: env.MAIL_FROM || FROM, to: [m.to], subject: m.subject, html: m.html, text: m.text };
  if (m.headers) out.headers = m.headers;
  return out;
}

// One email, within the day's limits. kind also counts it under its own name ("confirm").
async function sendOne(env, m, kind) {
  if (await used(env, 'all') >= (Number(env.DAILY_LIMIT) || 100)) return false;
  if (!(await resend(env, '/emails', message(env, m))).ok) return false;
  await bump(env, 'all');
  if (kind) await bump(env, kind);
  return true;
}

// ── Pages ────────────────────────────────────────────────

function page(title, body, status = 200) {
  return new Response(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${esc(title)} · Re:Haven</title>
<style>
  :root { --bg: #f2f3f7; --surface: #fff; --line: #d3d7e2; --fg: #141622; --muted: #586074; --accent: #3d4ad0; --on-accent: #fff; --danger: #b3261e; }
  @media (prefers-color-scheme: dark) { :root { --bg: #0e1017; --surface: #161924; --line: #2c3142; --fg: #eceef5; --muted: #a2a9bd; --accent: #8f9bff; --on-accent: #0e1017; --danger: #ff8a80; } }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--fg); font: 16px/1.55 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
  main { max-width: 560px; margin: 0 auto; padding: 32px 16px 48px; }
  .logo { display: block; width: 200px; max-width: 70%; margin-bottom: 24px; }
  h1 { font-size: 1.5rem; line-height: 1.2; margin: 0 0 12px; }
  p { margin: 0 0 14px; }
  a { color: var(--accent); }
  .box { background: var(--surface); border: 1px solid var(--line); border-radius: 10px; padding: 18px; margin: 18px 0; }
  ul.list { list-style: none; margin: 0; padding: 0; }
  ul.list li { display: flex; gap: 12px; align-items: center; justify-content: space-between; padding: 10px 0; border-top: 1px solid var(--line); }
  ul.list li:first-child { border-top: 0; padding-top: 0; }
  form { margin: 0; }
  button { font: inherit; font-weight: 600; height: 38px; padding: 0 14px; border-radius: 8px; border: 1px solid var(--accent); background: var(--accent); color: var(--on-accent); cursor: pointer; }
  button.ghost { background: transparent; color: var(--accent); }
  button.danger { background: transparent; color: var(--danger); border-color: var(--danger); }
  .muted { color: var(--muted); font-size: 0.9rem; }
  .done { border-left: 4px solid var(--accent); }
</style>
</head>
<body>
<main>
<a href="${SITE}/"><img class="logo" src="${SITE}/assets/logo.png" alt="Re:Haven"></a>
${body}
</main>
</body>
</html>`, { status, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' } });
}

const backToSite = `<p><a href="${SITE}/">Back to Re:Haven</a></p>`;

// ── Sign-up and confirmation ─────────────────────────────

const EMAIL_RE = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[^\s@<>()[\]\\,;:"]{2,}$/;
const ID_RE = /^[a-z0-9][a-z0-9-]{0,99}$/;

async function subscribe(request, env) {
  const headers = cors(request, env);
  const reply = (status, ok, text) => json({ ok, message: text }, status, headers);
  let body;
  try { body = await request.json(); } catch { return reply(400, false, 'Something went wrong with the form. Please reload the page and try again.'); }
  const email = String(body.email || '').trim().toLowerCase();
  // A field people don't see: anything in it came from a bot.
  if (body.website) return reply(200, true, `Almost done: check ${email} for a link to confirm.`);
  const weekly = body.weekly ? 1 : 0;
  const recomp = body.recomp ? String(body.recomp) : null;
  if (email.length > 254 || !EMAIL_RE.test(email)) return reply(400, false, 'That email address doesn’t look right.');
  if (!weekly && !recomp) return reply(400, false, 'Choose the newsletter or a project to follow.');
  let project = null;
  if (recomp) {
    project = ID_RE.test(recomp) ? (await recomps()).get(recomp) : null;
    if (!project) return reply(400, false, 'That project isn’t on Re:Haven any more. Reload the page and try again.');
  }

  await cleanUp(env);
  const ip = request.headers.get('CF-Connecting-IP');
  if (ip) {
    const kind = 'ip:' + (await sha256(`${ip}|${env.ADMIN_TOKEN}`)).slice(0, 24);
    if (await used(env, kind) >= PER_NETWORK) return reply(429, false, 'Too many sign-ups from your network today. Please try again tomorrow.');
    await bump(env, kind);
  }
  if (await used(env, 'confirm') >= (Number(env.CONFIRM_LIMIT) || 40)) {
    return reply(503, false, 'Sign-ups are paused for the rest of today. Please try again tomorrow.');
  }

  let sub = await one(env, 'SELECT * FROM subscribers WHERE email = ?', email);
  if (sub && sub.last_mail && Date.parse(sub.last_mail) > Date.now() - RESEND_WAIT * 60e3) {
    return reply(429, false, 'We just sent an email to this address. Check your inbox and spam folder, or try again in a couple of minutes.');
  }
  if (!sub) {
    await run(env, 'INSERT INTO subscribers (email, token, created) VALUES (?, ?, ?)', email, randomToken(), now());
    sub = await one(env, 'SELECT * FROM subscribers WHERE email = ?', email);
  }
  const code = randomToken();
  await run(env, 'INSERT INTO pending (code, subscriber, weekly, recomp, created) VALUES (?, ?, ?, ?, ?)',
    code, sub.id, weekly, recomp, now());
  const link = `${new URL(request.url).origin}/confirm?c=${code}`;
  if (!(await sendOne(env, { to: email, ...confirmEmail(link, email, weekly, project) }, 'confirm'))) {
    await run(env, 'DELETE FROM pending WHERE code = ?', code);
    return reply(503, false, 'We couldn’t send the email just now. Please try again later.');
  }
  await run(env, 'UPDATE subscribers SET last_mail = ? WHERE id = ?', now(), sub.id);
  return reply(200, true, `Almost done: check ${email} for a link to confirm.`);
}

async function cleanUp(env) {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM pending WHERE created < ?').bind(daysAgo(PENDING_DAYS)),
    env.DB.prepare('DELETE FROM subscribers WHERE confirmed = 0 AND created < ? AND id NOT IN (SELECT subscriber FROM pending)')
      .bind(daysAgo(PENDING_DAYS)),
    env.DB.prepare('DELETE FROM counts WHERE day < ?').bind(daysAgo(3).slice(0, 10)),
  ]);
}

function confirmEmail(link, email, weekly, project) {
  const what = [];
  if (weekly) what.push(['The Sunday newsletter', 'one email a week with the recomps released or updated that week']);
  if (project) what.push([`Update alerts for ${projectName(project)}`, 'an email as soon as it puts out a new release']);
  const subject = project && !weekly ? `Confirm update alerts for ${project.project}` : 'Confirm your Re:Haven emails';
  const html = `<!doctype html><html><body style="margin:0;background:#f2f3f7;font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;color:#141622">
<div style="max-width:520px;margin:0 auto;padding:28px 16px">
<img src="${SITE}/assets/logo.png" alt="Re:Haven" width="180" style="display:block;width:180px;margin-bottom:20px">
<div style="background:#fff;border:1px solid #d3d7e2;border-radius:10px;padding:22px">
<p style="margin:0 0 12px;font-size:16px">Someone, hopefully you, asked Re:Haven to email <strong>${esc(email)}</strong>:</p>
<ul style="margin:0 0 18px;padding-left:20px;font-size:15px;line-height:1.5">${what.map(([a, b]) => `<li><strong>${esc(a)}</strong>: ${esc(b)}</li>`).join('')}</ul>
<p style="margin:0 0 18px"><a href="${link}" style="display:inline-block;background:#3d4ad0;color:#fff;text-decoration:none;font-weight:600;padding:11px 18px;border-radius:8px">Yes, send me these emails</a></p>
<p style="margin:0;font-size:13px;color:#586074">If you didn't ask for this, ignore this email and you won't hear from us. The link works for ${PENDING_DAYS} days.</p>
</div></div></body></html>`;
  const text = `Someone, hopefully you, asked Re:Haven to email ${email}:\n\n`
    + what.map(([a, b]) => `- ${a}: ${b}`).join('\n')
    + `\n\nTo confirm, open this link:\n${link}\n\nIf you didn't ask for this, ignore this email and you won't hear from us. The link works for ${PENDING_DAYS} days.\n`;
  return { subject, html, text };
}

async function confirm(url, env) {
  const code = url.searchParams.get('c') || '';
  const p = code ? await one(env, 'SELECT * FROM pending WHERE code = ? AND created >= ?', code, daysAgo(PENDING_DAYS)) : null;
  if (!p) {
    return page('That link has expired', `<h1>That link has expired</h1>
<p>Confirmation links work for ${PENDING_DAYS} days, and each one works once. If you already clicked it, you're all set.</p>
<p>Otherwise, sign up again on <a href="${SITE}/">Re:Haven</a> for a new link.</p>`, 404);
  }
  const stmts = [
    env.DB.prepare('UPDATE subscribers SET confirmed = 1, weekly = MAX(weekly, ?) WHERE id = ?').bind(p.weekly, p.subscriber),
    env.DB.prepare('DELETE FROM pending WHERE code = ?').bind(code),
  ];
  if (p.recomp) {
    stmts.push(env.DB.prepare('INSERT OR IGNORE INTO follows (subscriber, recomp, created) VALUES (?, ?, ?)').bind(p.subscriber, p.recomp, now()));
  }
  await env.DB.batch(stmts);
  const sub = await one(env, 'SELECT * FROM subscribers WHERE id = ?', p.subscriber);
  const project = p.recomp ? (await recomps()).get(p.recomp) : null;
  const what = [];
  if (p.weekly) what.push('<li>The Sunday newsletter: the week’s new and updated recomps, every Sunday.</li>');
  if (project) {
    what.push(`<li>Update alerts for <a href="${SITE}/games/${esc(project.slug)}/">${esc(projectName(project))}</a>: an email when it puts out a new release.</li>`);
  }
  return page('You’re subscribed', `<h1>You’re subscribed</h1>
<div class="box done"><ul style="margin:0;padding-left:20px">${what.join('')}</ul></div>
<p>Every email has a link to stop it. You can also <a href="/manage?t=${esc(sub.token)}">manage your emails</a> here at any time.</p>
${backToSite}`);
}

// ── Managing and unsubscribing ───────────────────────────

async function subscriberFor(url, env) {
  const t = url.searchParams.get('t') || '';
  return t ? one(env, 'SELECT * FROM subscribers WHERE token = ? AND confirmed = 1', t) : null;
}

const goneSubscriber = () => page('Not subscribed', `<h1>You’re not subscribed</h1>
<p>This address doesn't get any Re:Haven emails, and we don't keep it. You can sign up again on <a href="${SITE}/">Re:Haven</a>.</p>`, 404);

// Someone with no newsletter and no follows left is deleted, not kept.
async function prune(env, id) {
  const sub = await one(env, 'SELECT weekly FROM subscribers WHERE id = ?', id);
  const follows = await one(env, 'SELECT COUNT(*) AS n FROM follows WHERE subscriber = ?', id);
  if (sub && !sub.weekly && !follows.n) {
    await env.DB.batch([
      env.DB.prepare('DELETE FROM pending WHERE subscriber = ?').bind(id),
      env.DB.prepare('DELETE FROM subscribers WHERE id = ?').bind(id),
    ]);
    return true;
  }
  return false;
}

async function forget(env, id) {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM follows WHERE subscriber = ?').bind(id),
    env.DB.prepare('DELETE FROM pending WHERE subscriber = ?').bind(id),
    env.DB.prepare('DELETE FROM subscribers WHERE id = ?').bind(id),
  ]);
}

const deletedPage = () => page('Unsubscribed', `<h1>You’re unsubscribed</h1>
<p>You won't get any more emails from Re:Haven, and your address has been deleted.</p>
${backToSite}`);

const DONE = {
  'weekly-on': 'You’ll get the Sunday newsletter.',
  'weekly-off': 'The Sunday newsletter is off.',
  unfollow: 'Update alerts for that project are off.',
};

async function managePage(url, env) {
  const sub = await subscriberFor(url, env);
  if (!sub) return goneSubscriber();
  const map = await recomps().catch(() => new Map());
  const follows = await all(env, 'SELECT recomp FROM follows WHERE subscriber = ? ORDER BY created', sub.id);
  const t = esc(sub.token);
  const done = DONE[url.searchParams.get('done')];
  const form = (action, label, cls = '', extra = '') => `<form method="post" action="/manage?t=${t}">
<input type="hidden" name="do" value="${action}">${extra}<button type="submit" class="${cls}">${label}</button></form>`;
  const rows = follows.map(({ recomp }) => {
    const p = map.get(recomp);
    const name = p ? `<a href="${SITE}/games/${esc(p.slug)}/">${esc(projectName(p))}</a>` : esc(recomp);
    return `<li><span>${name}</span>${form('unfollow', 'Stop', 'ghost', `<input type="hidden" name="recomp" value="${esc(recomp)}">`)}</li>`;
  });
  return page('Your emails', `<h1>Your Re:Haven emails</h1>
<p class="muted">For ${esc(sub.email)}</p>
${done ? `<div class="box done">${esc(done)}</div>` : ''}
<div class="box">
<ul class="list"><li><span><strong>The Sunday newsletter</strong><br><span class="muted">${sub.weekly ? 'On' : 'Off'}: the week’s new and updated recomps</span></span>
${sub.weekly ? form('weekly-off', 'Turn off', 'ghost') : form('weekly-on', 'Turn on')}</li></ul>
</div>
<div class="box">
<p><strong>Update alerts</strong></p>
${rows.length ? `<ul class="list">${rows.join('')}</ul>`
    : '<p class="muted" style="margin:0">You don’t follow any projects. Use “Get update emails” on a game’s page to follow one.</p>'}
</div>
<div class="box">
<p style="margin-bottom:12px">Stop everything and delete your email address from Re:Haven.</p>
${form('delete', 'Unsubscribe from everything', 'danger')}
</div>
${backToSite}`);
}

async function manageAction(request, url, env) {
  const sub = await subscriberFor(url, env);
  if (!sub) return goneSubscriber();
  const form = await request.formData().catch(() => new FormData());
  const action = String(form.get('do') || '');
  if (action === 'delete') {
    await forget(env, sub.id);
    return deletedPage();
  }
  if (action === 'weekly-on' || action === 'weekly-off') {
    await run(env, 'UPDATE subscribers SET weekly = ? WHERE id = ?', action === 'weekly-on' ? 1 : 0, sub.id);
  } else if (action === 'unfollow') {
    await run(env, 'DELETE FROM follows WHERE subscriber = ? AND recomp = ?', sub.id, String(form.get('recomp') || ''));
  } else {
    return Response.redirect(`${url.origin}/manage?t=${encodeURIComponent(sub.token)}`, 303);
  }
  if (await prune(env, sub.id)) return deletedPage();
  return Response.redirect(`${url.origin}/manage?t=${encodeURIComponent(sub.token)}&done=${action}`, 303);
}

// list is "weekly", "recomp:<id>" or "all". Opening the link shows a button, so that mail
// scanners that follow links don't unsubscribe anyone; mail apps' own unsubscribe buttons
// POST to it (List-Unsubscribe-Post), which unsubscribes at once.
async function unsubscribePage(url, env) {
  const sub = await subscriberFor(url, env);
  if (!sub) return goneSubscriber();
  const list = url.searchParams.get('list') || 'all';
  let what = 'all Re:Haven emails';
  if (list === 'weekly') what = 'the Sunday newsletter';
  else if (list.startsWith('recomp:')) {
    const p = (await recomps().catch(() => new Map())).get(list.slice(7));
    what = `update alerts for ${p ? projectName(p) : list.slice(7)}`;
  }
  const action = `/unsubscribe?t=${esc(sub.token)}&list=${esc(encodeURIComponent(list))}`;
  return page('Unsubscribe', `<h1>Unsubscribe</h1>
<p>Stop sending ${esc(what)} to ${esc(sub.email)}?</p>
<form method="post" action="${action}"><button type="submit">Unsubscribe</button></form>
<p style="margin-top:18px" class="muted">Or <a href="/manage?t=${esc(sub.token)}">manage all your emails</a>.</p>`);
}

async function unsubscribeAction(url, env) {
  const sub = await subscriberFor(url, env);
  if (!sub) return goneSubscriber();
  const list = url.searchParams.get('list') || 'all';
  if (list === 'weekly') await run(env, 'UPDATE subscribers SET weekly = 0 WHERE id = ?', sub.id);
  else if (list.startsWith('recomp:')) await run(env, 'DELETE FROM follows WHERE subscriber = ? AND recomp = ?', sub.id, list.slice(7));
  else {
    await forget(env, sub.id);
    return deletedPage();
  }
  if (await prune(env, sub.id)) return deletedPage();
  return page('Unsubscribed', `<h1>Done</h1>
<p>${list === 'weekly' ? 'You won’t get the Sunday newsletter any more.' : 'You won’t get update alerts for that project any more.'}</p>
<p>Your other Re:Haven emails carry on. <a href="/manage?t=${esc(sub.token)}">Manage your emails</a>.</p>
${backToSite}`);
}

// ── Admin: called by the GitHub jobs with ADMIN_TOKEN ────

async function stats(env) {
  const counts = await one(env, `SELECT
      (SELECT COUNT(*) FROM subscribers WHERE confirmed = 1) AS confirmed,
      (SELECT COUNT(*) FROM subscribers WHERE confirmed = 0) AS unconfirmed,
      (SELECT COUNT(*) FROM subscribers WHERE confirmed = 1 AND weekly = 1) AS weekly`);
  const followed = await all(env, `SELECT f.recomp AS recomp, COUNT(*) AS followers, s.tag AS tag
      FROM follows f JOIN subscribers u ON u.id = f.subscriber AND u.confirmed = 1
      LEFT JOIN seen s ON s.recomp = f.recomp GROUP BY f.recomp ORDER BY f.recomp`);
  return json({ ok: true, ...counts, sentToday: await used(env, 'all'), dailyLimit: Number(env.DAILY_LIMIT) || 100, followed });
}

// Records a project's latest release tag and returns the one before (null the first time).
async function markSeen(request, env) {
  const { recomp, tag } = await request.json();
  if (!ID_RE.test(String(recomp || '')) || !tag) return json({ ok: false, message: 'recomp and tag are needed.' }, 400);
  const before = await one(env, 'SELECT tag FROM seen WHERE recomp = ?', recomp);
  await run(env, 'INSERT INTO seen (recomp, tag, at) VALUES (?, ?, ?) ON CONFLICT (recomp) DO UPDATE SET tag = excluded.tag, at = excluded.at',
    recomp, String(tag), now());
  return json({ ok: true, previous: before ? before.tag : null });
}

// Sends one page of a list: {list: "weekly" | "recomp:<id>", subject, html, text, after}.
// {{manage}} and {{unsubscribe}} in html and text become each person's own links.
// Returns next: the "after" for the next page, or null when the list is done.
async function sendList(request, url, env) {
  const { list, subject, html, text, after = 0 } = await request.json();
  if (!subject || !html || !text) return json({ ok: false, message: 'subject, html and text are needed.' }, 400);
  const room = (Number(env.DAILY_LIMIT) || 100) - await used(env, 'all');
  if (room <= 0) return json({ ok: true, sent: 0, next: after, limited: true });
  const size = Math.min(PAGE, room);
  let people;
  if (list === 'weekly') {
    people = await all(env, 'SELECT id, email, token FROM subscribers WHERE confirmed = 1 AND weekly = 1 AND id > ? ORDER BY id LIMIT ?',
      Number(after), size);
  } else if (typeof list === 'string' && list.startsWith('recomp:') && ID_RE.test(list.slice(7))) {
    people = await all(env, `SELECT u.id AS id, u.email AS email, u.token AS token FROM follows f
        JOIN subscribers u ON u.id = f.subscriber WHERE f.recomp = ? AND u.confirmed = 1 AND u.id > ? ORDER BY u.id LIMIT ?`,
      list.slice(7), Number(after), size);
  } else {
    return json({ ok: false, message: 'list must be "weekly" or "recomp:<id>".' }, 400);
  }
  if (!people.length) return json({ ok: true, sent: 0, next: null });

  const batch = people.map((p) => {
    const manage = `${url.origin}/manage?t=${encodeURIComponent(p.token)}`;
    const unsubscribe = `${url.origin}/unsubscribe?t=${encodeURIComponent(p.token)}&list=${encodeURIComponent(list)}`;
    const fill = (s) => s.replaceAll('{{manage}}', manage).replaceAll('{{unsubscribe}}', unsubscribe);
    return message(env, {
      to: p.email, subject, html: fill(html), text: fill(text),
      headers: { 'List-Unsubscribe': `<${unsubscribe}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' },
    });
  });
  const res = await resend(env, '/emails/batch', batch);
  if (!res.ok) return json({ ok: false, message: `Resend refused the batch (HTTP ${res.status}): ${res.detail}` }, 502);
  await bump(env, 'all', people.length);
  const last = people[people.length - 1].id;
  const full = people.length === size;
  return json({ ok: true, sent: people.length, next: full ? last : null, limited: full && size < PAGE });
}

// One copy to any address, with placeholder links, to check how an email looks.
async function sendTest(request, url, env) {
  const { to, subject, html, text } = await request.json();
  if (!EMAIL_RE.test(String(to || '')) || !subject || !html || !text) {
    return json({ ok: false, message: 'to, subject, html and text are needed.' }, 400);
  }
  const fill = (s) => s.replaceAll('{{manage}}', `${url.origin}/manage`).replaceAll('{{unsubscribe}}', `${url.origin}/unsubscribe`);
  const sent = await sendOne(env, { to, subject: `[Test] ${subject}`, html: fill(html), text: fill(text) }, 'test');
  return json({ ok: sent, message: sent ? `Sent to ${to}.` : 'Not sent: the daily limit is reached or Resend refused it.' }, sent ? 200 : 502);
}

async function getState(url, env) {
  const row = await one(env, 'SELECT value FROM state WHERE key = ?', url.searchParams.get('key') || '');
  return json({ ok: true, value: row ? JSON.parse(row.value) : null });
}

async function putState(request, env) {
  const { key, value } = await request.json();
  if (!key) return json({ ok: false, message: 'key is needed.' }, 400);
  await run(env, 'INSERT INTO state (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value',
    String(key), JSON.stringify(value ?? null));
  return json({ ok: true });
}

// ── Reviews: GitHub sign-in and threads for game-page reviews ────
//
// A review is posted by the reviewer's own browser, as their own comment in the project's
// thread (the same GitHub Discussion giscus shows), with a user token of the GitHub App. This
// Worker only does the two things a browser can't:
//   /auth/start, /auth/callback  sign the person in (the App's client secret stays here) and
//                                send them back to the game page with the token in the URL's
//                                fragment, which the page reads and removes at once
//   /reviews/thread              finds the project's thread, or starts it as the App: the
//                                category takes new discussions only from maintainers and apps
// tools/track_ratings.py reads the scores from the thread every night, as before.

const GH_API = 'https://api.github.com';
const GH_REPO = 'rikuwru/recomphaven';
const GH_CATEGORY = 'Ratings and comments';
const GH_HEADERS = { Accept: 'application/vnd.github+json', 'User-Agent': 'recomphaven-worker' };
const REVIEWS_PER_DAY = 30;  // thread lookups a day for one GitHub account
let appToken = { token: null, until: 0 };
let repoIds = null;

const repoName = (env) => env.GH_REPO || GH_REPO;
const b64url = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const b64urlText = (s) => b64url(new TextEncoder().encode(s));
const fromB64url = (s) => new TextDecoder().decode(Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0)));

async function hmac(secret, text) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64url(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(text)));
}

async function sha1(text) {
  const d = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Where a reviewer may be sent back to: a page on one of the site's own origins.
function returnUrl(env, raw) {
  try {
    const u = new URL(raw);
    return siteOrigins(env).includes(u.origin) ? `${u.origin}${u.pathname}${u.search}` : null;
  } catch {
    return null;
  }
}

async function authStart(url, env) {
  if (!env.GH_CLIENT_ID || !env.GH_CLIENT_SECRET) return new Response('Reviews aren’t set up yet.', { status: 503 });
  const back = returnUrl(env, url.searchParams.get('return') || SITE);
  if (!back) return new Response('Unknown site.', { status: 400 });
  const body = b64urlText(JSON.stringify({ r: back, t: Date.now(), n: randomToken(9) }));
  const state = `${body}.${await hmac(env.GH_CLIENT_SECRET, body)}`;
  const q = new URLSearchParams({ client_id: env.GH_CLIENT_ID, redirect_uri: `${url.origin}/auth/callback`, state });
  return Response.redirect(`https://github.com/login/oauth/authorize?${q}`, 302);
}

async function authCallback(url, env) {
  const [body, sig] = (url.searchParams.get('state') || '').split('.');
  let state = null;
  if (body && sig && env.GH_CLIENT_SECRET && sig === await hmac(env.GH_CLIENT_SECRET, body)) {
    try { state = JSON.parse(fromB64url(body)); } catch { state = null; }
  }
  const back = state && Date.now() - state.t < 15 * 60 * 1000 ? returnUrl(env, state.r) : null;
  if (!back) {
    return new Response('This sign-in link has expired. Go back to the game page and press Submit again.',
      { status: 400, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  }
  let result = { error: url.searchParams.get('error') || 'cancelled' };
  const code = url.searchParams.get('code');
  if (code) {
    const res = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { ...GH_HEADERS, Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: env.GH_CLIENT_ID, client_secret: env.GH_CLIENT_SECRET, code,
        redirect_uri: `${url.origin}/auth/callback` }),
    });
    const out = await res.json().catch(() => ({}));
    const user = out.access_token ? await ghUser(out.access_token) : null;
    result = user
      ? { token: out.access_token, login: user.login, expires: out.expires_in ? Date.now() + (out.expires_in - 120) * 1000 : null }
      : { error: out.error || 'failed' };
  }
  return new Response(null, {
    status: 302,
    headers: { Location: `${back}#rh-github=${b64urlText(JSON.stringify(result))}`, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' },
  });
}

async function ghUser(token) {
  if (!token) return null;
  const res = await fetch(`${GH_API}/user`, { headers: { ...GH_HEADERS, Authorization: `Bearer ${token}` } });
  return res.ok ? res.json() : null;
}

// The App's private key, as WebCrypto wants it. GitHub hands out PKCS#1 ("BEGIN RSA PRIVATE KEY"),
// which gets the PKCS#8 wrapper here; a PKCS#8 key ("BEGIN PRIVATE KEY") is used as it is.
function pkcs8(pem) {
  const text = String(pem || '').replace(/\\n/g, '\n');
  const der = Uint8Array.from(atob(text.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '')), (c) => c.charCodeAt(0));
  if (!/BEGIN RSA PRIVATE KEY/.test(text)) return der;
  const len = (n) => (n < 128 ? [n] : n < 256 ? [0x81, n] : [0x82, n >> 8, n & 255]);
  const algorithm = [0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00];
  const inner = [0x02, 0x01, 0x00, ...algorithm, 0x04, ...len(der.length)];
  return new Uint8Array([0x30, ...len(inner.length + der.length), ...inner, ...der]);
}

async function appJwt(env) {
  const key = await crypto.subtle.importKey('pkcs8', pkcs8(env.GH_PRIVATE_KEY), { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const t = Math.floor(Date.now() / 1000);
  const head = b64urlText(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64urlText(JSON.stringify({ iat: t - 60, exp: t + 540, iss: String(env.GH_CLIENT_ID) }));
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(`${head}.${claims}`));
  return `${head}.${claims}.${b64url(sig)}`;
}

// A token for the App itself on the repo, kept until five minutes before it expires.
async function installToken(env) {
  if (appToken.token && Date.now() < appToken.until) return appToken.token;
  const headers = { ...GH_HEADERS, Authorization: `Bearer ${await appJwt(env)}` };
  const inst = await fetch(`${GH_API}/repos/${repoName(env)}/installation`, { headers });
  if (!inst.ok) throw new Error(`GitHub App installation on ${repoName(env)}: HTTP ${inst.status}`);
  const res = await fetch(`${GH_API}/app/installations/${(await inst.json()).id}/access_tokens`, { method: 'POST', headers });
  if (!res.ok) throw new Error(`GitHub App token: HTTP ${res.status}`);
  const out = await res.json();
  appToken = { token: out.token, until: Date.parse(out.expires_at) - 5 * 60 * 1000 };
  return out.token;
}

async function gql(token, query, variables) {
  const res = await fetch(`${GH_API}/graphql`, {
    method: 'POST',
    headers: { ...GH_HEADERS, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  const out = await res.json().catch(() => ({}));
  if (!res.ok || out.errors) throw new Error(`GitHub GraphQL: HTTP ${res.status} ${JSON.stringify(out.errors || out).slice(0, 300)}`);
  return out.data;
}

async function repoAndCategory(env, token) {
  if (repoIds) return repoIds;
  const [owner, name] = repoName(env).split('/');
  const d = await gql(token, `query($o: String!, $n: String!) {
    repository(owner: $o, name: $n) { id discussionCategories(first: 50) { nodes { id name } } } }`, { o: owner, n: name });
  const category = d.repository.discussionCategories.nodes.find((c) => c.name === (env.GH_CATEGORY || GH_CATEGORY));
  if (!category) throw new Error(`No "${env.GH_CATEGORY || GH_CATEGORY}" discussion category on ${repoName(env)}`);
  repoIds = { repo: d.repository.id, category: category.id };
  return repoIds;
}

// POST /reviews/thread {term}, with the reviewer's token: the id of the project's discussion,
// started first if nobody has reviewed or commented on the project yet. Its title is the
// project's id and its body carries the term's SHA-1, the way giscus starts and finds threads
// in strict mode, so giscus shows the same thread on the game page.
async function reviewThread(request, env) {
  const headers = cors(request, env);
  if (!env.GH_CLIENT_ID || !env.GH_PRIVATE_KEY) return json({ ok: false, message: 'Reviews aren’t set up yet.' }, 503, headers);
  const user = await ghUser((request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, ''));
  if (!user) return json({ ok: false, signIn: true, message: 'Please sign in with GitHub again.' }, 401, headers);
  const { term } = await request.json().catch(() => ({}));
  const project = (await recomps()).get(String(term || ''));
  if (!project) return json({ ok: false, message: 'That project isn’t on the site.' }, 400, headers);
  const kind = 'review:' + (await sha256(`${user.id}|${env.ADMIN_TOKEN || ''}`)).slice(0, 24);
  if (await used(env, kind) >= REVIEWS_PER_DAY) {
    return json({ ok: false, message: 'That’s a lot of reviews for one day. Please try again tomorrow.' }, 429, headers);
  }
  await bump(env, kind);

  const key = `thread:${term}`;
  const saved = await one(env, 'SELECT value FROM state WHERE key = ?', key);
  if (saved) return json({ ok: true, discussion: JSON.parse(saved.value) }, 200, headers);

  const token = await installToken(env);
  const hash = await sha1(term);
  const found = await gql(token, `query($q: String!) {
    search(type: DISCUSSION, query: $q, first: 10) { nodes { ... on Discussion { id title body } } } }`,
    { q: `repo:${repoName(env)} "${hash}" in:body` });
  let id = (found.search.nodes.find((d) => d && d.title === term && d.body.includes(hash)) || {}).id;
  if (!id) {
    const ids = await repoAndCategory(env, token);
    const made = await gql(token, `mutation($r: ID!, $c: ID!, $t: String!, $b: String!) {
      createDiscussion(input: { repositoryId: $r, categoryId: $c, title: $t, body: $b }) { discussion { id } } }`,
      { r: ids.repo, c: ids.category, t: term, b: `# ${term}\n\n${SITE}/games/${project.slug}/\n\n<!-- sha1: ${hash} -->` });
    id = made.createDiscussion.discussion.id;
  }
  await run(env, 'INSERT INTO state (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value', key, JSON.stringify(id));
  return json({ ok: true, discussion: id }, 200, headers);
}
