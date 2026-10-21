// Game pages (games/<slug>/, built by tools/build_pages.py): the theme toggle, the ratings and
// comments, update-email sign-ups, visit counting and the box-art fallback. The list page does
// its share in app.js.
(() => {
  'use strict';

  const root = document.documentElement;
  // Leaving the page: the music below swaps this for one that fades the sound out first.
  let leaveSoftly = (go) => go();
  const button = document.getElementById('theme-toggle');
  const darkMQ = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
  const isDark = () => root.dataset.theme ? root.dataset.theme === 'dark' : !!(darkMQ && darkMQ.matches);
  const sync = () => button.setAttribute('aria-label', isDark() ? 'Switch to light theme' : 'Switch to dark theme');

  let saved = null;
  try { saved = localStorage.getItem('rh-theme'); } catch { /* storage unavailable */ }
  if (saved === 'dark' || saved === 'light') root.dataset.theme = saved;
  button.addEventListener('click', () => {
    root.dataset.theme = isDark() ? 'light' : 'dark';
    try { localStorage.setItem('rh-theme', root.dataset.theme); } catch { /* storage unavailable */ }
    sync();
    giscus({ theme: isDark() ? 'dark' : 'light' });
  });
  darkMQ && darkMQ.addEventListener && darkMQ.addEventListener('change', sync);
  sync();

  // ── Ratings and comments (giscus, see comments_html() in tools/build_pages.py) ──

  // Settings for giscus before it has loaded wait for it.
  let ready = false;
  const pending = {};
  function giscus(config) {
    const frame = document.querySelector('iframe.giscus-frame');
    if (ready && frame) frame.contentWindow.postMessage({ giscus: { setConfig: config } }, 'https://giscus.app');
    else Object.assign(pending, config);
  }

  // giscus starts in the system's light or dark, on the page's pick; once it's up, match a theme
  // picked with the toggle and a project picked before it loaded.
  window.addEventListener('message', (ev) => {
    if (ev.origin !== 'https://giscus.app' || ready) return;
    ready = true;
    if (root.dataset.theme) pending.theme = isDark() ? 'dark' : 'light';
    if (Object.keys(pending).length) giscus(pending);
  });

  const comments = document.getElementById('comments');
  if (comments) {
    const status = comments.querySelector('.gp-rate__status');
    const tabs = [...comments.querySelectorAll('.gp-tabs [data-term]')];
    const form = comments.querySelector('form[data-review-form]');
    let review = null;

    const showProject = (term) => {
      tabs.forEach((t) => t.setAttribute('aria-selected', String(t.dataset.term === term)));
      giscus({ term });
      if (review) review.show(term);
      else if (status) status.textContent = '';
    };
    tabs.forEach((t) => t.addEventListener('click', () => showProject(t.dataset.term)));

    // "Be the first to rate it" on a project's card opens that project's thread.
    document.addEventListener('click', (ev) => {
      const link = ev.target.closest('a[data-rate]');
      if (link && tabs.length) showProject(link.dataset.rate);
    });

    if (form) review = reviewForm(form, tabs, showProject);
    else comments.querySelector('.gp-rate__buttons').addEventListener('click', async (ev) => {
      const b = ev.target.closest('button[data-score]');
      if (!b) return;
      const text = `Score: ${b.dataset.score}/10`;
      comments.querySelectorAll('.gp-rate__buttons button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
      try {
        await navigator.clipboard.writeText(`${text}\n\n`);
        status.textContent = `Copied "${text}". Paste it at the start of your comment below, add your thoughts, and post.`;
      } catch {
        status.textContent = `Start your comment below with "${text}", then add your thoughts and post.`;
      }
    });
  }

  // Reviews (REVIEWS_ON in tools/build_pages.py): a score, a written review and Submit. The first
  // Submit signs the person in with GitHub through the Worker in data-api (/auth/start), which
  // sends them back here with a token in the URL's fragment; the review waits in sessionStorage
  // meanwhile and goes out on the way back. The Worker finds or starts the project's thread
  // (/reviews/thread), and the review is posted to it from here as the reviewer's own comment,
  // "Score: N/10" first, which is what tools/track_ratings.py reads.
  function reviewForm(form, tabs, showProject) {
    const API = form.dataset.api.replace(/\/+$/, '');
    const MIN = Number(form.dataset.min) || 20;
    const SESSION = 'rh-github', DRAFT = 'rh-review-draft';
    const text = form.querySelector('textarea');
    const submit = form.querySelector('button[type="submit"]');
    const count = form.querySelector('.gp-review__count');
    const who = form.querySelector('.gp-review__who');
    const status = form.querySelector('.gp-review__status');
    const scores = [...form.querySelectorAll('button[data-score]')];
    const terms = tabs.length ? tabs.map((t) => t.dataset.term) : [form.dataset.term];
    let term = (tabs.find((t) => t.getAttribute('aria-selected') === 'true') || form).dataset.term;
    let score = 0, busy = false;

    const keep = {
      get(area, key) { try { return JSON.parse(window[area].getItem(key) || 'null'); } catch { return null; } },
      set(area, key, value) {
        try {
          if (value == null) window[area].removeItem(key);
          else window[area].setItem(key, JSON.stringify(value));
        } catch { /* storage unavailable */ }
      },
    };
    const session = () => {
      const s = keep.get('localStorage', SESSION);
      return s && s.token && (!s.expires || s.expires > Date.now()) ? s : null;
    };
    const say = (message, state = '', link = null) => {
      status.dataset.state = state;
      status.textContent = message;
      if (link) {
        const a = Object.assign(document.createElement('a'), { href: link, target: '_blank', rel: 'noopener', textContent: 'See it on GitHub ↗' });
        status.append(' ', a);
      }
    };

    const update = () => {
      const left = MIN - text.value.trim().length;
      const needs = [!score && 'Pick a score', left > 0 && `${left} more character${left === 1 ? '' : 's'}`].filter(Boolean);
      count.textContent = needs.length ? needs.join(' · ') : `${text.value.trim().length} characters`;
      submit.disabled = busy || needs.length > 0;
      const s = session();
      who.hidden = !s;
      if (s) who.querySelector('strong').textContent = `@${s.login}`;
    };
    const setScore = (n) => {
      score = n;
      scores.forEach((b) => b.setAttribute('aria-pressed', String(Number(b.dataset.score) === n)));
      update();
    };
    const show = (t) => {
      term = t;
      const tab = tabs.find((x) => x.dataset.term === t);
      if (tab) form.querySelector('[data-review-name]').textContent = tab.textContent;
      if (!busy) say('');
    };
    const restore = (draft) => {
      if (draft.term !== term) {
        showProject(draft.term);
        show(draft.term);
      }
      text.value = draft.review || '';
      setScore(Number(draft.score) || 0);
    };

    function signIn(draft, again) {
      keep.set('localStorage', SESSION, null);
      keep.set('sessionStorage', DRAFT, draft);
      say(again ? 'Your GitHub sign-in has run out. Taking you to GitHub to sign in again…' : 'Taking you to GitHub to sign in…');
      leaveSoftly(() => location.assign(`${API}/auth/start?return=${encodeURIComponent(location.href.split('#')[0])}`));
    }

    async function send() {
      const draft = { term, score, review: text.value.trim() };
      const s = session();
      if (!s) return signIn(draft, false);
      busy = true;
      update();
      say('Posting your review…');
      try {
        const res = await fetch(`${API}/reviews/thread`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${s.token}` },
          body: JSON.stringify({ term: draft.term }),
        });
        const out = await res.json().catch(() => ({}));
        if (res.status === 401 || out.signIn) return signIn(draft, true);
        if (!res.ok || !out.ok) throw new Error(out.message || 'Something went wrong. Please try again later.');
        const gh = await fetch('https://api.github.com/graphql', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${s.token}` },
          body: JSON.stringify({
            query: 'mutation($d: ID!, $b: String!) { addDiscussionComment(input: { discussionId: $d, body: $b }) { comment { url } } }',
            variables: { d: out.discussion, b: `Score: ${draft.score}/10\n\n${draft.review}` },
          }),
        });
        if (gh.status === 401) return signIn(draft, true);
        const posted = await gh.json().catch(() => ({}));
        const comment = posted.data && posted.data.addDiscussionComment && posted.data.addDiscussionComment.comment;
        if (!gh.ok || !comment) {
          throw new Error(`GitHub didn’t take the review: ${(posted.errors && posted.errors[0].message) || posted.message || `HTTP ${gh.status}`}`);
        }
        keep.set('sessionStorage', DRAFT, null);
        text.value = '';
        setScore(0);
        say('Thanks, your review is posted. It can take a minute to show below, and the User score updates overnight.', 'ok', comment.url);
        setTimeout(() => reloadThread(draft.term), 2500);
      } catch (err) {
        say(err instanceof TypeError ? 'Couldn’t reach GitHub or the review service. Check your connection and try again.' : err.message, 'error');
      } finally {
        busy = false;
        update();
      }
    }

    // giscus doesn't fetch a thread again for the term it's showing, so load it afresh.
    function reloadThread(t) {
      const frame = document.querySelector('iframe.giscus-frame');
      if (!frame) return;
      const u = new URL(frame.src);
      u.searchParams.set('term', t);
      if (root.dataset.theme) u.searchParams.set('theme', isDark() ? 'dark' : 'light');
      frame.src = u.href;
    }

    form.querySelector('.gp-rate__buttons').addEventListener('click', (ev) => {
      const b = ev.target.closest('button[data-score]');
      if (b) setScore(Number(b.dataset.score));
    });
    text.addEventListener('input', update);
    form.addEventListener('submit', (ev) => {
      ev.preventDefault();
      if (!submit.disabled) send();
    });
    form.querySelector('[data-review-signout]').addEventListener('click', () => {
      keep.set('localStorage', SESSION, null);
      update();
      say('Signed out of GitHub on this site.');
    });

    // A review left unsent on this page (GitHub's sign-in page closed with Back) comes back, and
    // on the way back from signing in it goes out.
    const draft = keep.get('sessionStorage', DRAFT);
    const mine = draft && terms.includes(draft.term) ? draft : null;
    if (mine) restore(mine);
    const back = location.hash.match(/^#rh-github=([\w-]+)/);
    if (back) {
      history.replaceState(null, '', `${location.pathname}${location.search}#comments`);
      let result = { error: 'failed' };
      try {
        const b64 = back[1].replace(/-/g, '+').replace(/_/g, '/');
        result = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))));
      } catch { /* a broken link: treated as a failed sign-in */ }
      form.scrollIntoView({ block: 'center' });
      if (result.token) {
        keep.set('localStorage', SESSION, { token: result.token, login: result.login, expires: result.expires || null });
        update();
        if (mine && !submit.disabled) send();
        else say(`Signed in as @${result.login}.`, 'ok');
      } else {
        say(result.error === 'access_denied'
          ? 'GitHub sign-in was cancelled, so your review wasn’t posted. It’s still here: press Submit to try again.'
          : 'GitHub sign-in didn’t work, so your review wasn’t posted. Press Submit to try again.', 'error');
      }
    }
    update();
    return { show };
  }

  // Visits for Trending (tools/track_visits.py): one GoatCounter event per project, for a
  // game page with a single project and for any project's repository or website link.
  // GoatCounter's script is only on the built site, and only once it's set up.
  const countVisit = (id) => {
    try { window.goatcounter.count({ path: `recomp/${id}`, event: true }); } catch { /* not loaded */ }
  };
  document.addEventListener('click', (ev) => {
    const link = ev.target.closest('a[data-visit]');
    if (link) countVisit(link.dataset.visit);
  });
  if (document.body.dataset.visit) {
    window.addEventListener('load', () => countVisit(document.body.dataset.visit));
  }

  // "Get update emails" on a project's card: update alerts by email, through the newsletter
  // Worker in <meta name="rh-mail"> (newsletter/worker.js). The same as in app.js.
  const MAIL_API = ((document.querySelector('meta[name="rh-mail"]') || {}).content || '').replace(/\/+$/, '');
  const remember = {
    get() { try { return localStorage.getItem('rh-mail-email') || ''; } catch { return ''; } },
    set(v) { try { localStorage.setItem('rh-mail-email', v); } catch { /* storage unavailable */ } },
  };

  async function submitMail(form) {
    const status = form.querySelector('.mail-form__status');
    const submit = form.querySelector('button[type="submit"]');
    const data = new FormData(form);
    const email = String(data.get('email') || '').trim();
    const body = { email, website: String(data.get('website') || ''), weekly: !form.dataset.recomp || data.get('weekly') === 'on' };
    if (form.dataset.recomp) body.recomp = form.dataset.recomp;
    submit.disabled = true;
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
      if (ok) remember.set(email);
    } catch {
      status.dataset.state = 'error';
      status.textContent = 'Couldn’t reach the sign-up service. Check your connection and try again.';
    } finally {
      submit.disabled = false;
    }
  }

  if (MAIL_API) {
    document.addEventListener('submit', (ev) => {
      const form = ev.target.closest('form[data-mail-form]');
      if (!form) return;
      ev.preventDefault();
      submitMail(form);
    });
    document.addEventListener('click', (ev) => {
      const toggle = ev.target.closest('[data-follow-toggle]');
      const form = toggle && document.getElementById(toggle.getAttribute('aria-controls'));
      if (!form) return;
      form.hidden = !form.hidden;
      toggle.setAttribute('aria-expanded', String(!form.hidden));
      if (form.hidden) return;
      const input = form.querySelector('input[type="email"]');
      if (!input.value) input.value = remember.get();
      input.focus();
    });
  }

  // Featured playthrough (playthrough_html() in tools/build_pages.py): the thumbnail turns into
  // YouTube's no-cookie player when pressed, as in app.js.
  document.addEventListener('click', (ev) => {
    const button = ev.target.closest('button[data-youtube]');
    if (!button) return;
    const frame = document.createElement('iframe');
    frame.src = `https://www.youtube-nocookie.com/embed/${button.dataset.youtube}?autoplay=1&rel=0`;
    frame.title = button.getAttribute('aria-label').replace(/^Play the /, 'The ');
    frame.allow = 'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share';
    frame.allowFullscreen = true;
    frame.referrerPolicy = 'strict-origin-when-cross-origin';
    button.replaceWith(frame);
  });

  // A game page's backdrop (backdrop_html() in tools/build_pages.py): every 9 seconds the next
  // picture fades in, drifting left and zooming in as it goes, and the last one leads back to the
  // first. It stays on the first picture for people who ask for less motion.
  const slides = [...document.querySelectorAll('.backdrop__slide')];
  const calm = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (slides.length) {
    const drift = (s) => {
      s.classList.remove('is-drifting');
      void s.offsetWidth;  // starts the drift over
      s.classList.add('is-drifting');
    };
    // The first picture waits until it has loaded, then fades in and starts drifting, so it
    // doesn't pop in late.
    let at = 0;
    let begun = false;
    const begin = () => {
      if (begun) return;
      begun = true;
      slides[0].classList.add('is-first');  // a quicker fade than between pictures
      void slides[0].offsetWidth;
      slides[0].classList.add('is-on');
      setTimeout(() => slides[0].classList.remove('is-first'), 1500);
      if (calm) return;
      drift(slides[0]);
      if (slides.length > 1) {
        slides.slice(1).forEach((s) => { new Image().src = urlOf(s); });  // loaded before their turn
        setInterval(() => {
          const out = slides[at];
          out.classList.remove('is-on');  // fades out, still drifting, then rests hidden
          setTimeout(() => { if (!out.classList.contains('is-on')) out.classList.remove('is-drifting'); }, 2600);
          at = (at + 1) % slides.length;
          drift(slides[at]);
          slides[at].classList.add('is-on');
        }, 9000);
      }
    };
    const urlOf = (s) => (getComputedStyle(s).backgroundImage.match(/url\(["']?(.*?)["']?\)/) || [])[1] || '';
    const first = new Image();
    first.onload = first.onerror = begin;
    first.src = urlOf(slides[0]);
    if (first.complete) begin();
  }

  // A game page's music (music_html() in tools/build_pages.py): it fades in, plays at a gentle
  // volume, fades out over its last seconds and starts again. Browsers only let a page play sound
  // after the visitor clicks or presses a key, so when it can't start right away it starts on the
  // first one, and the button says so meanwhile. The button mutes it (with a short fade), and the
  // choice is remembered. Links that
  // leave the page fade it out over a second before going; a browser's Back button or a closed
  // tab can't be held back, so those still stop it at once.
  const music = document.querySelector('[data-music]');
  if (music) {
    const audio = music.querySelector('audio');
    const toggle = music.querySelector('button');
    const VOLUME = Number(music.dataset.volume) || 0.3;
    const FADE_IN = 4, FADE_OUT = 8;  // seconds
    let on = true, started = false, level = 0, ctx = null, gain = null, timer = 0;
    try { on = localStorage.getItem('rh-music') !== 'off'; } catch { /* storage unavailable */ }

    // Where the volume should be now: rising over the first seconds, falling over the last.
    const target = () => {
      if (!on) return 0;
      const t = audio.currentTime, d = audio.duration;
      let v = VOLUME * Math.min(1, t / FADE_IN);
      if (d && Number.isFinite(d)) v *= Math.min(1, Math.max(0, (d - t) / FADE_OUT));
      return v;
    };
    const tick = () => {
      if (on && started && audio.paused) {  // the browser stopped it: it wants a click first
        started = false;
        waiting(true);
        listen();
        return;
      }
      const want = target();
      level += (want - level) * 0.12;  // eases toward it, so muting and unmuting fade too
      if (Math.abs(want - level) < 0.002) level = want;
      if (gain) gain.gain.setTargetAtTime(level, ctx.currentTime, 0.05);
      else audio.volume = level;
      if (!on && level === 0 && !audio.paused) audio.pause();
    };
    // Volume through Web Audio, which iPhones need: they ignore an audio element's own volume.
    // It has to be set up while handling a click or key press.
    const connect = () => {
      if (ctx || !window.AudioContext) return;
      try {
        ctx = new AudioContext();
        gain = ctx.createGain();
        gain.gain.value = level;
        ctx.createMediaElementSource(audio).connect(gain).connect(ctx.destination);
        audio.volume = 1;
      } catch { ctx = null; gain = null; }
    };
    const about = toggle.title;
    const paint = () => {
      toggle.setAttribute('aria-pressed', String(on));
      toggle.title = `${on ? 'Mute' : 'Play'}: ${about}`;
    };
    // While the browser holds the music back, the button says how to start it, and pulses.
    const label = toggle.querySelector('.music__label');
    const name = label.textContent;
    const touch = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
    const waiting = (yes) => {
      music.classList.toggle('is-waiting', yes);
      label.textContent = yes ? `${touch ? 'Tap' : 'Click'} anywhere for music` : name;
    };
    async function play(fromGesture) {
      if (fromGesture) connect();
      // Barely audible rather than silent: Firefox and Safari let silent sound start and then
      // pause it as it fades in, so asking at a volume they count as sound gets a straight answer.
      if (!gain) audio.volume = Math.max(level, 0.001);
      try {
        if (ctx && ctx.state !== 'running') await ctx.resume();
        await audio.play();
      } catch (err) {
        // Anything but "wait for a click" means the track can't play (gone from the media
        // repository, say), so the button goes rather than asking for a click forever.
        if (err && err.name !== 'NotAllowedError') {
          music.hidden = true;
          GESTURES.forEach((t) => document.removeEventListener(t, firstGesture));
        }
        return false;
      }
      waiting(false);
      started = true;
      if (!timer) timer = setInterval(tick, 100);
      return true;
    }
    const GESTURES = ['click', 'keydown', 'touchend'];
    const firstGesture = async (ev) => {
      if (toggle.contains(ev.target) || !on || started) return;  // the button does its own
      if (await play(true)) GESTURES.forEach((t) => document.removeEventListener(t, firstGesture));
    };
    function listen() {
      GESTURES.forEach((t) => document.addEventListener(t, firstGesture));
    }
    // Plays now if the browser allows it, or else waits for a click or key press, saying so.
    const playOrWait = () => play(false).then((ok) => {
      if (ok || music.hidden) return;
      waiting(true);
      listen();
    });

    const LEAVE_FADE = 1000;  // ms
    leaveSoftly = (go) => {
      if (audio.paused || level < 0.005) return go();
      clearInterval(timer);
      timer = 0;
      const from = level, t0 = performance.now();
      const step = () => {
        const k = Math.min(1, (performance.now() - t0) / LEAVE_FADE);
        level = from * (1 - k) * (1 - k);  // eases out
        if (gain) gain.gain.setTargetAtTime(level, ctx.currentTime, 0.02);
        else audio.volume = level;
        if (k < 1) requestAnimationFrame(step);
        else {
          audio.pause();
          go();
        }
      };
      requestAnimationFrame(step);
    };
    // A link that takes this tab to another page, as opposed to a new tab or a spot on this page.
    document.addEventListener('click', (ev) => {
      const link = ev.target.closest('a[href]');
      if (!link || ev.defaultPrevented || ev.button !== 0 || ev.ctrlKey || ev.metaKey || ev.shiftKey || ev.altKey) return;
      if ((link.target && link.target !== '_self') || link.hasAttribute('download') || !/^https?:$/.test(link.protocol)) return;
      if (link.origin === location.origin && link.pathname === location.pathname && link.search === location.search) return;
      ev.preventDefault();
      leaveSoftly(() => { location.href = link.href; });
    });

    toggle.addEventListener('click', () => {
      on = started ? !on : true;
      try { localStorage.setItem('rh-music', on ? 'on' : 'off'); } catch { /* storage unavailable */ }
      paint();
      if (on && (audio.paused || !started)) play(true);
    });
    // Back to this page from the browser's memory of it, paused by the fade on the way out.
    window.addEventListener('pageshow', (ev) => {
      if (!ev.persisted || !on) return;
      level = 0;
      playOrWait();
    });
    paint();
    if (on) playOrWait();
  }

  // A cover that fails to load turns into the initials placeholder.
  document.addEventListener('error', (ev) => {
    const box = ev.target instanceof HTMLImageElement && ev.target.closest('.cover, .d-cover');
    if (!box) return;
    if (box.classList.contains('d-cover')) box.className = 'cover cover--lg';
    box.classList.add('cover--none');
    box.textContent = box.dataset.initials;
  }, true);
})();
