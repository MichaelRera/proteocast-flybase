#!/usr/bin/env python3
"""
Reference implementation of the endpoint the extension expects.

    GET /api/v1/drosophila/<FBpp>  ->  JSON (schema in ../README.md)

Two modes:
  --mock           : fabricate deterministic fake data for any FBpp (for UI testing)
  --data DIR       : serve pre-built JSON files  DIR/<FBpp>.json

Build the JSON files once from the ProteoCast per-proteoform outputs with
`build_json.py` (adapt the column names there to the real files).

Run:  python3 proteocast_api.py --mock --port 8765
Then set the extension endpoint to http://localhost:8765/api/v1/drosophila/{fbpp}
and untick "Demo mode".
"""
import argparse, json, os, random, re, sys, urllib.request
from functools import lru_cache
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

AA = "ACDEFGHIKLMNPQRSTVWY"
ROUTE = re.compile(r"^/api/v1/drosophila/(FBpp\d{7})/?$")
FLYBASE_API = "https://api.flybase.org/api/v1.0"


@lru_cache(maxsize=256)
def flybase_sequence(fbpp):
    """Real sequence from FlyBase, so the variant box's reference-residue check passes. None if unavailable."""
    try:
        with urllib.request.urlopen(f"{FLYBASE_API}/sequence/id/{fbpp}", timeout=10) as r:
            j = json.load(r)
        hits = j.get("resultset", j).get("result") or []
        return re.sub(r"\s+", "", hits[0].get("sequence", "")) or None if hits else None
    except Exception as e:
        sys.stderr.write(f"FlyBase sequence for {fbpp} unavailable ({e}); using random residues\n")
        return None


def mock_record(fbpp, sequence=None):
    rnd = random.Random(fbpp)
    L = len(sequence) if sequence else rnd.randint(150, 900)
    residues, base = [], rnd.random()
    for i in range(L):
        base = min(1, max(0, base + (rnd.random() - 0.5) * 0.25))
        aa = sequence[i] if sequence else rnd.choice(AA)
        subs = {}
        for a in AA:
            if a == aa:
                continue
            r = rnd.random()
            subs[a] = "impactful" if r < base * 0.9 else "mild" if r < base * 0.9 + 0.2 else "neutral"
        n_imp = sum(v == "impactful" for v in subs.values())
        scores = {a: round({"impactful": -3.5 - 4 * rnd.random(), "mild": -2 - rnd.random(),
                            "neutral": -1.5 * rnd.random()}[c], 1) for a, c in subs.items()}
        residues.append({"pos": i + 1, "aa": aa, "sensitivity": round(base, 3), "n_impactful": n_imp,
                         "sensitive": base > 0.5, "confident": rnd.random() > 0.1,
                         "substitutions": subs, "scores": scores})
    return {"fbpp": fbpp, "length": L,
            "frac_confident": round(sum(r["confident"] for r in residues) / L, 3),
            "source": "MOCK SERVER — not real predictions",
            "portal_url": "https://proteocast.ijm.fr/drosophiladb/", "residues": residues}


class Handler(BaseHTTPRequestHandler):
    mock = False
    data_dir = None

    def _send(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "*")  # harmless; extension uses host_permissions anyway
        self.send_header("Cache-Control", "public, max-age=86400")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        m = ROUTE.match(self.path.split("?")[0])
        if not m:
            return self._send(404, {"error": "unknown route"})
        fbpp = m.group(1)
        if self.mock:
            return self._send(200, mock_record(fbpp, flybase_sequence(fbpp)))
        path = os.path.join(self.data_dir, fbpp + ".json")
        if not os.path.exists(path):
            return self._send(404, {"error": f"no ProteoCast record for {fbpp}"})
        with open(path, "rb") as f:
            body = f.read()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Cache-Control", "public, max-age=86400")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):
        sys.stderr.write("%s %s\n" % (self.address_string(), fmt % args))


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--mock", action="store_true")
    ap.add_argument("--data", help="directory of <FBpp>.json files")
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--host", default="127.0.0.1")
    a = ap.parse_args()
    if not a.mock and not a.data:
        ap.error("need --mock or --data DIR")
    Handler.mock, Handler.data_dir = a.mock, a.data
    print(f"serving on http://{a.host}:{a.port}/api/v1/drosophila/<FBpp>  ({'mock' if a.mock else a.data})")
    ThreadingHTTPServer((a.host, a.port), Handler).serve_forever()
