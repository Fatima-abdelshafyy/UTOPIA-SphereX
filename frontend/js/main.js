// API base: same origin when served by main.py; falls back to :8000 for other dev servers / file://
const API = (location.protocol === 'file:' || (location.port && location.port !== '8000' && /^(localhost|127\.0\.0\.1)$/.test(location.hostname))) ? 'http://localhost:8000' : '';
const STORE_KEY = 'utopia.search';
// Keep-alive between tabs (pages): Spectral Explorer and Time Machine save their results when you leave the page and
// restore them when you come back. A browser refresh (F5 / reload button) throws the saved results away and starts fresh.
const IS_RELOAD = (() => { try { const n = performance.getEntriesByType('navigation')[0]; return n ? n.type === 'reload' : !!(performance.navigation && performance.navigation.type === 1) } catch (e) { return false } })();
function keepLoad(key) { try { if (IS_RELOAD) { sessionStorage.removeItem(key); return null } return JSON.parse(sessionStorage.getItem(key)) } catch (e) { return null } }
function keepSave(key, build) {
  try { sessionStorage.setItem(key, JSON.stringify(build(false))) }
  catch (e) { try { sessionStorage.setItem(key, JSON.stringify(build(true))) } catch (e2) { try { sessionStorage.removeItem(key) } catch (e3) { } } }
}
// Starfield background
(function () {
  const c = document.getElementById('stars'); if (!c) return;
  const x = c.getContext('2d'); let s = [];
  function size() { c.width = innerWidth; c.height = innerHeight; s = Array.from({ length: 140 }, () => ({ x: Math.random() * c.width, y: Math.random() * c.height, r: Math.random() * 1.2 + .2, a: Math.random() * .6 + .2 })); draw() }
  function draw() { x.clearRect(0, 0, c.width, c.height); s.forEach(p => { x.globalAlpha = p.a; x.fillStyle = '#fff'; x.beginPath(); x.arc(p.x, p.y, p.r, 0, 7); x.fill() }) }
  addEventListener('resize', size); size();
})();
// Time Machine: real SPHEREx spectral-image observations, playback, WCS-aligned differencing and coaddition.
(function () {
  const $ = id => document.getElementById(id);
  const search = $('tm-search'); if (!search) return;
  let observations = [], timer = null, lastPair = null;
  const status = (t, error = false) => { $('tm-status').textContent = t; $('tm-status').style.color = error ? '#ff8a80' : ''; };
  const enc = encodeURIComponent;
  const params = () => `ra=${encodeURIComponent($('tm-ra').value)}&dec=${encodeURIComponent($('tm-dec').value)}&size=${encodeURIComponent($('tm-fov').value)}`;
  const imageUrl = o => `${API}/api/cutout.png?url=${enc(o.url)}&${params()}&stretch=${$('tm-stretch')?.value || 'asinh'}&contrast=${$('tm-contrast')?.value || 1}`;
  function setImage(id, src, alt) {
    const box = $(id); box.innerHTML = ''; box.style.overflow = 'auto'; box.style.alignItems = 'flex-start'; box.style.justifyContent = 'flex-start';
    const im = new Image(); im.alt = alt; im.loading = 'lazy'; im.style.cssText = 'display:block;width:auto;height:auto;max-width:none;max-height:none;object-fit:contain;image-rendering:pixelated;transform-origin:top left'; im.dataset.baseImage = '1'; im.style.width = `${100 * (Number($('tm-zoom')?.value || 1))}%`; 
    im.onerror = () => { box.textContent = 'Image could not be loaded from IRSA.'; };
    im.src = src; box.appendChild(im);
  }
  function fillSelect(id) {
    $(id).innerHTML = observations.map((o, i) => `<option value="${i}">${i + 1}. ${o.date} · ${o.band || ('D' + o.det)}</option>`).join('');
  }
  function selected(id) { return observations[Number($(id).value)] || null; }
  function updateCurrent() {
    if (!observations.length) return;
    const i = Number($('tm-slider').value), o = observations[i];
    $('tm-current').textContent = `Observation ${i + 1} of ${observations.length} · ${o.date} UTC · ${o.band} · D${o.det}`;
    $('tm-det-label').textContent = `D${o.det}`;
    setImage('tm-main-image', imageUrl(o), `SPHEREx ${o.band} ${o.date}`);
    $('tm-metadata').innerHTML = `<b>Observation date:</b> ${o.date} UTC<br><b>Wavelength band:</b> ${String(o.band || 'Unknown').replace(/[<>]/g, '')}<br><b>Detector:</b> D${o.det}<br><b>Release:</b> ${String(o.release || 'unknown').toUpperCase()}<br><b>MJD:</b> ${Number(o.mjd).toFixed(5)}<br><b>Target:</b> ${Number($('tm-ra').value).toFixed(5)}°, ${Number($('tm-dec').value).toFixed(5)}°`;
    drawLightCurve();
  }
  function updatePair() {
    const a = selected('tm-a'), b = selected('tm-b');
    lastPair = null;
    if (!a || !b) return;
    setImage('tm-image-a', imageUrl(a), 'Observation A');
    setImage('tm-image-b', imageUrl(b), 'Observation B');
    $('tm-result').textContent = 'Choose Subtract or Combine.';
  }
  search.onclick = async () => {
    const ra = Number($('tm-ra').value), dec = Number($('tm-dec').value), fov = Number($('tm-fov').value);
    if (!Number.isFinite(ra) || ra < 0 || ra > 360 || !Number.isFinite(dec) || dec < -90 || dec > 90 || !Number.isFinite(fov) || fov < 1 || fov > 30) {
      status('Check coordinates (RA 0–360°, Dec −90–90°) and FOV (1–30 arcmin).', true); return;
    }
    search.disabled = true; status('Searching SPHEREx observations in IRSA…');
    try {
      const detector = $('tm-det').value;
      const from = $('tm-from').value ? Date.parse($('tm-from').value + 'T00:00:00Z') / 864e5 + 40587 : 0;
      const to = $('tm-to').value ? Date.parse($('tm-to').value + 'T23:59:59Z') / 864e5 + 40587 : 0;
      const q = new URLSearchParams({ ra, dec, detectors: detector }); if (from) q.set('t0', from); if (to) q.set('t1', to);
      const r = await fetch(`${API}/api/spectral/observations?${q}`); if (!r.ok) throw new Error((await r.json()).detail || `HTTP ${r.status}`);
      const data = await r.json(); observations = data.observations || [];
      if (!observations.length) { status('No observations found for this detector and time range. Try another detector or wider dates.'); $('tm-main-image').textContent = 'No observations found.'; return; }
      $('tm-slider').max = observations.length - 1; $('tm-slider').value = 0;
      fillSelect('tm-a'); fillSelect('tm-b'); $('tm-b').value = String(Math.min(1, observations.length - 1));
      clearChanges();
      updateCurrent(); updatePair();
      status(`${observations.length} observations loaded from ${data.source}. Images are grouped by detector D${detector}.`);
      try { sessionStorage.setItem(STORE_KEY, JSON.stringify({ ra, dec, fov, observations })); } catch (e) {}
      const u = new URL(location.href); u.searchParams.set('ra', ra); u.searchParams.set('dec', dec); u.searchParams.set('fov', fov); history.replaceState(null, '', u);
    } catch (e) { status(`Could not load observations: ${e.message}. Make sure the backend is running.`, true); }
    finally { search.disabled = false; }
  };
  // Start / end dropdowns, bounded by the mission timeline (launch 11 Mar 2025, survey began 1 May 2025)
  (function buildDateSelects() {
    const from = $('tm-from'), to = $('tm-to'), now = new Date();
    const tags = { '2025-03': ' · Launch (11 Mar)', '2025-04': ' · Commissioning', '2025-05': ' · Survey begins (1 May)' };
    const pad = n => String(n).padStart(2, '0'), mon = (y, m) => new Date(Date.UTC(y, m, 1)).toLocaleString('en', { month: 'short', timeZone: 'UTC' });
    const months = [];
    for (let y = 2025, m = 2; y < now.getUTCFullYear() || (y === now.getUTCFullYear() && m <= now.getUTCMonth()); m++) { months.push([y, m]); if (m === 11) { y++; m = -1; } }
    const group = (sel, mk) => {
      let html = '', year = null;
      months.forEach(([y, m], i) => { if (y !== year) { if (year) html += '</optgroup>'; html += `<optgroup label="${y}">`; year = y; } html += mk(y, m, i); });
      sel.innerHTML = html + '</optgroup>';
    };
    group(from, (y, m) => { const k = `${y}-${pad(m + 1)}`; return `<option value="${k}-${y === 2025 && m === 2 ? '11' : '01'}">${mon(y, m)} ${y}${tags[k] || ''}</option>`; });
    group(to, (y, m, i) => { const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate(), isNow = i === months.length - 1;
      return `<option value="${isNow ? '' : `${y}-${pad(m + 1)}-${pad(last)}`}">${mon(y, m)} ${y}${isNow ? ' · Latest' : ''}</option>`; });
    to.value = ''; // default: everything from launch up to the latest data
    const key = v => v || '9999-12-31';
    const sync = changed => {
      [...to.options].forEach(o => { o.disabled = key(o.value) < from.value; });
      if (key(to.value) < from.value) { if (changed === 'from') { const ok = [...to.options].find(o => !o.disabled); to.value = ok ? ok.value : ''; } }
    };
    from.onchange = () => sync('from'); to.onchange = () => { sync('to'); };
    sync();
  })();
  $('tm-slider').oninput = updateCurrent;
  $('tm-a').onchange = updatePair; $('tm-b').onchange = updatePair;
  $('tm-det').onchange = () => { observations = []; clearChanges(); $('tm-main-image').textContent = 'Load observations for the selected detector.'; };
  $('tm-play').onclick = () => {
    if (!observations.length) { status('Load observations before playback.'); return; }
    if (timer) { clearInterval(timer); timer = null; $('tm-play').textContent = 'Play'; return; }
    $('tm-play').textContent = 'Pause'; timer = setInterval(() => { $('tm-slider').value = (Number($('tm-slider').value) + 1) % observations.length; updateCurrent(); }, 900);
  };
  $('tm-stop').onclick = () => { if (timer) clearInterval(timer); timer = null; $('tm-play').textContent = 'Play'; $('tm-slider').value = 0; updateCurrent(); };
  async function pairAction(kind) {
    const a = selected('tm-a'), b = selected('tm-b'); if (!a || !b) { status('Choose two observations first.'); return; }
    if (a.url === b.url) { status('Choose two different observations.', true); return; }
    if (a.det !== b.det || a.band !== b.band) { status('For a scientifically meaningful comparison, choose observations with the same detector and band.', true); return; }
    lastPair = kind;
    const box = $('tm-result'); box.textContent = kind === 'diff' ? 'Subtracting and aligning images…' : 'Combining and aligning images…';
    const endpoint = kind === 'diff' ? '/api/diff.png' : '/api/combine.png';
    const q = new URLSearchParams({ ra: $('tm-ra').value, dec: $('tm-dec').value, size: $('tm-fov').value });
    q.set('stretch', $('tm-stretch').value); q.set('contrast', $('tm-contrast').value);
    if (kind === 'diff') { q.set('url1', a.url); q.set('url2', b.url); }
    else { q.set('urls', `${a.url},${b.url}`); q.set('method', $('tm-combine-method').value); }
    const im = new Image(); im.alt = kind === 'diff' ? 'Difference image B minus A' : 'Mean combined image'; im.style.cssText = `display:block;width:${100 * Number($('tm-zoom')?.value || 1)}%;height:auto;max-width:none;max-height:none;object-fit:contain;image-rendering:pixelated`; 
    im.onload = () => { box.innerHTML = ''; box.appendChild(im); };
    im.onerror = () => { box.textContent = 'Processing failed. Check that both observations are available.'; };
    im.src = `${API}${endpoint}?${q}`;
  }
  $('tm-diff').onclick = () => pairAction('diff'); $('tm-combine').onclick = () => pairAction('combine');
  $('tm-first-last').onclick = async () => {
    if (observations.length < 2) { status('Load observations first.'); return; }
    $('tm-a').value = '0'; $('tm-b').value = String(observations.length - 1);
    updatePair();
    await pairAction('diff');
    status(`First-to-last difference: ${observations[0].date} → ${observations[observations.length - 1].date}.`);
  };
  $('tm-stretch').onchange = () => { updateCurrent(); updatePair(); };
  $('tm-contrast').oninput = () => { updateCurrent(); updatePair(); };
  $('tm-zoom').oninput = () => {
    const scale = Number($('tm-zoom').value);
    document.querySelectorAll('#tm-main-image img, #tm-image-a img, #tm-image-b img, #tm-result img').forEach(im => {
      im.style.width = `${100 * scale}%`; im.style.maxWidth = 'none'; im.style.maxHeight = 'none'; im.style.imageRendering = 'pixelated';
    });
  };
  // ===== Change detection (backend: changes.py) =====
  const LABELS = { brightened: 'Brightened', dimmed: 'Dimmed', variable: 'Variable', appeared: 'Appeared', disappeared: 'Disappeared', stable: 'Stable' };
  const esc = t => String(t ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const chg = { result: null, selected: null, job: null, running: false, discard: false, runId: '', pts: [] };
  const chgStatus = t => { $('tm-chg-status').style.whiteSpace = 'pre-wrap'; $('tm-chg-status').textContent = t; };
  const chgBar = f => { const bar = $('tm-chg-bar'); bar.hidden = f == null; if (f != null) bar.firstElementChild.style.width = `${Math.round(100 * f)}%`; };
  const chgButtons = () => {
    const sources = chg.result?.sources || [];
    $('tm-chg-export').disabled = !sources.length;
    $('tm-chg-save').disabled = !sources.some(s => s.label !== 'stable');
    $('tm-chg-save').textContent = 'Add to Discoveries';
  };
  async function stopChanges() {
    if (!chg.running || !chg.job) return;
    chgStatus('Stopping…');
    try { await fetch(`${API}/api/changes/cancel?job=${enc(chg.job)}`, { method: 'POST' }); } catch (e) {}
  }
  function clearChanges() {
    if (chg.running) { chg.discard = true; stopChanges(); }
    chg.result = null; chg.selected = null; chg.pts = [];
    $('tm-chg-table').innerHTML = ''; $('tm-lightcurve').hidden = true; $('tm-lc-note').hidden = true;
    if (!chg.running) chgStatus('Load observations, then press “Detect changes”. It analyses every observation in the list above.');
    chgButtons();
  }
  async function runChanges() {
    if (chg.running) return;
    if (observations.length < 2) { chgStatus('Load at least two observations first.'); return; }
    const ra = Number($('tm-ra').value), dec = Number($('tm-dec').value), fov = Number($('tm-fov').value);
    if (observations.length > 300 && !confirm(`This will analyse ${observations.length} observations. The first run downloads every image and can take several minutes (later runs are much faster because images are cached). Continue?`)) return;
    chg.running = true; chg.discard = false; chg.result = null; chg.selected = null;
    $('tm-chg-run').disabled = true; $('tm-chg-stop').hidden = false; $('tm-chg-table').innerHTML = ''; $('tm-lightcurve').hidden = true; $('tm-lc-note').hidden = true; chgButtons();
    chgBar(0); chgStatus('Starting analysis…');
    try {
      const body = {
        observations: observations.map(o => ({ url: o.url, date: o.date || '', band: o.band || '' })), ra, dec, size: fov,
        mask: $('tm-chg-mask').checked, normalize: $('tm-chg-norm').checked, allow_provisional: $('tm-chg-prov').checked,
        wavelength_tol: Number($('tm-chg-wl').value), z_threshold: Number($('tm-chg-sens').value)
      };
      const start = await fetch(`${API}/api/changes`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const startData = await start.json().catch(() => ({}));
      if (!start.ok) throw new Error(startData.detail || `HTTP ${start.status}`);
      chg.job = startData.job;
      for (;;) {
        await new Promise(r => setTimeout(r, 700));
        const r = await fetch(`${API}/api/changes/status?job=${enc(chg.job)}`);
        const st = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(st.detail || `HTTP ${r.status}`);
        if (st.state === 'queued') { chgStatus('Waiting for a free analysis slot…'); continue; }
        if (st.state === 'running') {
          chgBar(st.total ? st.done / st.total : 0);
          if (!chg.discard) chgStatus(st.done >= st.total ? 'Comparing observations…' : `Loading observations: ${st.done}/${st.total}`);
          continue;
        }
        if (st.state === 'error') throw new Error(st.error || 'unknown error');
        if (st.state === 'cancelled') { if (!chg.discard) chgStatus('Stopped.'); break; }
        if (chg.discard) break;
        chg.result = st.result; chg.selected = null; chg.runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        renderChanges();
        break;
      }
    } catch (e) {
      if (!chg.discard) chgStatus(`Change detection error: ${e.message}. Make sure the backend is running.`);
    } finally {
      chg.running = false; chg.job = null; chgBar(null);
      $('tm-chg-run').disabled = false; $('tm-chg-stop').hidden = true;
      if (chg.discard) { chg.discard = false; clearChanges(); }
    }
  }
  function renderChanges() {
    const res = chg.result; if (!res) return;
    const all = res.sources || [], showStable = $('tm-chg-stable').checked;
    const rows = all.filter(s => showStable || s.label !== 'stable');
    const counts = {}; all.forEach(s => { counts[s.label] = (counts[s.label] || 0) + 1; });
    const summary = ['brightened', 'dimmed', 'variable', 'appeared', 'disappeared'].filter(k => counts[k]).map(k => `${counts[k]} ${LABELS[k].toLowerCase()}`).join(' · ');
    const dg = res.diagnostics || {};
    let msg = `Analysed ${res.analysed}/${res.requested} observations · wavelength read for ${dg.wavelength_read ?? '?'} · ${res.groups} comparable group(s)` +
      (dg.largest_group ? `, largest has ${dg.largest_group} images` : '') + `. ` + (summary ? `Found: ${summary}.` : 'No significant changes found.');
    if (res.notes?.length) msg += '\n' + res.notes.join('\n');
    chgStatus(msg); chgButtons();
    if (!rows.length) { $('tm-chg-table').innerHTML = ''; $('tm-lightcurve').hidden = true; $('tm-lc-note').hidden = true; return; }
    if (!chg.selected || !rows.includes(chg.selected)) chg.selected = rows[0];
    $('tm-chg-table').innerHTML = `<table><thead><tr><th>Result</th><th>Position (RA, Dec)</th><th>Wavelength group</th><th>Epochs</th><th>Change</th><th>σ</th></tr></thead><tbody>` +
      rows.map(s => `<tr class="row${s === chg.selected ? ' active' : ''}" data-id="${s.id}"><td><span class="chip ${esc(s.label)}">${esc(LABELS[s.label] || s.label)}</span></td>` +
        `<td class="pos">${s.is_target ? 'Target' : `${s.ra.toFixed(4)}, ${s.dec.toFixed(4)}`}</td><td>${esc(s.group)}${s.wavelength_matched ? '' : ' (provisional)'}</td>` +
        `<td>${s.n}</td><td>${s.change_pct > 0 ? '+' : ''}${s.change_pct}%</td><td>${s.z}</td></tr>`).join('') + '</tbody></table>';
    drawLightCurve();
  }
  // Event delegation: selecting a row only toggles a class and redraws the small canvas (no table rebuild).
  $('tm-chg-table').addEventListener('click', e => {
    const tr = e.target.closest('tr.row'); if (!tr || !chg.result) return;
    chg.selected = chg.result.sources.find(s => String(s.id) === tr.dataset.id) || chg.selected;
    $('tm-chg-table').querySelectorAll('tr.row').forEach(r => r.classList.toggle('active', r === tr));
    drawLightCurve();
  });
  function drawLightCurve() {
    const cv = $('tm-lightcurve'), s = chg.selected;
    if (!s || !chg.result) { cv.hidden = true; $('tm-lc-note').hidden = true; return; }
    cv.hidden = false; $('tm-lc-note').hidden = false;
    const dpr = window.devicePixelRatio || 1, w = cv.clientWidth, h = cv.clientHeight; if (!w || !h) return;
    cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
    const ctx = cv.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, w, h);
    const pts = s.series.map((p, k) => ({ ...p, t: Date.parse(String(p.date).replace(' ', 'T') + 'Z') }));
    const useTime = pts.every(p => Number.isFinite(p.t)); pts.forEach((p, k) => { p.x = useTime ? p.t : k; });
    const m = { l: 64, r: 16, t: 14, b: 40 };
    let xmin = Math.min(...pts.map(p => p.x)), xmax = Math.max(...pts.map(p => p.x));
    let ymin = Math.min(...pts.map(p => p.f - p.e)), ymax = Math.max(...pts.map(p => p.f + p.e));
    if (xmax === xmin) { xmax += 1; xmin -= 1; } if (ymax === ymin) { ymax += 1; ymin -= 1; }
    const ypad = (ymax - ymin) * 0.08, xpad = (xmax - xmin) * 0.04; ymin -= ypad; ymax += ypad; xmin -= xpad; xmax += xpad;
    const X = x => m.l + (x - xmin) / (xmax - xmin) * (w - m.l - m.r), Y = y => h - m.b - (y - ymin) / (ymax - ymin) * (h - m.t - m.b);
    ctx.font = '11px Inter, sans-serif'; ctx.lineWidth = 1;
    for (let k = 0; k <= 4; k++) {
      const yv = ymin + (ymax - ymin) * k / 4, xv = xmin + (xmax - xmin) * k / 4;
      ctx.strokeStyle = '#232a38'; ctx.beginPath(); ctx.moveTo(m.l, Y(yv)); ctx.lineTo(w - m.r, Y(yv)); ctx.stroke();
      ctx.fillStyle = '#8d97a8'; ctx.textAlign = 'right'; ctx.fillText(Number(yv.toPrecision(3)).toString(), m.l - 6, Y(yv) + 4);
      ctx.textAlign = 'center'; ctx.fillText(useTime ? new Date(xv).toISOString().slice(0, 10) : Math.round(xv), X(xv), h - m.b + 16);
    }
    ctx.textAlign = 'center'; ctx.fillText(`Brightness at ${s.is_target ? 'the target' : 'source'} (${s.group}) · time →`, (m.l + w - m.r) / 2, h - 6);
    const sorted = [...pts].sort((a, b) => a.x - b.x);
    ctx.strokeStyle = 'rgba(90,209,230,.35)'; ctx.lineWidth = 1.2; ctx.beginPath();
    sorted.forEach((p, k) => k ? ctx.lineTo(X(p.x), Y(p.f)) : ctx.moveTo(X(p.x), Y(p.f))); ctx.stroke();
    pts.forEach(p => {
      p.px = X(p.x); p.py = Y(p.f);
      ctx.strokeStyle = '#5ad1e6'; ctx.lineWidth = 1.4; ctx.beginPath(); ctx.moveTo(p.px, Y(p.f - p.e)); ctx.lineTo(p.px, Y(p.f + p.e)); ctx.stroke();
      ctx.fillStyle = '#5ad1e6'; ctx.beginPath(); ctx.arc(p.px, p.py, 4, 0, Math.PI * 2); ctx.fill();
    });
    const cur = pts.find(p => p.i === Number($('tm-slider').value));
    if (cur) { ctx.strokeStyle = '#c9a46a'; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(cur.px, cur.py, 8, 0, Math.PI * 2); ctx.stroke(); }
    chg.pts = pts;
  }
  const nearestPoint = e => {
    const rect = $('tm-lightcurve').getBoundingClientRect(), x = e.clientX - rect.left, y = e.clientY - rect.top;
    let best = null, bd = 18 * 18;
    for (const p of chg.pts) { const d = (p.px - x) ** 2 + (p.py - y) ** 2; if (d < bd) { bd = d; best = p; } }
    return best;
  };
  $('tm-lightcurve').addEventListener('click', e => {
    const p = nearestPoint(e); if (!p || !observations[p.i]) return;
    $('tm-slider').value = p.i; updateCurrent(); $('tm-main-image').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  });
  $('tm-lightcurve').addEventListener('mousemove', e => {
    const p = nearestPoint(e); $('tm-lightcurve').title = p ? `${p.date} UTC · ${Number(p.f.toPrecision(4))} ± ${Number(p.e.toPrecision(2))}` : '';
  });
  let lcFrame = 0;
  addEventListener('resize', () => { cancelAnimationFrame(lcFrame); lcFrame = requestAnimationFrame(drawLightCurve); });
  $('tm-chg-run').onclick = runChanges; $('tm-chg-stop').onclick = stopChanges; $('tm-chg-stable').onchange = renderChanges;
  $('tm-chg-export').onclick = () => {
    const sources = chg.result?.sources || []; if (!sources.length) return;
    const cols = ['source_id', 'result', 'is_target', 'ra_deg', 'dec_deg', 'wavelength_group', 'epoch_number', 'date_utc', 'flux', 'flux_err', 'z_sigma', 'change_percent'];
    const quote = v => `"${String(v ?? '').replace(/"/g, '""')}"`, rows = [cols.join(',')];
    sources.forEach(s => s.series.forEach(p => rows.push([s.id, s.label, s.is_target, s.ra, s.dec, s.group, p.i + 1, p.date, p.f, p.e, s.z, s.change_pct].map(quote).join(','))));
    const url = URL.createObjectURL(new Blob([rows.join('\r\n')], { type: 'text/csv;charset=utf-8;' })), a = document.createElement('a');
    a.href = url; a.download = 'spherex_change_detection.csv'; a.click(); URL.revokeObjectURL(url);
  };
  $('tm-chg-save').onclick = async () => {
    const changed = (chg.result?.sources || []).filter(s => s.label !== 'stable'); if (!changed.length) return;
    const name = $('tm-name').value.trim(), targetRa = Number($('tm-ra').value), targetDec = Number($('tm-dec').value), now = new Date().toISOString();
    const candidates = changed.map(s => ({
      id: `${chg.runId}-${s.id}`, kind: 'change', label: s.label,
      name: s.is_target && name ? name : 'Object',
      display_name: s.is_target ? `${name || 'Target'} · ${LABELS[s.label]}` : `Field source · RA ${s.ra.toFixed(5)}°, Dec ${s.dec.toFixed(5)}°`,
      object_type: s.is_target ? 'Target' : 'Field source', is_new_coordinate: !s.is_target,
      ra: s.ra, dec: s.dec, targetRa, targetDec, z: s.z, change_pct: s.change_pct, peak_snr: s.peak_snr, red_chi2: s.red_chi2,
      group: s.group, wavelength_matched: s.wavelength_matched, epochs: s.n, detector: $('tm-det').value,
      firstDate: s.series[0]?.date ?? null, lastDate: s.series[s.series.length - 1]?.date ?? null,
      track: s.series, savedAt: now, status: 'Needs verification', confirmed: false
    }));
    const btn = $('tm-chg-save'); btn.disabled = true; btn.textContent = 'Saving…';
    try {
      const r = await fetch(`${API}/api/discoveries`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ candidates }) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.detail || `HTTP ${r.status}`);
      btn.textContent = `Saved ${d.saved_count} ✓`;
      chgStatus(`Saved ${d.saved_count} source(s) to Discoveries. They stay unconfirmed until you verify them.`);
    } catch (e) { btn.textContent = 'Retry Add to Discoveries'; chgStatus(`Could not save: ${e.message}`); }
    finally { btn.disabled = false; }
  };
  $('tm-share').onclick = async () => {
    const u = new URL(location.href); u.searchParams.set('ra', $('tm-ra').value); u.searchParams.set('dec', $('tm-dec').value); u.searchParams.set('fov', $('tm-fov').value);
    try { await navigator.clipboard.writeText(u.href); status('Coordinate link copied.'); } catch (e) { status(u.href); }
  };
  // Open directly from a coordinate URL: /time-machine.html?ra=...&dec=...&fov=...
  const p = new URLSearchParams(location.search);
  if (p.has('ra') && p.has('dec')) { $('tm-ra').value = p.get('ra'); $('tm-dec').value = p.get('dec'); if (p.has('fov')) $('tm-fov').value = p.get('fov'); }

  // ===== keep results when switching tabs; only a refresh resets them =====
  const KEEP = 'utopia.keep.timemachine';
  const KF = ['tm-name', 'tm-ra', 'tm-dec', 'tm-fov', 'tm-det', 'tm-from', 'tm-to', 'tm-slider', 'tm-a', 'tm-b', 'tm-combine-method', 'tm-stretch', 'tm-contrast', 'tm-zoom', 'tm-chg-sens', 'tm-chg-wl'];
  const KC = ['tm-chg-mask', 'tm-chg-norm', 'tm-chg-prov', 'tm-chg-stable'];
  function snapshot(light) {
    const f = {}, c = {}; KF.forEach(id => f[id] = $(id).value); KC.forEach(id => c[id] = $(id).checked);
    return {
      f, c, observations, pair: lastPair, status: $('tm-status').textContent, statusErr: !!$('tm-status').style.color,
      chg: { result: light ? null : chg.result, selected: chg.selected ? chg.selected.id : null, runId: chg.runId, wasRunning: chg.running }
    };
  }
  function keep() { if (observations.length) keepSave(KEEP, snapshot); }
  function restoreState(s) {
    KF.filter(id => !['tm-slider', 'tm-a', 'tm-b'].includes(id)).forEach(id => { if (s.f[id] != null) $(id).value = s.f[id]; });
    KC.forEach(id => { if (id in s.c) $(id).checked = s.c[id]; });
    $('tm-from').dispatchEvent(new Event('change')); // refreshes which "To" months are allowed
    observations = s.observations || []; if (!observations.length) return;
    $('tm-slider').max = observations.length - 1; $('tm-slider').value = s.f['tm-slider'];
    fillSelect('tm-a'); fillSelect('tm-b'); $('tm-a').value = s.f['tm-a']; $('tm-b').value = s.f['tm-b'];
    clearChanges(); updateCurrent(); updatePair();
    const g = s.chg || {};
    if (g.result) {
      chg.result = g.result; chg.runId = g.runId || ''; chg.selected = g.result.sources.find(x => x.id === g.selected) || null;
      renderChanges();
    } else if (g.wasRunning) chgStatus('Change detection was interrupted when you left this tab. Press “Detect changes” to run it again.');
    if (s.pair) pairAction(s.pair);
    status(s.status, s.statusErr);
  }
  addEventListener('pagehide', keep);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') keep(); });
  { // restore unless this page was opened with different coordinates in the URL
    const kept = keepLoad(KEEP);
    if (kept && kept.f && (!(p.has('ra') && p.has('dec')) || (Number(p.get('ra')) === Number(kept.f['tm-ra']) && Number(p.get('dec')) === Number(kept.f['tm-dec'])))) restoreState(kept);
  }
})();
// Sky Explorer form -> observations covering the position (IRSA TAP first, SIA as fallback), then /api/cutout.png
(function () {
  const f = document.getElementById('search-btn'); if (!f) return;
  const $ = id => document.getElementById(id);
  const esc = t => String(t).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const card = $('result'), body = $('result-body');
  const showCard = html => { body.innerHTML = html; card.hidden = false; };
  const hideCard = () => { card.hidden = true; body.innerHTML = ''; };
  $('result-close').onclick = hideCard;
  // minimise / expand the search pop-up
  const pop = $('sky-pop'), toggle = $('pop-toggle');
  toggle.onclick = () => {
    const min = pop.classList.toggle('minimised');
    toggle.innerHTML = min ? '+' : '&minus;'; toggle.setAttribute('aria-expanded', String(!min));
    toggle.setAttribute('aria-label', min ? 'Expand search' : 'Minimise search');
  };
  async function getJson(url) {
    const r = await fetch(url); if (!r.ok) { let d = ''; try { d = (await r.json()).detail } catch (e) { } throw new Error(d || 'HTTP ' + r.status); }
    return r.json();
  }
  async function findObservations(ra, dec, fov, det) {
    // 1) IRSA TAP footprint search: covers every release (weekly ingests included)
    try {
      const d = await getJson(`${API}/api/spectral/observations?ra=${ra}&dec=${dec}${det ? '&detectors=' + det : ''}`);
      if (d.count) return d.observations.map(o => ({ date: o.date, band: o.band, det: o.det, url: o.url }));
    } catch (e) { console.warn('[Utopia] TAP search failed, trying SIA:', e.message); }
    // 2) fallback: SIA search
    const d = await getJson(`${API}/api/observations?ra=${ra}&dec=${dec}&fov=${fov}`);
    const rows = (d.observations || []).map(o => { const m = /D([1-6])\s*$/.exec(o.band || '') || /\/([1-6])\/level2_/.exec(o.url || ''); return { date: o.date, band: o.band, det: m ? +m[1] : null, url: o.url }; });
    return det ? rows.filter(o => String(o.det) === det) : rows;
  }
  f.onclick = async () => {
    const ra = +$('ra').value, dec = +$('dec').value, fov = +($('fov').value || 5), det = $('band').value;
    if (!isFinite(ra) || !isFinite(dec) || ra < 0 || ra > 360 || dec < -90 || dec > 90) { showCard('<p class="res-msg">RA must be 0–360° and Dec −90° to 90°.</p>'); return }
    hideCard(); f.disabled = true; const label = f.textContent; f.textContent = 'Searching…';
    try {
      const obs = await findObservations(ra, dec, fov, det);
      const shareUrl = new URL(location.href); shareUrl.searchParams.set('ra', ra); shareUrl.searchParams.set('dec', dec); shareUrl.searchParams.set('fov', fov); history.replaceState(null, '', shareUrl);
      try { sessionStorage.setItem(STORE_KEY, JSON.stringify({ ra, dec, fov, observations: obs })) } catch (e) { }
      if (!obs.length) { showCard('<p class="res-msg">No SPHEREx images cover this position yet.</p>'); return }
      const q = `ra=${ra}&dec=${dec}&size=${fov}`, src = k => `${API}/api/cutout.png?url=${encodeURIComponent(obs[k].url)}&${q}`;
      showCard(`<div class="res-head"><b>${obs.length}</b> observations</div>` +
        `<img id="cutout" alt="Cutout" src="${src(0)}">` +
        `<div class="res-list">` + obs.map((o, k) => `<div data-k="${k}" class="${k ? '' : 'on'}">${k + 1}. ${esc(o.date)} · ${o.det ? 'D' + o.det : esc(o.band)}</div>`).join('') + `</div>` +
        `<a class="res-link" href="time-machine.html?ra=${ra}&dec=${dec}&fov=${fov}">Open in Time Machine →</a>`);
      body.querySelectorAll('[data-k]').forEach(el => el.onclick = () => {
        body.querySelectorAll('[data-k].on').forEach(x => x.classList.remove('on')); el.classList.add('on');
        $('cutout').src = src(+el.dataset.k);
      });
    } catch (e) { showCard('<p class="res-msg">Could not reach the backend. Start it with <code>python main.py</code>.</p>') }
    finally { f.disabled = false; f.textContent = label; }
  };
})();

// Sky map (Aladin Lite): full-screen map on Sky Explorer. Wheel = zoom, drag = pan, click = pick position.
// The sky images come from public HiPS servers. CDS (Strasbourg) is down, so we probe several mirrors
// at once, use the first that answers, and keep retrying. If none answer, the map still works
// (dark map + target marker) and the SPHEREx search results below do not depend on it.
(function () {
  const box = document.getElementById('aladin-lite-div'); if (!box) return;
  const $ = id => document.getElementById(id);
  const ra = $('ra'), dec = $('dec'), fov = $('fov'), layer = $('sky-layer'), name = $('name');
  const fail = msg => { box.innerHTML = '<div class="sky-fallback">' + msg + '</div>'; console.error('[Utopia sky map]', msg) };
  if (typeof A === 'undefined') { fail('Sky map library (js/aladin.js) did not load.'); return }
  const MIRRORS = {
    // SPHEREx DR1 all-sky mosaic = HiPS *cube* (102 wavelength planes, orders 0-5). Aladin Lite 3.9 reads cubes natively
    // and shows a plane slider. The folder name is dated (hips_YYYYMMDD) and IRSA may publish a newer one:
    // check the notebook / https://irsa.ipac.caltech.edu/data/hips/list and update it here if the map goes back to WISE.
    spherex: ['https://irsa.ipac.caltech.edu/ibe/data/spherex/dr1/hips5_cube/hips_20261026'],
    dss: ['https://skies.esac.esa.int/DSSColor', 'https://stpubdata.s3.us-east-1.amazonaws.com/mast/skybackgrounds/DSSColor', 'https://casda.csiro.au/hips/DSS2/color', 'https://hips.china-vo.org/m/CDS_P_DSS2_color', 'https://alasky.cds.unistra.fr/DSS/DSSColor'],
    wise: ['https://skies.esac.esa.int/AllWISEColor', 'https://hips.china-vo.org/m/CDS_P_allWISE_color', 'https://alaskybis.cds.unistra.fr/AllWISE/RGB-W4-W2-W1'],
    '2mass': ['https://skies.esac.esa.int/2MASSColor', 'https://casda.csiro.au/hips/2MASS/Color', 'https://hips.china-vo.org/m/CDS_P_2MASS_color', 'https://alaskybis.cds.unistra.fr/2MASS/Color']
  };
  const picked = {};
  // Probe all mirrors in parallel; resolve with the first that answers, or null if none do.
  function probe(u) {
    const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), 6000);
    return fetch(u + '/properties', { signal: ctl.signal, mode: 'cors' })
      .then(r => { clearTimeout(t); if (!r.ok) throw new Error('HTTP ' + r.status); return u })
      .catch(e => { clearTimeout(t); console.warn('[Utopia sky map] mirror failed:', u, e.message || e); throw e });
  }
  async function pickUrl(key) {
    if (picked[key]) return picked[key];
    try { const u = await Promise.any(MIRRORS[key].map(probe)); console.log('[Utopia sky map] using mirror:', u); return picked[key] = u }
    catch (e) { return null }
  }
  // Small status badge so the user knows why the background is dark.
  const badge = document.createElement('div');
  badge.style.cssText = 'position:fixed;left:50%;bottom:16px;transform:translateX(-50%);z-index:4;padding:8px 14px;border-radius:8px;background:rgba(0,0,0,.75);color:#e8d9b8;font:13px Inter,sans-serif;pointer-events:none;display:none;max-width:90vw;text-align:center';
  document.body.appendChild(badge);
  const say = t => { badge.textContent = t || ''; badge.style.display = t ? 'block' : 'none' };
  const OFFLINE = 'Sky imagery servers are not reachable right now (CDS outage). The map stays dark, but SPHEREx search still works. Retrying…';

  let aladin, cat, retry = null, gaiaCatalog = null;
  const valid = () => !isNaN(parseFloat(ra.value)) && !isNaN(parseFloat(dec.value));
  async function toggleGaia() {
    const toggle = $('gaia-overlay'); if (!toggle || !aladin) return;
    if (!toggle.checked) { if (gaiaCatalog) { aladin.removeCatalog(gaiaCatalog); gaiaCatalog = null; } return; }
    if (gaiaCatalog) return;
    try {
      say('Loading Gaia DR3 catalog…');
      const radiusDeg = Math.min(Math.max((+fov.value || 5) / 60 / 2, 0.03), 0.5);
      gaiaCatalog = A.catalogFromVizieR('I/355/gaiadr3', `${+ra.value} ${+dec.value}`, radiusDeg,
        { name: 'Gaia DR3', sourceSize: 7, color: '#55d9ff', shape: 'circle', limit: 1500 });
      aladin.addCatalog(gaiaCatalog); say('Gaia DR3 catalog overlay added.'); setTimeout(() => say(''), 3500);
    } catch (e) { toggle.checked = false; say('Gaia catalog could not be loaded.'); setTimeout(() => say(''), 3500); console.warn(e); }
  }
  const mapFov = () => Math.max((+fov.value || 5) / 60 * 4, 0.1); // degrees
  function mark() { if (!aladin || !valid()) return; cat.removeAll(); cat.addSources([A.source(+ra.value, +dec.value, {})]) }
  // Default view = whole sky (Hammer-Aitoff, Galactic frame), like IRSA's SPHEREx viewer.
  function goTo() { if (!aladin || !valid()) return; aladin.setProjection('SIN'); aladin.gotoRaDec(+ra.value, +dec.value); aladin.setFoV(mapFov()); mark() }
  function allSky() { if (!aladin) return; aladin.setProjection('AIT'); aladin.gotoRaDec(266.405, -28.936); aladin.setFoV(360) } // centred on the Galactic centre
  // SPHEREx Deep Fields: ~100 deg² each, centred on the ecliptic poles (NEP 18h,+66.56°  /  SEP 6h,-66.56°).
  function addDeepFields() {
    const ov = A.graphicOverlay({ name: 'SPHEREx Deep Fields', color: '#ff0000', lineWidth: 1 });
    aladin.addOverlay(ov);
    const o = { color: '#ff1a1a', fill: true, fillColor: 'rgba(230,0,0,0.85)', lineWidth: 1 };
    ov.add(A.circle(270.0, 66.56, 5.6, o)); ov.add(A.circle(90.0, -66.56, 5.6, o));
  }
  async function applyLayer() {
    clearTimeout(retry); say('Loading sky imagery…');
    let key = layer.value, u = await pickUrl(key);
    if (!u && key === 'spherex') { u = await pickUrl('wise'); if (u) { key = 'wise'; say('SPHEREx all-sky map is not reachable (CORS or a newer IRSA HiPS folder). Showing WISE instead.'); setTimeout(() => say(''), 6000) } }
    else if (u) say('');
    if (u) {
      if (aladin) {
        aladin.setImageSurvey(u);
        if (key === 'spherex') { try { aladin.getBaseImageLayer().setColormap('grayscale', { stretch: 'asinh' }) } catch (e) { console.warn(e) } }
      }
      return;
    }
    say(OFFLINE); retry = setTimeout(applyLayer, 30000); // try again in 30 s
  }
  const urlParams = new URLSearchParams(location.search);
  if (urlParams.has('ra') && urlParams.has('dec')) { ra.value = urlParams.get('ra'); dec.value = urlParams.get('dec'); if (urlParams.has('fov')) fov.value = urlParams.get('fov'); }
  A.init.then(() => {
    aladin = A.aladin('#aladin-lite-div', {
      survey: MIRRORS[layer.value][0], // placeholder; applyLayer() swaps in the first mirror that answers
      projection: 'AIT', cooFrame: 'galactic', fov: 360, target: '0 0',
      showFullscreenControl: false, showSimbadPointerControl: false, showCooGrid: false, showReticle: false
    });
    addDeepFields();
    cat = A.catalog({ name: 'Target', shape: 'circle', sourceSize: 22, color: '#c9a46a' });
    aladin.addCatalog(cat); mark(); applyLayer();
    // Click (not drag) on the map -> fill RA/Dec from the clicked pixel
    let down = null;
    box.addEventListener('pointerdown', e => { down = { x: e.clientX, y: e.clientY } });
    box.addEventListener('pointerup', e => {
      if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 4) { down = null; return }
      down = null;
      const r = box.getBoundingClientRect(), p = aladin.pix2world(e.clientX - r.left, e.clientY - r.top);
      if (!p || isNaN(p[0])) return;
      ra.value = (((p[0] % 360) + 360) % 360).toFixed(4); dec.value = (+p[1]).toFixed(4); if (name) name.value = ''; mark();
    });
  }).catch(e => fail('Sky map failed to start: ' + (e && e.message || e) + ' (WebGL2 is required).'));
  layer.onchange = applyLayer;
  $('search-btn').addEventListener('click', () => { goTo(); if ($('gaia-overlay') && $('gaia-overlay').checked) { if (gaiaCatalog) { aladin.removeCatalog(gaiaCatalog); gaiaCatalog = null; } toggleGaia(); } });
  if ($('gaia-overlay')) $('gaia-overlay').addEventListener('change', toggleGaia);
  const asb = $('allsky-btn'); if (asb) asb.onclick = allSky;
  const lg = document.createElement('div');
  lg.style.cssText = 'position:fixed;right:16px;top:96px;z-index:4;padding:8px 12px;border-radius:8px;background:rgba(0,0,0,.65);color:#e8d9b8;font:12px Inter,sans-serif;pointer-events:none';
  lg.innerHTML = '<span style="display:inline-block;width:10px;height:10px;background:#e60000;margin-right:8px;border-radius:2px"></span>SPHEREx Deep Fields';
  document.body.appendChild(lg);
  document.querySelectorAll('.sky-targets .chip').forEach(b => b.onclick = () => {
    ra.value = b.dataset.ra; dec.value = b.dataset.dec; if (name) name.value = b.dataset.name;
    goTo(); $('search-btn').click();
  });
})();