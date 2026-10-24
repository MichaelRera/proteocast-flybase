# ProteoCast for FlyBase

Browser extension (Chrome, Edge, Brave and other Chromium browsers) that overlays ProteoCast missense-variant predictions on FlyBase protein (`FBpp`), gene (`FBgn`) and allele (`FBal`) pages.

**Install from the Chrome Web Store:** https://chromewebstore.google.com/detail/proteocast-for-flybase/pdkdmicjkpiamojmcfgbcajcnifccokl

What it shows, injected at the top of the report:
- per-residue mutational-sensitivity track (blue = mean GEMME score 0–1, as in the paper; grey band = low-confidence alignment; drag to select a stretch of the sequence), with FlyBase/InterPro domains underneath;
- a variant box: type `R123G` or `Arg123Gly` → impactful / mild / neutral, with a sanity check that the reference residue matches the isoform;
- an optional colour-coded sequence view (all of it, or the stretch selected on the track); hovering a residue shows its 19 substitutions coloured by ProteoCast variant score on the orange-to-black scale of the paper's mutational-landscape heatmaps, with their impactful / mild / neutral classes.

The protein sequence, domains and a gene's isoforms come from the public FlyBase API (`api.flybase.org`). From the page itself the extension reads only the ID in the URL and, on allele pages, the gene and the "Amino acid replacement" line. Everything cross-origin is fetched from the service worker under `host_permissions`.

## Install
From the [Chrome Web Store](https://chromewebstore.google.com/detail/proteocast-for-flybase/pdkdmicjkpiamojmcfgbcajcnifccokl) (one click, automatic updates).

From source (for development): `chrome://extensions` → enable *Developer mode* → *Load unpacked* → select this folder. `INSTALL.txt` is the step-by-step note for testers installing from a zip.

Then:

1. Check the extension is enabled in `chrome://extensions`.
2. Open e.g. `https://flybase.org/reports/FBpp0070000`. By default the predictions come from `https://proteocast.ijm.fr/data/api/{fbpp}.json` (30,461 of the 30,739 FBpp in `mapping_database.csv`; the rest have no ProteoCast prediction).
3. Click the toolbar icon to change the endpoint (only for testing against another server).

## Testing against the mock server
```
python3 server/proteocast_api.py --mock --port 8765
```
Endpoint: `http://localhost:8765/api/v1/drosophila/{fbpp}`. The shared build has no localhost permission: add `"http://localhost/*"` to `host_permissions` in `manifest.json` first. The mock takes the real sequence from the FlyBase API (random residues if it is unreachable), so the variant box's reference check works against it.

## Endpoint contract
`GET <endpoint with {fbpp} substituted>`, live as static files at `https://proteocast.ijm.fr/data/api/<FBpp>.json` → `application/json`, cacheable, 404 if unknown.

```json
{
  "fbpp": "FBpp0070000",
  "proteoform_id": "1",
  "symbol": "Nep3-PA",
  "length": 786,
  "frac_confident": 1.0,
  "source": "ProteoCast (Abakarova et al. 2026, Nat Commun)",
  "portal_url": "https://proteocast.ijm.fr/drosophiladb/",
  "residues": [
    {
      "pos": 1, "aa": "M",
      "sensitivity": 0.42,
      "n_impactful": 7,
      "sensitive": true,
      "confident": true,
      "substitutions": {"A": "impactful", "C": "mild", "D": "neutral", "...": "..."}
    }
  ]
}
```
Field notes (all taken from the ProteoCast outputs, see `server/build_json.py`): `sensitivity` = per-residue mean GEMME score (`GEMME_mean`), used for the blue colour; `n_impactful` = impactful substitutions at that residue; `sensitive` = ProteoCast's own residue class (`Residue_class` sensitive/tolerant, not a count threshold); `confident` = `LocalConfidence` of the residue's alignment; `frac_confident` = share of confident residues (the outputs have no per-protein confidence value; the Zenodo recap table may); `substitutions` = `Variant_class` for the 19 alternatives and may be omitted to shrink the payload (the track still works, only the variant box loses its answer). Size ≈ 370 bytes/residue raw, ≈ 20 gzipped (Nep3-PA: 290 kB raw, 15 kB gzipped).

## Building the data
`server/build_json.py` converts the ProteoCast *D. melanogaster* outputs (the per-proteoform folders and
`mapping_database.csv` of the [Zenodo archive](https://zenodo.org/records/14871341); 30,739 FBpp → 22,396
proteoforms) into one JSON file per FBpp. Standard library only:
```
python3 server/build_json.py --proteocast-dir Drosophila_ProteoCast --out <outdir> [--jobs 8] [--only FBpp0070000 ...]
```
Isoforms sharing a proteoform get identical predictions. Serve `<outdir>` as static files (enable gzip for
`application/json`: about 430 kB raw, 45 kB compressed per protein) or with `server/proteocast_api.py --data <outdir>`,
and point the extension's endpoint at it.

## Known limitations / next steps
- Gene (FBgn) pages list the isoforms from the FlyBase API (`/sequence/id/<FBgn>/CDS`, whose records carry the FBpp IDs) and show -PA first. Allele (FBal) pages read the gene and "Amino acid replacement: …" from the server-rendered report, so a FlyBase layout change can break them; the isoform shown is the first (PA first) whose residue matches, since FlyBase doesn't say which isoform the numbering refers to.
- FlyBase's report pages are client-rendered; the panel is mounted at the top of `<main>` (fallback `body`) and re-checks the URL on client-side navigation.
- Domain names come from the FlyBase API; the mock server produces the same schema as `build_json.py`.

## License
ProteoCast for FlyBase is free software, released under the [GNU General Public License v3.0](LICENSE):
you may use, study, share and modify it; versions you distribute must stay under the same license.
The ProteoCast predictions it displays come from Abakarova et al., *Nature Communications* (2026);
please cite the paper when you use them.
