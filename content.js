// Content script: finds the FBpp (protein page), FBgn (gene page) or FBal (allele page) on the current
// FlyBase page and injects a ProteoCast panel; on gene and allele pages, with a menu to switch isoforms,
// and on allele pages with the allele's amino-acid replacement classified and marked on the track.

(() => {
  const PANEL_ID = "proteocast-panel-host";
  let currentId = null;

  const THREE = { Ala:"A",Arg:"R",Asn:"N",Asp:"D",Cys:"C",Gln:"Q",Glu:"E",Gly:"G",His:"H",Ile:"I",
                  Leu:"L",Lys:"K",Met:"M",Phe:"F",Pro:"P",Ser:"S",Thr:"T",Trp:"W",Tyr:"Y",Val:"V" };

  function idFromUrl() {
    const m = location.pathname.match(/(FBpp|FBgn|FBal)\d{7}/);
    return m ? m[0] : null;
  }

  // <select> listing a gene's isoforms; picking one reloads the panel for it.
  function isoformSelect(isoforms, fbpp, allele) {
    const sel = document.createElement("select");
    sel.style.cssText = "font:12px system-ui;margin-left:6px";
    for (const iso of isoforms) sel.add(new Option(`${iso.name} (${iso.fbpp})`, iso.fbpp, false, iso.fbpp === fbpp));
    sel.onchange = () => load(sel.value, isoforms, allele);
    return sel;
  }

  // Position-specific sensitivity (per-residue mean GEMME score, 0-1) in blue shades, as in the paper (Fig. 4).
  const BLUES = [[247,251,255],[198,219,239],[107,174,214],[33,113,181],[8,48,107]];
  // Per-substitution ProteoCast variant score (0 = neutral, more negative = more damaging) on the orange-to-black
  // ramp of the paper's mutational-landscape heatmaps (Fig. 2A); position along the ramp calibrated on the
  // server's heatmap for Nep3-PA: t = 0.11 + |score| / 10.1, so about -9 reaches the near-black end.
  const ORANGES = [[255,245,235],[254,230,206],[253,208,162],[253,174,107],[253,141,60],[241,105,19],
                   [217,72,1],[166,54,3],[127,39,4],[37,37,37]];
  function scoreT(score) { return Math.max(0, Math.min(1, 0.11 + Math.max(0, -score) / 10.1)); }
  function ramp(stops, t) {
    const x = t * (stops.length - 1), i = Math.min(Math.floor(x), stops.length - 2), f = x - i;
    return `rgb(${stops[i].map((v, k) => Math.round(v + (stops[i + 1][k] - v) * f)).join(",")})`;
  }
  function colorFor(sensitivity) {
    return ramp(BLUES, Math.max(0, Math.min(1, Number(sensitivity) || 0)));
  }

  function parseVariant(text, residues) {
    const t = text.trim();
    let m = t.match(/^([A-Za-z]{3})(\d+)([A-Za-z]{3})$/);
    let ref, pos, alt;
    if (m) {
      ref = THREE[m[1][0].toUpperCase() + m[1].slice(1).toLowerCase()];
      alt = THREE[m[3][0].toUpperCase() + m[3].slice(1).toLowerCase()];
      pos = +m[2];
    } else {
      m = t.match(/^([A-Za-z])(\d+)([A-Za-z])$/);
      if (!m) return { error: "Format: R123G or Arg123Gly" };
      ref = m[1].toUpperCase(); alt = m[3].toUpperCase(); pos = +m[2];
    }
    if (!ref || !alt) return { error: "Unknown amino-acid code" };
    const r = residues[pos - 1];
    if (!r) return { error: `Position ${pos} is outside the protein (length ${residues.length})` };
    if (r.aa !== ref) return { error: `Position ${pos} is ${r.aa}, not ${ref} — wrong isoform?` };
    const cls = r.substitutions ? r.substitutions[alt] : null;
    return { pos, ref, alt, cls, residue: r };
  }

  // Allele report pages are server-rendered: the gene is the FBgn link in the "Associated gene" row and the
  // lesion, when it is one, reads "Amino acid replacement: E147V." (several are comma-separated).
  function alleleFromPage() {
    const label = [...document.querySelectorAll("div, th, td, dt")]
      .find((e) => e.children.length < 6 && /^\s*Associated gene\s*$/.test(e.textContent));
    const link = label && [...(label.closest("tr") || label.parentElement).querySelectorAll("a")]
      .map((a) => (a.getAttribute("href") || "").match(/FBgn\d{7}/)).find(Boolean);
    const symbol = (document.title.match(/Allele Report:\s*(?:Dmel\\)?(.+)$/) || [])[1] || "";
    const m = document.body.innerText.match(/Amino acid replacements?:\s*([^\n]*)/);
    const variants = [];
    for (const [, ref, pos, alt] of (m ? m[1] : "").matchAll(/\b([A-Z][a-z]{2}|[A-Z])(\d+)([A-Z][a-z]{2}|[A-Z])\b/g)) {
      const one = (x) => (x.length === 3 ? THREE[x] : "ACDEFGHIKLMNPQRSTVWY".includes(x) ? x : null);
      if (one(ref) && one(alt)) variants.push({ ref: one(ref), pos: +pos, alt: one(alt) });
    }
    return { fbgn: link ? link[0] : null, symbol, variants, lesion: m ? m[1].trim() : "" };
  }

  function buildPanel(data, isoforms, allele) {
    const host = document.createElement("div");
    host.id = PANEL_ID;
    const sh = host.attachShadow({ mode: "open" });
    const { fbpp, seq, domains, pc } = data;
    const residues = pc.residues || [];
    const L = residues.length;
    const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
    const symbol = esc((seq.description.match(/name=([^;\s]+)/) || [, fbpp])[1]);
    const source = pc.source || "";
    // Flag data that isn't real predictions: a test server says so in `source`.
    const fakeLabel = /mock|demo|not real/i.test(source) ? "MOCK DATA" : "";
    const N19 = "19 single nucleotide substitutions impactful";

    sh.innerHTML = `
      <style>
        :host{all:initial;display:block;font:13px/1.4 system-ui,Segoe UI,Arial,sans-serif;color:#222}
        .box{border:1px solid #c9d6e2;border-left:4px solid #1f77b4;border-radius:6px;background:#fff;margin:12px 0;padding:10px 14px;box-shadow:0 1px 3px rgba(0,0,0,.08)}
        h3{margin:0 0 6px;font-size:15px;display:flex;align-items:center;gap:10px}
        h3 a{font-size:12px;font-weight:400;color:#1f77b4}
        .meta{color:#555;font-size:12px;margin-bottom:8px}
        .demo{background:#fff3cd;color:#7a5a00;border:1px solid #ffe08a;border-radius:4px;padding:2px 8px;font-size:11px;font-weight:600}
        .track{position:relative;height:48px;margin:${allele && allele.variants.length ? 16 : 6}px 0 2px}
        .mark{position:absolute;top:-15px;transform:translateX(-50%);color:#6f0043;font-size:13px;line-height:13px;pointer-events:none}
        .brush{position:absolute;top:0;height:28px;box-sizing:border-box;border:2px solid #6f0043;background:rgba(111,0,67,.12);pointer-events:none;display:none;border-radius:2px}
        canvas{width:100%;height:28px;display:block;border:1px solid #ddd;border-radius:3px;cursor:crosshair}
        .dom{position:absolute;top:32px;height:12px;background:#9ecae1;border:1px solid #3182bd;border-radius:2px;font-size:9px;line-height:12px;overflow:hidden;white-space:nowrap;padding:0 2px;box-sizing:border-box;color:#08306b}
        .tip{position:absolute;top:-2px;transform:translate(-50%,-100%);background:#222;color:#fff;padding:3px 6px;border-radius:3px;font-size:11px;white-space:nowrap;pointer-events:none;display:none}
        .legend{font-size:11px;color:#555;display:flex;gap:12px;align-items:center;margin-top:6px}
        .grad{display:inline-block;width:80px;height:10px;vertical-align:middle;border:1px solid #ccc;background:linear-gradient(90deg,#f7fbff,#c6dbef,#6baed6,#2171b5,#08306b)}
        .row{display:flex;gap:8px;align-items:center;margin-top:10px;flex-wrap:wrap}
        input{font:inherit;padding:4px 6px;border:1px solid #bbb;border-radius:4px;width:120px}
        button{font:inherit;padding:4px 10px;border:1px solid #1f77b4;background:#1f77b4;color:#fff;border-radius:4px;cursor:pointer}
        button.sec{background:#fff;color:#1f77b4}
        .res{font-weight:600}
        .impactful{color:#6f0043;font-weight:600}.mild{color:#c8604f;font-weight:600}.neutral{color:#777}
        .seq{font:11px/1.6 ui-monospace,Menlo,Consolas,monospace;word-break:break-all;margin-top:8px;display:none;letter-spacing:.5px}
        .seq span{padding:0 1px;border-radius:2px}
        .seqinfo{font-size:12px;color:#555;margin-top:8px;display:none}.seqinfo a{color:#1f77b4;cursor:pointer;margin-left:6px}
        .seq i{color:#999;font-style:normal;margin-right:4px}
        .err{color:#b30000}
        .box{position:relative}
        .pop{position:absolute;z-index:10;display:none;background:#fff;border:1px solid #bbb;border-radius:6px;box-shadow:0 3px 10px rgba(0,0,0,.18);padding:8px 10px;font-size:12px;width:310px;pointer-events:none}
        .pop .grid{display:grid;grid-template-columns:repeat(10,1fr);gap:3px;margin:6px 0}
        .pop .grid b{display:block;text-align:center;border-radius:3px;padding:2px 0;font:600 11px ui-monospace,Menlo,Consolas,monospace}
        .pop .cls{font-size:11px;color:#444;margin-top:2px}.pop .cls b{display:inline-block;min-width:62px}
        .scale{display:inline-block;width:90px;height:9px;vertical-align:-1px;margin:0 4px;border:1px solid #ccc;
          background:linear-gradient(90deg,#fee6ce,#fdae6b,#f16913,#a63603,#252525)}
        .c-self{background:#fff;color:#999;outline:1px dashed #bbb}.c-none{background:#eee;color:#999}
        .pop .key{color:#666;font-size:11px}.pop .key b{display:inline-block;width:10px;height:10px;border-radius:2px;vertical-align:-1px;margin:0 3px 0 8px}
      </style>
      <div class="box">
        <h3>ProteoCast · ${symbol} <span class="meta">(${fbpp}, ${L} aa)</span>
          ${fakeLabel ? `<span class="demo">${fakeLabel}</span>` : ""}
          <a href="https://proteocast.ijm.fr/drosophiladb/" target="_blank" rel="noopener">open in ProteoCast ↗</a>
        </h3>
        <div class="meta">Blue: per-residue mutational sensitivity (0 to 1). Drag on the track to show part of the sequence.
          Residues with a confident alignment: <b>${pc.frac_confident != null ? Math.round(pc.frac_confident * 100) + "%" : "n/a"}</b>.
          Residues classified sensitive: <b>${residues.filter(r => r.sensitive).length}</b>.
          ${source ? `Source: ${esc(source)}.` : ""}</div>
        <div class="allele"></div>
        <div class="track"><canvas></canvas><div class="brush"></div><div class="tip"></div></div>
        <div class="legend"><span>0</span><span class="grad"></span><span>1 mutational sensitivity</span>
          <span><span style="display:inline-block;width:18px;height:4px;background:rgba(0,0,0,.25);vertical-align:middle"></span> low-confidence alignment</span>
          <span style="margin-left:auto">■ domains (FlyBase/InterPro)</span></div>
        <div class="row">
          <label>Variant:</label><input placeholder="R123G or Arg123Gly">
          <button class="go">Classify</button>
          <button class="sec toggle">Show sequence</button>
          <span class="out"></span>
        </div>
        <div class="seqinfo"></div>
        <div class="seq"></div>
        <div class="pop"></div>
      </div>`;

    // --- track ---
    const canvas = sh.querySelector("canvas"), tip = sh.querySelector(".tip"), track = sh.querySelector(".track");
    const draw = () => {
      const W = canvas.clientWidth || 800, H = 28;
      canvas.width = W * devicePixelRatio; canvas.height = H * devicePixelRatio;
      const ctx = canvas.getContext("2d"); ctx.scale(devicePixelRatio, devicePixelRatio);
      const w = W / L;
      for (let i = 0; i < L; i++) {
        ctx.fillStyle = residues[i].masked ? "#bbb" : colorFor(residues[i].sensitivity);
        ctx.fillRect(i * w, 0, Math.max(w, 1), H);
      }
      // low-confidence band (residue's alignment not confident enough)
      ctx.fillStyle = "rgba(0,0,0,.25)";
      for (let i = 0; i < L; i++) if (residues[i].confident === false) ctx.fillRect(i * w, H - 4, Math.max(w, 1), 4);
    };
    draw();
    new ResizeObserver(draw).observe(canvas);
    canvas.addEventListener("mousemove", (e) => {
      const i = Math.floor((e.offsetX / canvas.clientWidth) * L);
      const r = residues[i]; if (!r) return;
      tip.style.display = "block"; tip.style.left = e.offsetX + "px";
      tip.textContent = r.masked ? `${r.aa}${r.pos}: no ProteoCast prediction`
        : `${r.aa}${r.pos}: sensitivity ${r.sensitivity == null ? "n/a" : r.sensitivity.toFixed(2)} · ${r.n_impactful}/${N19}${r.sensitive ? " · sensitive" : ""}${r.confident === false ? " · low confidence" : ""}`;
    });
    canvas.addEventListener("mouseleave", () => (tip.style.display = "none"));
    for (const v of allele ? allele.variants : []) {
      if (v.pos > L) continue;
      const el = document.createElement("div"); el.className = "mark"; el.textContent = "▼";
      el.style.left = ((v.pos - 0.5) / L * 100) + "%";
      track.appendChild(el);
    }
    for (const d of domains) {
      const el = document.createElement("div"); el.className = "dom";
      el.style.left = ((d.start - 1) / L * 100) + "%"; el.style.width = ((d.end - d.start + 1) / L * 100) + "%";
      el.textContent = d.name || d.abbrev || d.pfam || ""; el.title = `${d.name || ""} ${d.start}-${d.end} (${d.source || ""})`;
      track.appendChild(el);
    }

    // --- variant lookup ---
    const input = sh.querySelector("input"), out = sh.querySelector(".out");
    const classify = () => {
      const v = parseVariant(input.value, residues);
      if (v.error) { out.innerHTML = `<span class="err">${esc(v.error)}</span>`; return; }
      const name = esc(`${v.ref}${v.pos}${v.alt}`);
      if (v.residue.masked) { out.innerHTML = `<span class="res">${name}</span>: no ProteoCast prediction at this position`; return; }
      const cls = esc(v.cls || "no per-substitution data");
      const sc = v.residue.scores ? v.residue.scores[v.alt] : undefined;
      out.innerHTML = `<span class="res">${name}</span>: <span class="${esc(v.cls || "")}">${cls}</span>${typeof sc === "number" ? ` (score ${esc(sc.toFixed(1))})` : ""}
        · residue ${esc(v.residue.n_impactful)}/${N19}${v.residue.sensitive ? ", sensitive" : ", tolerant"}${v.residue.confident === false ? " · <span class=\"err\">low-confidence alignment</span>" : ""}`;
    };
    sh.querySelector(".go").addEventListener("click", classify);
    input.addEventListener("keydown", (e) => e.key === "Enter" && classify());

    // --- coloured sequence ---
    const seqEl = sh.querySelector(".seq"), seqInfo = sh.querySelector(".seqinfo"), toggle = sh.querySelector(".toggle");
    const brush = sh.querySelector(".brush");
    let range = null; // [first, last] residue index (0-based, inclusive) selected on the track, or null = all
    const renderSeq = () => {
      const [a, b] = range || [0, L - 1];
      seqEl.textContent = "";
      const frag = document.createDocumentFragment();
      for (let i = a; i <= b; i++) {
        const r = residues[i], k = i - a;
        if (k % 60 === 0) { const n = document.createElement("i"); n.textContent = String(i + 1).padStart(5); frag.appendChild(n); }
        const s = document.createElement("span"); s.textContent = r.aa;
        s.style.background = r.masked ? "#ddd" : colorFor(r.sensitivity);
        if (!r.masked && r.sensitivity > 0.6) s.style.color = "#fff";
        s.dataset.i = i; frag.appendChild(s);
        if (k % 60 === 59) frag.appendChild(document.createElement("br"));
      }
      seqEl.appendChild(frag);
      seqInfo.textContent = "";
      if (range) {
        seqInfo.append(`Residues ${a + 1}–${b + 1} of ${L}`);
        const all = document.createElement("a"); all.textContent = "show all";
        all.onclick = () => setRange(null);
        seqInfo.append(all);
      }
      seqInfo.style.display = range ? "block" : "none";
    };
    const showSeq = (show) => {
      seqEl.style.display = show ? "block" : "none";
      toggle.textContent = show ? "Hide sequence" : "Show sequence";
      if (show) renderSeq(); else seqInfo.style.display = "none";
    };
    const setRange = (r) => {
      range = r;
      if (r) {
        brush.style.display = "block";
        brush.style.left = (r[0] / L * 100) + "%"; brush.style.width = ((r[1] - r[0] + 1) / L * 100) + "%";
      } else brush.style.display = "none";
      showSeq(true);
    };
    toggle.addEventListener("click", () => showSeq(seqEl.style.display !== "block"));
    // drag on the track to select a stretch of the protein; a plain click clears the selection
    const idxAt = (clientX) => {
      const c = canvas.getBoundingClientRect();
      return Math.max(0, Math.min(L - 1, Math.floor(((clientX - c.left) / c.width) * L)));
    };
    canvas.addEventListener("mousedown", (e) => {
      const from = idxAt(e.clientX);
      e.preventDefault();
      const span = (x) => { const j = idxAt(x); return [Math.min(from, j), Math.max(from, j)]; };
      const move = (ev) => {
        const [a, b] = span(ev.clientX);
        brush.style.display = "block";
        brush.style.left = (a / L * 100) + "%"; brush.style.width = ((b - a + 1) / L * 100) + "%";
      };
      const up = (ev) => { // listeners live only for the duration of one drag
        document.removeEventListener("mousemove", move); document.removeEventListener("mouseup", up);
        const [a, b] = span(ev.clientX);
        if (b - a >= 1) setRange([a, b]);
        else if (range) setRange(null);
        else brush.style.display = "none";
      };
      document.addEventListener("mousemove", move); document.addEventListener("mouseup", up);
    });
    // hovering a residue in the sequence shows its 19 substitutions, coloured by class
    const pop = sh.querySelector(".pop"), box = sh.querySelector(".box");
    seqEl.addEventListener("mouseover", (e) => {
      const r = residues[e.target.dataset && e.target.dataset.i];
      if (!r) return;
      pop.textContent = "";
      const head = document.createElement("div");
      head.innerHTML = `<span class="res">${esc(r.aa)}${esc(r.pos)}</span> · ` + (r.masked ? "no ProteoCast prediction"
        : `sensitivity ${r.sensitivity == null ? "n/a" : esc(r.sensitivity.toFixed(2))} · ${esc(r.n_impactful)}/${N19} · ${r.sensitive ? "sensitive" : "tolerant"}${r.confident === false ? ' · <span class="err">low-confidence alignment</span>' : ""}`);
      pop.appendChild(head);
      if (!r.masked) {
        // 20 cells coloured by variant score (paper's heatmap scale), then the classes as text
        const grid = document.createElement("div"); grid.className = "grid";
        const byClass = { impactful: [], mild: [], neutral: [] };
        for (const a of "ACDEFGHIKLMNPQRSTVWY") {
          const c = document.createElement("b"); c.textContent = a;
          const sc = (r.scores || {})[a], cl = (r.substitutions || {})[a];
          if (a === r.aa) c.className = "c-self";
          else if (typeof sc === "number") {
            const t = scoreT(sc);
            c.style.background = ramp(ORANGES, t); c.style.color = t > 0.55 ? "#fff" : "#3a2410";
          } else c.className = "c-none";
          if (byClass[cl]) byClass[cl].push(a);
          grid.appendChild(c);
        }
        pop.appendChild(grid);
        for (const k of ["impactful", "mild", "neutral"]) {
          const line = document.createElement("div"); line.className = "cls";
          const lab = document.createElement("b"); lab.className = k; lab.textContent = k;
          line.append(lab, byClass[k].length ? byClass[k].join(" ") : "–");
          pop.appendChild(line);
        }
        const key = document.createElement("div"); key.className = "key";
        key.innerHTML = 'variant score 0<span class="scale"></span>−9 · <b class="c-self"></b>wild type';
        pop.appendChild(key);
      }
      const t = e.target.getBoundingClientRect(), b = box.getBoundingClientRect();
      pop.style.display = "block";
      pop.style.left = Math.max(0, Math.min(t.left - b.left - 150, b.width - 320)) + "px";
      pop.style.top = (t.bottom - b.top + 6) + "px";
    });
    seqEl.addEventListener("mouseleave", () => (pop.style.display = "none"));
    if (isoforms) sh.querySelector("h3 .meta").before(isoformSelect(isoforms, fbpp, allele));
    if (allele) {
      const el = sh.querySelector(".allele");
      el.style.cssText = "margin:4px 0;font-size:12px";
      const name = allele.symbol ? `This allele (${allele.symbol})` : "This allele";
      if (allele.variants.length) {
        const list = allele.variants.map((v) => `${v.ref}${v.pos}${v.alt}`);
        el.textContent = `${name}: ${list.join(", ")} (marked on the track).`;
        input.value = list[0];
        classify();
      } else {
        el.textContent = allele.lesion
          ? `${name}: amino acid replacement "${allele.lesion}" (not a single missense change ProteoCast can classify).`
          : `${name} is not an amino-acid replacement, so ProteoCast does not classify it; the gene's predictions are shown.`;
      }
    }
    return host;
  }

  function mountPoint() {
    // Prefer the main report area; fall back to body. FlyBase's DOM may change, so stay generic.
    return document.querySelector("main, #main, .report, #content, .container") || document.body;
  }

  async function send(msg) {
    try {
      return (await chrome.runtime.sendMessage(msg)) || { error: { service: "extension", kind: "internal", detail: "no response" } };
    } catch (e) {
      // Typically "Extension context invalidated" after the extension was reloaded or updated.
      return { error: { service: "extension", kind: "reloaded", detail: String(e.message || e) } };
    }
  }

  function placeholder(text) {
    document.getElementById(PANEL_ID)?.remove();
    const host = document.createElement("div"); host.id = PANEL_ID;
    host.textContent = text;
    host.style.cssText = "font:13px system-ui;color:#555;padding:8px 14px";
    mountPoint().prepend(host);
    return host;
  }

  async function run() {
    const id = idFromUrl();
    if (id === currentId) return;
    currentId = id;
    document.getElementById(PANEL_ID)?.remove();
    if (!id) return;
    if (id.startsWith("FBpp")) return load(id);
    const allele = id.startsWith("FBal") ? alleleFromPage() : null;
    if (allele && !allele.fbgn) return; // allele of a transgene, a construct, etc.: no gene to show
    const fbgn = allele ? allele.fbgn : id;
    const host = placeholder("ProteoCast: loading isoforms…");
    const data = await send({ type: "getIsoforms", fbgn });
    if (id !== currentId) return; // navigated away meanwhile
    if (data.error) return showError(host, data.error, fbgn);
    if (!data.isoforms.length) return host.remove(); // non-coding gene: nothing to show
    const ordered = [...data.isoforms].sort((x, y) => /-PA$/.test(y.name) - /-PA$/.test(x.name));
    let pick = ordered[0];
    if (allele && allele.variants.length) {
      // FlyBase doesn't say which isoform the numbering refers to: take the first (PA first) whose residue matches.
      const v = allele.variants[0];
      const r = await send({ type: "pickIsoform", fbpps: ordered.map((iso) => iso.fbpp), pos: v.pos, ref: v.ref });
      if (id !== currentId) return;
      if (r.fbpp) pick = ordered.find((iso) => iso.fbpp === r.fbpp);
    }
    load(pick.fbpp, data.isoforms, allele);
  }

  // Show the panel for one protein; `isoforms` (gene/allele pages) adds the isoform menu, `allele` the allele line.
  async function load(fbpp, isoforms, allele) {
    const id = currentId;
    const host = placeholder("ProteoCast: loading…");
    const data = await send({ type: "getProteoCast", fbpp });
    if (id !== currentId) return;
    if (!data.error) return host.replaceWith(buildPanel(data, isoforms, allele));
    showError(host, data.error, fbpp, isoforms, allele);
  }

  function explain(err, fbpp) {
    const p = err.service === "proteocast", f = err.service === "flybase";
    if (err.kind === "reloaded") return "The extension was reloaded or updated. Refresh this page.";
    if (p && err.kind === "offline")
      return "The ProteoCast server is not responding (offline, unreachable from this network, or under maintenance). Try again later.";
    if (p && err.kind === "not_found") return `ProteoCast has no prediction for ${fbpp}.`;
    if (p) return "The ProteoCast server returned an error. Try again later.";
    if (f && err.kind === "offline") return "FlyBase's API is not responding, so the protein sequence could not be loaded. Try again later.";
    if (f && err.kind === "not_found") return `FlyBase has no sequence for ${fbpp} (possibly an obsolete ID).`;
    if (f) return "FlyBase's API returned an error. Try again later.";
    return "Something went wrong in the extension.";
  }

  function showError(host, err, fbpp, isoforms, allele) {
    host.textContent = "";
    host.style.color = "#b30000";
    const msg = document.createElement("span");
    msg.textContent = `ProteoCast: ${explain(err, fbpp)} `;
    const details = document.createElement("span");
    details.textContent = `(${[err.detail, err.url].filter(Boolean).join(" — ")})`;
    details.style.cssText = "color:#888;font-size:11px";
    host.append(msg, details);
    if (isoforms) host.append(isoformSelect(isoforms, fbpp, allele)); // e.g. no prediction for this isoform: try another
    if (err.kind !== "not_found" && err.kind !== "reloaded") {
      const retry = document.createElement("button");
      retry.textContent = "Retry";
      retry.style.cssText = "margin-left:8px;font:inherit;font-size:12px;padding:1px 8px;cursor:pointer";
      retry.onclick = () => { currentId = null; run(); };
      host.append(retry);
    }
  }

  run();
  // FlyBase navigates client-side in places. Content scripts live in an isolated world, so patching
  // history.pushState here would not see the page's own calls: poll the URL instead (run() is a no-op
  // while the ID is unchanged), plus back/forward and hash changes.
  for (const ev of ["popstate", "hashchange"]) addEventListener(ev, run);
  setInterval(run, 2000);
})();
