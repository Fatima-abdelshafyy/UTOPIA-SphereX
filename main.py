"""Utopia x SPHEREx backend (FastAPI).

Serves the Utopia website (./frontend) and the SPHEREx / IRSA API:
    GET /api/observations   observations covering a sky position
    GET /api/cutout.png     image cutout for one observation
    GET /api/diff.png       difference image between two observations
    GET /api/collections    SPHEREx collections available at IRSA
    GET /api/fits-info      FITS extension summary for a cutout
    GET /api/spectral/observations  all SPHEREx images covering a position (IRSA TAP, DR1 + QR3 + future releases)
    GET /api/spectrum-point one spectral point (flux at one wavelength) for one observation
    GET /api/resolve        object name -> RA/Dec (+ proper motion when SIMBAD has it)
    GET /api/health         simple liveness check

Run:  python main.py        (or: uvicorn main:app --reload)
Open: http://127.0.0.1:8000
"""
import hashlib
import io
import json
import logging
import math
import mimetypes
import os
import random
import re
import threading
import time
import uuid
from collections import OrderedDict
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from typing import List
from urllib.parse import urlparse, urlsplit, urlunsplit, parse_qsl, urlencode

import numpy as np
import requests
from astropy import units as u
from astropy.coordinates import SkyCoord
from astropy.io import fits
from astropy.time import Time
from astropy.stats import sigma_clipped_stats
from astropy.visualization import ZScaleInterval
from astropy.wcs import WCS
from astropy.wcs.utils import proj_plane_pixel_scales
from astroquery.ipac.irsa import Irsa
from fastapi import FastAPI, HTTPException, Body
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response
from fastapi.staticfiles import StaticFiles
from PIL import Image
from pydantic import BaseModel
from requests.adapters import HTTPAdapter

import changes  # automatic change detection (Time Machine)

# Windows registries sometimes map .js to text/plain; force the right type.
mimetypes.add_type("application/javascript", ".js")

# ---- Configuration (override via environment variables) ----
COLLECTION = os.getenv("SPHEREX_COLLECTION", "")  # e.g. a name from /api/collections
HERE = os.path.dirname(os.path.abspath(__file__))
FRONTEND_DIR = os.path.join(HERE, "frontend")
# Cutout URLs come from the browser, so only fetch from IRSA hosts (prevents SSRF).
ALLOWED_HOSTS = tuple(
    h.strip() for h in os.getenv("ALLOWED_CUTOUT_HOSTS", "irsa.ipac.caltech.edu").split(",") if h.strip()
)
# FITS cutouts are cached in memory (bounded by size, least-recently-used first) and on disk, so re-opening a target,
# re-running change detection or restarting the server does not download the same images again.
CACHE_MAX_BYTES = int(float(os.getenv("SPHEREX_CACHE_MB", "400")) * 1024 * 1024)
DISK_CACHE = os.getenv("SPHEREX_DISK_CACHE", "1") != "0"
DISK_CACHE_DIR = os.path.join(HERE, "cache", "fits")
DISK_CACHE_MAX_BYTES = int(float(os.getenv("SPHEREX_DISK_CACHE_MB", "1500")) * 1024 * 1024)
CHANGE_WORKERS = int(os.getenv("SPHEREX_CHANGE_WORKERS", "6"))  # parallel downloads inside one change-detection run
POINT_CACHE_MAX = 5000
# IRSA drops connections when hit by too many parallel cutout requests (the IRSA notebook sees ~15% failures with
# 10 threads). Cap concurrent upstream requests and retry transient errors with exponential back-off.
UPSTREAM_LIMIT = int(os.getenv("SPHEREX_UPSTREAM_CONCURRENCY", "8"))
UPSTREAM_RETRIES = int(os.getenv("SPHEREX_RETRIES", "4"))
# Releases that IRSA says are superseded (QR3 + DR1 replace QR2). Hidden unless asked for explicitly.
SUPERSEDED = {x.strip().lower() for x in os.getenv("SPHEREX_SUPERSEDED", "qr1,qr2").split(",") if x.strip()}
TAP_TTL = int(os.getenv("SPHEREX_TAP_TTL", "900"))  # seconds a TAP answer is reused (new data is ingested weekly)

# FLAGS bits, from the IRSA SPHEREx Data Explorer help (spectrophotometry chapter) / Explanatory Supplement.
FLAG_NAMES = {0: "TRANSIENT", 1: "OVERFLOW", 2: "SUR_ERROR", 6: "NONFUNC", 7: "DICHROIC", 9: "MISSING_DATA", 10: "HOT",
              11: "COLD", 12: "FULLSAMPLE", 14: "PHANMISS", 15: "NONLINEAR", 17: "PERSIST", 19: "OUTLIER",
              20: "CROSSTALK", 21: "SOURCE", 22: "GHOST", 23: "GHOST_FPA", 24: "GHOST_EXT", 25: "STREAK", 26: "BLOOM",
              27: "SNOWBALL", 28: "HALO", 29: "SATELLITE_HALO"}
DICHROIC_BIT = 7
# Pixels masked in our photometry: the ones IRSA's Tractor pipeline ignores (SUR_ERROR, NONFUNC, MISSING_DATA, HOT, COLD,
# NONLINEAR, PERSIST, BLOOM, SNOWBALL, HALO, SATELLITE_HALO) plus TRANSIENT (cosmic-ray hits corrupt an aperture sum).
# SOURCE (bit 21) only says "a catalogued source is here" and must NOT be masked: it is the star we look at.
# DICHROIC is a calibration warning (D3/D4 overlap), reported but not masked. Override: SPHEREX_BAD_BITS="0,2,6".
BAD_BITS = [int(b) for b in os.getenv("SPHEREX_BAD_BITS", "0,2,6,9,10,11,15,17,26,27,28,29").split(",") if b.strip()]
BAD_MASK = sum(1 << b for b in BAD_BITS)
CONTAINS_BAD_PIXEL = 1 << 32  # same convention as IRSA: flag value >= 2**32 means a bad pixel was involved

app = FastAPI(title="Utopia SPHEREx Explorer")
# Lets the site work even if the HTML is opened from another dev server (e.g. VS Code Live Server :8080).
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

_cache = OrderedDict()  # (url, ra, dec, size) -> FITS bytes (LRU)
_cache_bytes = 0
_inflight = {}  # key -> Lock: the same cutout is never downloaded twice at once
_inflight_lock = threading.Lock()
_SHUTDOWN = threading.Event()  # set on server stop so queued background work ends instantly
_log = logging.getLogger("utopia")
_point_cache = {}  # spectrum points (tiny dicts)
_lock = threading.Lock()
_tap_cache = {}  # (ra, dec) -> (time, rows)
_tap_lock = threading.Lock()  # TAP queries are slow (~20 s): never run the same one twice at once
_upstream = threading.BoundedSemaphore(UPSTREAM_LIMIT)
_http = requests.Session()
_http.mount("https://", HTTPAdapter(pool_connections=4, pool_maxsize=UPSTREAM_LIMIT * 2))
_http.mount("http://", HTTPAdapter(pool_connections=4, pool_maxsize=UPSTREAM_LIMIT * 2))

# MongoDB is optional. Without MONGODB_URI (or when it is unreachable) Discoveries are kept in data/discoveries.json.
MONGODB_URI = os.getenv("MONGODB_URI", "").strip()
MONGODB_DB = os.getenv("MONGODB_DB", "utopia").strip() or "utopia"
_mongo_client = None
_mongo_lock = threading.Lock()
_mongo_retry_at = 0.0


# ---------------------------------------------------------------- helpers
def pick_collection():
    if COLLECTION:
        return COLLECTION
    cols = [str(c) for c in Irsa.list_collections()["collection"]]
    sp = [c for c in cols if "spherex" in c.lower()]
    if not sp:
        raise HTTPException(500, "No SPHEREx collection found")
    dr = [c for c in sp if "dr1" in c.lower()]
    return (dr or sp)[-1]


def find_col(names, cands):
    low = {n.lower(): n for n in names}
    for c in cands:
        if c in low:
            return low[c]
    return None


def check_url(url):
    host = urlparse(url).hostname or ""
    if urlparse(url).scheme not in ("http", "https") or not any(
        host == h or host.endswith("." + h) for h in ALLOWED_HOSTS
    ):
        raise HTTPException(400, "Cutout URL host is not allowed")


def fetch_bytes(full):
    """Fetch an IRSA FITS cutout. Retry only transient failures; surface 4xx details."""
    last = "unknown error"
    for attempt in range(UPSTREAM_RETRIES):
        if _SHUTDOWN.is_set():
            raise HTTPException(503, "Server is shutting down")
        try:
            with _upstream:
                r = _http.get(full, timeout=(10, 45))
            if r.status_code == 200:
                # SPHEREx cutouts are normally returned as an uncompressed MEF FITS.
                # requests transparently decodes HTTP content-encoding, but not a .fits.gz body.
                if r.content[:6] == b"SIMPLE":
                    return r.content
                last = f"HTTP 200 but response is not a FITS file (content-type={r.headers.get('Content-Type', 'unknown')}; body={r.text[:240]!r})"
            elif 400 <= r.status_code < 500 and r.status_code != 429:
                detail = (r.text or "(empty response body)").strip().replace("\n", " ")[:500]
                raise HTTPException(
                    502,
                    f"IRSA rejected the cutout request (HTTP {r.status_code}). Details: {detail}. "
                    f"Requested URL path: {urlsplit(full).path}"
                )
            else:
                last = f"HTTP {r.status_code}: {(r.text or '')[:240]}"
        except HTTPException:
            raise
        except requests.exceptions.RequestException as e:
            last = f"{type(e).__name__}: {e}"
        if attempt < UPSTREAM_RETRIES - 1:
            time.sleep(min(2 ** attempt, 8) * (0.5 + random.random() / 2))
    raise HTTPException(502, f"IRSA cutout failed after {UPSTREAM_RETRIES} attempts ({last})")


_disk_writes = 0


def _mem_get(key):
    with _lock:
        content = _cache.get(key)
        if content is not None:
            _cache.move_to_end(key)
        return content


def _mem_set(key, content):
    global _cache_bytes
    with _lock:
        old = _cache.pop(key, None)
        if old is not None:
            _cache_bytes -= len(old)
        _cache[key] = content
        _cache_bytes += len(content)
        while _cache_bytes > CACHE_MAX_BYTES and len(_cache) > 1:
            _, evicted = _cache.popitem(last=False)
            _cache_bytes -= len(evicted)


def _disk_path(key):
    return os.path.join(DISK_CACHE_DIR, hashlib.sha1(repr(key).encode()).hexdigest() + ".fits")


def _disk_get(key):
    if not DISK_CACHE:
        return None
    try:
        with open(_disk_path(key), "rb") as f:
            content = f.read()
        return content if content[:6] == b"SIMPLE" else None
    except OSError:
        return None


def _disk_prune():
    """Keep the disk cache under its size limit by deleting the oldest files."""
    try:
        files = []
        for name in os.listdir(DISK_CACHE_DIR):
            path = os.path.join(DISK_CACHE_DIR, name)
            st = os.stat(path)
            files.append((st.st_mtime, st.st_size, path))
        total = sum(f[1] for f in files)
        for _, size, path in sorted(files):
            if total <= DISK_CACHE_MAX_BYTES * 0.8:
                break
            try:
                os.remove(path)
                total -= size
            except OSError:
                pass
    except OSError:
        pass


def _disk_set(key, content):
    global _disk_writes
    if not DISK_CACHE:
        return
    try:
        os.makedirs(DISK_CACHE_DIR, exist_ok=True)
        tmp = _disk_path(key) + f".{threading.get_ident()}.tmp"
        with open(tmp, "wb") as f:
            f.write(content)
        os.replace(tmp, _disk_path(key))
        _disk_writes += 1
        if _disk_writes % 40 == 1:
            _disk_prune()
    except OSError:
        pass


def load_cutout(url, ra, dec, size):
    if _SHUTDOWN.is_set():
        raise HTTPException(503, "Server is shutting down")
    check_url(url)
    key = (url, round(ra, 6), round(dec, 6), size)
    content = _mem_get(key)
    if content is None:
        with _inflight_lock:
            lock = _inflight.setdefault(key, threading.Lock())
        try:
            with lock:
                # another request may have finished this download while we waited
                content = _mem_get(key)
                if content is None:
                    content = _disk_get(key)
                    if content is not None:
                        _mem_set(key, content)
                if content is None:
                    # Build the IBE query safely and request an uncompressed FITS MEF.
                    # IRSA documents center/size as the required cutout parameters; SPHEREx cutouts
                    # preserve all MEF extensions and are returned uncompressed.
                    parts = urlsplit(url)
                    query = dict(parse_qsl(parts.query, keep_blank_values=True))
                    query.update({"center": f"{ra:.8f},{dec:.8f}", "size": f"{size}arcmin", "gzip": "false"})
                    full = urlunsplit((parts.scheme, parts.netloc, parts.path, urlencode(query), parts.fragment))
                    content = fetch_bytes(full)
                    _mem_set(key, content)
                    _disk_set(key, content)
        finally:
            with _inflight_lock:
                _inflight.pop(key, None)
    return fits.open(io.BytesIO(content))


def get_ext(hdul, name):
    for h in hdul:
        if h.name.upper() == name:
            return h
    return None


def image_and_wcs(hdul):
    img = get_ext(hdul, "IMAGE")
    if img is None:
        raise HTTPException(500, f"No IMAGE ext. Extensions: {[h.name for h in hdul]}")
    data = img.data.astype(float)
    fl = get_ext(hdul, "FLAGS")
    if fl is not None and fl.data is not None and fl.data.shape == data.shape:
        data[(fl.data.astype(np.int64) & BAD_MASK) != 0] = np.nan  # mask bad pixels only (not the SOURCE bit)
    return data, WCS(img.header)


def to_png(arr, stretch="asinh", contrast=1.0, low_pct=1.0, high_pct=99.5):
    """Render at the FITS image's native pixel dimensions; display scaling never alters science data."""
    finite = np.asarray(arr, dtype=float)
    good = finite[np.isfinite(finite)]
    if good.size == 0:
        raise HTTPException(422, "Image contains no valid pixels")
    lo, hi = np.nanpercentile(good, [float(low_pct), float(high_pct)])
    if not np.isfinite(lo + hi) or hi <= lo:
        lo, hi = float(np.nanmin(good)), float(np.nanmax(good) + 1e-12)
    norm = np.clip((np.nan_to_num(finite, nan=lo) - lo) / (hi - lo), 0, 1)
    norm = np.clip((norm - 0.5) * float(contrast) + 0.5, 0, 1)
    if stretch == "asinh":
        norm = np.arcsinh(10 * norm) / np.arcsinh(10)
    elif stretch == "sqrt":
        norm = np.sqrt(norm)
    elif stretch == "log":
        norm = np.log1p(100 * norm) / np.log1p(100)
    elif stretch != "linear":
        raise HTTPException(400, "stretch must be asinh, sqrt, log, or linear")
    pixels = (norm * 255).astype("uint8")[::-1]
    im = Image.fromarray(pixels)  # preserve native FITS dimensions; no 480x480 resampling
    buf = io.BytesIO()
    im.save(buf, "PNG", optimize=True)
    return Response(buf.getvalue(), media_type="image/png")


# ---------------------------------------------------------------- API
@app.get("/api/health")
def health():
    return {"status": "ok"}


@app.get("/api/collections")
def collections():
    cols = [str(c) for c in Irsa.list_collections()["collection"]]
    return [c for c in cols if "spherex" in c.lower()]


@app.get("/api/observations")
def observations(ra: float, dec: float, fov: float = 5.0, collection: str = ""):
    """fov in arcmin. Returns observations covering the position, sorted by date."""
    coll = collection or pick_collection()
    pos = SkyCoord(ra, dec, unit="deg")
    try:
        tbl = Irsa.query_sia(pos=(pos, (fov / 60.0) * u.deg), collection=coll)
    except Exception as e:
        raise HTTPException(502, f"IRSA query failed: {e}")
    names = tbl.colnames
    c_url = find_col(names, ["access_url"])
    c_t = find_col(names, ["t_min", "obs_date", "date_obs"])
    c_band = find_col(names, ["energy_bandpassname", "bandpass", "band", "em_min"])
    c_det = find_col(names, ["detector", "obs_id", "obs_publisher_did"])
    rows = []
    for r in tbl:
        t = r[c_t] if c_t else None
        try:
            date = Time(float(t), format="mjd").iso[:19] if c_t and float(t) > 50000 else str(t)
        except Exception:
            date = str(t)
        rows.append({
            "date": date,
            "band": str(r[c_band]) if c_band else "",
            "detector": str(r[c_det]) if c_det else "",
            "url": str(r[c_url]) if c_url else "",
        })
    rows.sort(key=lambda x: x["date"])
    return {"collection": coll, "columns": names, "count": len(rows), "observations": rows}


@app.get("/api/cutout.png")
def cutout_png(url: str, ra: float, dec: float, size: float = 5.0, stretch: str = "asinh", contrast: float = 1.0):
    data, _ = image_and_wcs(load_cutout(url, ra, dec, size))
    return to_png(data, stretch=stretch, contrast=contrast)


@app.get("/api/diff.png")
def diff_png(url1: str, url2: str, ra: float, dec: float, size: float = 5.0):
    from reproject import reproject_interp

    d1, w1 = image_and_wcs(load_cutout(url1, ra, dec, size))
    d2, w2 = image_and_wcs(load_cutout(url2, ra, dec, size))
    d2a, _ = reproject_interp((d2, w2), w1, shape_out=d1.shape)
    return to_png(d2a - d1)


@app.get("/api/fits-info")
def fits_info(url: str, ra: float, dec: float, size: float = 5.0):
    hdul = load_cutout(url, ra, dec, size)
    return [{"name": h.name, "shape": getattr(h.data, "shape", None),
             "bunit": h.header.get("BUNIT"), "date": h.header.get("DATE-OBS"),
             "detector": h.header.get("DETECTOR")} for h in hdul]


@app.get("/api/combine.png")
def combine_png(urls: str, ra: float, dec: float, size: float = 5.0, method: str = "mean", stretch: str = "asinh", contrast: float = 1.0):
    """Combine 2-12 cutouts from the same detector/band. Reproject to the first image WCS first.

    This is intended for repeated observations of the same spectral band, not for summing all six
    detectors (the detectors cover different wavelength ranges). method is mean or sum.
    """
    from reproject import reproject_interp

    items = [u.strip() for u in urls.split(",") if u.strip()]
    if not 2 <= len(items) <= 12:
        raise HTTPException(400, "Choose between 2 and 12 observations to combine")
    if method not in ("mean", "median", "sum"):
        raise HTTPException(400, "method must be mean or sum")
    dets = {detector_of("", u) for u in items}
    if len(dets) != 1 or None in dets:
        raise HTTPException(400, "Only observations from the same detector can be combined")
    arrays, ref_wcs, shape = [], None, None
    for i, url in enumerate(items):
        data, wcs = image_and_wcs(load_cutout(url, ra, dec, size))
        if i == 0:
            ref_wcs, shape = wcs, data.shape
            arrays.append(data)
        else:
            aligned, _ = reproject_interp((data, wcs), ref_wcs, shape_out=shape)
            arrays.append(aligned)
    stack = np.stack(arrays)
    # A robust median suppresses isolated transients; mean/sum are available when requested.
    if method == "sum":
        combined = np.nansum(stack, axis=0)
        combined[np.all(~np.isfinite(stack), axis=0)] = np.nan
    elif method == "mean":
        combined = np.nanmean(stack, axis=0)
    else:
        combined = np.nanmedian(stack, axis=0)
    return to_png(combined, stretch=stretch, contrast=contrast)


# ---------------------------------------------------------------- automatic change detection (Time Machine)
class ChangeObs(BaseModel):
    url: str
    date: str = ""
    band: str = ""


class ChangeRequest(BaseModel):
    observations: List[ChangeObs]
    ra: float
    dec: float
    size: float = 5.0
    mask: bool = True
    z_threshold: float = 4.0
    wavelength_tol: float = 0.015
    allow_provisional: bool = False
    normalize: bool = True


# The analysis runs as a background job and the page polls for progress, so a long run never hits a browser or
# proxy timeout and the rest of the site stays responsive while it works.
_change_pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix="changes")
_change_jobs = OrderedDict()
_change_lock = threading.Lock()


def _job_update(job_id, **fields):
    with _change_lock:
        job = _change_jobs.get(job_id)
        if job is not None:
            job.update(fields)


def _run_change_job(job_id, obs, req, z):
    with _change_lock:
        if _change_jobs.get(job_id, {}).get("cancel"):
            _change_jobs[job_id].update(state="cancelled")
            return
        _change_jobs[job_id].update(state="running")

    def progress(done, total):
        _job_update(job_id, done=done, total=total)

    def should_stop():
        with _change_lock:
            return bool(_change_jobs.get(job_id, {}).get("cancel")) or _SHUTDOWN.is_set()

    try:
        result = changes.analyze(
            obs,
            lambda url: load_cutout(url, req.ra, req.dec, req.size),
            req.ra, req.dec,
            bad_mask=BAD_MASK if req.mask else 0,
            z_threshold=z,
            workers=min(CHANGE_WORKERS, UPSTREAM_LIMIT),
            progress=progress,
            wavelength_tol=min(0.06, max(0.002, req.wavelength_tol)),
            allow_provisional=req.allow_provisional,
            normalize=req.normalize,
            should_stop=should_stop,
        )
        _job_update(job_id, state="done", result=result)
    except changes.Cancelled:
        _job_update(job_id, state="cancelled")
    except Exception as e:
        _job_update(job_id, state="error", error=str(getattr(e, "detail", e)))


@app.post("/api/changes")
def start_change_detection(req: ChangeRequest):
    if not 0 < req.size <= 60:
        raise HTTPException(400, "Invalid cutout size")
    if not (-90 <= req.dec <= 90 and 0 <= req.ra <= 360):
        raise HTTPException(400, "Invalid coordinates")
    if len(req.observations) < 2:
        raise HTTPException(400, "At least two observations are needed")
    if len(req.observations) > 3000:
        raise HTTPException(400, "Too many observations (max 3000). Use a shorter time range.")
    if (req.size * 60.0 / 6.2) ** 2 * len(req.observations) > changes.MAX_TOTAL_PIXELS:
        raise HTTPException(400, "Field of view too large for change detection; use a smaller FOV.")

    z = min(10.0, max(2.0, req.z_threshold))
    obs = []
    for i, o in enumerate(req.observations):
        check_url(o.url)
        obs.append({"index": i, "url": o.url, "date": o.date, "band": o.band})

    job_id = uuid.uuid4().hex[:12]
    with _change_lock:
        _change_jobs[job_id] = {"state": "queued", "done": 0, "total": len(obs), "cancel": False}
        while len(_change_jobs) > 20:
            _change_jobs.popitem(last=False)
    _change_pool.submit(_run_change_job, job_id, obs, req, z)
    return {"job": job_id}


@app.get("/api/changes/status")
def change_status(job: str):
    with _change_lock:
        info = _change_jobs.get(job)
        if info is None:
            raise HTTPException(404, "Unknown job")
        return {k: v for k, v in info.items() if k != "cancel"}


@app.post("/api/changes/cancel")
def change_cancel(job: str):
    with _change_lock:
        info = _change_jobs.get(job)
        if info is None:
            raise HTTPException(404, "Unknown job")
        info["cancel"] = True
    return {"ok": True}


# ---------------------------------------------------------------- saved discoveries
# Stored in MongoDB when MONGODB_URI is set and reachable; otherwise in data/discoveries.json next to this file, so
# the Discoveries page and "Add to Discoveries" work out of the box with no database and never show a setup error.
DISCOVERIES_FILE = os.path.join(HERE, "data", "discoveries.json")
_disc_lock = threading.Lock()
DISCOVERY_STATUSES = {"Needs verification", "Promising candidate", "Rejected", "Confirmed by reviewer"}


def mongo_json(doc):
    doc = dict(doc)
    doc.pop("_id", None)
    return doc


def _mongo_collection():
    """The MongoDB collection, or None when MongoDB is not configured / not reachable right now."""
    global _mongo_client, _mongo_retry_at
    if not MONGODB_URI or time.time() < _mongo_retry_at:
        return None
    try:
        from pymongo import MongoClient

        with _mongo_lock:
            if _mongo_client is None:
                _mongo_client = MongoClient(MONGODB_URI, serverSelectionTimeoutMS=3000, connectTimeoutMS=3000)
            _mongo_client.admin.command("ping")
            return _mongo_client[MONGODB_DB]["discoveries"]
    except Exception as exc:
        _mongo_retry_at = time.time() + 60  # do not make every request wait for a dead server
        _log.warning("MongoDB unavailable (%s); using %s", str(exc)[:150], DISCOVERIES_FILE)
        return None


def _file_read():
    try:
        with open(DISCOVERIES_FILE, encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, list) else []
    except (OSError, ValueError):
        return []


def _file_write(items):
    os.makedirs(os.path.dirname(DISCOVERIES_FILE), exist_ok=True)
    tmp = DISCOVERIES_FILE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(items, f, ensure_ascii=False)
    os.replace(tmp, DISCOVERIES_FILE)


@app.get("/api/discoveries")
def list_discoveries(limit: int = 500, status: str = ""):
    limit = max(1, min(int(limit), 1000))
    coll = _mongo_collection()
    if coll is not None:
        query = {"status": status} if status else {}
        docs = [mongo_json(d) for d in coll.find(query).sort("created_at", -1).limit(limit)]
        return {"count": len(docs), "store": "mongodb", "discoveries": docs}
    with _disc_lock:
        docs = _file_read()
    if status:
        docs = [d for d in docs if d.get("status") == status]
    docs.sort(key=lambda d: str(d.get("created_at", "")), reverse=True)
    docs = docs[:limit]
    return {"count": len(docs), "store": "local file", "discoveries": docs}


@app.post("/api/discoveries")
def save_discoveries(payload: dict = Body(...)):
    candidates = payload.get("candidates", [])
    if not isinstance(candidates, list) or not candidates:
        raise HTTPException(400, "candidates must be a non-empty list")
    if len(candidates) > 500:
        raise HTTPException(400, "Save at most 500 candidates per request")
    now = datetime.now(timezone.utc).isoformat()
    docs = []
    for item in candidates:
        if not isinstance(item, dict) or not isinstance(item.get("track"), list) or not item["track"]:
            continue
        doc = dict(item)
        doc["id"] = str(doc.get("id") or uuid.uuid4())
        doc["status"] = str(doc.get("status") or "Needs verification")
        doc["created_at"] = str(doc.get("created_at") or now)
        doc["updated_at"] = now
        doc["confirmed"] = False
        docs.append(doc)
    if not docs:
        raise HTTPException(400, "No valid candidates were supplied")
    saved = []
    coll = _mongo_collection()
    if coll is not None:
        for doc in docs:
            # Upsert makes repeated clicks idempotent for the same candidate ID.
            coll.update_one({"id": doc["id"]}, {"$setOnInsert": doc}, upsert=True)
            saved.append(mongo_json(coll.find_one({"id": doc["id"]}) or doc))
    else:
        with _disc_lock:
            items = _file_read()
            known = {d.get("id"): d for d in items}
            for doc in docs:
                if doc["id"] not in known:
                    items.append(doc)
                    known[doc["id"]] = doc
                saved.append(known[doc["id"]])
            _file_write(items)
    return {"saved_count": len(saved), "discoveries": saved}


@app.patch("/api/discoveries/{candidate_id}")
def update_discovery(candidate_id: str, payload: dict = Body(...)):
    allowed = {"status", "name", "notes"}
    edits = {k: payload[k] for k in allowed if k in payload}
    if not edits:
        raise HTTPException(400, "Supply one of: status, name, notes")
    if "status" in edits and edits["status"] not in DISCOVERY_STATUSES:
        raise HTTPException(400, "Invalid status")
    edits["updated_at"] = datetime.now(timezone.utc).isoformat()
    coll = _mongo_collection()
    if coll is not None:
        if not coll.update_one({"id": candidate_id}, {"$set": edits}).matched_count:
            raise HTTPException(404, "Candidate not found")
        return mongo_json(coll.find_one({"id": candidate_id}))
    with _disc_lock:
        items = _file_read()
        for d in items:
            if d.get("id") == candidate_id:
                d.update(edits)
                _file_write(items)
                return d
    raise HTTPException(404, "Candidate not found")


# ---------------------------------------------------------------- spectral image search (TAP)
RELEASE_RE = re.compile(r"/spherex/([^/]+)/level2/")
EXPOSURE_RE = re.compile(r"/(level2_[^/]*?)_spx_")  # level2_<obs>_<exposure>D<detector>
STAMP_RE = re.compile(r"-(\d{4})-(\d{3})\.fits")  # processing stamp: -<year>-<day of year>
DET_RE = re.compile(r"_\d+D([1-6])_")


def release_of(url):
    m = RELEASE_RE.search(url)
    return m.group(1).lower() if m else "unknown"


def detector_of(band, url):
    m = re.search(r"D([1-6])\s*$", band or "") or DET_RE.search(url) or re.search(r"/([1-6])/level2_", url)
    return int(m.group(1)) if m else None


def dedupe_latest(rows):
    """The same exposure can exist in several releases / reprocessings: keep the most recent one."""
    best, dropped = {}, 0
    for r in rows:
        m = EXPOSURE_RE.search(r["url"])
        key = m.group(1) if m else r["url"]
        st = STAMP_RE.search(r["url"])
        rank = (int(st.group(1)), int(st.group(2)), r["url"]) if st else (0, 0, r["url"])
        if key in best:
            dropped += 1
            if rank <= best[key][0]:
                continue
        best[key] = (rank, r)
    return [v[1] for v in best.values()], dropped


def tap_rows(ra, dec):
    """Every SPHEREx spectral image whose footprint contains (ra, dec), straight from IRSA's metadata tables.

    Same query as the IRSA cutout notebook, but for all six bandpasses at once. spherex.plane is filled at ingestion
    (weekly), so new data / new releases show up here without touching any code.
    """
    key = (round(ra, 4), round(dec, 4))
    with _tap_lock:
        hit = _tap_cache.get(key)
        if hit and time.time() - hit[0] < TAP_TTL:
            return hit[1]
        query = f"""
            SELECT a.uri, p.time_bounds_lower, p.energy_bandpassname
            FROM spherex.artifact a
            JOIN spherex.plane p ON a.planeid = p.planeid
            WHERE 1 = CONTAINS(POINT('ICRS', {ra:.6f}, {dec:.6f}), p.poly)
            ORDER BY p.time_bounds_lower
        """
        res = Irsa.query_tap(query)
        tbl = res.to_table() if hasattr(res, "to_table") else res
        rows = []
        for r in tbl:
            uri = str(r["uri"])
            if ".fits" not in uri:
                continue
            url = uri if uri.startswith("http") else "https://irsa.ipac.caltech.edu/" + uri.lstrip("/")
            try:
                mjd = float(r["time_bounds_lower"])
            except (TypeError, ValueError):
                continue
            if not math.isfinite(mjd):
                continue
            band = str(r["energy_bandpassname"])
            det = detector_of(band, url)
            if det is None:
                continue
            rows.append({"date": Time(mjd, format="mjd").iso[:19], "mjd": mjd, "det": det, "band": band,
                         "release": release_of(url), "url": url})
        _tap_cache[key] = (time.time(), rows)
        if len(_tap_cache) > 64:
            _tap_cache.pop(next(iter(_tap_cache)))
        return rows


@app.get("/api/spectral/observations")
def spectral_observations(ra: float, dec: float, release: str = "", detectors: str = "", t0: float = 0.0,
                          t1: float = 0.0):
    """All spectral images covering the position, oldest first. Each row has det (1-6), release and the cutout base url.

    release: only this release (e.g. dr1, qr3). Empty = every release except the superseded ones.
    detectors: e.g. "246" keeps only D2, D4, D6. Empty = all.
    t0, t1: start / end of the time window as MJD (0 = open). Applied before any photometry, so it also saves time.
    """
    source = "IRSA TAP (spherex.plane)"
    try:
        rows = tap_rows(ra, dec)
    except Exception as e:  # TAP is down or slow: fall back to the SIA service the rest of the site uses
        try:
            sia = observations(ra, dec, 1.0, "")
        except Exception:
            raise HTTPException(502, f"IRSA query failed: {e}")
        source = "IRSA SIA (TAP unavailable)"
        rows = []
        for o in sia["observations"]:
            det = detector_of(o["band"], o["url"])
            if det is None:
                continue
            try:
                mjd = Time(o["date"].replace(" ", "T")).mjd
            except Exception:
                mjd = 0.0
            rows.append({"date": o["date"], "mjd": mjd, "det": det, "band": o["band"],
                         "release": release_of(o["url"]), "url": o["url"]})
    available = {}
    for r in rows:
        available[r["release"]] = available.get(r["release"], 0) + 1
    rel = release.strip().lower()
    if rel:
        rows = [r for r in rows if r["release"] == rel]
    else:
        rows = [r for r in rows if r["release"] not in SUPERSEDED]
    dets = {int(c) for c in detectors if c in "123456"}
    if dets:
        rows = [r for r in rows if r["det"] in dets]
    rows, dropped = dedupe_latest(rows)
    span = (min(r["mjd"] for r in rows), max(r["mjd"] for r in rows)) if rows else (None, None)  # before the time cut
    if t0:
        rows = [r for r in rows if r["mjd"] >= t0]
    if t1:
        rows = [r for r in rows if r["mjd"] <= t1]
    rows.sort(key=lambda r: r["mjd"])
    return {"source": source, "count": len(rows), "releases": available, "duplicates_dropped": dropped,
            "mjd_min": span[0], "mjd_max": span[1], "observations": rows}


# ---------------------------------------------------------------- spectra
def moved_position(ra, dec, pmra, pmdec, epoch, date):
    """Position at the observation date. pmra/pmdec in mas/yr (pmra already * cos(dec)), epoch = year of ra/dec."""
    pos = SkyCoord(ra, dec, unit="deg")
    if not (pmra or pmdec) or not date:
        return pos
    try:
        dt = Time(date.replace(" ", "T")).jyear - epoch
    except Exception:
        return pos
    return pos.spherical_offsets_by(pmra * dt * u.mas, pmdec * dt * u.mas)


def _num(v):
    v = float(v)
    return v if math.isfinite(v) else None


@app.get("/api/spectrum-point")
def spectrum_point(url: str, ra: float, dec: float, size: float = 2.5, radius: float = 12.0,
                   date: str = "", pmra: float = 0.0, pmdec: float = 0.0, epoch: float = 2000.0):
    """Aperture flux of the target in ONE spectral image.

    Each SPHEREx image sees the target at a different wavelength (set by the linear variable filter), so one
    call = one point of the spectrum. The browser calls this for every observation and builds the spectrum.
    radius = aperture radius (arcsec); size = cutout size (arcmin).
    """
    check_url(url)
    key = (url, round(ra, 6), round(dec, 6), size, radius, date, pmra, pmdec, epoch)
    with _lock:
        if key in _point_cache:
            return _point_cache[key]

    pos = moved_position(ra, dec, pmra, pmdec, epoch, date)
    hdul = load_cutout(url, pos.ra.deg, pos.dec.deg, size)
    img, fl, var = get_ext(hdul, "IMAGE"), get_ext(hdul, "FLAGS"), get_ext(hdul, "VARIANCE")
    if img is None or img.data is None:
        raise HTTPException(500, f"No IMAGE ext. Extensions: {[h.name for h in hdul]}")
    data = img.data.astype(float)
    flags = fl.data.astype(np.int64) if fl is not None and fl.data is not None else np.zeros(data.shape, np.int64)
    variance = var.data.astype(float) if var is not None and var.data is not None else np.full(data.shape, np.nan)
    wcs = WCS(img.header)

    x, y = (float(v) for v in wcs.world_to_pixel(pos))
    ny, nx = data.shape
    if not (0 <= x < nx and 0 <= y < ny):
        raise HTTPException(404, "Target falls outside the cutout (check proper motion / epoch)")

    # ---- wavelength at the target position (same recipe as the IRSA notebook)
    try:
        swcs = WCS(img.header, fobj=hdul, key="W")
        swcs.sip = None
        wave, bw = swcs.pixel_to_world(x, y)
        wave_um = _num(u.Quantity(wave).to(u.um).value)
        try:
            bw_um = _num(u.Quantity(bw).to(u.um).value)
        except Exception:
            bw_um = None
    except Exception as e:
        raise HTTPException(500, f"No spectral WCS: {e}")

    # ---- aperture photometry (pixels are ~6.15 arcsec)
    scale = float(np.mean(proj_plane_pixel_scales(wcs))) * 3600.0
    r_ap = max(radius / scale, 0.8)
    r_in, r_out = r_ap + 1.5, r_ap + 4.5
    yy, xx = np.indices(data.shape)
    rr = np.hypot(xx - x, yy - y)
    ap, ann = rr <= r_ap, (rr >= r_in) & (rr <= r_out)
    bad = ((flags & BAD_MASK) != 0) | ~np.isfinite(data)
    n_ap = int(ap.sum())
    ok_ap = ap & ~bad
    flag_frac = 1.0 - ok_ap.sum() / max(n_ap, 1)
    flag_or = int(np.bitwise_or.reduce(flags[ap])) if n_ap else 0
    contains_bad = bool((((flags[ap] & BAD_MASK) != 0) | ~np.isfinite(data[ap])).any()) if n_ap else False

    ok_ann = ann & ~bad
    if ok_ann.sum() >= 8:
        _, bkg, bkg_std = sigma_clipped_stats(data[ok_ann], sigma=3.0)
        bkg_err = bkg_std / math.sqrt(ok_ann.sum())
    else:
        bkg, bkg_err = 0.0, 0.0

    pix_sr = (scale / 206264.806) ** 2          # pixel solid angle (sr)
    to_jy = pix_sr * 1e6                          # MJy/sr * sr -> Jy
    flux = err = None
    if ok_ap.sum() >= 0.5 * n_ap and n_ap > 0:
        mean_net = float(np.mean(data[ok_ap]) - bkg)
        flux = _num(mean_net * n_ap * to_jy)       # bad pixels replaced by the mean of the good ones
        v = variance[ok_ap]
        if np.isfinite(v).any():
            e2 = float(np.nanmean(v)) * n_ap          # independent pixels: var(sum) = n * mean(var)
            err = _num(math.sqrt(e2 + (bkg_err * n_ap) ** 2) * to_jy)

    det = detector_of("", url)
    try:
        det = int(hdul[0].header.get("DETECTOR")) or det
    except (TypeError, ValueError):
        pass
    out = {
        "ok": flux is not None,
        "wave": wave_um, "bandwidth": bw_um,
        "flux_jy": flux, "err_jy": err,
        "bkg_mjysr": _num(bkg),
        "flag_frac": round(float(flag_frac), 3), "flag_or": flag_or,
        "flag_value": flag_or | (CONTAINS_BAD_PIXEL if contains_bad else 0),  # IRSA convention: >= 2**32 -> bad pixel involved
        "contains_bad": contains_bad, "dichroic": bool(flag_or & (1 << DICHROIC_BIT)),
        "x_image": float(x), "y_image": float(y),
        "flags": [FLAG_NAMES.get(b, f"bit {b}") for b in range(32) if flag_or & (1 << b)],
        "detector": int(det) if det is not None else None,
        "version": hdul[0].header.get("VERSION", ""), "release": release_of(url),
        "date": date, "ra": float(pos.ra.deg), "dec": float(pos.dec.deg),
    }
    with _lock:
        while len(_point_cache) >= POINT_CACHE_MAX:
            _point_cache.pop(next(iter(_point_cache)))
        _point_cache[key] = out
    return out


@app.get("/api/resolve")
def resolve(name: str):
    """Object name -> position (+ proper motion from SIMBAD when available). Best effort."""
    try:
        from astroquery.simbad import Simbad

        sim = Simbad()
        sim.add_votable_fields("pmra", "pmdec")
        t = sim.query_object(name)
        if t is not None and len(t):
            c = SkyCoord(t["ra"][0], t["dec"][0], unit="deg")
            pm = lambda k: float(t[k][0]) if k in t.colnames and np.isfinite(float(t[k][0])) else 0.0
            return {"name": name, "ra": c.ra.deg, "dec": c.dec.deg, "pmra": pm("pmra"), "pmdec": pm("pmdec"),
                    "epoch": 2000.0, "source": "SIMBAD"}
    except Exception:
        pass
    try:
        c = SkyCoord.from_name(name)
        return {"name": name, "ra": c.ra.deg, "dec": c.dec.deg, "pmra": 0.0, "pmdec": 0.0, "epoch": 2000.0,
                "source": "Sesame (no proper motion)"}
    except Exception as e:
        raise HTTPException(404, f"Could not resolve '{name}': {e}")


@app.on_event("shutdown")
def _stop_background_work():
    _SHUTDOWN.set()
    _change_pool.shutdown(wait=False, cancel_futures=True)


# ---------------------------------------------------------------- website
# Mounted last so /api/* routes take precedence. Serves index.html at "/".
app.mount("/", StaticFiles(directory=FRONTEND_DIR, html=True), name="site")


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("main:app", host="127.0.0.1", port=8000, reload=False)
