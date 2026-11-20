

import math
from concurrent.futures import ThreadPoolExecutor
from threading import Lock

import numpy as np
from scipy import ndimage

from astropy import units as u
from astropy.coordinates import SkyCoord
from astropy.wcs import WCS
from astropy.wcs.utils import proj_plane_pixel_scales

# ---- tunable defaults -------------------------------------------------
R_AP, R_IN, R_OUT = 2.0, 4.0, 7.0   
DETECT_NSIGMA = 5.0
MIN_DETECT_PIX = 2
MAX_SOURCES_PER_GROUP = 40
WAVELENGTH_TOL = 0.015              
SYSTEMATIC_FLOOR = 0.05           
MAX_TOTAL_PIXELS = 80_000_000       


class Cancelled(Exception):
    """Raised when the user pressed Stop."""


# ======================================================================
# Reading one observation
# ======================================================================

def _ext(hdul, name):
    for hdu in hdul:
        if hdu.name.upper() == name.upper():
            return hdu
    return None


def read_wavelength_um(hdul, wcs, ra, dec):
    """Central wavelength (micron) at the target pixel, from the WCS-WAVE
    spectral WCS. Returns None if it cannot be read."""
    try:
        image = _ext(hdul, "IMAGE")
        spectral = WCS(image.header, fobj=hdul, key="W")
        spectral.sip = None
        x, y = wcs.world_to_pixel(SkyCoord(ra, dec, unit="deg"))
        wavelength, _bandwidth = spectral.pixel_to_world(x, y)
        value = float(wavelength.to(u.micrometer).value)
        return value if np.isfinite(value) and value > 0 else None
    except Exception:
        return None


def extract(hdul, ra, dec, bad_mask=0):
    """Pull everything we need from one cutout into a plain dict.

    bad_mask: integer bit-mask of FLAGS bits to blank out (0 = no masking).
    """
    image = _ext(hdul, "IMAGE")
    if image is None or image.data is None:
        raise ValueError("No IMAGE extension")

    data = np.asarray(image.data, dtype=np.float32)
    wcs = WCS(image.header)

    variance = None
    v = _ext(hdul, "VARIANCE")
    if v is not None and v.data is not None and v.data.shape == data.shape:
        variance = np.asarray(v.data, dtype=np.float32)

    flags = _ext(hdul, "FLAGS")
    if bad_mask and flags is not None and flags.data is not None \
            and flags.data.shape == data.shape:
        bad = (np.asarray(flags.data).astype(np.int64) & int(bad_mask)) != 0
        masked = data.copy()
        masked[bad] = np.nan
        if np.isfinite(masked).mean() > 0.1:     # never throw away (almost) everything
            data = masked

    try:
        pixscale = float(np.mean(proj_plane_pixel_scales(wcs.celestial))) * 3600.0
    except Exception:
        pixscale = 6.2

    return {
        "data": data,
        "var": variance,
        "wcs": wcs,
        "wavelength": read_wavelength_um(hdul, wcs, ra, dec),
        "pixscale": pixscale,
    }


# ======================================================================
# Source detection
# ======================================================================

def _robust_sigma(values):
    values = values[np.isfinite(values)]
    if values.size < 5:
        return float("nan")
    med = np.median(values)
    return float(1.4826 * np.median(np.abs(values - med)))


def detect_sources(obs, nsigma=DETECT_NSIGMA):
    """Return [(ra, dec, snr), ...] for peaks above the local background."""
    data = obs["data"]
    finite = np.isfinite(data)
    if finite.sum() < 20:
        return []

    filled = np.where(finite, data, np.nanmedian(data))
    background = ndimage.median_filter(filled, size=11, mode="nearest")
    residual = filled - background
    sigma = _robust_sigma(residual[finite])
    if not np.isfinite(sigma) or sigma <= 0:
        return []

    detected = (residual > nsigma * sigma) & finite
    labels, count = ndimage.label(detected)
    if count == 0:
        return []

    index = np.arange(1, count + 1)
    sizes = ndimage.sum(detected, labels, index)
    peaks = ndimage.maximum(residual, labels, index)
    centers = ndimage.center_of_mass(np.clip(residual, 0, None), labels, index)

    keep = [k for k, size in enumerate(sizes) if size >= MIN_DETECT_PIX]
    if not keep:
        return []
    cy = np.array([centers[k][0] for k in keep], dtype=float)
    cx = np.array([centers[k][1] for k in keep], dtype=float)
    try:
        ras, decs = obs["wcs"].celestial.pixel_to_world_values(cx, cy)
    except Exception:
        return []
    return [
        (float(r), float(d), float(peaks[k] / sigma))
        for k, r, d in zip(keep, np.atleast_1d(ras), np.atleast_1d(decs))
        if np.isfinite(r) and np.isfinite(d)
    ]


# ======================================================================
# Photometry
# ======================================================================

def pixel_positions(obs, ras, decs):
    """Sky -> pixel for many positions at once (one WCS call per image)."""
    try:
        x, y = obs["wcs"].celestial.world_to_pixel_values(
            np.asarray(ras, dtype=float), np.asarray(decs, dtype=float))
        return np.atleast_1d(x).astype(float), np.atleast_1d(y).astype(float)
    except Exception:
        n = len(ras)
        return np.full(n, np.nan), np.full(n, np.nan)


def measure_at(obs, x, y):
    """Background-subtracted mean surface brightness and its error at pixel
    (x, y). Returns (flux, error) or None when the position is not usable."""
    data, variance = obs["data"], obs["var"]
    if not (np.isfinite(x) and np.isfinite(y)):
        return None

    ny, nx = data.shape
    # the whole aperture must be inside the image
    if x < R_AP or y < R_AP or x > nx - 1 - R_AP or y > ny - 1 - R_AP:
        return None

    pad = int(math.ceil(R_OUT)) + 1
    x0, x1 = max(0, int(x) - pad), min(nx, int(x) + pad + 1)
    y0, y1 = max(0, int(y) - pad), min(ny, int(y) + pad + 1)
    sub = data[y0:y1, x0:x1]
    yy, xx = np.indices(sub.shape)
    rr = np.hypot(xx + x0 - x, yy + y0 - y)

    ok = np.isfinite(sub)
    ap = (rr <= R_AP) & ok
    bg = (rr >= R_IN) & (rr <= R_OUT) & ok
    n_ap, n_bg = int(ap.sum()), int(bg.sum())

    if n_ap < 7 or n_bg < 10:          # too many masked pixels
        return None

    background = float(np.median(sub[bg]))
    sigma_pix = _robust_sigma(sub[bg])
    if not np.isfinite(sigma_pix):
        return None

    flux = float(np.mean(sub[ap])) - background

    err_empirical = sigma_pix / math.sqrt(n_ap)
    err_ap = err_empirical
    if variance is not None:
        vsub = variance[y0:y1, x0:x1][ap]
        vsub = vsub[np.isfinite(vsub) & (vsub > 0)]
        if vsub.size:
            err_ap = max(err_empirical, math.sqrt(float(np.sum(vsub))) / n_ap)
    err_bg = 1.2533 * sigma_pix / math.sqrt(n_bg)
    error = math.sqrt(err_ap ** 2 + err_bg ** 2)

    if error <= 0 or not np.isfinite(error):
        return None
    return flux, error


def measure(obs, ra, dec):
    """Convenience wrapper: measure at a sky position."""
    x, y = pixel_positions(obs, [ra], [dec])
    return measure_at(obs, float(x[0]), float(y[0]))


# ======================================================================
# Grouping and clustering
# ======================================================================

def group_by_wavelength(items, tol=WAVELENGTH_TOL):
    """items: list of (obs_id, wavelength_um). Returns list of lists of obs_id."""
    ordered = sorted(items, key=lambda t: t[1])
    groups, current, start = [], [], None
    for obs_id, wl in ordered:
        if start is None or wl > start * (1.0 + tol):
            if current:
                groups.append(current)
            current, start = [obs_id], wl
        else:
            current.append(obs_id)
    if current:
        groups.append(current)
    return groups


def cluster_positions(detections, tol_arcsec):
    """detections: [(ra, dec, snr)]. Greedy merge of positions closer than tol."""
    clusters = []   # each: {"ra","dec","snr","w"}
    for ra, dec, snr in sorted(detections, key=lambda d: -d[2]):
        cosd = math.cos(math.radians(dec))
        for c in clusters:
            dx = (ra - c["ra"]) * cosd * 3600.0
            dy = (dec - c["dec"]) * 3600.0
            if math.hypot(dx, dy) <= tol_arcsec:
                w = snr
                c["ra"] = (c["ra"] * c["w"] + ra * w) / (c["w"] + w)
                c["dec"] = (c["dec"] * c["w"] + dec * w) / (c["w"] + w)
                c["w"] += w
                c["snr"] = max(c["snr"], snr)
                break
        else:
            clusters.append({"ra": ra, "dec": dec, "snr": snr, "w": snr})
    return clusters


# ======================================================================
# Classification
# ======================================================================

def classify(series, z_threshold=4.0):
    """series: list of dicts with f, e (already time-ordered).
    Returns dict with label and statistics, or None if not enough data."""
    n = len(series)
    if n < 2:
        return None

    f = np.array([s["f"] for s in series], dtype=float)
    e = np.array([math.hypot(s["e"], SYSTEMATIC_FLOOR * abs(s["f"])) for s in series])

    k = max(1, n // 3)

    def wmean(idx):
        w = 1.0 / e[idx] ** 2
        mean = float(np.sum(w * f[idx]) / np.sum(w))
        err = float(1.0 / math.sqrt(np.sum(w)))
        return mean, err

    first, first_err = wmean(slice(0, k))
    last, last_err = wmean(slice(n - k, n))
    z = (last - first) / math.hypot(first_err, last_err)

    w_all = 1.0 / e ** 2
    mean_all = float(np.sum(w_all * f) / np.sum(w_all))
    chi2 = float(np.sum(((f - mean_all) / e) ** 2))
    red_chi2 = chi2 / (n - 1)
    max_dev = float(np.max(np.abs(f - mean_all) / e))

    snr_first = first / first_err
    snr_last = last / last_err
    peak_snr = float(max(snr_first, snr_last, np.max(f / e)))

    label = "stable"
    if peak_snr >= 3:
        if z >= z_threshold:
            label = "appeared" if (snr_first < 3 and snr_last >= 5) else "brightened"
        elif z <= -z_threshold:
            label = "disappeared" if (snr_last < 3 and snr_first >= 5) else "dimmed"
        elif n >= 3 and red_chi2 >= 3 and max_dev >= z_threshold:
            label = "variable"

    change_pct = (last - first) / max(abs(first), 3 * first_err) * 100.0

    return {
        "label": label,
        "z": round(float(z), 2),
        "change_pct": round(float(change_pct), 1),
        "first": first,
        "last": last,
        "red_chi2": round(red_chi2, 2),
        "peak_snr": round(peak_snr, 1),
    }


# ======================================================================
# Differential normalisation
# ======================================================================

def epoch_scale(F, refs, n_epochs):
    """Per-epoch brightness scale estimated from reference sources.
    F: (n_candidates, n_epochs) flux matrix (NaN where unmeasured)."""
    if len(refs) < 3:
        return None
    ref_f = F[refs, :]
    baseline = np.nanmedian(ref_f, axis=1, keepdims=True)
    if np.any(~np.isfinite(baseline)) or np.any(np.abs(baseline) < 1e-12):
        return None
    scale = np.nanmedian(ref_f / baseline, axis=0)
    if not np.all(np.isfinite(scale)) or np.any(scale < 0.3) or np.any(scale > 3.0):
        return None
    return scale


# ======================================================================
# Main entry point
# ======================================================================

def analyze_extracted(observations, extracted, ra, dec, z_threshold=4.0,
                      wavelength_tol=WAVELENGTH_TOL, allow_provisional=False,
                      normalize=True):
    """
    observations: list of dicts {index, date, band}
    extracted:    dict index -> output of extract() (or None if loading failed)
    """
    notes = []
    usable = [o for o in observations if extracted.get(o["index"]) is not None]
    diagnostics = {
        "usable": len(usable),
        "wavelength_read": sum(1 for o in usable if extracted[o["index"]]["wavelength"]),
        "largest_group": 0,
        "normalized_groups": 0,
        "skipped_provisional": 0,
    }
    if len(usable) < 2:
        return {"sources": [], "groups": 0, "diagnostics": diagnostics,
                "notes": ["Fewer than two usable observations."]}

    # ---- 1. build comparison groups -------------------------------------
    with_wl = [(o["index"], extracted[o["index"]]["wavelength"])
               for o in usable if extracted[o["index"]]["wavelength"]]
    without_wl = [o for o in usable if not extracted[o["index"]]["wavelength"]]

    groups = []   # (label, wavelength_matched, [obs dicts])
    by_index = {o["index"]: o for o in usable}

    for ids in group_by_wavelength(with_wl, wavelength_tol):
        wls = [extracted[i]["wavelength"] for i in ids]
        groups.append((f"{np.mean(wls):.3f} µm", True, [by_index[i] for i in ids]))

    if without_wl:
        by_band = {}
        for o in without_wl:
            by_band.setdefault(o.get("band") or "unknown band", []).append(o)
        provisional = [(f"band {b}", False, items) for b, items in by_band.items()]
        if allow_provisional:
            groups.extend(provisional)
            notes.append(
                "Observations without a readable wavelength were grouped by band. "
                "Their wavelength still varies between images, so those rows are "
                "marked provisional."
            )
        else:
            diagnostics["skipped_provisional"] = len(without_wl)
            notes.append(
                f"{len(without_wl)} observation(s) had no readable wavelength and were "
                "skipped. Enable “Include provisional groups” to analyse them by band."
            )

    diagnostics["largest_group"] = max((len(g[2]) for g in groups), default=0)
    groups = [g for g in groups if len(g[2]) >= 2]
    if not groups:
        notes.append(
            "No two observations share the same wavelength yet "
            f"(match tolerance {wavelength_tol * 100:.1f} %). Try a looser wavelength "
            "match, or wait for more repeat visits of this field."
        )
        return {"sources": [], "groups": 0, "diagnostics": diagnostics, "notes": notes}

    # ---- 2. analyse each group ------------------------------------------
    sources = []
    sid = 0
    for label, matched, members in groups:
        members = sorted(members, key=lambda o: o.get("date") or "")
        n_ep = len(members)
        pix = float(np.mean([extracted[o["index"]]["pixscale"] for o in members]))

        detections = []
        for o in members:
            ex = extracted[o["index"]]
            if "detections" not in ex:          # normally filled by the download worker
                ex["detections"] = detect_sources(ex)
            detections.extend(ex["detections"])

        clusters = cluster_positions(detections, tol_arcsec=2.0 * pix)
        clusters.sort(key=lambda c: -c["snr"])
        clusters = clusters[:MAX_SOURCES_PER_GROUP]

        # the searched position is always examined, even if nothing was detected there
        candidates = [{"ra": ra, "dec": dec, "snr": 0.0, "target": True}]
        for c in clusters:
            d = math.hypot((c["ra"] - ra) * math.cos(math.radians(dec)) * 3600,
                           (c["dec"] - dec) * 3600)
            if d <= 2.0 * pix:
                candidates[0]["snr"] = c["snr"]
            else:
                candidates.append({**c, "target": False})

        # measure every candidate in every epoch (one WCS call per epoch)
        C = len(candidates)
        c_ra = [c["ra"] for c in candidates]
        c_dec = [c["dec"] for c in candidates]
        F = np.full((C, n_ep), np.nan)
        E = np.full((C, n_ep), np.nan)
        for ei, o in enumerate(members):
            ex = extracted[o["index"]]
            xs, ys = pixel_positions(ex, c_ra, c_dec)
            for ci in range(C):
                m = measure_at(ex, float(xs[ci]), float(ys[ci]))
                if m is not None:
                    F[ci, ei], E[ci, ei] = m

        # reference sources: bright, measured in every epoch
        ref_ids = [
            ci for ci in range(C)
            if np.all(np.isfinite(F[ci])) and np.median(F[ci] / E[ci]) >= 10
        ]
        normalized_any = False

        for ci, cand in enumerate(candidates):
            f_row, e_row = F[ci].copy(), E[ci].copy()

            if normalize:
                refs = [r for r in ref_ids if r != ci]   # leave the tested source out
                scale = epoch_scale(F, refs, n_ep)
                if scale is not None:
                    f_row, e_row = f_row / scale, e_row / scale
                    normalized_any = True

            series = []
            for ei, o in enumerate(members):
                if np.isfinite(f_row[ei]) and np.isfinite(e_row[ei]) and e_row[ei] > 0:
                    series.append({
                        "i": o["index"], "date": o.get("date", ""),
                        "f": float(f_row[ei]), "e": float(e_row[ei]),
                    })

            result = classify(series, z_threshold)
            if result is None:
                continue
            sid += 1
            sources.append({
                "id": sid,
                "ra": round(float(cand["ra"]), 6),
                "dec": round(float(cand["dec"]), 6),
                "is_target": bool(cand.get("target")),
                "group": label,
                "wavelength_matched": matched,
                "n": len(series),
                **result,
                "series": [
                    {"i": s["i"], "date": s["date"],
                     "f": round(s["f"], 4), "e": round(s["e"], 4)}
                    for s in series
                ],
            })
        if normalized_any:
            diagnostics["normalized_groups"] += 1

    if normalize and diagnostics["normalized_groups"] == 0:
        notes.append(
            "Not enough bright, stable reference sources in the field (need 3), so "
            "brightness differences between images could not be corrected. Real changes "
            "and calibration changes cannot be told apart as well in that case."
        )

    sources.sort(key=lambda s: (s["label"] == "stable", -abs(s["z"])))
    return {"sources": sources, "groups": len(groups),
            "diagnostics": diagnostics, "notes": notes}


def analyze(observations, loader, ra, dec, bad_mask=0, z_threshold=4.0, workers=6,
            progress=None, wavelength_tol=WAVELENGTH_TOL, allow_provisional=False,
            normalize=True, should_stop=None):
    """
    observations: list of dicts {index, url, date, band}
    loader(url) -> opened HDUList (closed here)
    progress(done, total) is called after each observation is loaded.
    should_stop() -> True makes the run abort with Cancelled.
    """
    extracted = {}
    lock = Lock()
    state = {"done": 0, "pixels": 0, "too_big": False}
    stop = should_stop or (lambda: False)

    def work(o):
        if stop() or state["too_big"]:
            return o["index"], None
        try:
            hdul = loader(o["url"])
            try:
                result = extract(hdul, ra, dec, bad_mask)
            finally:
                hdul.close()
            result["detections"] = detect_sources(result)   # overlaps with other downloads
            with lock:
                state["pixels"] += result["data"].size
                if state["pixels"] > MAX_TOTAL_PIXELS:
                    state["too_big"] = True
        except Exception:
            result = None
        with lock:
            state["done"] += 1
            done = state["done"]
        if progress:
            progress(done, len(observations))
        return o["index"], result

    with ThreadPoolExecutor(max_workers=max(1, workers)) as pool:
        for index, result in pool.map(work, observations):
            extracted[index] = result

    if stop():
        raise Cancelled()
    if state["too_big"]:
        raise ValueError("The cutouts are too large to analyse together; use a smaller field of view.")

    out = analyze_extracted(observations, extracted, ra, dec, z_threshold,
                            wavelength_tol, allow_provisional, normalize)
    out["analysed"] = sum(1 for e in extracted.values() if e)
    out["requested"] = len(observations)
    return out
