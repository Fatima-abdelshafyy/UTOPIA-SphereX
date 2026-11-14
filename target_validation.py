"""Step 4: check data availability for the 5 targets. Run: python target_validation.py"""
from astropy.coordinates import SkyCoord
from astroquery.ipac.irsa import Irsa

TARGETS = ["Barnard's Star", "Epsilon Indi B", "WISE 0855-0714", "RW Aurigae", "R Draconis"]
cols = [str(c) for c in Irsa.list_collections()["collection"]]
sp = [c for c in cols if "spherex" in c.lower()]
print("SPHEREx collections:", sp)
coll = sp[-1]
for name in TARGETS:
    try:
        pos = SkyCoord.from_name(name)  # note: proper-motion objects -> coordinates at the observation epoch
        t = Irsa.query_sia(pos=(pos, 0.05), collection=coll)
        print(f"{name}: {len(t)} observations | columns: {t.colnames[:12]}")
    except Exception as e:
        print(f"{name}: FAILED -> {e}")
