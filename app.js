/* Gel pseudo-chromatograms: pick lanes, see their traces on one kDa axis and where they sit on the gel. */
(() => {
  "use strict";

  // Okabe-Ito, ordered so the faint yellow and the black come last; black becomes light grey on a dark page
  const LANE_HUES = {
    light: ["#0072B2", "#D55E00", "#009E73", "#CC79A7", "#E69F00", "#56B4E9", "#F0E442", "#000000"],
    dark: ["#0072B2", "#D55E00", "#009E73", "#CC79A7", "#E69F00", "#56B4E9", "#F0E442", "#BBBBBB"],
  };
  // line style marks what was done differently to a lane (as in pseudochrom.py)
  const DASHES = [["no CPI", "dash"], ["vehicle", "dash"], ["bead eluate", "dash"], ["−REP1", "dash"],
                  ["−RabGGTase", "dot"], ["−B-GPP", "dashdot"]];
  const KIND_LABEL = { endogenous: "endogenous", reagent: "reaction mix?",
                       reaction: "product", rab: "Rab-like", odd: "no-enzyme label" };

  // ladder sizes plus a few in between, so a zoomed-in axis still has numbers
  const TICKS = [250, 200, 150, 120, 100, 75, 60, 50, 40, 37, 30, 25, 20, 17, 15, 12, 10];

  const $ = (s) => document.querySelector(s);
  const el = (tag, attrs = {}, ...kids) => {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === "class") e.className = v;
      else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
      else if (v !== null && v !== undefined && v !== false) e.setAttribute(k, v === true ? "" : v);
    }
    for (const k of kids.flat()) if (k !== null && k !== undefined) e.append(k.nodeType ? k : String(k));
    return e;
  };
  const SVG = "http://www.w3.org/2000/svg";
  const sv = (tag, attrs = {}) => {
    const e = document.createElementNS(SVG, tag);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
    return e;
  };

  const state = {
    versions: [], version: null, data: null, bands: null,
    selected: [],           // lane ids, in the order picked
    slots: new Map(),       // lane id -> colour slot (each-lane colouring), kept while selected
    geno: "all", colourBy: "defect", ymax: "auto", showBands: true,
    gel: null, gelMode: "whole", activeBand: null, hoverKda: null,
    pickMode: "band",        // what a click on a gel image picks: a band (default) or a lane
    picked: null,            // a band picked on a gel that the band table doesn't have: {kda, lo, hi}
    openEvidence: new Set(), // band-table rows whose evidence is open (index, or "picked")
    imgs: new Map(),        // image src -> Promise<HTMLImageElement>
  };

  const dark = () => {
    const t = document.documentElement.dataset.theme;
    if (t) return t === "dark";
    return matchMedia("(prefers-color-scheme: dark)").matches;
  };
  const cssVar = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
  const laneById = (id) => state.data.lanes.find((l) => l.id === id);
  const gelById = (id) => state.data.gels.find((g) => g.id === id);
  const fmtKda = (k) => (k >= 100 ? k.toFixed(0) : k >= 10 ? k.toFixed(0) : k.toFixed(1));

  // ------------------------------------------------------------------ URL state

  const latestVersion = () => state.versions.length ? state.versions[state.versions.length - 1].id : null;

  function readHash() {
    const p = new URLSearchParams(location.hash.slice(1));
    return {
      v: p.get("v"), l: p.get("l") ? p.get("l").split("|").filter(Boolean) : null,
      c: p.get("c"), g: p.get("g"), y: p.get("y"), gv: p.get("gv"), pm: p.get("pm"), b: p.get("b"),
    };
  }
  function writeHash() {
    const p = new URLSearchParams();
    if (state.version !== latestVersion()) p.set("v", state.version);
    p.set("l", state.selected.join("|"));
    p.set("c", state.colourBy);
    if (state.ymax !== "auto") p.set("y", state.ymax);
    if (state.gel) p.set("g", state.gel);
    if (state.gelMode === "sbs") p.set("gv", "sbs");
    if (state.pickMode === "lane") p.set("pm", "lane");
    const b = curBand();
    if (b) p.set("b", String(b.kda));
    history.replaceState(null, "", "#" + p.toString());
  }

  // ------------------------------------------------------------------ colours

  function dilutionFold(meta) {
    const d = (meta.dilution || "neat").toLowerCase();
    const m = d.match(/1\s*in\s*(\d+)/);
    return m ? +m[1] : 1;
  }
  function laneStyle(lane) {
    let dash = "solid";
    for (const [k, d] of DASHES) if (lane.legend.includes(k)) dash = d;
    if (state.colourBy === "lane") {
      const slot = state.slots.get(lane.id) ?? 0;
      const hues = LANE_HUES[dark() ? "dark" : "light"];
      return { color: hues[slot % 8], dash: slot >= 8 ? "dot" : "solid" };
    }
    // defect colouring: reds for the defect, blues without; darker = more lysate
    const g = lane.meta.genotype === "MUT" ? "mut" : "het";
    const same = state.selected.map(laneById).filter((l) => (l.meta.genotype === "MUT" ? "mut" : "het") === g);
    const folds = [...new Set(same.map((l) => dilutionFold(l.meta)))].sort((a, b) => a - b);
    const rank = Math.min(3, folds.indexOf(dilutionFold(lane.meta)));
    return { color: cssVar(`--${g}-${Math.max(0, rank) + 1}`), dash };
  }
  function assignSlot(id) {
    if (state.slots.has(id)) return;
    const used = new Set(state.slots.values());
    let s = 0;
    while (used.has(s)) s++;
    state.slots.set(id, s);
  }

  // ------------------------------------------------------------------ selection

  function toggle(id, on) {
    const has = state.selected.includes(id);
    if (on === undefined) on = !has;
    if (on && !has) { state.selected.push(id); assignSlot(id); }
    if (!on && has) { state.selected = state.selected.filter((x) => x !== id); state.slots.delete(id); }
  }
  function changed() {
    renderLaneList();
    renderPlot();
    renderGel();
    renderLaneTable();
    if (state.bands) renderBandRows();
    writeHash();
  }

  // ------------------------------------------------------------------ the band in focus

  // a row of the band table, or a band picked on a gel that the table doesn't have
  function curBand() {
    if (state.activeBand !== null && state.bands) return state.bands.bands[state.activeBand];
    return state.picked;
  }
  // is the band there in this lane? a called peak inside the band's window, or almost nothing there
  function presence(lane, b) {
    const k = state.data.kda;
    let h = -1, any = false;
    for (let i = 0; i < k.length; i++) {
      if (k[i] >= b.lo && k[i] <= b.hi && lane.y[i] !== null) { any = true; if (lane.y[i] > h) h = lane.y[i]; }
    }
    if (!any) return { state: "na", h: null };
    const peak = lane.peaks.some((p) => p.kda >= b.lo && p.kda <= b.hi);
    if (peak && h >= 0.02) return { state: "seen", h };
    if (h < 0.015) return { state: "absent", h };
    return { state: "unclear", h };
  }
  const GLYPH = { seen: "✓", absent: "✗", unclear: "?", na: "–" };
  const PRES_LABEL = { seen: "band seen", absent: "band not seen", unclear: "unclear (weak, or on the side of a bigger band)", na: "outside this gel's range" };

  function setBand(idx, picked = null) {
    state.activeBand = idx;
    state.picked = idx === null ? picked : null;
    if (!state.picked) state.openEvidence.delete("picked");
    renderPlot();
    renderGel();
    if (state.bands) renderBandRows();
    writeHash();
  }

  function kdaForRow(g, lane, row) {
    const rLad = lane ? lane.map[0] * row + lane.map[1] : row;
    const { rows, logkda } = g.cal;
    for (let i = 1; i < rows.length; i++) {
      if (rLad >= rows[i - 1] && rLad <= rows[i]) {
        const f = (rLad - rows[i - 1]) / (rows[i] - rows[i - 1] || 1);
        return 10 ** (logkda[i - 1] + f * (logkda[i] - logkda[i - 1]));
      }
    }
    return null;
  }

  // a click at some size: the table's band there, else the nearest peak in that lane, else just that size
  function pickBandAt(kda, lane) {
    if (!kda) return;
    const B = state.bands ? state.bands.bands : [];
    const inTable = (k) => B.findIndex((b) => k >= b.lo && k <= b.hi);
    let i = inTable(kda);
    if (i >= 0) { setBand(i); return; }
    let k = kda;
    if (lane) {
      const near = lane.peaks.filter((p) => Math.abs(Math.log10(p.kda / kda)) < 0.035)
        .sort((a, b) => Math.abs(Math.log10(a.kda / kda)) - Math.abs(Math.log10(b.kda / kda)))[0];
      if (near) k = near.kda;
    }
    i = inTable(k);
    if (i >= 0) { setBand(i); return; }
    const r = k < 100 ? Math.round(k * 10) / 10 : Math.round(k);
    setBand(null, { kda: r, lo: k / 1.045, hi: k * 1.045 });
  }

  // the lanes that show a band's evidence: those its claims name, or for a picked band,
  // the clearest lanes with it and lanes on the same gels without it
  function evidenceLanes(b) {
    const named = (b.evidence || []).filter((e) => e.lanes).flatMap((e) => [...e.lanes.with, ...e.lanes.without]);
    if (named.length) return [...new Set(named)];
    const all = state.data.lanes.map((l) => ({ l, p: presence(l, b) }));
    const seen = all.filter((x) => x.p.state === "seen").sort((a, c) => c.p.h - a.p.h).slice(0, 6).map((x) => x.l);
    const gels = new Set(seen.map((l) => l.gel));
    const absent = all.filter((x) => x.p.state === "absent").sort((a, c) => gels.has(c.l.gel) - gels.has(a.l.gel)).slice(0, 4).map((x) => x.l);
    return [...seen, ...absent].map((l) => l.id);
  }

  function showEvidence(key) {
    if (state.openEvidence.has(key)) { state.openEvidence.delete(key); renderBandRows(); return; }
    const b = key === "picked" ? state.picked : state.bands.bands[key];
    state.openEvidence.clear(); // one band's evidence at a time
    state.openEvidence.add(key);
    if (key !== "picked") { state.activeBand = key; state.picked = null; }
    selectOnly(evidenceLanes(b));
    state.gelMode = "sbs";
    changed();
  }
  function selectOnly(ids) {
    state.selected.slice().forEach((id) => toggle(id, false));
    ids.forEach((id) => toggle(id, true));
  }

  // ------------------------------------------------------------------ lane list

  function renderLaneList() {
    const box = $("#lane-groups");
    box.replaceChildren();
    for (const g of state.data.gels) {
      const lanes = state.data.lanes.filter((l) => l.gel === g.id);
      const shown = lanes.filter((l) => state.geno === "all" || l.meta.genotype === state.geno);
      const head = el("div", { class: "group-head" },
        el("span", {}, el("b", {}, g.name), " ", el("span", { class: "when" }, g.when)),
        el("span", {},
          el("button", { title: "Show this gel", onclick: () => { state.gel = g.id; state.gelMode = "whole"; renderGel(); writeHash(); $("#gel-view").scrollIntoView({ behavior: "smooth", block: "nearest" }); } }, "gel"),
          " ",
          el("button", { title: "Select every shown lane of this gel", onclick: () => { shown.forEach((l) => toggle(l.id, true)); changed(); } }, "all"),
          " ",
          el("button", { title: "Remove this gel's lanes", onclick: () => { lanes.forEach((l) => toggle(l.id, false)); changed(); } }, "none")));
      const grp = el("div", { class: "group" }, head);
      for (const l of lanes) {
        const on = state.selected.includes(l.id);
        const st = on ? laneStyle(l) : null;
        const sw = el("span", { class: "sw" });
        if (st) { sw.style.background = "none"; sw.style.borderTop = `3px ${st.dash === "solid" ? "solid" : st.dash === "dot" ? "dotted" : "dashed"} ${st.color}`; }
        const row = el("label", { class: "lane" + (shown.includes(l) ? "" : " hidden"), title: `${g.name}: lane "${l.name}"` },
          el("input", { type: "checkbox", checked: on, onchange: (e) => { toggle(l.id, e.target.checked); changed(); } }),
          sw,
          el("span", {}, l.legend, l.detail ? el("span", { class: "det" }, ` · ${l.detail}`) : null));
        grp.append(row);
      }
      box.append(grp);
    }
  }

  // ------------------------------------------------------------------ plot

  function bandShapes() {
    const out = [];
    const shape = (b, on) => ({
      type: "rect", xref: "x", yref: "paper", x0: b.lo, x1: b.hi, y0: 0, y1: 1, layer: "below",
      fillcolor: on ? cssVar("--zone-hi") : cssVar("--zone"),
      line: on ? { width: 1, color: cssVar("--ladder"), dash: "dot" } : { width: 0 },
    });
    if (state.bands) state.bands.bands.forEach((b, i) => { const on = i === state.activeBand; if (state.showBands || on) out.push(shape(b, on)); });
    if (state.picked) out.push(shape(state.picked, true));
    return out;
  }
  function bandLabels() {
    if (!state.showBands || !state.bands || $("#plot").clientWidth < 600) return [];
    const B = state.bands.bands;
    return B.map((b, i) => ({
      x: Math.log10(Math.sqrt(b.lo * b.hi)), xref: "x", y: 1, yref: "paper", yanchor: "bottom", xanchor: "center",
      // a band close to the one before it is labelled on its own side so the two don't overlap
      xshift: i > 0 && Math.log10(B[i - 1].kda / b.kda) < 0.06 ? 10 : i < B.length - 1 && Math.log10(b.kda / B[i + 1].kda) < 0.06 ? -10 : 0,
      text: `~${b.kda}`, showarrow: false, font: { size: 10, color: cssVar("--muted") },
    }));
  }

  function renderPlot(keepRange = true) {
    const d = state.data;
    const lanes = state.selected.map(laneById).filter(Boolean);
    const traces = lanes.map((l) => {
      const st = laneStyle(l);
      const g = gelById(l.gel);
      return {
        type: "scatter", mode: "lines", x: d.kda, y: l.y, name: l.legend,
        line: { color: st.color, width: 2, dash: st.dash },
        hovertemplate: `%{y:.3f}  <span style="opacity:.7">${g.name}</span><extra>${l.legend}</extra>`,
        connectgaps: false,
      };
    });
    const ink = cssVar("--text-2"), grid = cssVar("--grid");
    const plot = $("#plot");
    const narrow = plot.clientWidth < 600;
    const cur = plot.layout && keepRange ? plot.layout.xaxis.range : null;
    const layout = {
      margin: { l: 56, r: 14, t: 22, b: 46 },
      paper_bgcolor: "rgba(0,0,0,0)", plot_bgcolor: "rgba(0,0,0,0)",
      font: { family: "system-ui, -apple-system, Segoe UI, Roboto, sans-serif", size: 12, color: ink },
      showlegend: false, hovermode: "x unified",
      hoverlabel: { bgcolor: cssVar("--surface"), bordercolor: cssVar("--border"), font: { color: cssVar("--text") } },
      xaxis: {
        type: "log", range: cur || [Math.log10(300), Math.log10(9)],
        tickvals: narrow ? d.ladder_kda : TICKS, ticktext: (narrow ? d.ladder_kda : TICKS).map(String), tickangle: 0,
        title: { text: narrow ? "kDa (from each gel's ladder)" : "apparent mass (kDa, from each gel's ladder)", standoff: 8 },
        gridcolor: grid, zeroline: false, showline: true, linecolor: grid,
        hoverformat: ".1f", showspikes: true, spikemode: "across", spikethickness: 1, spikecolor: ink, spikedash: "dot",
      },
      yaxis: {
        title: { text: "fraction of saturation" }, gridcolor: grid, zeroline: true, zerolinecolor: grid,
        rangemode: "tozero", range: state.ymax === "1" ? [0, 1.03] : undefined, autorange: state.ymax !== "1",
      },
      shapes: bandShapes(), annotations: bandLabels(),
    };
    Plotly.react(plot, traces, layout, { responsive: true, displaylogo: false, modeBarButtonsToRemove: ["select2d", "lasso2d", "autoScale2d"] });
    if (!plot._hooked) {
      plot._hooked = true;
      plot.on("plotly_hover", (ev) => { state.hoverKda = ev.points?.[0]?.x ?? null; drawHoverMarks(); });
      plot.on("plotly_unhover", () => { state.hoverKda = null; drawHoverMarks(); });
      plot.on("plotly_click", (ev) => {
        const pt = ev.points?.[0];
        if (state.pickMode === "band" && pt) pickBandAt(pt.x, laneById(state.selected[pt.curveNumber]));
      });
    }
    renderLegend(lanes);
  }

  function renderLegend(lanes) {
    const box = $("#legend");
    box.replaceChildren();
    if (!lanes.length) { box.append(el("span", { class: "muted" }, "No lanes selected: pick some on the left or click lanes on a gel.")); return; }
    for (const l of lanes) {
      const st = laneStyle(l);
      const i = el("i");
      i.style.borderTopColor = st.color;
      i.style.borderTopStyle = st.dash === "solid" ? "solid" : st.dash === "dot" ? "dotted" : "dashed";
      box.append(el("span", {}, i, `${l.legend}`, el("span", { class: "muted" }, ` · ${gelById(l.gel).name}`)));
    }
  }

  // ------------------------------------------------------------------ gel image

  function rowForKda(gel, lane, kda) {
    const { rows, logkda } = gel.cal;
    const t = Math.log10(kda);
    // logkda falls as rows rise
    for (let i = 1; i < rows.length; i++) {
      const a = logkda[i - 1], b = logkda[i];
      if ((a >= t && t >= b) || (a <= t && t <= b)) {
        const f = (t - a) / (b - a || 1);
        const rLad = rows[i - 1] + f * (rows[i] - rows[i - 1]);
        return lane ? (rLad - lane.map[1]) / lane.map[0] : rLad;
      }
    }
    return null;
  }

  function renderGel() {
    $("#whole-gel").hidden = state.gelMode !== "whole";
    $("#sbs-gel").hidden = state.gelMode !== "sbs";
    document.querySelectorAll("#gel-mode button").forEach((b) => b.classList.toggle("on", b.dataset.mode === state.gelMode));
    if (state.gelMode === "sbs") { renderSbs(); return; }
    const d = state.data;
    if (!state.gel || !gelById(state.gel)) state.gel = d.gels[0].id;
    const tabs = $("#gel-tabs");
    tabs.replaceChildren(...d.gels.map((g) => el("button", {
      role: "tab", class: g.id === state.gel ? "on" : "", "aria-selected": g.id === state.gel ? "true" : "false",
      onclick: () => { state.gel = g.id; state.gelMode = "whole"; renderGel(); writeHash(); },
    }, g.name)));

    const g = gelById(state.gel);
    const view = $("#gel-view");
    let img = view.querySelector("img");
    const src = `data/${state.version}/${g.image}`;
    if (!img || img.dataset.src !== src) {
      view.replaceChildren();
      img = el("img", { src, alt: `${g.name} (${g.when}): streptavidin blot`, "data-src": src });
      view.append(img);
    }
    view.querySelector("svg")?.remove();
    const svg = sv("svg", { viewBox: `0 0 ${g.width} ${g.height}`, preserveAspectRatio: "none" });
    const [r0, r1] = g.rows;
    const lx = g.ladder.x;
    const fs = Math.max(10, g.width / 70);
    for (const b of g.ladder.bands) {
      const tick = sv("line", { x1: lx[0] - 6, x2: lx[1] + 2, y1: b.row, y2: b.row, stroke: cssVar("--ladder"), "stroke-width": Math.max(1.5, g.width / 600) });
      const tt = sv("title");
      tt.textContent = `ladder ${b.kda} kDa`;
      tick.append(tt);
      svg.append(tick);
    }
    const lanes = d.lanes.filter((l) => l.gel === g.id);
    for (const l of lanes) {
      const on = state.selected.includes(l.id);
      const st = on ? laneStyle(l) : null;
      const rect = sv("rect", {
        class: "lanebox", x: l.cols[0], y: r0, width: l.cols[1] - l.cols[0], height: r1 - r0,
        fill: on ? st.color : "#888888", "fill-opacity": on ? 0.18 : 0.06,
        stroke: on ? st.color : "#888888", "stroke-opacity": on ? 1 : 0.35, "stroke-width": Math.max(1.5, g.width / (on ? 300 : 700)),
      });
      const title = sv("title");
      title.textContent = `${l.legend}${l.detail ? " · " + l.detail : ""}\n(lane "${l.name}") – click to ${on ? "remove" : "add"}`;
      rect.append(title);
      rect.addEventListener("click", (e) => { if (state.pickMode !== "lane") return; e.stopPropagation(); toggle(l.id); changed(); });
      svg.append(rect);
    }
    const band = curBand();
    if (band) {
      for (const l of lanes) {
        const y1 = rowForKda(g, l, band.hi), y2 = rowForKda(g, l, band.lo);
        if (y1 === null || y2 === null) continue;
        const pres = presence(l, band);
        const w = l.cols[1] - l.cols[0], pad = w * 0.35;
        svg.append(sv("rect", { x: l.cols[0] - pad, y: y1, width: w + 2 * pad, height: Math.max(2, y2 - y1), fill: cssVar("--zone-hi"), stroke: cssVar("--ladder"), "stroke-width": Math.max(1.2, g.width / 700), "stroke-dasharray": "4 3", "pointer-events": "none" }));
        const t = sv("text", { x: (l.cols[0] + l.cols[1]) / 2, y: y1 - fs * 0.35, "text-anchor": "middle", "font-size": fs * 1.1, "font-weight": 700, fill: pres.state === "seen" ? "#006b47" : pres.state === "absent" ? "#a33c00" : "#444", "paint-order": "stroke", stroke: "#fff", "stroke-width": fs / 3.5, "pointer-events": "none" });
        t.textContent = GLYPH[pres.state];
        svg.append(t);
      }
    }
    svg.style.cursor = state.pickMode === "band" ? "crosshair" : "";
    svg.addEventListener("click", (e) => {
      if (state.pickMode !== "band") return;
      const pt = new DOMPoint(e.clientX, e.clientY).matrixTransform(svg.getScreenCTM().inverse());
      const lane = lanes.find((l) => { const w = l.cols[1] - l.cols[0]; return pt.x >= l.cols[0] - w * 0.35 && pt.x <= l.cols[1] + w * 0.35; });
      pickBandAt(kdaForRow(g, lane || null, pt.y), lane || null);
    });
    svg.append(sv("g", { id: "hover-marks" }));
    if (band) loadImg(src).then((im) => { if (state.gelMode === "whole" && state.gel === g.id) renderCloseup([{ g, im, lanes }], true); });
    else renderCloseup([], true);
    view.append(svg);
    drawHoverMarks();
    renderGelNotes(g);
  }

  function drawHoverMarks() {
    if (state.gelMode === "sbs") { drawSbsMarks(); return; }
    const grp = document.getElementById("hover-marks");
    if (!grp) return;
    grp.replaceChildren();
    const g = gelById(state.gel);
    if (!state.hoverKda || !g) return;
    const lanes = state.selected.map(laneById).filter((l) => l && l.gel === g.id);
    for (const l of lanes) {
      const r = rowForKda(g, l, state.hoverKda);
      if (r === null) continue;
      const pad = (l.cols[1] - l.cols[0]) * 0.4;
      const w = Math.max(2, g.width / 220);
      grp.append(sv("line", { x1: l.cols[0] - pad, x2: l.cols[1] + pad, y1: r, y2: r, stroke: "#fff", "stroke-width": w * 2.2 }));
      grp.append(sv("line", { x1: l.cols[0] - pad, x2: l.cols[1] + pad, y1: r, y2: r, stroke: laneStyle(l).color, "stroke-width": w }));
    }
    const rl = rowForKda(g, null, state.hoverKda);
    if (rl !== null) {
      const t = sv("text", { x: g.ladder.x[1] + 4, y: rl, "dominant-baseline": "middle", "font-size": Math.max(10, g.width / 60), fill: "#111", "paint-order": "stroke", stroke: "#fff", "stroke-width": 3 });
      t.textContent = `${fmtKda(state.hoverKda)} kDa`;
      grp.append(t);
    }
  }

  // ------------------------------------------------------------------ side by side

  const SBS = { kmax: 260, kmin: 9, h: 520, w: 46 };
  const sbsY = (kda) => SBS.h * (Math.log10(SBS.kmax) - Math.log10(kda)) / (Math.log10(SBS.kmax) - Math.log10(SBS.kmin));
  const sbsKda = (y) => 10 ** (Math.log10(SBS.kmax) - (y / SBS.h) * (Math.log10(SBS.kmax) - Math.log10(SBS.kmin)));

  function loadImg(src) {
    if (!state.imgs.has(src)) {
      state.imgs.set(src, new Promise((res, rej) => { const im = new Image(); im.onload = () => res(im); im.onerror = rej; im.src = src; }));
    }
    return state.imgs.get(src);
  }

  // one strip: columns x0..x1 of the gel, every output row taken from the gel row where that kDa sits in this lane
  // view: how tall the strip is and which size each of its rows shows (default: the side-by-side scale)
  function drawStrip(canvas, im, g, lane, x0, x1, view = { h: SBS.h, kda: sbsKda }) {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(SBS.w * dpr);
    canvas.height = Math.round(view.h * dpr);
    canvas.style.width = SBS.w + "px";
    canvas.style.height = view.h + "px";
    const ctx = canvas.getContext("2d");
    ctx.imageSmoothingEnabled = true;
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    const sx = Math.max(0, x0), sw = Math.min(g.width, x1) - sx;
    for (let y = 0; y < canvas.height; y++) {
      const r = rowForKda(g, lane, view.kda((y + 0.5) / dpr));
      if (r === null || r < 0 || r >= g.height - 1) continue;
      ctx.drawImage(im, sx, r, sw, 1, 0, y, canvas.width, 1);
    }
  }

  async function renderSbs() {
    const box = $("#sbs");
    const token = (state.sbsToken = (state.sbsToken || 0) + 1);
    const lanes = state.selected.map(laneById).filter(Boolean);
    if (!lanes.length) { box.replaceChildren(el("div", { class: "sbs-empty" }, "No lanes selected.")); return; }
    // gels in the order their first lane was picked; each gel's ladder, then its lanes
    const order = [];
    for (const l of lanes) if (!order.includes(l.gel)) order.push(l.gel);
    const imgs = await Promise.all(order.map((id) => loadImg(`data/${state.version}/${gelById(id).image}`)));
    if (token !== state.sbsToken) return;

    const axis = sv("svg", { width: 44, height: SBS.h });
    for (const k of state.data.ladder_kda) {
      const y = sbsY(k);
      axis.append(sv("line", { x1: 38, x2: 44, y1: y, y2: y }));
      const t = sv("text", { x: 35, y, "text-anchor": "end", "dominant-baseline": "middle" });
      t.textContent = k;
      axis.append(t);
    }
    const axisCol = el("div", { class: "sbs-axis" });
    axisCol.append(axis);
    const cols = [axisCol];

    order.forEach((gid, gi) => {
      const g = gelById(gid);
      const strips = el("div", { class: "sbs-strips" });
      const band = curBand();
      const mk = (label, cls, colour, dash, draw, tip, lane) => {
        const c = el("canvas", { title: tip });
        c.addEventListener("click", (e) => { if (state.pickMode === "band") pickBandAt(sbsKda(e.offsetY), lane || null); });
        if (state.pickMode === "band") c.style.cursor = "crosshair";
        const sw = el("div", { class: "sbs-swatch" });
        sw.style.borderTopColor = colour;
        sw.style.borderTopStyle = dash;
        let pres = el("div", { class: "sbs-pres" });
        if (band && lane) {
          const p = presence(lane, band);
          pres = el("div", { class: `sbs-pres pres-${p.state}`, title: `${PRES_LABEL[p.state]}${p.h !== null ? ` (height ${p.h.toFixed(2)})` : ""}` }, GLYPH[p.state]);
        }
        strips.append(el("div", { class: "sbs-strip" }, el("div", { class: "sbs-label" }, el("span", { class: cls }, label)), sw, c, pres));
        draw(c);
      };
      mk("Ladder", "ladder", cssVar("--text-2"), "solid",
        (c) => drawStrip(c, imgs[gi], g, null, g.ladder.x[0], g.ladder.x[1]), `${g.name}: ladder`);
      for (const l of lanes.filter((x) => x.gel === gid)) {
        const st = laneStyle(l);
        const half = (l.cols[1] - l.cols[0]) / 0.6 / 2 * 0.9; // the whole lane, not just the averaged middle
        const mid = (l.cols[0] + l.cols[1]) / 2;
        mk(l.legend.replace(/^Prenylation defect/, "Defect"), "", st.color,
          st.dash === "solid" ? "solid" : st.dash === "dot" ? "dotted" : "dashed",
          (c) => drawStrip(c, imgs[gi], g, l, mid - half, mid + half),
          `${l.legend}${l.detail ? " · " + l.detail : ""}\n${g.name}, lane "${l.name}"`, l);
      }
      cols.push(el("div", { class: "sbs-group" }, el("div", { class: "sbs-group-head", title: `${g.name} (${g.when})` }, g.name), strips));
    });
    box.replaceChildren(...cols);
    // line the axis up with the strips
    const top = box.querySelector("canvas").offsetTop;
    axisCol.style.marginTop = top + "px";
    drawSbsMarks();
    renderCloseup(order.map((gid, gi) => ({ g: gelById(gid), im: imgs[gi], lanes: lanes.filter((x) => x.gel === gid) })), false);
  }

  // the picked band again, magnified and with nothing drawn over it, so the region can be inspected by eye
  const CLOSE = { h: 170, pad: 1.35 };
  function renderCloseup(groups, labels) {
    const box = $("#closeup");
    const b = curBand();
    box.hidden = !b || !groups.length;
    if (box.hidden) { box.replaceChildren(); return; }
    const top = Math.log10(b.hi * CLOSE.pad), bot = Math.log10(b.lo / CLOSE.pad);
    const y = (k) => CLOSE.h * (top - Math.log10(k)) / (top - bot);
    const view = { h: CLOSE.h, kda: (py) => 10 ** (top - (py / CLOSE.h) * (top - bot)) };

    const axis = sv("svg", { width: 44, height: CLOSE.h });
    for (const [k, strong] of [[b.hi, false], [b.kda, true], [b.lo, false]]) {
      const yy = y(k);
      axis.append(sv("line", { x1: strong ? 34 : 38, x2: 44, y1: yy, y2: yy }));
      const t = sv("text", { x: 32, y: yy, "text-anchor": "end", "dominant-baseline": "middle", "font-weight": strong ? 700 : 400 });
      t.textContent = fmtKda(k);
      axis.append(t);
    }
    // the band's edges as a bracket on the scale, not over the image
    axis.append(sv("path", { d: `M41 ${y(b.hi)} H43 V${y(b.lo)} H41`, fill: "none", "stroke-width": 1.5 }));
    const axisCol = el("div", { class: "sbs-axis" }, axis);
    const cols = [axisCol];
    for (const { g, im, lanes } of groups) {
      const strips = el("div", { class: "sbs-strips" });
      const mk = (label, tip, draw, lane) => {
        const c = el("canvas", { title: tip });
        const p = lane ? presence(lane, b) : null;
        strips.append(el("div", { class: "sbs-strip" },
          labels ? el("div", { class: "sbs-label short" }, el("span", {}, label)) : null,
          el("div", { class: `sbs-pres ${p ? "pres-" + p.state : ""}`, title: p ? PRES_LABEL[p.state] : "" }, p ? GLYPH[p.state] : ""), c));
        draw(c);
      };
      mk("Ladder", `${g.name}: ladder`, (c) => drawStrip(c, im, g, null, g.ladder.x[0], g.ladder.x[1], view));
      for (const l of lanes) {
        const half = (l.cols[1] - l.cols[0]) / 0.6 / 2 * 0.9, mid = (l.cols[0] + l.cols[1]) / 2;
        mk(l.name, `${l.legend}${l.detail ? " · " + l.detail : ""}\n${g.name}, lane "${l.name}"`, (c) => drawStrip(c, im, g, l, mid - half, mid + half, view), l);
      }
      cols.push(el("div", { class: "sbs-group" }, el("div", { class: "sbs-group-head" }, g.name), strips));
    }
    box.replaceChildren(
      el("p", { class: "muted small" }, `Close-up of ~${fmtKda(b.kda)} kDa (${fmtKda(b.lo)}–${fmtKda(b.hi)}, bracketed on the scale), with nothing drawn over the image. ${labels ? "" : "Columns line up with the strips above. "}Contrast is each image's own.`),
      el("div", { class: "sbs closeup-strips" }, cols));
    axisCol.style.marginTop = box.querySelector("canvas").offsetTop + "px";
  }

  function drawSbsMarks() {
    const box = $("#sbs");
    box.querySelectorAll(".sbs-mark, .sbs-zone").forEach((e) => e.remove());
    const c = box.querySelector("canvas");
    if (!c) return;
    const top = c.offsetTop, width = box.scrollWidth;
    const b = curBand();
    if (b) {
      const z = el("div", { class: "sbs-zone" });
      z.style.top = top + sbsY(b.hi) + "px";
      z.style.height = sbsY(b.lo) - sbsY(b.hi) + "px";
      z.style.width = width - 44 + "px";
      box.append(z);
    }
    if (state.hoverKda) {
      const y = sbsY(state.hoverKda);
      if (y >= 0 && y <= SBS.h) {
        const m = el("div", { class: "sbs-mark" }, el("b", {}, `${fmtKda(state.hoverKda)}`));
        m.style.top = top + y + "px";
        m.style.width = width + "px";
        box.append(m);
      }
    }
  }

  function renderGelNotes(g) {
    const box = $("#gel-notes");
    box.replaceChildren(el("h3", {}, `${g.name} · ${g.when}`), el("p", {}, g.title));
    for (const [k, v] of Object.entries(g.notes)) box.append(el("h3", {}, k), el("p", {}, v));
    if (g.source) box.append(el("h3", {}, "Notebook page"), el("p", { class: "muted" }, g.source));
  }

  // ------------------------------------------------------------------ tables

  // references are numbered in the order they're first used: a claim's footnotes, then its evidence
  function refNumbers() {
    const B = state.bands, num = new Map();
    const add = (id) => { if (!num.has(id)) num.set(id, num.size + 1); };
    for (const b of B.bands) {
      (b.guess_refs || []).forEach(add);
      (b.evidence || []).forEach((e) => (e.refs || []).forEach(add));
    }
    return num;
  }
  const refLinks = (ids) => el("sup", { class: "fn" },
    "[", ids.flatMap((id, j) => [j ? "," : null, el("a", { href: `#ref-${state.refNum.get(id)}`, onclick: (e) => jumpToRef(e, state.refNum.get(id)) }, String(state.refNum.get(id)))]).filter(Boolean), "]");

  // scroll to a reference without touching the address bar, which holds the view's state
  function jumpToRef(e, n) {
    e.preventDefault();
    e.stopPropagation();
    const li = document.getElementById(`ref-${n}`);
    if (!li) return;
    li.scrollIntoView({ behavior: "smooth", block: "center" });
    li.classList.remove("flash");
    void li.offsetWidth;
    li.classList.add("flash");
  }

  function renderBands() {
    const t = $("#bands-table");
    const B = state.bands;
    state.refNum = refNumbers();
    state.openEvidence.clear();
    $("#bands-caption").textContent = B.caption;
    t.replaceChildren(el("thead", {}, el("tr", {}, B.columns.map(([, h]) => el("th", {}, h)), el("th", {}, ""))), el("tbody"));
    renderBandRows();
    const refs = (B.references || []).filter((r) => state.refNum.has(r.id)).sort((a, b) => state.refNum.get(a.id) - state.refNum.get(b.id));
    $("#band-refs-wrap").hidden = !refs.length;
    $("#band-refs").replaceChildren(...refs.map((r) => el("li", { id: `ref-${state.refNum.get(r.id)}`, value: state.refNum.get(r.id) },
      r.cite, " ", el("a", { href: `https://doi.org/${r.doi}`, target: "_blank", rel: "noopener" }, `doi:${r.doi}`))));
  }
  function laneChip(id, pres) {
    const l = laneById(id);
    if (!l) return null;
    const g = gelById(l.gel);
    const on = state.selected.includes(id);
    return el("button", {
      class: `chip${on ? " on" : ""} pres-${pres.state}`,
      title: `${l.legend}${l.detail ? " · " + l.detail : ""}: ${PRES_LABEL[pres.state]}${pres.h !== null ? ` (height ${pres.h.toFixed(2)})` : ""}. Click to ${on ? "remove it from" : "add it to"} the plot.`,
      onclick: (e) => { e.stopPropagation(); toggle(id); changed(); },
    }, el("b", {}, GLYPH[pres.state]), ` ${g.name}: ${l.name}`);
  }

  function evidencePanel(b, ncol) {
    const items = (b.evidence || []).map((e) => {
      const tag = el("span", { class: "ev-tag" }, e.kind === "data" ? "These gels" : e.kind === "lit" ? "Literature" : "Note");
      const body = el("span", {}, e.text, e.refs?.length ? refLinks(e.refs) : null);
      if (e.lanes) {
        const grp = (label, ids) => ids.length ? el("span", { class: "chip-group" }, el("span", { class: "muted" }, label), ids.map((id) => laneChip(id, presence(laneById(id), b)))) : null;
        body.append(el("div", { class: "chips" },
          grp("Band expected:", e.lanes.with), grp("Weaker or absent:", e.lanes.without),
          el("button", { class: "ev-show", onclick: (ev) => { ev.stopPropagation(); selectOnly([...e.lanes.with, ...e.lanes.without]); state.gelMode = "sbs"; changed(); } }, "Show only these")));
      }
      return el("li", { class: `ev ev-${e.kind}` }, tag, body);
    });
    // every lane, measured: where the band is and isn't
    const all = state.data.lanes.map((l) => ({ l, p: presence(l, b) }));
    // a plain-language reading of the band first; a band picked on a gel has only its counts
    const n = (st) => all.filter((x) => x.p.state === st).length;
    const summary = b.summary || `Not interpreted yet: this band isn't in the table. It is measured as seen in ${n("seen")} of ${all.length} lanes and absent from ${n("absent")}, with ${n("unclear")} unclear.`;
    items.unshift(el("li", { class: "ev ev-summary" }, el("span", { class: "ev-tag" }, "Summary"), el("span", {}, summary)));
    const by = (st) => all.filter((x) => x.p.state === st).sort((a, c) => (c.p.h ?? 0) - (a.p.h ?? 0));
    const groups = [["seen", "Seen in"], ["absent", "Not seen in"], ["unclear", "Unclear in"]].map(([st, label]) => {
      const xs = by(st);
      return xs.length ? el("div", { class: "chips" }, el("span", { class: "muted" }, `${label} ${xs.length}:`), xs.map((x) => laneChip(x.l.id, x.p))) : null;
    });
    items.push(el("li", { class: "ev ev-all" }, el("span", { class: "ev-tag" }, "Every lane"),
      el("span", {}, `Measured in all ${all.length} lanes: ✓ a peak between ${fmtKda(b.lo)} and ${fmtKda(b.hi)} kDa; ✗ next to nothing there; ? weak, or on the side of a bigger band. Click a lane to add or remove it.`, groups)));
    return el("tr", { class: "ev-row" }, el("td", { colspan: ncol }, el("ul", { class: "ev-list" }, items)));
  }

  function renderBandRows() {
    const B = state.bands;
    const tb = $("#bands-table tbody");
    if (!tb) return;
    const ncol = B.columns.length + 1;
    const rows = [];
    const evBtn = (key) => {
      const open = state.openEvidence.has(key);
      return el("button", {
        class: "ev-btn", "aria-expanded": open ? "true" : "false",
        title: open ? "" : "Put the lanes behind this band on the plot and the gel strips, and list where it's seen",
        onclick: (e) => { e.stopPropagation(); showEvidence(key); },
      }, open ? "Hide evidence" : "Show evidence");
    };
    if (state.picked) {
      const b = state.picked;
      rows.push(el("tr", { class: "on picked" },
        B.columns.map(([k]) => el("td", {}, k === "kda" ? el("b", {}, `~${fmtKda(b.kda)}`) : k === "kind" ? el("span", { class: "kind" }, "picked on a gel") : k === "guess" ? "Not in the table: no claim yet" : "—")),
        el("td", {}, evBtn("picked"), " ", el("button", { class: "ev-btn", onclick: (e) => { e.stopPropagation(); setBand(null); } }, "Clear"))));
      if (state.openEvidence.has("picked")) rows.push(evidencePanel(b, ncol));
    }
    B.bands.forEach((b, i) => {
      const cells = B.columns.map(([k]) => el("td", {},
        k === "kda" ? el("b", {}, `~${b.kda}`)
          : k === "kind" ? el("span", { class: "kind" }, KIND_LABEL[b.kind] || b.kind)
          : k === "guess" ? [b.guess, b.guess_refs?.length ? refLinks(b.guess_refs) : null]
          : b[k]));
      rows.push(el("tr", { class: i === state.activeBand ? "on" : "", onclick: () => highlightBand(i) }, cells, el("td", {}, evBtn(i))));
      if (state.openEvidence.has(i)) rows.push(evidencePanel(b, ncol));
    });
    tb.replaceChildren(...rows);
  }
  // highlight a band everywhere without zooming: the whole profile stays in view
  function highlightBand(i) {
    setBand(state.activeBand === i ? null : i);
  }

  function renderLaneTable() {
    const t = $("#lanes-table");
    const lanes = state.selected.map(laneById).filter(Boolean);
    $("#lane-count").textContent = `(${lanes.length} selected)`;
    const fields = ["genotype", "allele", "mice", "blood", "rbc_lysis", "inhibitor", "dilution", "prep", "reaction", "ug", "ug_note"];
    const heads = ["Legend", "Experiment", "Lane on gel", ...fields.map((f) => f.replace("_", " "))];
    t.replaceChildren(
      el("thead", {}, el("tr", {}, heads.map((h) => el("th", {}, h)))),
      el("tbody", {}, lanes.map((l) => {
        const g = gelById(l.gel);
        const st = laneStyle(l);
        const sw = el("i", { style: `display:inline-block;width:14px;margin-right:6px;vertical-align:middle;border-top:3px ${st.dash === "solid" ? "solid" : st.dash === "dot" ? "dotted" : "dashed"} ${st.color}` });
        return el("tr", {}, el("td", {}, sw, l.legend), el("td", {}, `${g.name} (${g.when})`), el("td", {}, l.name),
          fields.map((f) => el("td", {}, l.meta[f] === null || l.meta[f] === undefined ? "" : String(l.meta[f]))));
      })));
  }

  // ------------------------------------------------------------------ load

  async function loadVersion(v, keepSelection) {
    const base = `data/${v}/`;
    const [data, bands] = await Promise.all([
      fetch(base + "data.json", { cache: "no-cache" }).then((r) => r.json()),
      fetch(base + "bands.json", { cache: "no-cache" }).then((r) => (r.ok ? r.json() : null)),
    ]);
    state.version = v;
    state.data = data;
    state.bands = bands;
    const ids = new Set(data.lanes.map((l) => l.id));
    const keep = (keepSelection || []).filter((id) => ids.has(id));
    state.selected = [];
    state.slots.clear();
    const start = keep.length ? keep : ["G2:HET full", "G2:MUT full", "G2:HET no B-GPP", "G2:MUT no B-GPP"].filter((id) => ids.has(id));
    start.forEach((id) => toggle(id, true));
    const meta = state.versions.find((x) => x.id === v);
    $("#version-note").textContent = meta ? `${meta.date}${meta.note ? " · " + meta.note : ""}` : "";
    const newest = latestVersion();
    const older = $("#older-version");
    older.hidden = v === newest;
    if (v !== newest) older.replaceChildren(`You're looking at ${v}, an older version. `,
      el("button", { onclick: () => { $("#version").value = newest; loadVersion(newest, state.selected.slice()); } }, `Switch to ${newest}`));
    if (bands) renderBands();
    state.activeBand = null;
    state.picked = null;
    const bk = parseFloat(state.startBand);
    if (bk) {
      const i = bands ? bands.bands.findIndex((b) => b.kda === bk) : -1;
      if (i >= 0) state.activeBand = i;
      else state.picked = { kda: bk, lo: bk / 1.045, hi: bk * 1.045 };
    }
    state.startBand = null;
    changed();
  }

  async function init() {
    state.versions = await fetch("versions.json", { cache: "no-cache" }).then((r) => r.json());
    const h = readHash();
    const sel = $("#version");
    sel.replaceChildren(...state.versions.slice().reverse().map((v) => el("option", { value: v.id }, v.id)));
    const v = h.v && state.versions.some((x) => x.id === h.v) ? h.v : state.versions[state.versions.length - 1].id;
    sel.value = v;
    if (h.c === "lane" || h.c === "defect") state.colourBy = h.c;
    if (h.y === "1") state.ymax = "1";
    if (h.g) state.gel = h.g;
    if (h.gv === "sbs") state.gelMode = "sbs";
    if (h.pm === "lane") state.pickMode = "lane";
    state.startBand = h.b;
    const pickBtns = document.querySelectorAll("#pick-mode button");
    pickBtns.forEach((b) => {
      b.classList.toggle("on", b.dataset.pick === state.pickMode);
      b.addEventListener("click", () => {
        state.pickMode = b.dataset.pick;
        pickBtns.forEach((x) => x.classList.toggle("on", x === b));
        renderGel();
        writeHash();
      });
    });
    document.querySelectorAll("#gel-mode button").forEach((b) => b.addEventListener("click", () => {
      state.gelMode = b.dataset.mode;
      renderGel();
      writeHash();
    }));
    $("#colour-by").value = state.colourBy;
    $("#ymax").value = state.ymax;

    sel.addEventListener("change", () => loadVersion(sel.value, state.selected.slice()));
    $("#colour-by").addEventListener("change", (e) => { state.colourBy = e.target.value; changed(); });
    $("#ymax").addEventListener("change", (e) => { state.ymax = e.target.value; renderPlot(); writeHash(); });
    $("#show-bands").addEventListener("change", (e) => { state.showBands = e.target.checked; renderPlot(); });
    $("#reset-zoom").addEventListener("click", () => renderPlot(false));
    $("#sel-none").addEventListener("click", () => { state.selected.slice().forEach((id) => toggle(id, false)); changed(); });
    $("#sel-shown").addEventListener("click", () => {
      state.data.lanes.filter((l) => state.geno === "all" || l.meta.genotype === state.geno).forEach((l) => toggle(l.id, true));
      changed();
    });
    document.querySelectorAll(".seg button[data-geno]").forEach((b) => b.addEventListener("click", () => {
      state.geno = b.dataset.geno;
      document.querySelectorAll(".seg button[data-geno]").forEach((x) => x.classList.toggle("on", x === b));
      renderLaneList();
    }));
    matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => { if (state.data) changed(); });

    await loadVersion(v, h.l);
  }

  init().catch((e) => {
    document.querySelector(".main").prepend(el("div", { class: "card" }, `Couldn't load the data: ${e.message}. If you opened index.html from disk, serve the folder instead (python3 -m http.server).`));
    console.error(e);
  });
})();
