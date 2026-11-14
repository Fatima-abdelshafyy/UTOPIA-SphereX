// Home page: scroll-driven rocket launch, hero fade, reveal-on-scroll and count-up numbers.
(function () {
  const $ = id => document.getElementById(id);
  const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
  const smooth = (a, b, v) => { const t = clamp((v - a) / (b - a)); return t * t * (3 - 2 * t); };
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;

  // ---- spectrum bars (102 colors)
  const sp = document.querySelector('.spectrum');
  if (sp) {
    for (let i = 0; i < 102; i++) {
      const b = document.createElement('i'), t = i / 101;
      b.style.background = `hsl(${(1 - t) * 285 + 0}, 85%, ${52 + 8 * Math.sin(t * 6)}%)`;
      b.style.animationDelay = `${(i % 17) * 0.09}s`;
      sp.appendChild(b);
    }
  }

  // ---- reveal on scroll + count-up
  const countUp = el => {
    const end = +el.dataset.count, pre = el.dataset.plus || '', t0 = performance.now(), dur = 1400;
    const tick = now => {
      const k = clamp((now - t0) / dur), v = Math.round(end * (1 - Math.pow(1 - k, 3)));
      el.textContent = pre + v.toLocaleString('en'); if (k < 1) requestAnimationFrame(tick);
    };
    reduce ? (el.textContent = pre + end.toLocaleString('en')) : requestAnimationFrame(tick);
  };
  const io = new IntersectionObserver(es => es.forEach(e => {
    if (!e.isIntersecting) return;
    e.target.classList.add('in'); const n = e.target.querySelector('[data-count]'); if (n) countUp(n);
    io.unobserve(e.target);
  }), { threshold: .2 });
  document.querySelectorAll('.reveal').forEach(el => io.observe(el));

  // ---- launch
  const launch = $('launch'), rocket = $('rocket'), hero = $('hero-layer'), msg = $('launch-msg'), hint = $('scroll-hint');
  // split the title into words/letters so each letter can be revealed as the rocket passes
  const chars = [];
  if (msg) {
    const txt = msg.textContent; msg.textContent = ''; let n = 0;
    txt.split(' ').forEach((word, wi, arr) => {
      const w = document.createElement('span'); w.className = 'w';
      [...word].forEach(c => { const s = document.createElement('span'); s.className = 'ch'; s.textContent = c; s.style.setProperty('--i', n++); w.appendChild(s); chars.push(s); });
      msg.appendChild(w); if (wi < arr.length - 1) { const sp = document.createElement('span'); sp.className = 'ch sp'; sp.style.setProperty('--i', n++); sp.textContent = '\u00a0'; msg.appendChild(sp); chars.push(sp); }
    });
    msg.setAttribute('role', 'heading');
  }
  const powered = document.querySelector('.powered'), nav = document.querySelector('header.nav');
  if (!launch || !rocket || reduce) { if (launch) launch.classList.add('static'); return; }
  let ticking = false;
  function frame() {
    ticking = false;
    const vh = innerHeight, total = launch.offsetHeight - vh;
    const p = clamp(scrollY / total), rp = clamp(p / 0.88);
    const H = rocket.offsetHeight, flameLen = H * 0.5;
    // rocket accelerates like a real launch: slow lift-off, then fast
    const y = vh + 20 - Math.pow(rp, 1.65) * (vh + H + flameLen + 60);
    const sway = Math.sin(rp * 11) * 6 * (1 - rp);
    rocket.style.transform = `translate3d(calc(-50% + ${sway}px), ${y}px, 0)`;
    rocket.style.setProperty('--burn', String(clamp(rp * 12)));
    rocket.style.setProperty('--len', String(0.55 + clamp(rp * 2) * 0.5));
    rocket.style.opacity = rp > 0 && rp < 1 ? 1 : 0;
    // hero fades out gradually while the rocket climbs
    const fade = 1 - smooth(0.06, 0.5, p);
    hero.style.opacity = fade; hero.style.transform = `translate3d(0, ${-p * 90}px, 0) scale(${1 - p * 0.05})`;
    hero.style.filter = `blur(${(1 - fade) * 6}px)`; hero.style.pointerEvents = fade < .3 ? 'none' : '';
    if (powered) powered.style.opacity = clamp(fade * 1.2);
    hint.style.opacity = 1 - smooth(0, 0.06, p);
    // title is revealed letter by letter right under the rocket's tail, then stays
    const textY = vh * 0.56, tail = y + H + flameLen * 0.8;
    const q = clamp((textY + H * 0.35 - tail) / (H * 0.95));
    const N = chars.length, span = 6; // letters animating at once
    chars.forEach((c, i) => {
      const k = clamp(q * (N + span) - i, 0, span) / span, e = k * k * (3 - 2 * k);
      c.style.opacity = e; c.style.transform = `translateY(${(1 - e) * 26}px) scale(${.96 + .04 * e})`; c.style.filter = e >= 1 ? 'none' : `blur(${(1 - e) * 8}px)`;
    });
    msg.style.opacity = 1 - smooth(0.96, 1, p);
    msg.classList.toggle('done', q >= 1);
    nav.classList.toggle('scrolled', scrollY > 40);
  }
  const req = () => { if (!ticking) { ticking = true; requestAnimationFrame(frame); } };
  addEventListener('scroll', req, { passive: true }); addEventListener('resize', req); frame();
  // the powered tag must not sit on top of the facts section
  if (powered) new IntersectionObserver(es => es.forEach(e => { powered.style.visibility = e.isIntersecting ? 'visible' : 'hidden'; }), { threshold: 0 }).observe(launch);
})();
