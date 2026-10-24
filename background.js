// Service worker: all cross-origin fetches go through here (host_permissions apply),
// so the content script never hits CORS.

const DEFAULTS = {
  endpoint: "https://proteocast.ijm.fr/data/api/{fbpp}.json", // {fbpp} is substituted; static files from server/build_json.py
};
const FLYBASE_API = "https://api.flybase.org/api/v1.0";

chrome.action.onClicked.addListener(() => chrome.runtime.openOptionsPage());

const FBPP = /^FBpp\d{7}$/, FBGN = /^FBgn\d{7}$/;
const badInput = (detail) => ({ error: { service: "extension", kind: "internal", detail } });

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) return; // only our own content script (there is no externally_connectable)
  if (msg.type === "getProteoCast") {
    if (!FBPP.test(msg.fbpp)) return sendResponse(badInput("bad FBpp ID"));
    handleRequest(msg.fbpp)
      .then(sendResponse)
      .catch((e) => sendResponse({ error: e.info || { service: "extension", kind: "internal", detail: String(e) } }));
    return true; // async
  }
  if (msg.type === "pickIsoform") {
    if (!Array.isArray(msg.fbpps) || !msg.fbpps.every((x) => FBPP.test(x)) || !(msg.pos > 0)) return sendResponse({ fbpp: null });
    pickIsoform(msg.fbpps, msg.pos, msg.ref)
      .then((fbpp) => sendResponse({ fbpp }))
      .catch(() => sendResponse({ fbpp: null }));
    return true;
  }
  if (msg.type === "getIsoforms") {
    if (!FBGN.test(msg.fbgn)) return sendResponse(badInput("bad FBgn ID"));
    fetchIsoforms(msg.fbgn)
      .then((isoforms) => sendResponse({ isoforms }))
      .catch((e) => sendResponse({ error: e.info || { service: "extension", kind: "internal", detail: String(e) } }));
    return true;
  }
});

// First isoform (in the given order) whose sequence has `ref` at `pos`; null if none does.
async function pickIsoform(fbpps, pos, ref) {
  for (const fbpp of fbpps) {
    const { sequence } = await fetchSequence(fbpp);
    if (sequence[pos - 1] === ref) return fbpp;
  }
  return null;
}

// A gene's polypeptides. FlyBase's API has no polypeptide listing per gene, but the gene's CDS records
// carry the FBpp IDs (with transcript names like Naprt-RA; the protein is Naprt-PA).
async function fetchIsoforms(fbgn) {
  let j;
  try {
    j = await fetchJson(`${FLYBASE_API}/sequence/id/${fbgn}/CDS`);
  } catch (e) {
    if (e.info && e.info.kind === "not_found") return []; // non-coding gene: FlyBase answers 404
    throw e;
  }
  const seen = new Map();
  for (const hit of (j.resultset || j).result || []) {
    if (!/^FBpp\d{7}$/.test(hit.id) || seen.has(hit.id)) continue;
    const name = ((hit.description || "").match(/name=([^;\s]+)/) || [, hit.id])[1].replace(/-R([A-Z]+)$/, "-P$1");
    seen.set(hit.id, { fbpp: hit.id, name });
  }
  return [...seen.values()].sort((x, y) => x.name.localeCompare(y.name));
}

async function handleRequest(fbpp) {
  const settings = await chrome.storage.sync.get(DEFAULTS);
  const [seq, domains] = await Promise.all([fetchSequence(fbpp), fetchDomains(fbpp)]);
  if (!allowedEndpoint(settings.endpoint)) {
    throw fetchError("proteocast", "http", settings.endpoint, "endpoint must be https:// (or http://localhost for testing)");
  }
  const url = settings.endpoint.replace("{fbpp}", fbpp);
  const pc = sanitizePredictions(await fetchJson(url, "proteocast"), url);
  return { fbpp, seq, domains: sanitizeDomains(domains), pc };
}

function allowedEndpoint(u) {
  return /^https:\/\/[^/]+\//.test(u) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//.test(u);
}

// Server answers end up in FlyBase's page (which has no Content-Security-Policy), so keep only values of the
// expected type: numbers, booleans, single letters and the three class names. Anything else is dropped,
// and a malformed answer is rejected as a whole.
const AA20 = "ACDEFGHIKLMNPQRSTVWY", CLASSES = new Set(["impactful", "mild", "neutral"]);
const num = (x) => (typeof x === "number" && Number.isFinite(x) ? x : null);

function sanitizePredictions(pc, url) {
  if (!pc || !Array.isArray(pc.residues) || pc.residues.length === 0 || pc.residues.length > 40000) {
    throw fetchError("proteocast", "bad_data", url, "unexpected prediction format");
  }
  const residues = pc.residues.map((r, i) => {
    r = r && typeof r === "object" ? r : {};
    const subs = {};
    if (r.substitutions && typeof r.substitutions === "object") {
      for (const a of AA20) if (Object.hasOwn(r.substitutions, a) && CLASSES.has(r.substitutions[a])) subs[a] = r.substitutions[a];
    }
    const scores = {};
    if (r.scores && typeof r.scores === "object") {
      for (const a of AA20) {
        const v = Object.hasOwn(r.scores, a) ? num(r.scores[a]) : null;
        if (v !== null && v >= -50 && v <= 50) scores[a] = Math.round(v * 10) / 10;
      }
    }
    const n = num(r.n_impactful);
    return {
      pos: i + 1,
      aa: typeof r.aa === "string" && /^[A-Z]$/.test(r.aa) ? r.aa : "X",
      sensitivity: num(r.sensitivity),
      n_impactful: n === null ? 0 : Math.max(0, Math.min(19, Math.round(n))),
      sensitive: r.sensitive === true,
      confident: r.confident !== false,
      masked: r.masked === true,
      substitutions: subs,
      scores,
    };
  });
  const f = num(pc.frac_confident);
  return {
    residues,
    frac_confident: f === null ? null : Math.max(0, Math.min(1, f)),
    source: typeof pc.source === "string" ? pc.source.slice(0, 200) : "",
  };
}

function sanitizeDomains(domains) {
  return (Array.isArray(domains) ? domains : [])
    .map((d) => ({
      start: Math.round(num(d && d.start) ?? NaN), end: Math.round(num(d && d.end) ?? NaN),
      name: String((d && (d.name || d.abbrev || d.pfam)) || "").slice(0, 200), source: String((d && d.source) || "").slice(0, 50),
    }))
    .filter((d) => d.start > 0 && d.end >= d.start);
}

// Errors carry `info` = {service, kind, status?, url, detail} so the panel can explain them in plain words.
// kind: "offline" (no answer / timeout), "not_found" (404), "http" (other status), "bad_data" (not JSON).
function fetchError(service, kind, url, detail, status) {
  const e = new Error(`${service} ${kind}: ${detail}`);
  e.info = { service, kind, url, detail, status };
  return e;
}

async function fetchJson(url, service = "flybase") {
  let r;
  try {
    // Predictions are revalidated on every request (cheap "304 Not Modified" when unchanged), so a data
    // update on the server shows up immediately instead of after the 1-day browser cache expires.
    r = await fetch(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(15000),
                           cache: service === "proteocast" ? "no-cache" : "default" });
  } catch (e) {
    throw fetchError(service, "offline", url, e.name === "TimeoutError" ? "no answer within 15 s" : String(e.message || e));
  }
  if (r.status === 404) throw fetchError(service, "not_found", url, "HTTP 404", 404);
  if (!r.ok) throw fetchError(service, "http", url, `HTTP ${r.status}`, r.status);
  try {
    return await r.json();
  } catch (e) {
    throw fetchError(service, "bad_data", url, "response is not valid JSON");
  }
}

async function fetchSequence(fbpp) {
  const j = await fetchJson(`${FLYBASE_API}/sequence/id/${fbpp}`);
  const hit = ((j.resultset || j).result || [])[0];
  if (!hit) throw fetchError("flybase", "not_found", `${FLYBASE_API}/sequence/id/${fbpp}`, `no sequence for ${fbpp}`);
  return { id: hit.id, description: hit.description || "", sequence: (hit.sequence || "").replace(/\s+/g, "") };
}

async function fetchDomains(fbpp) {
  try {
    const j = await fetchJson(`${FLYBASE_API}/domain/${fbpp}`);
    const hit = ((j.resultset || j).result || [])[0];
    return hit ? hit.regions || [] : [];
  } catch {
    return []; // domains are optional
  }
}
