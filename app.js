(() => {
  'use strict';

  // Projects whose repository hands out game files (romFiles, tools/check_roms.py) stay hidden.
  const DATA = (Array.isArray(window.RECOMPS) ? window.RECOMPS : []).filter((e) => !e.romFiles);
  const META = window.RECOMPHAVEN_META || {};
  const DAY = 864e5;

  // ── Reference tables ─────────────────────────────────────

  // Labels, colours and icons come from data/tables.js, shared with tools/build_pages.py.
  const TABLES = window.RECOMPHAVEN_TABLES;
  const CONSOLES = TABLES.consoles;
  const STAGES = TABLES.stages;
  const STAGE_ORDER = Object.keys(STAGES);
  const TIERS = TABLES.tiers;
  const TIER_ORDER = Object.keys(TIERS);
  const FEATURES = TABLES.features;
  // "Must have" chips: each matches any of its feature tags.
  const FEATURE_FILTERS = {
    widescreen: { label: 'Widescreen', tags: ['widescreen'] },
    'high-fps': { label: 'High frame rate', tags: ['high-fps'] },
    mods: { label: 'Mod support', tags: ['mods'] },
    modmgr: { label: 'Mod manager', tags: ['mod-manager'], title: 'Find and install community mods through a mod manager or mod site such as Thunderstore' },
    multiplayer: { label: 'Multiplayer', tags: ['multiplayer'] },
    kbm: { label: 'Keyboard/mouse', tags: ['keyboard-mouse', 'keyboard'], title: 'Playable with a keyboard, with or without the mouse' },
  };
  // Systems a recomp runs on: Windows, Linux, macOS, Android (the "platforms" field). Logos from
  // Simple Icons (CC0); the 24x24 paths are filled with currentColor.
  const OS = TABLES.os;
  const OS_ORDER = Object.keys(OS);
  const PLATFORM_SOURCE = TABLES.platformSource;
  const LANGUAGE_SOURCE = TABLES.languageSource;  // where "languages" came from (tools/detect_languages.py)
  // A project that doesn't name its languages is taken to be in English.
  const languagesOf = (e) => ((e.languages || []).length ? e.languages : ['English']);
  const languageSourceOf = (e) => ((e.languages || []).length ? e.languagesFrom || 'readme' : 'assumed');

  // Trending ranks by people who opened each project here in the last 3 days (visitsWeek, from
  // tools/track_visits.py). Until there are any, it uses GitHub stars gained this week
  // (starsWeek, from tools/track_stars.py).
  const BY_VISITS = DATA.some((e) => e.visitsWeek > 0);
  const trendOf = (e) => (BY_VISITS ? e.visitsWeek : e.starsWeek);

  const SORTS = {
    quality: { label: 'Quality', dir: 'asc', get: (e) => TIER_ORDER.indexOf(e.quality), dirs: ['Best first', 'Worst first'] },
    updated: { label: 'Last activity', dir: 'desc', get: (e) => e.updated, dirs: ['Oldest first', 'Newest first'] },
    release: { label: 'Latest release', dir: 'desc', get: (e) => e.versionDate, dirs: ['Oldest first', 'Newest first'] },
    started: { label: 'Project start', dir: 'desc', get: (e) => e.started, dirs: ['Oldest first', 'Newest first'] },
    added: { label: 'Recently added', dir: 'desc', get: (e) => e.added, dirs: ['Oldest first', 'Newest first'] },
    stars: { label: 'GitHub stars', dir: 'desc', get: (e) => e.stars, dirs: ['Fewest first', 'Most first'] },
    score: { label: 'User score', dir: 'desc', get: (e) => e.userScore, dirs: ['Lowest first', 'Highest first'] },
    trending: { label: 'Trending', dir: 'desc', get: (e) => trendOf(e), dirs: ['Fewest first', 'Most first'] },
    title: { label: 'Name', dir: 'asc', get: (e) => e.title, dirs: ['A to Z', 'Z to A'] },
    year: { label: 'Original release', dir: 'asc', get: (e) => e.year, dirs: ['Oldest first', 'Newest first'] },
    console: { label: 'Console', dir: 'asc', get: (e) => consoleOf(e).label, dirs: ['A to Z', 'Z to A'] },
    genre: { label: 'Genre', dir: 'asc', get: (e) => e.genre, dirs: ['A to Z', 'Z to A'] },
    stage: { label: 'Stage', dir: 'asc', get: (e) => STAGE_ORDER.indexOf(e.stage), dirs: ['Released first', 'Earliest first'] },
    toolchain: { label: 'Toolchain', dir: 'asc', get: (e) => e.toolchain, dirs: ['A to Z', 'Z to A'] },
  };

  // The feedback issue form (.github/ISSUE_TEMPLATE/feedback.yml). "Suggest a correction"
  // opens it with the game and project filled in.
  const FEEDBACK_URL = 'https://github.com/rikuwru/recomphaven/issues/new?template=feedback.yml';
  const PENCIL = '<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16v4Zm10-14 4 4" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linejoin="round"/></svg>';

  // User scores: the average of everyone's latest "N/10" in a project's comments on its game page
  // (tools/track_ratings.py, nightly). Comments exist once giscus is set up; the build marks that
  // with <meta name="rh-comments">.
  const COMMENTS_ON = !!document.querySelector('meta[name="rh-comments"]');
  const scoreText = (e) => e.userScore.toFixed(1);
  const ratingsText = (e) => `${e.userScoreCount} ${e.userScoreCount === 1 ? 'rating' : 'ratings'}`;
  // Rating trend (tools/track_ratings.py): the average score since the latest release minus the
  // one before it, there once five or more people have rated on each side. long adds "since vX".
  const trendTag = (e, long) => {
    if (e.scoreTrend == null) return '';
    const t = e.scoreTrend;
    const dir = t > 0 ? 'up' : t < 0 ? 'down' : 'flat';
    const text = `${t > 0 ? '▲ +' : t < 0 ? '▼ −' : '= '}${Math.abs(t).toFixed(1)}`;
    const since = esc(e.scoreTrendSince || 'the latest release');
    return `<span class="trend trend--${dir}" title="Average score since ${since} compared with before it">${text}${long ? ` since ${since}` : ''}</span>`;
  };

  // Email: the Sunday newsletter and per-project update alerts, run by a Cloudflare Worker
  // (newsletter/worker.js). The build puts its address in <meta name="rh-mail"> once it's set
  // up; until then the sign-up forms stay hidden. game.js does the same on game pages.
  const MAIL_API = ((document.querySelector('meta[name="rh-mail"]') || {}).content || '').replace(/\/+$/, '');
  const BELL = '<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path d="M6 16V11a6 6 0 0 1 12 0v5l2 2H4l2-2Zm4 4h4" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round"/></svg>';
  const followForm = (formId, e) => `
      <form class="mail-form mail-form--follow" id="${formId}" data-mail-form data-recomp="${esc(e.id)}" hidden>
        <p class="mail-form__lead">Email me as soon as ${esc(e.project || e.title)} puts out a new release.</p>
        <div class="mail-form__row">
          <input type="email" name="email" required autocomplete="email" placeholder="you@example.com" aria-label="Your email address">
          <button class="btn" type="submit">Follow</button>
        </div>
        <label class="mail-form__check"><input type="checkbox" name="weekly"> Also send me the Sunday newsletter</label>
        <input class="mail-form__hp" type="text" name="website" tabindex="-1" autocomplete="off" aria-hidden="true">
        <p class="mail-form__status" role="status"></p>
      </form>`;

  async function submitMail(form) {
    const status = form.querySelector('.mail-form__status');
    const button = form.querySelector('button[type="submit"]');
    const data = new FormData(form);
    const email = String(data.get('email') || '').trim();
    const body = { email, website: String(data.get('website') || ''), weekly: !form.dataset.recomp || data.get('weekly') === 'on' };
    if (form.dataset.recomp) body.recomp = form.dataset.recomp;
    button.disabled = true;
    status.dataset.state = '';
    status.textContent = 'Sending…';
    try {
      const res = await fetch(`${MAIL_API}/subscribe`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      const out = await res.json().catch(() => ({}));
      const ok = res.ok && out.ok !== false;
      status.dataset.state = ok ? 'ok' : 'error';
      status.textContent = out.message || (ok ? `Almost done: check ${email} for a link to confirm.` : 'Something went wrong. Please try again later.');
      if (ok) store.set('rh-mail-email', email);
    } catch {
      status.dataset.state = 'error';
      status.textContent = 'Couldn’t reach the sign-up service. Check your connection and try again.';
    } finally {
      button.disabled = false;
    }
  }

  if (MAIL_API) {
    document.addEventListener('submit', (ev) => {
      const form = ev.target.closest('form[data-mail-form]');
      if (!form) return;
      ev.preventDefault();
      submitMail(form);
    });
    // "Get update emails" opens its form, with the address used last time filled in.
    document.addEventListener('click', (ev) => {
      const toggle = ev.target.closest('[data-follow-toggle]');
      const form = toggle && document.getElementById(toggle.getAttribute('aria-controls'));
      if (!form) return;
      form.hidden = !form.hidden;
      toggle.setAttribute('aria-expanded', String(!form.hidden));
      if (form.hidden) return;
      const input = form.querySelector('input[type="email"]');
      if (!input.value) input.value = store.get('rh-mail-email') || '';
      input.focus();
    });
  }

  // Featured playthrough: a YouTube video picked for a project ("playthrough" in the data). It
  // shows as a thumbnail; YouTube's player (its privacy-enhanced, no-cookie one) loads only when
  // someone presses play. game.js does the same on game pages.
  const youtubeId = (url) => (String(url || '').match(
    /(?:youtu\.be\/|youtube(?:-nocookie)?\.com\/(?:watch\?(?:.*&)?v=|embed\/|shorts\/|live\/))([\w-]{11})/) || [])[1];
  const PLAY_ICON = '<svg viewBox="0 0 68 48" width="68" height="48" aria-hidden="true"><path d="M66.5 7.7a8.5 8.5 0 0 0-6-6C55.2.3 34 .3 34 .3s-21.2 0-26.5 1.4a8.5 8.5 0 0 0-6 6C.1 13 .1 24 .1 24s0 11 1.4 16.3a8.5 8.5 0 0 0 6 6C12.8 47.7 34 47.7 34 47.7s21.2 0 26.5-1.4a8.5 8.5 0 0 0 6-6C67.9 35 67.9 24 67.9 24s0-11-1.4-16.3Z" fill="#e00"/><path d="M45 24 27 14v20z" fill="#fff"/></svg>';
  function videoHtml(e) {
    const id = youtubeId(e.playthrough);
    if (!id) return '';
    return `<figure class="video">
        <button type="button" class="video__play" data-youtube="${id}" aria-label="Play the featured playthrough of ${esc(e.project || e.title)}">
          <img src="https://i.ytimg.com/vi/${id}/hqdefault.jpg" alt="" loading="lazy">${PLAY_ICON}
        </button>
        <figcaption><a href="https://www.youtube.com/watch?v=${id}" target="_blank" rel="noopener">Watch on YouTube ↗</a></figcaption>
      </figure>`;
  }
  // Pressing play swaps the thumbnail for the player.
  function playVideo(button) {
    const frame = document.createElement('iframe');
    frame.src = `https://www.youtube-nocookie.com/embed/${button.dataset.youtube}?autoplay=1&rel=0`;
    frame.title = button.getAttribute('aria-label').replace(/^Play the /, 'The ');
    frame.allow = 'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share';
    frame.allowFullscreen = true;
    frame.referrerPolicy = 'strict-origin-when-cross-origin';
    button.replaceWith(frame);
  }
  document.addEventListener('click', (ev) => {
    const button = ev.target.closest('button[data-youtube]');
    if (button) playVideo(button);
  });

  const correctionUrl = (e) => `${FEEDBACK_URL}&${new URLSearchParams({
    title: `[Feedback]: ${e.title}`,
    game: e.title,
    details: `About ${e.project || e.title}${e.repo || e.website ? ` (${e.repo || e.website})` : ''}:\n\n`,
  })}`;

  // Each game has a page at games/<slug>/, built by tools/build_pages.py, whose slug_of()
  // this must match. A trailing note in brackets doesn't count unless it's a year, so
  // "Daytona USA (Arcade)" and "Daytona USA (XBLA)" share daytona-usa.
  const slugOf = (title) => title.replace(/\s*\((?!\d{4}\))[^)]*\)\s*$/, '').normalize('NFKD').replace(/[^\x00-\x7f]/g, '')
    .toLowerCase().replace(/['.]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const SLUG = new Map(DATA.map((e) => [e.id, slugOf(e.title)]));
  const PROJECTS_PER_GAME = new Map();
  SLUG.forEach((s) => PROJECTS_PER_GAME.set(s, (PROJECTS_PER_GAME.get(s) || 0) + 1));

  // Visits for Trending (tools/track_visits.py): one GoatCounter event per project, sent
  // when its details open or someone follows its repository or website link. GoatCounter
  // counts each visitor once per event. Its script is only on the built site, once set up.
  function countVisit(e) {
    const send = () => {
      try {
        window.goatcounter.count({ path: `recomp/${e.id}`, title: `${e.title} · ${e.project || e.title}`, event: true });
      } catch { /* not loaded */ }
    };
    // A link straight to a project opens it before GoatCounter's script has loaded.
    if ((window.goatcounter && window.goatcounter.count) || document.readyState === 'complete') send();
    else window.addEventListener('load', send, { once: true });
  }

  const DEFAULTS = { q: '', console: '', genre: '', quality: '', toolchain: '', os: '', sort: 'quality', dir: 'asc' };

  const state = {
    ...DEFAULTS,
    stages: new Set(),
    features: new Set(),
    hideAI: false,
    view: 'table',
  };

  // ── Helpers ──────────────────────────────────────────────

  const $ = (sel) => document.querySelector(sel);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const consoleOf = (e) => CONSOLES[e.console] || { label: e.console, short: String(e.console).toUpperCase(), color: '#555' };

  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* storage unavailable */ } },
  };

  const today = Date.now();
  const daysSince = (d) => (d ? Math.max(0, Math.floor((today - Date.parse(d + 'T00:00:00Z')) / DAY)) : null);

  function activity(e) {
    const n = daysSince(e.updated);
    if (n == null) return 'unknown';
    if (n <= 60) return 'active';
    if (n <= 180) return 'quiet';
    return 'stalled';
  }

  function relTime(d) {
    const n = daysSince(d);
    if (n == null) return 'Unknown';
    if (n === 0) return 'Today';
    if (n === 1) return 'Yesterday';
    if (n < 45) return `${n} days ago`;
    if (n < 365) return `${Math.round(n / 30.4)} months ago`;
    const y = n / 365;
    return y < 1.5 ? '1 year ago' : `${Math.round(y)} years ago`;
  }

  const fmtDate = (d) => {
    if (!d) return '';
    const dt = new Date(d + 'T00:00:00Z');
    return dt.toLocaleDateString('en-US', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
  };

  const fmtStars = (n) => (n == null ? '—' : n >= 1000 ? (n / 1000).toFixed(n >= 10000 ? 0 : 1).replace(/\.0$/, '') + 'k' : String(n));
  const gainTag = (e) => (e.starsWeek > 0
    ? `<span class="gain" title="${e.starsWeek.toLocaleString('en')} new GitHub stars in the last 7 days">+${fmtStars(e.starsWeek)}</span>` : '');

  const ctag = (e) => {
    const c = consoleOf(e);
    return `<span class="ctag" style="--c:${c.color}" title="${esc(c.label)}">${esc(c.short)}</span>`;
  };
  const stagePill = (e) => `<span class="stage" data-stage="${e.stage}">${esc(STAGES[e.stage]?.label || e.stage)}</span>`;
  const tierTile = (e) => `<span class="tier" data-tier="${e.quality}" title="${esc(e.quality + ': ' + (TIERS[e.quality]?.label || ''))}">${e.quality}</span>`;
  const aiTag = (e) => (e.ai ? '<span class="ai" title="The project discloses substantial AI-generated code">AI</span>' : '');
  const osIcon = (k) => `<svg class="os-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="${OS[k].path}"/></svg>`;

  // Table: only the systems it runs on, in the filter's order. A faded logo for the others
  // read as "runs here too".
  function osSlots(e) {
    if (!e.platforms) return '<span class="muted small" title="Not stated by the project">—</span>';
    const names = e.platforms.map((k) => OS[k].label).join(', ');
    return `<span class="os-set" title="Runs on ${esc(names)}" aria-label="Runs on ${esc(names)}">${OS_ORDER
      .filter((k) => e.platforms.includes(k)).map(osIcon).join('')}</span>`;
  }

  // Cards: only the supported logos.
  function osInline(e) {
    if (!e.platforms) return '';
    const names = e.platforms.map((k) => OS[k].label).join(', ');
    return `<span class="os-set os-set--inline" title="Runs on ${esc(names)}" aria-label="Runs on ${esc(names)}">${e.platforms.map(osIcon).join('')}</span>`;
  }

  const actTag = (e) => `<span class="act act--${activity(e)}" title="${e.updated ? 'Last push ' + esc(fmtDate(e.updated)) : 'No activity data'}">${esc(relTime(e.updated))}</span>`;

  const STOPWORDS = new Set(['the', 'of', 'and', 'a', 'an', 'to', 'in']);
  function initials(title) {
    const words = title.replace(/\s*\([^)]*\)\s*$/, '').split(/[^A-Za-z0-9]+/).filter((w) => w && !STOPWORDS.has(w.toLowerCase()));
    return words.slice(0, 2).map((w) => w[0]).join('').toUpperCase();
  }

  // Box art, or the console's colour with the game's initials when there is none.
  // size: sm (table), md (cards), lg (detail panel).
  function coverTile(e, size) {
    const attrs = `class="cover cover--${size}${e.cover ? '' : ' cover--none'}" style="--c:${consoleOf(e).color}" data-initials="${esc(initials(e.title))}"`;
    return e.cover
      ? `<span ${attrs}><img src="${esc(e.cover)}" alt="" loading="lazy" decoding="async"></span>`
      : `<span ${attrs} aria-hidden="true">${esc(initials(e.title))}</span>`;
  }

  // The detail panel shows the whole box at its own shape; no cover keeps the square tile.
  function fullCover(e) {
    if (!e.cover) return coverTile(e, 'lg');
    return `<figure class="d-cover" style="--c:${consoleOf(e).color}" data-initials="${esc(initials(e.title))}">
      <img src="${esc(e.cover)}" alt="Box art for ${esc(e.title)}" decoding="async"></figure>`;
  }

  function subline(e) {
    const bits = [e.project, e.team && e.team !== e.project ? e.team : null].filter(Boolean);
    return `${esc(bits.join(' · '))}${aiTag(e)}`;
  }

  // ── Filtering & sorting ──────────────────────────────────

  // Search forgives typos. Accents, case and punctuation don't count ("pokemon" finds Pokémon,
  // "pt" finds P.T.), and spaces may be left out ("supermario"). A typed word matches the start of
  // a word (four letters or more may match inside one too). A typed word that matches nothing that
  // way matches the closest words in game and project names instead, one letter off in a short
  // word and two in a longer one, so "legnd of zlda" finds the Zelda games.
  const fold = (s) => String(s).normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/['’.]/g, '').replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim();
  const haystack = new Map(DATA.map((e) => {
    const text = fold([
      e.title, e.project, e.team, e.toolchain, e.genre, e.developer, consoleOf(e).label, consoleOf(e).short, e.year,
    ].filter(Boolean).join(' '));
    const seq = text.split(' ');
    const names = [...new Set(fold(`${e.title} ${e.project || ''}`).split(' '))].filter((w) => w.length >= 4);
    return [e.id, { text, seq, names }];
  }));
  const HAY = [...haystack.values()];

  function hasTerm(h, t) {
    if (t.length >= 4 && h.text.includes(t)) return true;
    // From the start of a word, running on into the next words when spaces were left out.
    for (let i = 0; i < h.seq.length; i++) {
      let run = '';
      for (let j = i; j < h.seq.length && run.length < t.length; j++) {
        run += h.seq[j];
        if (!(run.startsWith(t) || t.startsWith(run))) break;
        if (run.startsWith(t)) return true;
      }
    }
    return false;
  }
  const NAME_WORDS = [...new Set(HAY.flatMap((h) => h.names))];

  // Edit distance with swapped neighbours counting as one edit, giving up past max.
  function editDistance(a, b, max) {
    if (Math.abs(a.length - b.length) > max) return max + 1;
    let before = null;
    let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
    for (let i = 1; i <= a.length; i++) {
      const cur = [i];
      let best = i;
      for (let j = 1; j <= b.length; j++) {
        let d = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
        if (before && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d = Math.min(d, before[j - 2] + 1);
        cur[j] = d;
        best = Math.min(best, d);
      }
      if (best > max) return max + 1;
      before = prev;
      prev = cur;
    }
    return prev[b.length];
  }

  // A word is close to what was typed if it's within the typo allowance: one letter for three to
  // five typed letters, two for more. From five letters, the start of a longer word counts too,
  // for a word still being typed. One or two typed letters must match exactly.
  function isNear(typed, word) {
    const max = typed.length <= 2 ? 0 : typed.length <= 5 ? 1 : 2;
    if (!max) return false;
    const forms = typed.length >= 5 ? [word, word.slice(0, typed.length), word.slice(0, typed.length + 1)] : [word];
    return forms.some((w) => w.length >= typed.length - max && editDistance(typed, w, max) <= max);
  }

  // The typed words, each with the set of close words it stands for when it matches nothing as
  // typed. Worked out once per search, not once per row.
  let searchCache = { q: null, terms: [] };
  function searchTerms() {
    if (searchCache.q !== state.q) {
      const terms = fold(state.q).split(' ').filter(Boolean).map((t) => {
        const found = HAY.some((h) => hasTerm(h, t));
        return { t, near: found ? null : new Set(NAME_WORDS.filter((w) => isNear(t, w))) };
      });
      searchCache = { q: state.q, terms };
    }
    return searchCache.terms;
  }

  function matches(e, ignoreStage) {
    if (state.q) {
      const h = haystack.get(e.id);
      for (const { t, near } of searchTerms()) {
        if (near ? !h.names.some((w) => near.has(w)) : !hasTerm(h, t)) return false;
      }
    }
    if (state.console && e.console !== state.console) return false;
    if (state.genre && e.genre !== state.genre) return false;
    if (state.quality && e.quality !== state.quality) return false;
    if (state.toolchain && e.toolchain !== state.toolchain) return false;
    if (state.os && !(e.platforms || []).includes(state.os)) return false;
    if (!ignoreStage && state.stages.size && !state.stages.has(e.stage)) return false;
    for (const f of state.features) if (!FEATURE_FILTERS[f].tags.some((t) => (e.features || []).includes(t))) return false;
    if (state.hideAI && e.ai) return false;
    return true;
  }

  function sortList(list) {
    const s = SORTS[state.sort] || SORTS.quality;
    const m = state.dir === 'desc' ? -1 : 1;
    return list.slice().sort((a, b) => {
      const va = s.get(a);
      const vb = s.get(b);
      const na = va == null || va === '' || va === -1;
      const nb = vb == null || vb === '' || vb === -1;
      if (na !== nb) return na ? 1 : -1;
      if (!na && va !== vb) {
        const c = typeof va === 'string' ? va.localeCompare(vb, 'en', { sensitivity: 'base' }) : va - vb;
        if (c) return c * m;
      }
      return (b.stars || 0) - (a.stars || 0) || a.title.localeCompare(b.title, 'en');
    });
  }

  const isFiltered = () =>
    !!(state.q || state.console || state.genre || state.quality || state.toolchain || state.os ||
      state.stages.size || state.features.size || state.hideAI);

  // ── Rendering ────────────────────────────────────────────

  function renderStageTiles() {
    const base = DATA.filter((e) => matches(e, true));
    const counts = Object.fromEntries(STAGE_ORDER.map((s) => [s, 0]));
    base.forEach((e) => { counts[e.stage] = (counts[e.stage] || 0) + 1; });
    $('#stage-tiles').innerHTML = STAGE_ORDER.map((s) => `
      <button type="button" class="stage-tile" data-stage="${s}" aria-pressed="${state.stages.has(s)}">
        <span class="stage-tile__n">${counts[s]}</span>
        <span class="stage-tile__dot" aria-hidden="true"></span>
        <span class="stage-tile__label">${STAGES[s].label}</span>
        <span class="stage-tile__blurb">${STAGES[s].blurb}</span>
      </button>`).join('');
  }

  function renderTable(list) {
    $('#rows').innerHTML = list.map((e) => `
      <tr data-id="${esc(e.id)}">
        <td><div class="game-cell">${coverTile(e, 'sm')}<div class="game">
          <button type="button" class="game__title" data-open="${esc(e.id)}">${esc(e.title)}</button>
          <span class="game__sub">${subline(e)}</span>
        </div></div></td>
        <td>${ctag(e)}</td>
        <td class="col-os">${osSlots(e)}</td>
        <td class="col-genre"><div class="stack"><span>${esc(e.genre)}</span><span class="small muted">${e.year || ''}</span></div></td>
        <td>${stagePill(e)}</td>
        <td>${tierTile(e)}</td>
        <td class="col-release">${e.version || e.versionDate
          ? `<div class="stack"><span class="mono trunc" title="${esc(e.version || 'Release')}">${esc(e.version || 'Release')}</span><span class="small muted">${esc(fmtDate(e.versionDate))}</span></div>`
          : '<span class="muted">No release</span>'}</td>
        <td class="small col-activity">${actTag(e)}</td>
        <td class="num col-score">${e.userScore != null
          ? `<div class="stack"><span class="mono score">${scoreText(e)}</span><span class="small muted">${ratingsText(e)}</span>${trendTag(e)}</div>`
          : '<span class="muted">—</span>'}</td>
        <td class="num"><div class="stack"><span class="mono">${fmtStars(e.stars)}</span>${gainTag(e)}</div></td>
      </tr>`).join('');

    document.querySelectorAll('.grid th[data-sort]').forEach((th) => {
      if (th.dataset.sort === state.sort) th.setAttribute('aria-sort', state.dir === 'asc' ? 'ascending' : 'descending');
      else th.removeAttribute('aria-sort');
    });
  }

  function renderCards(list) {
    $('#card-view').innerHTML = list.map((e) => `
      <article class="card" data-id="${esc(e.id)}">
        <div class="card__top">
          <div class="card__meta">${ctag(e)}<span>${esc(e.genre)}</span>${e.year ? `<span>${e.year}</span>` : ''}${osInline(e)}</div>
          ${tierTile(e)}
        </div>
        <div class="card__main">${coverTile(e, 'md')}<div class="game">
          <button type="button" class="game__title" data-open="${esc(e.id)}">${esc(e.title)}</button>
          <span class="game__sub">${subline(e)}</span>
        </div></div>
        ${(e.features || []).length ? `<div class="feats">${e.features.map((f) => `<span class="feat">${esc(FEATURES[f] || f)}</span>`).join('')}</div>` : ''}
        <div class="card__foot">
          ${stagePill(e)}
          <span class="muted">${actTag(e)}${e.userScore != null ? `<span class="mono" title="User score, from ${ratingsText(e)}">${scoreText(e)}/10</span>` : ''}<span class="mono" title="GitHub stars">★ ${fmtStars(e.stars)} ${gainTag(e)}</span></span>
        </div>
      </article>`).join('');
  }

  function render() {
    const list = sortList(DATA.filter((e) => matches(e)));
    renderStageTiles();

    const total = DATA.length;
    const guessed = state.q ? searchTerms().filter((x) => x.near && x.near.size).map((x) => x.t) : [];
    $('#count').innerHTML = (list.length === total
      ? `<strong>${total}</strong> recomps tracked`
      : `Showing <strong>${list.length}</strong> of ${total} recomps`)
      + (guessed.length && list.length
        ? ` <span class="count__guess">· close matches for ${guessed.map((t) => `“${esc(t)}”`).join(', ')}</span>` : '');

    $('#reset').disabled = !isFiltered();
    $('#empty').hidden = list.length > 0;
    $('#table-view').hidden = state.view !== 'table' || !list.length;
    $('#card-view').hidden = state.view !== 'cards' || !list.length;
    document.querySelectorAll('.segmented button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.view === state.view)));

    if (state.view === 'table') renderTable(list); else renderCards(list);

    const s = SORTS[state.sort];
    $('#sort').value = state.sort;
    $('#sort-dir').textContent = s.dirs[state.dir === 'asc' ? 0 : 1];
    $('#sort-dir').setAttribute('aria-label', `Sort direction: ${s.dirs[state.dir === 'asc' ? 0 : 1]}. Click to reverse.`);

    for (const [id, key] of [['#f-console', 'console'], ['#f-genre', 'genre'], ['#f-quality', 'quality'], ['#f-toolchain', 'toolchain']]) {
      const el = $(id);
      el.value = state[key];
      el.classList.toggle('is-set', !!state[key]);
    }
    $('#hide-ai').checked = state.hideAI;
    document.querySelectorAll('#os-filter button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.os === state.os)));
    document.querySelectorAll('#feature-chips .chip').forEach((c) => c.setAttribute('aria-pressed', String(state.features.has(c.dataset.feature))));

    writeURL();
  }

  // ── Static UI ────────────────────────────────────────────

  function countBy(key) {
    const m = new Map();
    DATA.forEach((e) => m.set(e[key], (m.get(e[key]) || 0) + 1));
    return m;
  }

  function fillSelect(el, allLabel, entries) {
    el.innerHTML = `<option value="">${allLabel}</option>` +
      entries.map(([v, label, n]) => `<option value="${esc(v)}">${esc(label)} (${n})</option>`).join('');
  }

  function buildControls() {
    const consoles = countBy('console');
    fillSelect($('#f-console'), 'All consoles', [...consoles]
      .sort((a, b) => b[1] - a[1] || consoleOf({ console: a[0] }).label.localeCompare(consoleOf({ console: b[0] }).label))
      .map(([k, n]) => [k, consoleOf({ console: k }).label, n]));

    const genres = countBy('genre');
    fillSelect($('#f-genre'), 'All genres', [...genres].sort((a, b) => a[0].localeCompare(b[0])).map(([k, n]) => [k, k, n]));

    const tiers = countBy('quality');
    fillSelect($('#f-quality'), 'Any quality', TIER_ORDER.filter((t) => tiers.has(t)).map((t) => [t, `${t} · ${TIERS[t].label}`, tiers.get(t)]));

    const tools = countBy('toolchain');
    fillSelect($('#f-toolchain'), 'All toolchains', [...tools]
      .sort((a, b) => (a[0] === 'Custom') - (b[0] === 'Custom') || b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([k, n]) => [k, k === 'Custom' ? 'Custom or unlisted' : k, n]));

    $('#sort').innerHTML = Object.entries(SORTS).map(([k, s]) => `<option value="${k}">${s.label}</option>`).join('');

    const osCount = (k) => DATA.filter((e) => (e.platforms || []).includes(k)).length;
    $('#os-filter').innerHTML = `<button type="button" data-os="" aria-pressed="true">All</button>` +
      OS_ORDER.map((k) => `<button type="button" data-os="${k}" aria-pressed="false" aria-label="${OS[k].label}" title="${osCount(k)} recomps run on ${OS[k].label}">${osIcon(k)}<span>${OS[k].label}</span></button>`).join('');

    $('#feature-chips').innerHTML = '<span class="chips__label">Must have</span>' + Object.entries(FEATURE_FILTERS).map(([f, c]) =>
      `<button type="button" class="chip" data-feature="${f}" aria-pressed="false"${c.title ? ` title="${c.title}"` : ''}>${c.label}</button>`).join('');

    $('#tier-list').innerHTML = TIER_ORDER.map((t) => {
      const n = DATA.filter((e) => e.quality === t).length;
      return `<div class="tier-row" data-tier="${t}">
        <div class="tier-row__label">${t}</div>
        <div class="tier-row__text"><strong>${TIERS[t].label} <em>${n} ${n === 1 ? 'project' : 'projects'}</em></strong><span>${TIERS[t].text}</span></div>
      </div>`;
    }).join('');

    $('#stage-list').innerHTML = STAGE_ORDER.map((s) =>
      `<dt><span class="stage" data-stage="${s}">${STAGES[s].label}</span></dt><dd>${STAGES[s].long}</dd>`).join('');

    if (META.snapshot) {
      $('#snapshot').dateTime = META.snapshot;
      $('#snapshot').textContent = fmtDate(META.snapshot);
    }
  }

  // ── What's new: the trending release, latest releases, newly added ──

  const LATEST = DATA.filter((e) => e.versionDate)
    .sort((a, b) => b.versionDate.localeCompare(a.versionDate) || (b.stars || 0) - (a.stars || 0))
    .slice(0, 5);
  // Newest additions to the catalogue first ("added", the day an entry went in); the same day by stars.
  const NEWLY_ADDED = DATA.filter((e) => e.added)
    .sort((a, b) => b.added.localeCompare(a.added) || (b.stars || 0) - (a.stars || 0))
    .slice(0, 5);
  const TRENDING = DATA.filter((e) => trendOf(e) >= 2)
    .sort((a, b) => trendOf(b) - trendOf(a) || (b.stars || 0) - (a.stars || 0));

  function pulseRow(e, sub, meta) {
    return `<li><button type="button" class="pulse__row" data-open="${esc(e.id)}">${coverTile(e, 'sm')}
      <span class="pulse__main"><span class="pulse__title">${esc(e.title)}</span><span class="game__sub">${sub}</span></span>
      <span class="pulse__meta">${meta}</span></button></li>`;
  }

  function renderPulse() {
    $('#latest-list').innerHTML = LATEST.map((e) => pulseRow(e,
      `${esc(e.project || '')} <span class="mono">${esc(e.version || '')}</span>`,
      `<span title="${esc(fmtDate(e.versionDate))}">${esc(relTime(e.versionDate))}</span>`)).join('');
    $('#added-list').innerHTML = NEWLY_ADDED.map((e) => pulseRow(e, esc(e.project || ''),
      `<span title="Added to Recomp Haven on ${esc(fmtDate(e.added))}">${esc(relTime(e.added))}</span>`)).join('');
    renderSpot();
  }

  // The top 5 trending projects, across both columns, one at a time: each over its first backdrop
  // picture (data/media.js, already out of focus), or else its box art blurred, slowly drifting. A
  // picture fades in once it has loaded. The bar under the active game fills over 9 seconds and then the next game
  // crossfades in; the arrows and bars move by hand. Pointing at the box, or keyboard focus in it,
  // pauses it, and it doesn't move by itself for people who ask for less motion (the bar's
  // animation is off, and its end is what moves it on). With nothing trending the box stays hidden.
  const TRENDING_ICON = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M3 17 9.5 10.5l4 4L21 7M14.5 7H21v6.5" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const chevron = (d) => `<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="${d}" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  // Box art is small and sharp: drawn tiny and scaled back up (blurred too where the browser can),
  // it turns into soft colour. Done once, so the drift moves a plain picture; a CSS blur would be
  // redone every frame.
  function softened(img) {
    const small = document.createElement('canvas');
    small.width = 24;
    small.height = Math.max(1, Math.round(24 * img.naturalHeight / img.naturalWidth));
    small.getContext('2d').drawImage(img, 0, 0, small.width, small.height);
    const big = document.createElement('canvas');
    big.width = 240;
    big.height = Math.round(240 * small.height / small.width);
    const ctx = big.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.filter = 'blur(6px) saturate(1.25)';
    ctx.drawImage(small, -18, -18, big.width + 36, big.height + 36);  // past the edges, which blur thin
    return big.toDataURL('image/jpeg', 0.85);
  }
  function renderSpot() {
    const top = TRENDING.slice(0, 5);
    if (!top.length) return;
    const box = $('#spot');
    const many = top.length > 1;
    const picOf = (e) => {
      const slug = SLUG.get(e.id);
      const pic = ((MEDIA.games[slug] || {}).backdrop || [])[0];
      return pic
        ? { url: `${MEDIA.base}backdrops/${encodeURIComponent(slug)}/${encodeURIComponent(pic.file)}`, focus: pic.focus || 'center' }
        : e.cover ? { url: e.cover, focus: 'center', cover: true } : null;
    };
    const pics = top.map(picOf);
    const slide = (e, i) => {
      const c = consoleOf(e);
      const stat = BY_VISITS
        ? `<strong>${e.visitsWeek.toLocaleString('en')}</strong> visitors in the last 3 days`
        : `<strong class="gain">+${e.starsWeek.toLocaleString('en')}</strong> GitHub stars this week`;
      return `<div class="spot__slide" role="group" aria-roledescription="slide" aria-label="${i + 1} of ${top.length}: ${esc(e.title)}">
        ${e.cover ? `<img class="spot__cover" src="${esc(e.cover)}" alt="Box art for ${esc(e.title)}" decoding="async"${i ? ' loading="lazy"' : ''}>` : coverTile(e, 'lg')}
        <div class="spot__text">
          <div class="d-head__meta spot__meta"><span class="spot__rank">#${i + 1}</span>${ctag(e)}<span>${esc(c.label)}</span>${e.year ? `<span>· ${e.year}</span>` : ''}${e.developer ? `<span>· ${esc(e.developer)}</span>` : ''}</div>
          <h3 class="spot__title">${esc(e.title)}</h3>
          <div class="d-head__meta spot__sub">${subline(e)}</div>
          <div class="spot__facts">${tierTile(e)}${stagePill(e)}${e.version
            ? `<span title="Latest release, ${esc(fmtDate(e.versionDate))}"><span class="mono">${esc(e.version)}</span> · ${esc(relTime(e.versionDate))}</span>` : ''}${osInline(e)}</div>
        </div>
        ${e.summary ? `<p class="spot__summary">${esc(e.summary)}</p>` : '<span></span>'}
        <div class="spot__foot">
          <a class="btn btn--rate" href="games/${SLUG.get(e.id)}/">Game page</a>
          <span class="spot__stat">${stat}</span>
        </div>
      </div>`;
    };
    box.innerHTML = `
      <div class="spot__bgs" aria-hidden="true">${pics.map((p) => (p
        ? `<div class="spot__bg" style="background-position:${esc(p.focus)}"></div>` : '<div class="spot__bg"></div>')).join('')}</div>
      <div class="spot__head">
        <h2 class="spot__heading">${TRENDING_ICON}Trending releases</h2>
        <button type="button" class="pulse__link" data-sort-trending>Sort by trending →</button>
      </div>
      <div class="spot__slides">${top.map(slide).join('')}</div>
      ${many ? `<div class="spot__dots">${top.map((e, i) => `<button type="button" class="spot__dot" data-spot="${i}" aria-label="Show #${i + 1}, ${esc(e.title)}"><span class="spot__fill"></span></button>`).join('')}</div>
      <button type="button" class="spot__arrow spot__arrow--prev" data-spot-step="-1" aria-label="Previous trending game">${chevron('M15 5l-7 7 7 7')}</button>
      <button type="button" class="spot__arrow spot__arrow--next" data-spot-step="1" aria-label="Next trending game">${chevron('M9 5l7 7-7 7')}</button>` : ''}`;
    $('.spot-wrap').hidden = false;

    const bgs = [...box.querySelectorAll('.spot__bg')];
    const slides = [...box.querySelectorAll('.spot__slide')];
    const dots = [...box.querySelectorAll('.spot__dot')];
    // Each picture drifts left and zooms in a little while it shows, and keeps going as it fades
    // out, then rests hidden.
    const drift = (el) => {
      el.classList.remove('is-drifting');
      void el.offsetWidth;  // starts the drift over
      el.classList.add('is-drifting');
    };
    const load = (i) => {
      const p = pics[i];
      if (!p || bgs[i].dataset.loading) return;
      bgs[i].dataset.loading = '1';
      const img = new Image();
      img.onload = () => {
        bgs[i].style.backgroundImage = `url("${p.cover ? softened(img) : p.url}")`;
        bgs[i].classList.add('is-loaded');
        if (i === at) drift(bgs[i]);  // it was waiting to load: drift from the start
      };
      img.src = p.url;
    };
    let at = -1;
    const show = (i) => {
      i = (i + top.length) % top.length;
      if (i === at) return;
      const out = bgs[at];
      if (out) setTimeout(() => { if (!out.classList.contains('is-on')) out.classList.remove('is-drifting'); }, 1300);
      at = i;
      [bgs, slides].forEach((set) => set.forEach((el, k) => el.classList.toggle('is-on', k === i)));
      drift(bgs[i]);
      dots.forEach((d, k) => {
        d.classList.remove('is-on');
        d.toggleAttribute('aria-current', k === i);
      });
      if (dots[i]) {
        void dots[i].offsetWidth;  // starts its bar over
        dots[i].classList.add('is-on');
      }
      load(i);
      if (many) load((i + 1) % top.length);  // ready before its turn
    };
    show(0);
    box.addEventListener('click', (ev) => {
      const dot = ev.target.closest('[data-spot]');
      const step = ev.target.closest('[data-spot-step]');
      if (dot) show(+dot.dataset.spot);
      else if (step) show(at + +step.dataset.spotStep);
    });
    box.addEventListener('animationend', (ev) => {
      if (ev.target.classList.contains('spot__fill')) show(at + 1);
    });
  }

  // ── Thanks (data/credits.js) ─────────────────────────────

  const PROFILES = {
    github: (n) => [`https://github.com/${encodeURIComponent(n)}`, `@${n}`],
    reddit: (n) => [`https://www.reddit.com/user/${encodeURIComponent(n)}/`, `u/${n}`],
  };

  function renderNewsletter() {
    if (!MAIL_API) return;
    const section = $('#newsletter');
    const input = $('#nl-email');
    section.hidden = false;
    $('#newsletter-btn').hidden = false;
    if (!input.value) input.value = store.get('rh-mail-email') || '';
    // The masthead's Newsletter button scrolls down to the box and puts the cursor in it,
    // without touching the #id hash the details dialog uses.
    document.addEventListener('click', (ev) => {
      if (!ev.target.closest('a[href="#newsletter"]')) return;
      ev.preventDefault();
      goToNewsletter();
    });
  }

  // Smooth for a short way; a jump from far up a phone's long card list.
  function goToNewsletter() {
    const section = $('#newsletter');
    const far = Math.abs(section.getBoundingClientRect().top) > 4 * window.innerHeight;
    section.scrollIntoView({ behavior: far ? 'auto' : 'smooth', block: 'center' });
    $('#nl-email').focus({ preventScroll: true });
  }

  function renderThanks() {
    const people = (window.RECOMPHAVEN_CREDITS || []).filter((p) => PROFILES[p.site]);
    $('.thanks').hidden = !people.length;
    $('#thanks-list').innerHTML = people.map((p) => {
      const [url, handle] = PROFILES[p.site](p.name);
      return `<li><a href="${esc(url)}" target="_blank" rel="noopener">${esc(handle)}</a>${p.for ? `<span>${esc(p.for)}</span>` : ''}</li>`;
    }).join('');
  }

  // ── Detail dialog ────────────────────────────────────────

  const dialog = $('#detail');

  function openDetail(id, { push = true } = {}) {
    const e = DATA.find((x) => x.id === id);
    if (!e) return;
    const c = consoleOf(e);
    const t = TIERS[e.quality] || { label: '', text: '' };
    const fact = (k, v) => (v ? `<div><dt>${k}</dt><dd>${v}</dd></div>` : '');
    const slug = SLUG.get(e.id);
    const siblings = PROJECTS_PER_GAME.get(slug);

    $('#d-body').innerHTML = `
      <button type="button" class="d-close" data-close aria-label="Close">×</button>
      <div class="d-head">
        ${fullCover(e)}
        <div class="d-head__text">
          <div class="d-head__meta">${ctag(e)}<span>${esc(c.label)}</span>${e.year ? `<span>· ${e.year}</span>` : ''}${e.developer ? `<span>· ${esc(e.developer)}</span>` : ''}</div>
          <h2 class="d-title" id="d-title">${esc(e.title)}</h2>
          <div class="d-head__meta">${subline(e)}</div>
        </div>
      </div>
      <div class="d-verdict">
        <span class="tier" data-tier="${e.quality}">${e.quality}</span>
        <div><strong>${esc(t.label)}</strong><span>${esc(t.text)}</span></div>
      </div>
      ${siblings > 1 ? `<a class="d-compare" href="games/${slug}/"><span>${siblings} projects cover this game.</span><strong>Which one should I play? →</strong></a>` : ''}
      <dl class="facts">
        ${fact('Stage', stagePill(e))}
        ${fact('Genre', esc(e.genre))}
        ${fact('Toolchain', `<span class="mono">${esc(e.toolchain === 'Custom' ? 'Custom or unlisted' : e.toolchain)}</span>`)}
        <div class="fact--wide"><dt>Runs on</dt><dd>${e.platforms
          ? `<span class="os-chips">${e.platforms.map((k) => `<span class="os-chip">${osIcon(k)}${OS[k].label}</span>`).join('')}</span>${
            PLATFORM_SOURCE[e.platformsFrom] ? `<span class="small muted os-note">${PLATFORM_SOURCE[e.platformsFrom]}</span>` : ''}`
          : '<span class="muted">Not stated by the project</span>'}</dd></div>
        ${(e.planned || []).length ? `<div class="fact--wide"><dt>Planned for</dt><dd><span class="os-chips">${e.planned.map((k) => `<span class="os-chip os-chip--planned">${osIcon(k)}${OS[k].label}</span>`).join('')}</span><span class="small muted os-note">What the project says is coming next</span></dd></div>` : ''}
        <div class="fact--wide"><dt>Languages</dt><dd>${esc(languagesOf(e).join(', '))}<span class="small muted os-note">${
          esc(LANGUAGE_SOURCE[languageSourceOf(e)])}</span></dd></div>
        ${fact('Latest release', e.version || e.versionDate ? `<span class="mono">${esc(e.version || 'Release')}</span>${e.versionDate ? `<br><span class="small muted">${esc(fmtDate(e.versionDate))}</span>` : ''}` : '<span class="muted">No release yet</span>')}
        ${fact('Last activity', `${actTag(e)}${e.updated ? `<br><span class="small muted">${esc(fmtDate(e.updated))}</span>` : ''}`)}
        ${fact('User score', e.userScore != null
          ? `<span class="mono">${scoreText(e)}</span> <span class="small muted">/ 10</span><br><span class="small muted">${ratingsText(e)}</span>${
            e.scoreTrend != null ? `<br>${trendTag(e, true)}` : ''}`
          : COMMENTS_ON ? `<a href="games/${slug}/#comments">Be the first to rate it</a>` : '')}
        ${fact('Project started', e.started ? esc(fmtDate(e.started)) : '')}
        ${fact('GitHub stars', e.stars != null ? `<span class="mono">${e.stars.toLocaleString('en')}</span>${
          e.starsWeek > 0 ? `<br><span class="small gain">+${e.starsWeek.toLocaleString('en')} this week</span>` : ''}` : '')}
        ${fact('Maintained by', esc(e.team || ''))}
        ${fact('Original developer', esc(e.developer || ''))}
      </dl>
      ${e.summary ? `<div class="d-section"><h3>About this recomp</h3><p>${esc(e.summary)}</p></div>` : ''}
      ${youtubeId(e.playthrough) ? `<div class="d-section"><h3>Re: Playthrough</h3>${videoHtml(e)}</div>` : ''}
      ${(e.features || []).length ? `<div class="d-section"><h3>Features</h3><div class="feats">${e.features.map((f) => `<span class="feat">${esc(FEATURES[f] || f)}</span>`).join('')}</div></div>` : ''}
      ${e.requires ? `<div class="d-section"><h3>What you need</h3><p class="d-note">${esc(e.requires)}</p></div>` : ''}
      ${e.ai ? '<div class="d-section"><p class="d-note">This project discloses that a substantial share of its code was written with AI tools.</p></div>' : ''}
      <div class="d-links">
        ${e.repo ? `<a class="btn" href="${esc(e.repo)}" target="_blank" rel="noopener" data-visit="${esc(e.id)}">Open repository ↗</a>` : ''}
        ${e.website ? `<a class="btn btn--ghost" href="${esc(e.website)}" target="_blank" rel="noopener" data-visit="${esc(e.id)}">Project website ↗</a>` : ''}
        ${COMMENTS_ON ? `<a class="btn btn--rate" href="games/${slug}/#comments">Rate and comment</a>` : ''}
        ${siblings > 1 ? '' : `<a class="btn btn--rate" href="games/${slug}/">Game page</a>`}
        <a class="btn btn--ghost" href="${esc(correctionUrl(e))}" target="_blank" rel="noopener" title="Something wrong or out of date? Opens the feedback form on GitHub with this game filled in">${PENCIL}Suggest a correction</a>
        ${MAIL_API ? `<button class="btn btn--ghost" type="button" data-follow-toggle aria-expanded="false" aria-controls="d-follow">${BELL}Get update emails</button>` : ''}
        ${MAIL_API ? followForm('d-follow', e) : ''}
      </div>`;

    showBackdrop(slug);
    if (!dialog.open) {
      if (typeof dialog.showModal === 'function') dialog.showModal(); else dialog.setAttribute('open', '');
    }
    dialog.scrollTop = 0;
    $('#d-body').scrollTop = 0;
    if (push) pushDetail(e.id);
    countVisit(e);
  }

  // A game with a backdrop (data/media.js) shows it behind its details, as on its game page
  // (game.js): every 9 seconds the next picture fades in, drifting left and zooming in as it
  // goes. It stays on the first picture for people who ask for less motion.
  const MEDIA = window.RECOMPHAVEN_MEDIA || { base: '', games: {} };
  const calm = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  let backdropTimer = 0;
  let backdropSlug = null;
  function showBackdrop(slug) {
    const box = $('#d-backdrop');
    const pics = (MEDIA.games[slug] || {}).backdrop || [];
    dialog.classList.toggle('has-backdrop', pics.length > 0);
    box.hidden = !pics.length;
    if (slug === backdropSlug && pics.length) return;  // the same game: keep it running
    clearInterval(backdropTimer);
    backdropSlug = slug;
    const url = (p) => `${MEDIA.base}backdrops/${encodeURIComponent(slug)}/${encodeURIComponent(p.file)}`;
    box.innerHTML = pics.map((p) => `<div class="backdrop__slide" style="background-image:url(&quot;${esc(url(p))}&quot;);background-position:${esc(p.focus || 'center')}"></div>`).join('');
    const slides = [...box.children];
    if (!slides.length) return;
    const drift = (s) => {
      s.classList.remove('is-drifting');
      void s.offsetWidth;  // starts the drift over
      s.classList.add('is-drifting');
    };
    // The first picture waits until it has loaded, then fades in and starts drifting, so it
    // doesn't pop in late. Another game opened meanwhile has its own pictures.
    let at = 0;
    let begun = false;
    const begin = () => {
      if (begun || backdropSlug !== slug || !slides[0].isConnected) return;
      begun = true;
      slides[0].classList.add('is-first');  // a quicker fade than between pictures
      void slides[0].offsetWidth;
      slides[0].classList.add('is-on');
      setTimeout(() => slides[0].classList.remove('is-first'), 1500);
      if (calm) return;
      drift(slides[0]);
      if (slides.length > 1) {
        pics.slice(1).forEach((p) => { new Image().src = url(p); });  // loaded before their turn
        backdropTimer = setInterval(() => {
          const out = slides[at];
          out.classList.remove('is-on');  // fades out, still drifting, then rests hidden
          setTimeout(() => { if (!out.classList.contains('is-on')) out.classList.remove('is-drifting'); }, 2600);
          at = (at + 1) % slides.length;
          drift(slides[at]);
          slides[at].classList.add('is-on');
        }, 9000);
      }
    };
    const first = new Image();
    first.onload = first.onerror = begin;
    first.src = url(pics[0]);
    if (first.complete) begin();
  }

  // Opening a game's details adds a history entry (#id), so the browser's or phone's Back button
  // closes them instead of leaving the site. detailPushed says the current entry is one this page
  // added, so closing with ✕, Esc or a click outside steps back over it rather than leaving it in
  // the way of the next Back. An entry the page didn't add (a shared #id link) is never stepped
  // back over: that would leave the site.
  let detailPushed = false;
  function pushDetail(id) {
    if (detailPushed) return setHash(id);
    try {
      history.pushState({ detail: id }, '', location.pathname + location.search + '#' + id);
      detailPushed = true;
    } catch { setHash(id); }
  }
  const ownsEntry = (id) => !!id && !!history.state && history.state.detail === id;

  function closeDetail() {
    if (dialog.open) dialog.close();
  }

  // A cover that fails to load turns into the initials placeholder.
  document.addEventListener('error', (ev) => {
    const box = ev.target instanceof HTMLImageElement && ev.target.closest('.cover, .d-cover');
    if (!box) return;
    if (box.classList.contains('d-cover')) box.className = 'cover cover--lg';
    box.classList.add('cover--none');
    box.textContent = box.dataset.initials;
  }, true);

  document.addEventListener('click', (ev) => {
    const link = ev.target.closest('a[data-visit]');
    const e = link && DATA.find((x) => x.id === link.dataset.visit);
    if (e) countVisit(e);
  });

  dialog.addEventListener('close', () => {
    dialog.querySelectorAll('.video iframe').forEach((frame) => frame.remove());
    clearInterval(backdropTimer);
    backdropSlug = null;
    if (detailPushed) {
      detailPushed = false;
      history.back();
    } else {
      setHash('');
    }
  });
  dialog.addEventListener('click', (ev) => {
    if (ev.target === dialog || ev.target.closest('[data-close]')) closeDetail();
  });

  // ── URL state ────────────────────────────────────────────

  function setHash(id) {
    try {
      const url = location.pathname + location.search + (id ? '#' + id : '');
      history.replaceState(null, '', url);
    } catch { /* history unavailable */ }
  }

  function writeURL() {
    try {
      const p = new URLSearchParams();
      for (const k of ['q', 'console', 'genre', 'quality', 'toolchain', 'os']) if (state[k]) p.set(k, state[k]);
      if (state.stages.size) p.set('stage', [...state.stages].join(','));
      if (state.features.size) p.set('has', [...state.features].join(','));
      if (state.hideAI) p.set('noai', '1');
      if (state.sort !== DEFAULTS.sort || state.dir !== DEFAULTS.dir) { p.set('sort', state.sort); p.set('dir', state.dir); }
      const qs = p.toString();
      history.replaceState(history.state, '', location.pathname + (qs ? '?' + qs : '') + location.hash);
    } catch { /* history unavailable */ }
  }

  function readURL() {
    let p;
    try { p = new URLSearchParams(location.search); } catch { return; }
    for (const k of ['q', 'console', 'genre', 'quality', 'toolchain']) if (p.get(k)) state[k] = p.get(k);
    if (OS[p.get('os')]) state.os = p.get('os');
    (p.get('stage') || '').split(',').filter((s) => STAGES[s]).forEach((s) => state.stages.add(s));
    (p.get('has') || '').split(',').filter((f) => FEATURE_FILTERS[f]).forEach((f) => state.features.add(f));
    state.hideAI = p.get('noai') === '1';
    if (SORTS[p.get('sort')]) state.sort = p.get('sort');
    // A sort given without a direction goes its own way: ?sort=added shows the newest first.
    state.dir = ['asc', 'desc'].includes(p.get('dir')) ? p.get('dir') : SORTS[state.sort].dir;
  }

  // ── Theme ────────────────────────────────────────────────

  const root = document.documentElement;
  const darkMQ = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
  const isDark = () => root.dataset.theme ? root.dataset.theme === 'dark' : !!(darkMQ && darkMQ.matches);
  function syncThemeButton() {
    $('#theme-toggle').setAttribute('aria-label', isDark() ? 'Switch to light theme' : 'Switch to dark theme');
  }
  const savedTheme = store.get('rh-theme');
  if (savedTheme === 'dark' || savedTheme === 'light') root.dataset.theme = savedTheme;
  $('#theme-toggle').addEventListener('click', () => {
    root.dataset.theme = isDark() ? 'light' : 'dark';
    store.set('rh-theme', root.dataset.theme);
    syncThemeButton();
  });
  darkMQ && darkMQ.addEventListener && darkMQ.addEventListener('change', syncThemeButton);
  syncThemeButton();

  // ── Events ───────────────────────────────────────────────

  function setSort(key, dir) {
    if (!SORTS[key]) return;
    state.sort = key;
    state.dir = dir || SORTS[key].dir;
    render();
  }

  function resetFilters() {
    Object.assign(state, { q: '', console: '', genre: '', quality: '', toolchain: '', os: '', hideAI: false });
    state.stages.clear();
    state.features.clear();
    $('#q').value = '';
    render();
  }

  let qTimer;
  $('#q').addEventListener('input', (ev) => {
    clearTimeout(qTimer);
    qTimer = setTimeout(() => { state.q = ev.target.value.trim(); render(); }, 120);
  });

  for (const [id, key] of [['#f-console', 'console'], ['#f-genre', 'genre'], ['#f-quality', 'quality'], ['#f-toolchain', 'toolchain']]) {
    $(id).addEventListener('change', (ev) => { state[key] = ev.target.value; render(); });
  }

  $('#sort').addEventListener('change', (ev) => setSort(ev.target.value));
  $('#sort-dir').addEventListener('click', () => setSort(state.sort, state.dir === 'asc' ? 'desc' : 'asc'));

  $('#feature-chips').addEventListener('click', (ev) => {
    const chip = ev.target.closest('.chip');
    if (!chip) return;
    const f = chip.dataset.feature;
    state.features.has(f) ? state.features.delete(f) : state.features.add(f);
    render();
  });

  $('#hide-ai').addEventListener('change', (ev) => { state.hideAI = ev.target.checked; render(); });

  $('#os-filter').addEventListener('click', (ev) => {
    const b = ev.target.closest('button[data-os]');
    if (!b) return;
    state.os = b.dataset.os;
    render();
  });

  $('#stage-tiles').addEventListener('click', (ev) => {
    const tile = ev.target.closest('.stage-tile');
    if (!tile) return;
    const s = tile.dataset.stage;
    state.stages.has(s) ? state.stages.delete(s) : state.stages.add(s);
    render();
  });

  $('#reset').addEventListener('click', resetFilters);
  $('#empty-reset').addEventListener('click', resetFilters);

  document.querySelector('.segmented').addEventListener('click', (ev) => {
    const b = ev.target.closest('button[data-view]');
    if (!b) return;
    state.view = b.dataset.view;
    store.set('rh-view', state.view);
    render();
  });

  document.querySelector('.grid thead').addEventListener('click', (ev) => {
    const th = ev.target.closest('th[data-sort]');
    if (!th) return;
    const key = th.dataset.sort;
    if (key === state.sort) setSort(key, state.dir === 'asc' ? 'desc' : 'asc');
    else setSort(key);
  });

  $('#results').addEventListener('click', (ev) => {
    const opener = ev.target.closest('[data-open]') || ev.target.closest('tr[data-id], .card[data-id]');
    if (!opener || ev.target.closest('a')) return;
    openDetail(opener.dataset.open || opener.dataset.id);
  });

  for (const section of document.querySelectorAll('.spot-wrap, .pulse')) {
    section.addEventListener('click', (ev) => {
      const row = ev.target.closest('[data-open]');
      const sort = ev.target.closest('[data-sort-trending], [data-sort-added]');
      if (row) {
        openDetail(row.dataset.open);
      } else if (sort) {
        setSort('sortTrending' in sort.dataset ? 'trending' : 'added');
        $('#results').scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    });
  }

  // Back and Forward: open or close the details to match the address. Set detailPushed first, so a
  // close caused by Back doesn't step back a second time.
  window.addEventListener('hashchange', () => {
    const id = decodeURIComponent(location.hash.slice(1));
    detailPushed = ownsEntry(id);
    if (id && DATA.some((e) => e.id === id)) openDetail(id, { push: false });
    else closeDetail();
  });

  // ── Boot ─────────────────────────────────────────────────

  const savedView = store.get('rh-view');
  state.view = savedView === 'cards' || savedView === 'table'
    ? savedView
    : (window.matchMedia && window.matchMedia('(max-width: 760px)').matches ? 'cards' : 'table');

  readURL();
  buildControls();
  renderPulse();
  renderNewsletter();
  renderThanks();
  $('#q').value = state.q;
  render();

  // Game pages' Newsletter button links to #newsletter, a box that was still hidden when the
  // browser looked for it. Done again after load, when the browser's own jump to #newsletter
  // has taken the cursor back out of the box.
  if (MAIL_API && location.hash === '#newsletter') {
    goToNewsletter();
    window.addEventListener('load', () => setTimeout(goToNewsletter, 0), { once: true });
  }
  const initial = decodeURIComponent(location.hash.slice(1));
  if (initial && DATA.some((e) => e.id === initial)) {
    detailPushed = ownsEntry(initial);  // true when Back from a game page returns to open details
    openDetail(initial, { push: false });
  }
})();
