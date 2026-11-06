#!/usr/bin/env python3
"""
Convert the ProteoCast Drosophila outputs into one JSON file per FBpp for proteocast_api.py
(or for static serving behind nginx).

    python3 build_json.py --proteocast-dir Drosophila_ProteoCast --out data/
    python3 build_json.py --proteocast-dir Drosophila_ProteoCast --out data/ --only FBpp0070000 FBpp0070044
    nice python3 build_json.py --proteocast-dir Drosophila_ProteoCast --out data/ --jobs 8

Input layout (as on proteocast.ijm.fr and in the Zenodo archive, records/14871341):
  mapping_database.csv             FBpp_ID,id,Protein_symbol,Structure_3D_file   (several FBpp can share one id)
  <id>/1.<FBpp>.fasta              sequence of the proteoform (a few are empty; selenocysteine U is written C)
  <id>/4.<FBpp>_ProteoCast.csv     Mutation,Variant_score,Residue,LocalConfidence,Variant_class,Residue_class
                                   20 rows per residue (the self-substitution, e.g. M1M, is included)
  <id>/14.<FBpp>_GEMME_pLDDT.csv   Residue,GEMME_mean,pLDDT
<FBpp> in the file names is the representative FBpp of the proteoform, not necessarily the one requested.
Some folders hold two prediction files; like the website, we read the one named after the folder's first FBpp
in mapping_database.csv. Positions ProteoCast masked as X are output with "masked": true and no classes.
Per substitution: "substitutions" = Variant_class, "scores" = Variant_score (1 decimal; 0 = neutral, more negative =
more damaging), used by the extension to colour substitutions like the paper's mutational-landscape heatmap.
Standard library only, so it runs with the system python3 on the server.
"""
import argparse, csv, glob, json, os, sys
from multiprocessing import Pool

AA = "ACDEFGHIKLMNPQRSTVWY"
SOURCE = "ProteoCast (Abakarova et al. 2026, Nat Commun)"
PORTAL = "https://proteocast.ijm.fr/drosophiladb/"


def load_mapping(path):
    """{FBpp: (folder_id, protein_symbol)}"""
    with open(path, newline="") as f:
        return {row["FBpp_ID"]: (row["id"], row.get("Protein_symbol") or "") for row in csv.DictReader(f)}


def one(folder, pattern):
    hits = glob.glob(os.path.join(folder, pattern))
    if len(hits) != 1:
        raise FileNotFoundError(f"expected one {pattern} in {folder}, found {len(hits)}")
    return hits[0]


def read_fasta(path):
    with open(path) as f:
        return "".join(line.strip() for line in f if not line.startswith(">"))


def pick(folder, prefix, rep, suffix):
    """The file the ProteoCast website reads (<prefix><rep><suffix>), else the only one matching the pattern."""
    named = os.path.join(folder, f"{prefix}{rep}{suffix}") if rep else None
    return named if named and os.path.exists(named) else one(folder, f"{prefix}*{suffix}")


def load_proteoform(folder, rep=None):
    """
    -> (sequence, residues) with residues in the endpoint's per-residue format.
    rep = the proteoform's first FBpp in mapping_database.csv; the website reads 4.<rep>_ProteoCast.csv,
    which matters for the few folders holding two prediction files.
    Residue letters come from the predictions (they match FlyBase, e.g. U for selenocysteine where the
    FASTA has C); the FASTA only fills positions ProteoCast masked as X, and may be empty.
    """
    fasta = read_fasta(one(folder, "1.*.fasta"))
    rows = {}
    with open(pick(folder, "4.", rep, "_ProteoCast.csv"), newline="") as f:
        for row in csv.DictReader(f):
            rows.setdefault(int(row["Residue"]) - 1, []).append(row)
    L = max(rows) + 1
    if fasta and len(fasta) != L:
        raise ValueError(f"FASTA length {len(fasta)} != {L} predicted residues in {folder}")
    sensitivity = {}
    with open(pick(folder, "14.", rep, "_GEMME_pLDDT.csv"), newline="") as f:
        for row in csv.DictReader(f):
            sensitivity[int(row["Residue"]) - 1] = float(row["GEMME_mean"])
    seq, residues = [], []
    for i in range(L):
        if i not in rows or i not in sensitivity:
            raise ValueError(f"residue {i + 1} missing in {folder}")
        ref = rows[i][0]["Mutation"][0]
        if ref == "X":
            # ProteoCast masks some positions as X (scores 0, all "neutral"): no prediction there.
            if not fasta:
                raise ValueError(f"masked residue {i + 1} and no FASTA in {folder}")
            seq.append(fasta[i])
            residues.append({"pos": i + 1, "aa": fasta[i], "sensitivity": round(sensitivity[i], 3), "n_impactful": 0,
                             "sensitive": False, "confident": False, "substitutions": {}, "scores": {}, "masked": True})
            continue
        if fasta and ref != fasta[i] and not (ref == "U" and fasta[i] == "C"):
            raise ValueError(f"{rows[i][0]['Mutation']} does not match the FASTA in {folder}")
        subs = {r["Mutation"][-1]: r["Variant_class"] for r in rows[i] if r["Mutation"][-1] != ref}
        scores = {r["Mutation"][-1]: round(float(r["Variant_score"]), 1) for r in rows[i] if r["Mutation"][-1] != ref}
        seq.append(ref)
        residues.append({"pos": i + 1, "aa": ref, "sensitivity": round(sensitivity[i], 3),
                         "n_impactful": sum(v == "impactful" for v in subs.values()),
                         "sensitive": rows[i][0]["Residue_class"] == "sensitive",
                         "confident": rows[i][0]["LocalConfidence"] == "True",
                         "substitutions": {a: subs[a] for a in AA if a in subs},
                         "scores": {a: scores[a] for a in AA if a in scores}})
    return "".join(seq), residues


def build(fbpp, folder_id, symbol, residues):
    return {"fbpp": fbpp, "proteoform_id": folder_id, "symbol": symbol, "length": len(residues),
            "frac_confident": round(sum(r["confident"] for r in residues) / len(residues), 3),
            "source": SOURCE, "portal_url": PORTAL, "residues": residues}


def convert(job):
    """Convert one proteoform folder; returns (folder_id, n_written, error_or_None). Runs in a worker process."""
    proteocast_dir, out, folder_id, entries = job
    try:
        _, residues = load_proteoform(os.path.join(proteocast_dir, folder_id), entries[0][0])
    except Exception as e:
        return folder_id, 0, f"{folder_id} ({', '.join(f for f, _ in entries)}): {e}"
    for fbpp, symbol in entries:  # isoforms with identical sequences share one proteoform
        tmp = os.path.join(out, fbpp + ".json.tmp")
        with open(tmp, "w") as f:
            json.dump(build(fbpp, folder_id, symbol, residues), f, separators=(",", ":"))
        os.chmod(tmp, 0o644)  # read-only for the web server's group: the extension inserts this data into FlyBase pages
        os.replace(tmp, os.path.join(out, fbpp + ".json"))  # never leave a half-written file in place
    return folder_id, len(entries), None


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--proteocast-dir", required=True)
    ap.add_argument("--mapping", help="default: <proteocast-dir>/mapping_database.csv")
    ap.add_argument("--out", required=True)
    ap.add_argument("--only", nargs="*", help="restrict to these FBpp IDs")
    ap.add_argument("--jobs", type=int, default=1, help="worker processes")
    a = ap.parse_args()
    mapping = load_mapping(a.mapping or os.path.join(a.proteocast_dir, "mapping_database.csv"))
    if a.only:
        mapping = {k: v for k, v in mapping.items() if k in set(a.only)}
    os.makedirs(a.out, exist_ok=True)
    by_folder = {}
    for fbpp, (folder_id, symbol) in mapping.items():
        by_folder.setdefault(folder_id, []).append((fbpp, symbol))
    jobs = [(a.proteocast_dir, a.out, fid, entries) for fid, entries in by_folder.items()]
    n = failed = 0
    with Pool(a.jobs) as pool:
        for k, (folder_id, written, err) in enumerate(pool.imap_unordered(convert, jobs, chunksize=16), 1):
            n += written
            if err:
                print(err, file=sys.stderr)
                failed += 1
            if k % 1000 == 0:
                print(f"{k}/{len(jobs)} proteoforms", file=sys.stderr, flush=True)
    print(f"wrote {n} records to {a.out}; {failed} proteoforms failed")
