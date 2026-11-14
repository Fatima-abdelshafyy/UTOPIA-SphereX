(() => {
  const body = document.getElementById('discoveries-rows');
  if (!body) return;
  const note = document.getElementById('discoveries-note');
  const API = (location.protocol === 'file:' || (location.port && location.port !== '8000' && /^(localhost|127\.0\.0\.1)$/.test(location.hostname))) ? 'http://localhost:8000' : '';
  const STATUSES = ['Needs verification', 'Promising candidate', 'Rejected', 'Confirmed by reviewer'];

  // Temporary sample rows, shown only while nothing real has been saved yet (clearly marked as samples).
  const SAMPLES = [
    { id: 'sample-1', sample: true, kind: 'change', label: 'brightened', display_name: 'Sample target · Brightened', object_type: 'Target', ra: 76.9565, dec: 30.4014, z: 6.8, change_pct: 41.2, epochs: 9, group: '1.482 µm' },
    { id: 'sample-2', sample: true, kind: 'change', label: 'dimmed', display_name: 'Sample field source', object_type: 'Field source', ra: 76.9712, dec: 30.3921, z: -5.1, change_pct: -27.5, epochs: 7, group: '1.482 µm' },
    { id: 'sample-3', sample: true, kind: 'change', label: 'variable', display_name: 'Sample field source', object_type: 'Field source', ra: 76.9408, dec: 30.4156, z: 3.3, change_pct: 8.9, epochs: 11, group: '2.215 µm' },
    { id: 'sample-4', sample: true, kind: 'change', label: 'appeared', display_name: 'Sample field source', object_type: 'Field source', ra: 76.9631, dec: 30.4087, z: 7.4, change_pct: 120.0, epochs: 6, group: '3.104 µm' }
  ];

  const cap = text => text ? text.charAt(0).toUpperCase() + text.slice(1) : '';
  const sign = n => (Number(n) > 0 ? '+' : '');
  const num = (v, digits = 5) => (v == null || v === '' || !Number.isFinite(Number(v))) ? '—' : Number(v).toFixed(digits);

  // Works for the current change-detection records and for older moving-candidate records.
  function describe(c, i) {
    const track = Array.isArray(c.track) ? c.track : [];
    const first = track[0] || {};
    const legacy = c.kind !== 'change' && !c.label;
    const name = c.display_name || c.name || `Candidate ${i + 1}`;
    const kind = legacy ? (c.object_type || 'Candidate') : `${cap(c.label)} · ${c.object_type || 'Source'}`;
    let significance, change, span;
    if (legacy) {
      const score = c.exploration_score ?? c.evidenceScore ?? first.evidence_score_percent;
      significance = score == null ? '—' : `${score}%*`;
      const speed = c.speed ?? first.motion_fit_speed_arcsec_per_day ?? first.angular_speed_arcsec_per_day;
      change = speed == null ? '—' : `${speed} arcsec/day`;
      span = `${track.length} epochs`;
    } else {
      significance = c.z == null ? '—' : `${c.z} σ`;
      change = c.change_pct == null ? '—' : `${sign(c.change_pct)}${c.change_pct}%`;
      span = `${c.epochs ?? track.length} epochs · ${c.group || '—'}`;
    }
    return { name, kind, significance, change, span, ra: c.ra ?? first.ra, dec: c.dec ?? first.dec };
  }

  function statusSelect(candidate) {
    const select = document.createElement('select');
    STATUSES.forEach(status => {
      const option = document.createElement('option');
      option.value = option.textContent = status;
      option.selected = status === String(candidate.status || 'Needs verification');
      select.appendChild(option);
    });
    if (candidate.sample) { select.disabled = true; return select; }
    select.addEventListener('change', async () => {
      select.disabled = true;
      try {
        const r = await fetch(`${API}/api/discoveries/${encodeURIComponent(candidate.id)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: select.value }) });
        const d = await r.json();
        if (!r.ok) throw new Error(d.detail || `HTTP ${r.status}`);
        candidate.status = d.status;
      } catch (e) {
        alert(`Could not update status: ${e.message}`);
        select.value = candidate.status || 'Needs verification';
      } finally { select.disabled = false; }
    });
    return select;
  }

  function render(candidates) {
    body.replaceChildren();
    candidates.forEach((candidate, i) => {
      const d = describe(candidate, i);
      const tr = document.createElement('tr');
      if (candidate.sample) tr.style.opacity = '.62';
      const cells = [d.name, num(d.ra), num(d.dec), null, d.significance, d.change, d.span];
      cells.forEach((value, j) => {
        const td = document.createElement('td');
        if (j === 0 && candidate.sample) {
          td.textContent = `${value} `;
          const chip = document.createElement('span'); chip.className = 'chip'; chip.textContent = 'sample'; td.appendChild(chip);
        } else if (j === 3) {
          const label = document.createElement('div'); label.textContent = d.kind; label.style.marginBottom = '5px';
          td.append(label, statusSelect(candidate));
        } else td.textContent = String(value);
        tr.appendChild(td);
      });
      tr.title = `First: ${candidate.firstDate || (candidate.track?.[0]?.date) || 'unknown'}; last: ${candidate.lastDate || candidate.track?.[candidate.track.length - 1]?.date || 'unknown'}; detector: D${candidate.detector || '?'}; saved: ${candidate.created_at || candidate.savedAt || 'unknown'}`;
      body.appendChild(tr);
    });
  }

  function showSamples() {
    render(SAMPLES);
    note.textContent = 'Sample data — nothing has been saved yet. Run “Detect changes” in Time Machine and press “Add to Discoveries”; your sources will appear here in place of these examples.';
  }

  const load = async () => {
    try {
      const response = await fetch(`${API}/api/discoveries`);
      const data = await response.json();
      if (!response.ok || !Array.isArray(data.discoveries) || !data.discoveries.length) { showSamples(); return; }
      render(data.discoveries);
      note.textContent = 'Significance is the change between the first and last epochs in sigma (σ); it is a statistical indicator, not a calibrated probability. Every candidate still requires verification.';
    } catch (e) { showSamples(); }
  };
  load();
})();
