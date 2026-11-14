// Spectral Explorer: builds a SPHEREx spectrum on the fly.
// Flow: /api/spectral/observations (IRSA TAP: which images cover the target) -> /api/spectrum-point once per image (6 in parallel)
// -> every point is plotted as it arrives (Plotly). API and STORE_KEY come from main.js.
(function () {
  if (typeof Plotly === 'undefined') { document.getElementById('status').textContent = 'Plotly failed to load (check your connection).'; return }
  const $ = id => document.getElementById(id);
  const esc = t => String(t).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  // The six SPHEREx detector arrays and the wavelength range each one covers (µm).
  const DET = {
    1: { lo: 0.75, hi: 1.09, color: '#5ad1e6' }, 2: { lo: 1.09, hi: 1.62, color: '#7bd88f' },
    3: { lo: 1.62, hi: 2.42, color: '#e8d36a' }, 4: { lo: 2.42, hi: 3.82, color: '#f0a05a' },
    5: { lo: 3.82, hi: 4.42, color: '#ee6f6f' }, 6: { lo: 4.42, hi: 5.0, color: '#b48cf0' }
  };
  // Test targets. RA/Dec are ICRS at the given epoch (default 2000) with proper motion (mas/yr, pmra already × cosδ),
  // so the aperture can follow them. Values are from SIMBAD/literature and editable in the form.
  // WISE 0855: the coordinates in its name / the challenge text (08h55m10.83s -07°14'42.5") are the WISE epoch ≈2010.5,
  // NOT J2000 (HST measured 08h55m08.43s in Nov 2014 -> 2.4 s west at 0.546 s/yr = 4.4 yr earlier). Treating them as
  // J2000 would put the aperture ~87" away from the target.
  const TARGETS = [
    { name: 'Barnard’s Star', ra: 269.4521, dec: 4.6934, pmra: -798.6, pmdec: 10328.1 },
    { name: 'Epsilon Indi B', ra: 331.0438, dec: -56.7827, pmra: 3966.4, pmdec: -2536.2 },
    { name: 'WISE 0855', ra: 133.7951321, dec: -7.245147, pmra: -8123.7, pmdec: 673.2, epoch: 2010.5 },
    { name: 'RW Aurigae', ra: 76.9565, dec: 30.4014, pmra: 0, pmdec: 0 },
    { name: 'R Draconis', ra: 248.1679, dec: 66.7550, pmra: 0, pmdec: 0 }
  ];

  let points = [], observations = [], running = false, abortCtl = null, redrawTimer = null, lastRun = null, plotsBound = false, relAvail = null, inspectedId = null, stackImg = null;

  // ---------- form helpers
  const val = id => $(id).value;
  const numv = (id, d) => { const v = parseFloat(val(id)); return isNaN(v) ? d : v };
  function selectedDets() { return [...document.querySelectorAll('#spx-dets input:checked')].map(i => +i.value) }

  // detector buttons
  $('spx-dets').innerHTML = Object.keys(DET).map(k =>
    `<label><input type="checkbox" value="${k}" checked><i style="background:${DET[k].color}"></i>D${k}</label>`).join('');
  $('dets-all').onclick = () => document.querySelectorAll('#spx-dets input').forEach(i => i.checked = true);
  $('dets-none').onclick = () => document.querySelectorAll('#spx-dets input').forEach(i => i.checked = false);

  // time range (UTC dates -> MJD). End date is inclusive (whole day).
  const MJD0 = 40587; // MJD of 1970-01-01
  const dateToMjd = (v, endOfDay) => { if (!v) return 0; const t = Date.parse(v + 'T00:00:00Z'); return isNaN(t) ? 0 : t / 864e5 + MJD0 + (endOfDay ? 1 - 1e-9 : 0) };
  const LAUNCH_MJD = 60745; // 2025-03-11, SPHEREx launch
  const mjdToDate = m => new Date((m - MJD0) * 864e5).toISOString().slice(0, 10);
  // Start / end dropdowns: months from launch (11 Mar 2025) to now. "To" = Latest means no upper limit.
  const LAUNCH_DAY = '2025-03-11';
  const setSel = (id, v) => { const el = $(id); if (![...el.options].some(o => o.value === v)) { const o = new Option(v, v); el.add(o) } el.value = v };
  (function buildDateSelects() {
    const from = $('tfrom'), to = $('tto'), now = new Date();
    const tags = { '2025-03': ' · Launch', '2025-04': ' · Commissioning', '2025-05': ' · Survey begins' };
    const pad = n => String(n).padStart(2, '0'), mon = (y, m) => new Date(Date.UTC(y, m, 1)).toLocaleString('en', { month: 'short', timeZone: 'UTC' });
    const months = [];
    for (let y = 2025, m = 2; y < now.getUTCFullYear() || (y === now.getUTCFullYear() && m <= now.getUTCMonth()); m++) { months.push([y, m]); if (m === 11) { y++; m = -1 } }
    const group = (sel, mk) => {
      let html = '', year = null;
      months.forEach(([y, m], i) => { if (y !== year) { if (year) html += '</optgroup>'; html += `<optgroup label="${y}">`; year = y } html += mk(y, m, i) });
      sel.innerHTML = html + '</optgroup>';
    };
    group(from, (y, m) => { const k = `${y}-${pad(m + 1)}`; return `<option value="${y === 2025 && m === 2 ? LAUNCH_DAY : k + '-01'}">${mon(y, m)} ${y}${tags[k] || ''}</option>` });
    group(to, (y, m, i) => { const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate(), isNow = i === months.length - 1;
      return `<option value="${isNow ? '' : `${y}-${pad(m + 1)}-${pad(last)}`}">${mon(y, m)} ${y}${isNow ? ' · Latest' : ''}</option>` });
    from.value = LAUNCH_DAY; to.value = '';
    const key = v => v || '9999-12-31';
    const sync = changed => {
      [...to.options].forEach(o => { o.disabled = key(o.value) < from.value });
      if (key(to.value) < from.value && changed === 'from') { const ok = [...to.options].find(o => !o.disabled); to.value = ok ? ok.value : '' }
    };
    from.addEventListener('change', () => sync('from')); to.addEventListener('change', () => sync('to')); sync();
    to.syncDates = sync; from.syncDates = sync;
  })();

  // target chips
  let tgt = null; // RA/Dec text of the last chosen target; editing them means a custom position
  function setTarget(t) {
    $('name').value = t.name || ''; $('ra').value = t.ra; $('dec').value = t.dec;
    $('pmra').value = t.pmra || 0; $('pmdec').value = t.pmdec || 0; $('epoch').value = t.epoch || 2000;
    $('pm-box').open = !!(t.pmra || t.pmdec);
    tgt = { ra: $('ra').value, dec: $('dec').value };
  }
  // typing your own RA/Dec must not keep the previous target's proper motion (it would move the aperture off your source)
  ['ra', 'dec'].forEach(id => $(id).addEventListener('input', () => {
    if (!tgt || ($('ra').value === tgt.ra && $('dec').value === tgt.dec)) return;
    tgt = null; $('name').value = ''; $('pmra').value = 0; $('pmdec').value = 0; $('epoch').value = 2000; $('pm-box').open = false;
    setStatus('Custom position: proper motion reset to 0 (open “Moving target” to set it). Press Enter or “Build spectrum”.');
  }));
  // Enter in any numeric field starts the run
  ['ra', 'dec', 'aper', 'size', 'maxn', 'tfrom', 'tto', 'pmra', 'pmdec', 'epoch'].forEach(id =>
    $(id).addEventListener('keydown', e => { if (e.key === 'Enter') run() }));
  $('spx-chips').innerHTML = TARGETS.map((t, i) => `<button class="chip" type="button" data-i="${i}">${esc(t.name)}</button>`).join('');
  $('spx-chips').onclick = e => { const b = e.target.closest('[data-i]'); if (b) { setTarget(TARGETS[+b.dataset.i]); run() } };

  // object name -> coordinates (+ proper motion)
  $('name').addEventListener('keydown', async e => {
    if (e.key !== 'Enter' || !val('name').trim()) return;
    const nm = val('name').trim(), known = TARGETS.find(t => t.name.toLowerCase() === nm.toLowerCase());
    if (known) { setTarget(known); return }
    setStatus('Resolving “' + nm + '”…');
    try {
      const r = await fetch(`${API}/api/resolve?name=${encodeURIComponent(nm)}`);
      if (!r.ok) throw new Error(await r.text());
      const d = await r.json(); setTarget({ name: nm, ra: +d.ra.toFixed(6), dec: +d.dec.toFixed(6), pmra: d.pmra, pmdec: d.pmdec, epoch: d.epoch });
      setStatus('Resolved via ' + d.source + '. Press “Build spectrum”.');
    } catch (err) { setStatus('Could not resolve that name. Enter RA/Dec instead.', true) }
  });

  // data releases: discovered from the IRSA metadata at search time, so a new release shows up without touching the code
  function fillReleases(avail, keep) {
    const names = Object.keys(avail || {}).sort();
    $('rel').innerHTML = '<option value="">All current releases</option>' +
      names.map(r => `<option value="${esc(r)}">${esc(r.toUpperCase())} (${avail[r]} images)</option>`).join('');
    $('rel').value = names.includes(keep) ? keep : '';
  }
  { const r0 = new URLSearchParams(location.search).get('release'); if (r0) $('rel').innerHTML += `<option value="${esc(r0)}" selected>${esc(r0.toUpperCase())}</option>` }

  // ---------- status / progress
  function setStatus(t, isErr) { const s = $('status'); s.textContent = t; s.classList.toggle('spx-err', !!isErr) }
  const setBar = f => $('bar').style.width = (100 * f).toFixed(1) + '%';

  // ---------- geometry: where is a moving target at a given date? (only used to search for images)
  function moved(ra, dec, pmra, pmdec, epoch, year) {
    const dt = year - epoch, d = dec + pmdec * dt / 3.6e6;
    return { ra: ra + pmra * dt / 3.6e6 / Math.cos(d * Math.PI / 180), dec: d };
  }
  const detOf = url => { const m = /_\d+D([1-6])_/.exec(url) || /\/([1-6])\/level2_/.exec(url); return m ? +m[1] : null };

  // ---------- main run
  async function run() {
    if (running) return;
    const ra = numv('ra', NaN), dec = numv('dec', NaN);
    if (isNaN(ra) || isNaN(dec) || ra < 0 || ra > 360 || dec < -90 || dec > 90) { setStatus('RA must be 0–360 and Dec −90 to 90.', true); return }
    const dets = selectedDets(); if (!dets.length) { setStatus('Select at least one detector.', true); return }
    const pmra = numv('pmra', 0), pmdec = numv('pmdec', 0), epoch = numv('epoch', 2000);
    const size = numv('size', 2.5), aper = numv('aper', 12), maxn = Math.max(0, numv('maxn', 0)), rel = val('rel');
    const t0 = val('tfrom') === LAUNCH_DAY ? 0 : dateToMjd(val('tfrom'), false), t1 = dateToMjd(val('tto'), true); // launch → latest = no filter
    if (t0 && t1 && t1 < t0) { setStatus('End time is before start time.', true); return }
    if ((t0 || t1) && Math.max(t0, t1) < LAUNCH_MJD) { setStatus('That time range is before SPHEREx launched (March 2025). Pick a start date from launch onwards.', true); return }
    updateUrl();
    points = []; draw(); running = true; abortCtl = new AbortController();
    $('run').disabled = true; $('cancel').hidden = false; setBar(0);
    try {
      setStatus('Searching IRSA for images covering the target…');
      const q = moved(ra, dec, pmra, pmdec, epoch, 2026.0); // mid-mission position; images are 3.5° wide so this is plenty
      const r = await fetch(`${API}/api/spectral/observations?ra=${q.ra}&dec=${q.dec}&release=${encodeURIComponent(rel)}&t0=${t0}&t1=${t1}`, { signal: abortCtl.signal });
      if (!r.ok) throw new Error(await r.text());
      const d = await r.json();
      observations = d.observations || [];
      renderStackChoices();
      fillReleases(d.releases, rel); relAvail = d.releases;
      lastRun = { size, aper };
      if (d.mjd_min != null) $('t-note').textContent = `Data for this position: ${mjdToDate(d.mjd_min)} to ${mjdToDate(d.mjd_max)}.` + (t0 || t1 ? ` ${d.count} images in your window.` : '');
      // group by detector, keep the selected ones, optionally cap, then interleave so the spectrum fills in evenly
      const by = {}; d.observations.forEach(o => { const k = o.det || detOf(o.url); if (k && dets.includes(k)) (by[k] = by[k] || []).push(o) });
      Object.keys(by).forEach(k => { if (maxn && by[k].length > maxn) { const step = by[k].length / maxn; by[k] = Array.from({ length: maxn }, (_, i) => by[k][Math.floor(i * step)]) } });
      const queue = []; for (let i = 0; Object.values(by).some(a => i < a.length); i++) Object.keys(by).forEach(k => { if (by[k][i]) queue.push(by[k][i]) });
      if (!queue.length) { setStatus('No SPHEREx images cover this position' + (rel ? ' in ' + rel.toUpperCase() : '') + ' for the chosen detectors' + (t0 || t1 ? ' and time range' : '') + '.' +
        (d.mjd_min != null ? ` Images exist for this position from ${mjdToDate(d.mjd_min)} to ${mjdToDate(d.mjd_max)}` + (t0 || t1 ? ' — press “Any time” or widen the range.' : ' — try other detectors.') : ' This position may be outside the released sky coverage.'), true); return }
      let done = 0, failed = 0, outside = 0, firstErr = ''; const total = queue.length, retry = [];
      const upd = () => setStatus(`${d.source}: ${done}/${total} images processed` + (failed ? `, ${failed} failed` : '') + (outside ? `, ${outside} without the target` : '') + ` — ${points.filter(p => p.ok).length} good points`);
      upd();
      // one image -> one point. 404 = the target is not inside the cutout (outside the footprint / edge): skipped, not an error.
      async function fetchPoint(o) {
        const u = `${API}/api/spectrum-point?url=${encodeURIComponent(o.url)}&ra=${ra}&dec=${dec}&size=${size}&radius=${aper}` +
          `&date=${encodeURIComponent(o.date)}&pmra=${pmra}&pmdec=${pmdec}&epoch=${epoch}`;
        const resp = await fetch(u, { signal: abortCtl.signal });
        if (resp.status === 404) return 'outside';
        if (!resp.ok) { if (!firstErr) { try { const j = await resp.json(); firstErr = j.detail || JSON.stringify(j) } catch (e) { firstErr = 'HTTP ' + resp.status } console.warn('spectrum-point failed:', firstErr, o.url) } return null }
        const p = await resp.json();
        p.t = Date.parse(o.date.replace(' ', 'T') + 'Z'); p.det = p.detector || o.det || detOf(o.url);
        p.url = o.url; p.mjd = o.mjd; p.release = p.release || o.release; p.size = size; p.aper = aper; p.id = points.length;
        points.push(p); return p;
      }
      async function pool(list, n, isRetry) {
        let next = 0;
        async function worker() {
          while (next < list.length && !abortCtl.signal.aborted) {
            const o = list[next++]; let res = null;
            try { res = await fetchPoint(o) } catch (e) { if (abortCtl.signal.aborted) return }
            if (res === 'outside') outside++;
            else if (!res) { if (isRetry) failed++; else retry.push(o) }
            if (!isRetry) done++; // progress counts first-pass images only; retries are a bonus pass
            setBar(Math.min(1, done / total)); upd(); scheduleDraw();
          }
        }
        await Promise.all(Array.from({ length: n }, worker));
      }
      await pool(queue, 6, false);
      // IRSA drops some connections under load: give every failed image a second chance, gently
      if (retry.length && !abortCtl.signal.aborted) { setStatus(`Retrying ${retry.length} images that IRSA dropped…`); await pool(retry, 2, true) }
      if (abortCtl.signal.aborted) setStatus('Cancelled — showing ' + points.length + ' points.');
      else setStatus(`Done: ${points.filter(p => p.ok).length} good points from ${total} images` + (failed ? ` (${failed} failed: ${String(firstErr).slice(0, 160)})` : '') + (outside ? ` (${outside} had no usable pixels at the target)` : '') + '.');
    } catch (e) {
      if (!(abortCtl && abortCtl.signal.aborted)) setStatus('Error: ' + (e.message || e) + ' (is the backend running? python main.py)', true);
    } finally {
      running = false; $('run').disabled = false; $('cancel').hidden = true; draw();
    }
  }
  $('run').onclick = run;
  $('cancel').onclick = () => abortCtl && abortCtl.abort();

  // ---------- same-band image stacking (separate from spectral point binning)
  function renderStackChoices() {
    const detSel = $('stack-det'), bandSel = $('stack-band');
    const dets = [...new Set(observations.map(o => +o.det).filter(Boolean))].sort((a,b) => a-b);
    detSel.innerHTML = dets.length ? dets.map(d => `<option value="${d}">D${d}</option>`).join('') : '<option value="">No observations</option>';
    detSel.disabled = !dets.length;
    updateStackBands();
  }
  function updateStackBands() {
    const d = +val('stack-det'), bandSel = $('stack-band');
    const bands = [...new Set(observations.filter(o => +o.det === d).map(o => o.band).filter(Boolean))].sort();
    bandSel.innerHTML = bands.length ? bands.map(b => `<option value="${esc(b)}">${esc(b)}</option>`).join('') : '<option value="">No bandpasses</option>';
    bandSel.disabled = !bands.length;
    renderStackObservationList();
  }
  function renderStackObservationList() {
    const d = +val('stack-det'), band = val('stack-band');
    const rows = observations.filter(o => +o.det === d && o.band === band);
    $('stack-observations').innerHTML = rows.length ? rows.map((o,i) => `<label class="stack-item"><input type="checkbox" value="${i}" ${i < Math.min(rows.length, 4) ? 'checked' : ''}><span>${esc(o.date || 'Unknown date')} <small>${esc((o.release || '').toUpperCase())}</small></span></label>`).join('') : '<span class="spx-note">No matching observations for this detector/band.</span>';
    // Store only the currently displayed, exact-band subset for checkbox indexing.
    $('stack-observations').dataset.count = String(rows.length);
    $('stack-observations')._rows = rows;
    $('stack-run').disabled = rows.length < 2;
    $('stack-status').textContent = rows.length < 2 ? 'At least two observations of this exact bandpass are required.' : `${rows.length} matching observations available; select 2–12.`;
  }
  $('stack-det').addEventListener('change', updateStackBands);
  $('stack-band').addEventListener('change', renderStackObservationList);
  $('stack-run').addEventListener('click', async () => {
    const wrap = $('stack-observations'), rows = wrap._rows || [];
    const chosen = [...wrap.querySelectorAll('input:checked')].map(cb => rows[+cb.value]).filter(Boolean);
    if (chosen.length < 2 || chosen.length > 12) { $('stack-status').textContent = 'Select between 2 and 12 observations.'; return; }
    const det = +val('stack-det'), band = val('stack-band');
    if (chosen.some(o => +o.det !== det || o.band !== band)) { $('stack-status').textContent = 'Safety check: all images must have the same detector and exact bandpass.'; return; }
    $('stack-run').disabled = true; $('stack-status').textContent = 'Aligning images and combining pixels…'; $('stack-result').hidden = true;
    try {
      const params = new URLSearchParams({ urls: chosen.map(o => o.url).join(','), ra: val('ra'), dec: val('dec'), size: val('size'), method: val('stack-method') });
      const response = await fetch(`${API}/api/combine.png?${params}`);
      if (!response.ok) { let msg = `HTTP ${response.status}`; try { const j = await response.json(); msg = j.detail || msg; } catch(e) {} throw new Error(msg); }
      const blob = await response.blob(), objectUrl = URL.createObjectURL(blob);
      $('stack-img').src = objectUrl; $('stack-result').hidden = false;
      $('stack-caption').textContent = `${chosen.length} images combined · D${det} · ${band} · ${val('stack-method')} · ${chosen[0].date} to ${chosen[chosen.length-1].date}`;
      $('stack-status').textContent = 'Combined image ready.';
      { const fr = new FileReader(); fr.onload = () => { stackImg = { src: fr.result, caption: $('stack-caption').textContent } }; fr.readAsDataURL(blob); } // kept so it survives a tab switch
    } catch (err) { $('stack-status').textContent = 'Could not combine images: ' + err.message; }
    finally { $('stack-run').disabled = false; }
  });

  // ---------- plotting
  const C = 2.998e8;
  function yOf(p, unit) {
    if (unit === 'sb') return p.bkg_mjysr;
    if (p.flux_jy == null) return null;
    if (unit === 'jy') return p.flux_jy;
    if (unit === 'mjy') return p.flux_jy * 1e3;
    if (unit === 'ujy') return p.flux_jy * 1e6;
    return p.flux_jy * 1e-26 * C / (p.wave * 1e-6); // νFν in W/m²
  }
  const eOf = (p, unit) => p.err_jy == null || unit === 'sb' ? null : yOf({ ...p, flux_jy: p.err_jy }, unit);
  const yLabel = { jy: 'Flux density (Jy)', mjy: 'Flux density (mJy)', ujy: 'Flux density (µJy)', nufnu: 'νFν (W m⁻²)', sb: 'Local background (MJy/sr)' };

  // weighted mean in log-wavelength bins, per detector
  function binned(pts, R, unit) {
    const out = [];
    for (const k of Object.keys(DET)) {
      const bins = {};
      pts.filter(p => p.det == k).forEach(p => {
        const y = yOf(p, unit); if (y == null) return;
        const b = Math.round(Math.log(p.wave) / Math.log(1 + 1 / R)), e = eOf(p, unit);
        (bins[b] = bins[b] || []).push({ w: p.wave, y, e });
      });
      Object.keys(bins).sort((a, b) => a - b).forEach(b => {
        const a = bins[b], hasE = a.every(v => v.e > 0), wt = a.map(v => hasE ? 1 / (v.e * v.e) : 1), sw = wt.reduce((x, y) => x + y, 0);
        const m = a.reduce((s, v, i) => s + v.y * wt[i], 0) / sw, w = a.reduce((s, v) => s + v.w, 0) / a.length;
        const sd = a.length > 1 ? Math.sqrt(a.reduce((s, v) => s + (v.y - m) ** 2, 0) / (a.length - 1) / a.length) : 0;
        out.push({ det: +k, w, y: m, e: Math.max(hasE ? 1 / Math.sqrt(sw) : 0, sd), n: a.length });
      });
    }
    return out;
  }

  // flag categories (IRSA convention: >= 2^32 = bad pixel involved; 0 or SOURCE only = nominal; DICHROIC = D3/D4 warning)
  const SRC = 2 ** 21;
  const FCAT = { clean: ['clean (0 / source only)', '#7bd88f'], warn: ['other flag (warning)', '#e8d36a'], dichroic: ['DICHROIC (bit 7)', '#b48cf0'], bad: ['bad pixel in aperture (bit 32)', '#ee6f6f'] };
  const fcat = p => p.contains_bad ? 'bad' : p.dichroic ? 'dichroic' : (p.flag_or === 0 || p.flag_or === SRC) ? 'clean' : 'warn';
  const usable = () => points.filter(p => p.ok && p.wave != null && !($('hidebad').checked && p.contains_bad));

  function hover(p) {
    const f = p.flags && p.flags.length ? p.flags.map(esc).join(', ') : 'none';
    return `λ = ${p.wave.toFixed(3)} µm<br>D${p.det} · ${esc(p.date)}<br>flagged aperture: ${(100 * p.flag_frac).toFixed(0)}%<br>flags: ${f}<br>flag value: ${p.flag_value}${p.dichroic ? ' — DICHROIC: calibration uncertain' : ''}<br>release: ${esc((p.release || '?').toUpperCase())} · version: ${esc(p.version || '?')}<br><i>click to inspect the cutout</i>`;
  }
  const layoutBase = () => ({
    paper_bgcolor: 'rgba(0,0,0,0)', plot_bgcolor: '#06090f', font: { color: '#e8ecf3', family: 'Inter, sans-serif', size: 12 },
    margin: { l: 70, r: 20, t: 10, b: 50 }, legend: { orientation: 'h', y: 1.12 }, hovermode: 'closest'
  });
  const axis = (title, extra) => Object.assign({ title, gridcolor: '#1a2130', zerolinecolor: '#2a3346', linecolor: '#232a38' }, extra || {});

  function drawSpectrum() {
    const unit = val('yunit'), good = usable(), bad = points.filter(p => !p.ok && p.wave != null);
    const traces = [], colorBy = val('color-by'), R = +val('bin');
    const t0 = Math.min(...good.map(p => p.t)), t1 = Math.max(...good.map(p => p.t));
    if ($('joinpts').checked) // connect the points of each detector in wavelength order (drawn first, under the markers)
      Object.keys(DET).forEach(k => {
        const g = good.filter(p => p.det == k).sort((a, b) => a.wave - b.wave); if (g.length < 2) return;
        traces.push({ type: 'scatter', mode: 'lines', x: g.map(p => p.wave), y: g.map(p => yOf(p, unit)), showlegend: false, hoverinfo: 'skip',
          line: { color: DET[k].color, width: 1 }, opacity: .45 });
      });
    if (colorBy === 'flags' && good.length) {
      Object.keys(FCAT).forEach(k => {
        const g = good.filter(p => fcat(p) === k); if (!g.length) return;
        traces.push({
          type: 'scattergl', mode: 'markers', name: FCAT[k][0], x: g.map(p => p.wave), y: g.map(p => yOf(p, unit)),
          error_y: { type: 'data', array: g.map(p => eOf(p, unit) || 0), thickness: 1, width: 0, color: FCAT[k][1] + '55' },
          marker: { size: 6, color: FCAT[k][1], opacity: .9 }, text: g.map(hover), customdata: g.map(p => p.id), hoverinfo: 'text'
        });
      });
    } else if (colorBy === 'date' && good.length) {
      traces.push({
        type: 'scattergl', mode: 'markers', name: 'images', x: good.map(p => p.wave), y: good.map(p => yOf(p, unit)),
        error_x: { type: 'data', array: good.map(p => (p.bandwidth || 0) / 2), thickness: 1, width: 0, color: '#556' },
        error_y: { type: 'data', array: good.map(p => eOf(p, unit) || 0), thickness: 1, width: 0, color: '#556' },
        marker: { size: 6, color: good.map(p => (p.t - t0) / ((t1 - t0) || 1)), colorscale: 'Viridis', showscale: true, colorbar: { title: 'time →', thickness: 10, len: .6 } },
        text: good.map(hover), customdata: good.map(p => p.id), hoverinfo: 'text'
      });
    } else {
      Object.keys(DET).forEach(k => {
        const g = good.filter(p => p.det == k); if (!g.length) return;
        traces.push({
          type: 'scattergl', mode: 'markers', name: 'D' + k, x: g.map(p => p.wave), y: g.map(p => yOf(p, unit)),
          error_x: { type: 'data', array: g.map(p => (p.bandwidth || 0) / 2), thickness: 1, width: 0, color: DET[k].color + '55' },
          error_y: { type: 'data', array: g.map(p => eOf(p, unit) || 0), thickness: 1, width: 0, color: DET[k].color + '55' },
          marker: { size: 6, color: DET[k].color, opacity: R ? .45 : .9 }, text: g.map(hover), customdata: g.map(p => p.id), hoverinfo: 'text'
        });
      });
    }
    if (R && good.length) {
      const b = binned(good, R, unit);
      Object.keys(DET).forEach(k => {
        const g = b.filter(v => v.det == k); if (!g.length) return;
        traces.push({
          type: 'scatter', mode: 'lines+markers', name: 'D' + k + ' binned', showlegend: false, x: g.map(v => v.w), y: g.map(v => v.y),
          error_y: { type: 'data', array: g.map(v => v.e), thickness: 1.2, width: 2, color: DET[k].color },
          line: { color: DET[k].color, width: 2 }, marker: { size: 5, color: DET[k].color },
          text: g.map(v => `D${k}: ${v.n} image${v.n > 1 ? 's' : ''} in bin`), hoverinfo: 'x+y+text'
        });
      });
    }
    if ($('showbad').checked && bad.length)
      traces.push({ type: 'scattergl', mode: 'markers', name: 'rejected', x: bad.map(p => p.wave), y: bad.map(p => p.flux_jy == null ? null : yOf(p, unit)), marker: { size: 6, symbol: 'x', color: '#888' }, text: bad.map(hover), customdata: bad.map(p => p.id), hoverinfo: 'text' });
    if ($('showbkg').checked && unit !== 'sb' && good.length)
      traces.push({ type: 'scattergl', mode: 'markers', name: 'local background (MJy/sr, right axis)', yaxis: 'y2', x: good.map(p => p.wave), y: good.map(p => p.bkg_mjysr), marker: { size: 4, color: '#666' }, hoverinfo: 'x+y' });

    // detector bands as faint background, labelled at the top
    const shapes = [], ann = [];
    Object.keys(DET).forEach(k => {
      if (!selectedDets().includes(+k)) return;
      shapes.push({ type: 'rect', xref: 'x', yref: 'paper', x0: DET[k].lo, x1: DET[k].hi, y0: 0, y1: 1, fillcolor: DET[k].color, opacity: .06, line: { width: 0 }, layer: 'below' });
      ann.push({ x: Math.sqrt(DET[k].lo * DET[k].hi), xref: 'x', y: 1, yref: 'paper', text: 'D' + k, showarrow: false, font: { size: 10, color: DET[k].color }, yanchor: 'bottom' });
    });
    const lay = layoutBase();
    lay.xaxis = axis('Wavelength (µm)', { type: $('logx').checked ? 'log' : 'linear', range: $('logx').checked ? [Math.log10(.72), Math.log10(5.1)] : [.72, 5.1] });
    lay.yaxis = axis(yLabel[unit], { type: $('logy').checked ? 'log' : 'linear' });
    if ($('showbkg').checked && unit !== 'sb') lay.yaxis2 = axis('Background (MJy/sr)', { overlaying: 'y', side: 'right', showgrid: false });
    lay.shapes = shapes; lay.annotations = ann; lay.margin.t = 24; lay.margin.r = $('showbkg').checked ? 70 : 20;
    Plotly.react('chart-spec', traces, lay, { responsive: true, displaylogo: false });
  }

  function drawLightCurve() {
    const lmin = numv('lmin', 0), lmax = numv('lmax', 99), mode = val('lc-mode');
    const g = usable().filter(p => p.wave >= lmin && p.wave <= lmax && p.flux_jy != null);
    let ys, ylab;
    if (mode === 'ratio') {
      const bins = {}, key = p => Math.round(Math.log(p.wave) / Math.log(1 + 1 / 40)), med = a => { a = [...a].sort((x, y) => x - y); const m = a.length >> 1; return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2 };
      g.forEach(p => (bins[key(p)] = bins[key(p)] || []).push(p.flux_jy));
      const md = {}; Object.keys(bins).forEach(k => md[k] = med(bins[k]));
      ys = g.map(p => { const m = md[key(p)]; return bins[key(p)].length >= 3 && m > 0 ? p.flux_jy / m : null }); ylab = 'Flux ÷ median at that wavelength';
    } else { ys = g.map(p => p.flux_jy); ylab = 'Flux density (Jy)' }
    const keep = g.map((p, i) => ys[i] != null ? i : -1).filter(i => i >= 0);
    const trace = {
      type: 'scattergl', mode: 'markers', x: keep.map(i => new Date(g[i].t)), y: keep.map(i => ys[i]),
      marker: { size: 6, color: keep.map(i => g[i].wave), colorscale: 'Turbo', cmin: .75, cmax: 5, showscale: true, colorbar: { title: 'λ (µm)', thickness: 10, len: .7 } },
      text: keep.map(i => hover(g[i])), customdata: keep.map(i => g[i].id), hoverinfo: 'text'
    };
    const lay = layoutBase(); lay.xaxis = axis('Date (UTC)'); lay.yaxis = axis(ylab); lay.margin.t = 10;
    if (mode === 'ratio') lay.shapes = [{ type: 'line', xref: 'paper', x0: 0, x1: 1, y0: 1, y1: 1, line: { color: '#556', dash: 'dot' } }];
    Plotly.react('chart-lc', [trace], lay, { responsive: true, displaylogo: false });
  }

  function drawSummary() {
    const ok = points.filter(p => p.ok), rej = points.length - ok.length;
    const per = Object.keys(DET).map(k => ok.filter(p => p.det == k).length ? `D${k}: ${ok.filter(p => p.det == k).length}` : '').filter(Boolean).join(' · ');
    const nb = ok.filter(p => p.contains_bad).length, nd = ok.filter(p => p.dichroic).length;
    $('summary').textContent = points.length ? `${ok.length} good points (${nb} with some bad pixel in the aperture, ${nd} DICHROIC), ${rej} rejected (more than half the aperture flagged). ${per}` : 'No data yet.';
  }
  function draw() { drawSpectrum(); drawLightCurve(); drawSummary(); bindPlots() }

  // ---------- click a point -> look at the actual cutout (is the star really inside the aperture? any contamination?)
  function bindPlots() {
    if (plotsBound) return; plotsBound = true;
    ['chart-spec', 'chart-lc'].forEach(id => $(id).on('plotly_click', ev => {
      const pt = ev.points && ev.points.find(q => q.customdata != null); if (pt) inspect(points[pt.customdata]);
    }));
  }
  function inspect(p, noScroll) {
    if (!p) return;
    inspectedId = p.id;
    $('inspect').hidden = false;
    const img = $('inspect-img'), msg = $('inspect-msg');
    msg.textContent = 'Loading cutout…';
    img.onload = () => { msg.textContent = '' }; img.onerror = () => { msg.textContent = 'Cutout could not be loaded.' };
    img.src = `${API}/api/cutout.png?url=${encodeURIComponent(p.url)}&ra=${p.ra}&dec=${p.dec}&size=${p.size}`;
    $('inspect-ap').setAttribute('r', Math.min(49, p.aper / (p.size * 60) * 100)); // svg viewBox is 100 wide = the cutout width
    const f = p.flags && p.flags.length ? p.flags.map(esc).join(', ') : 'none';
    const fx = p.flux_jy == null ? 'rejected' : `${p.flux_jy.toPrecision(3)} Jy` + (p.err_jy != null ? ` ± ${p.err_jy.toPrecision(2)}` : '');
    $('inspect-meta').innerHTML =
      `<b>λ</b> ${p.wave.toFixed(3)} µm` + (p.bandwidth ? ` (width ${p.bandwidth.toFixed(3)})` : '') + ` · <b>D${p.det}</b><br>` +
      `<b>Date</b> ${esc(p.date)} UTC<br><b>Release</b> ${esc((p.release || '?').toUpperCase())} · ${esc(p.version || '?')}<br>` +
      `<b>Flux</b> ${fx}<br><b>Aperture flagged</b> ${(100 * p.flag_frac).toFixed(0)}%<br><b>Flags</b> ${f} (value ${p.flag_value})<br>` +
      (p.dichroic ? '<b>Warning</b> DICHROIC pixel: calibration uncertain<br>' : '') +
      `<b>Pixel</b> x ${p.x_image.toFixed(1)}, y ${p.y_image.toFixed(1)}<br>` +
      `<b>Position</b> ${p.ra.toFixed(5)}°, ${p.dec.toFixed(5)}°`;
    if (!noScroll) $('inspect').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
  function scheduleDraw() { if (!redrawTimer) redrawTimer = setTimeout(() => { redrawTimer = null; draw() }, 500) }
  ['color-by', 'bin', 'yunit', 'logx', 'logy', 'showbad', 'hidebad', 'joinpts', 'showbkg', 'lc-mode', 'lmin', 'lmax'].forEach(id => $(id).addEventListener('change', draw));

  // ---------- CSV + share link
  $('dl-csv').onclick = () => {
    if (!points.length) return;
    // column names follow IRSA's spectrophotometry output (flux in µJy); extra: version, contains_bad, dichroic
    const cols = ['wavelength', 'flux', 'flux_err', 'lambda_width', 'flags', 'flux_bkg', 'det_id', 'mjd', 'date', 'data_collection', 'version', 'x_image', 'y_image', 'ra', 'dec', 'contains_bad', 'dichroic', 'ok'];
    const get = (p, c) => ({ wavelength: p.wave, flux: p.flux_jy == null ? null : p.flux_jy * 1e6, flux_err: p.err_jy == null ? null : p.err_jy * 1e6, lambda_width: p.bandwidth,
      flags: p.flag_value, flux_bkg: p.bkg_mjysr, det_id: p.det, mjd: p.mjd, date: p.date, data_collection: p.release })[c] ?? p[c];
    const rows = [...points].sort((a, b) => a.t - b.t).map(p => cols.map(c => { const v = get(p, c); return v == null ? '' : '"' + String(v).replace(/"/g, '""') + '"' }).join(','));
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([cols.join(',') + '\n' + rows.join('\n')], { type: 'text/csv' }));
    a.download = 'spherex_spectrum_' + (val('name') || val('ra') + '_' + val('dec')).replace(/\W+/g, '_') + '.csv'; a.click();
  };
  // shareable / embeddable state: ?ra=..&dec=..&pmra=..&pmdec=..&epoch=..&r=..&size=..&det=123456&name=..&release=dr1&from=2026-01-01&to=2026-06-30&embed=1
  function updateUrl() {
    const p = new URLSearchParams({ ra: val('ra'), dec: val('dec'), r: val('aper'), size: val('size'), det: selectedDets().join('') });
    if (numv('pmra', 0) || numv('pmdec', 0)) { p.set('pmra', val('pmra')); p.set('pmdec', val('pmdec')); p.set('epoch', val('epoch')) }
    if (val('tfrom') && val('tfrom') !== LAUNCH_DAY) p.set('from', val('tfrom')); if (val('tto')) p.set('to', val('tto'));
    if (val('name')) p.set('name', val('name')); if (val('rel')) p.set('release', val('rel'));
    if (new URLSearchParams(location.search).get('embed')) p.set('embed', '1');
    history.replaceState(null, '', '?' + p.toString());
  }
  $('share').onclick = () => { updateUrl(); (navigator.clipboard ? navigator.clipboard.writeText(location.href) : Promise.reject()).then(() => setStatus('Link copied.'), () => setStatus(location.href)) };

  // ---------- keep results when switching tabs; only a refresh resets them
  const KEEP = 'utopia.keep.spectral';
  const KF = ['name', 'ra', 'dec', 'pmra', 'pmdec', 'epoch', 'tfrom', 'tto', 'aper', 'size', 'maxn', 'color-by', 'bin', 'yunit', 'lmin', 'lmax', 'lc-mode', 'stack-method'];
  const KC = ['joinpts', 'logx', 'logy', 'hidebad', 'showbad', 'showbkg'];
  function snapshot(light) {
    const f = {}, c = {}; KF.forEach(id => f[id] = $(id).value); KC.forEach(id => c[id] = $(id).checked);
    return {
      f, c, rel: val('rel'), relAvail, dets: selectedDets(), pmOpen: $('pm-box').open, tgt, points, observations, lastRun, wasRunning: running, inspectedId,
      status: $('status').textContent, statusErr: $('status').classList.contains('spx-err'), tnote: $('t-note').textContent, bar: $('bar').style.width,
      stack: { det: val('stack-det'), band: val('stack-band'), checked: [...$('stack-observations').querySelectorAll('input')].map(i => i.checked), img: light ? null : stackImg }
    };
  }
  function keep() { if (points.length || observations.length) keepSave(KEEP, snapshot); }
  function restoreState(s) {
    KF.forEach(id => { if (s.f[id] != null) (id === 'tfrom' || id === 'tto') ? setSel(id, s.f[id] || (id === 'tfrom' ? LAUNCH_DAY : '')) : $(id).value = s.f[id] });
    KC.forEach(id => { if (id in s.c) $(id).checked = s.c[id] });
    document.querySelectorAll('#spx-dets input').forEach(i => i.checked = (s.dets || []).includes(+i.value));
    $('pm-box').open = !!s.pmOpen;
    relAvail = s.relAvail || null; fillReleases(relAvail, s.rel);
    if (s.rel && $('rel').value !== s.rel) { $('rel').innerHTML += `<option value="${esc(s.rel)}">${esc(s.rel.toUpperCase())}</option>`; $('rel').value = s.rel }
    tgt = s.tgt || null; points = s.points || []; observations = s.observations || []; lastRun = s.lastRun || null;
    inspectedId = s.inspectedId; const st = s.stack || {}; stackImg = st.img || null;
    renderStackChoices();
    if ([...$('stack-det').options].some(o => o.value === st.det)) { $('stack-det').value = st.det; updateStackBands() }
    if ([...$('stack-band').options].some(o => o.value === st.band)) { $('stack-band').value = st.band; renderStackObservationList() }
    [...$('stack-observations').querySelectorAll('input')].forEach((cb, i) => { if (st.checked && i < st.checked.length) cb.checked = st.checked[i] });
    if (stackImg) { $('stack-img').src = stackImg.src; $('stack-caption').textContent = stackImg.caption; $('stack-result').hidden = false }
    draw();
    if (s.tnote) $('t-note').textContent = s.tnote;
    $('bar').style.width = s.bar || '0%';
    if (s.wasRunning) setStatus(`You left this tab while the spectrum was still building — ${points.filter(p => p.ok).length} points kept. Press “Build spectrum” to rebuild it, or refresh the page.`);
    else setStatus(s.status || '', s.statusErr);
    if (inspectedId != null && points[inspectedId]) inspect(points[inspectedId], true);
    updateUrl();
  }
  addEventListener('pagehide', keep);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') keep() });

  // ---------- start-up: kept results, else URL params, else last Sky Explorer search, else WISE 0855
  (function init() {
    const p = new URLSearchParams(location.search);
    if (p.get('embed')) document.body.classList.add('embed'); // ?embed=1 hides the site header so the page fits an <iframe>
    const kept = keepLoad(KEEP), hasUrl = p.get('ra') && p.get('dec');
    if (kept && kept.f && (!hasUrl || (+p.get('ra') === +kept.f.ra && +p.get('dec') === +kept.f.dec))) { restoreState(kept); return } // back from another tab: show the same results, no re-run
    if (p.get('ra') && p.get('dec')) {
      setTarget({ name: p.get('name') || '', ra: +p.get('ra'), dec: +p.get('dec'), pmra: +p.get('pmra') || 0, pmdec: +p.get('pmdec') || 0, epoch: +p.get('epoch') || 2000 });
      if (p.get('from')) setSel('tfrom', p.get('from')); if (p.get('to')) setSel('tto', p.get('to'));
      if (p.get('r')) $('aper').value = p.get('r'); if (p.get('size')) $('size').value = p.get('size');
      if (p.get('det')) document.querySelectorAll('#spx-dets input').forEach(i => i.checked = p.get('det').includes(i.value));
      draw(); run();
    } else {
      let saved = null; try { saved = JSON.parse(sessionStorage.getItem(STORE_KEY)) } catch (e) { }
      if (saved && !isNaN(saved.ra)) setTarget({ ra: saved.ra, dec: saved.dec }); else setTarget(TARGETS[2]);
      draw();
    }
  })();
})();
