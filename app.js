(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const NS = "http://www.w3.org/2000/svg";
  const statusEl = $("status");

  const COLORS = {
    draft: "#42a5f5",
    waiting: "#ff9800",
    applied: "#66bb6a",
    selected: "#ffeb3b",
    handle: "#ffffff",
    handleStroke: "#111111",
    control: "#ce93d8",
  };

  const state = {
    img: null,
    imgCanvas: null,
    imgCtx: null,
    imgData: null,
    svgText: null,
    viewBox: null,
    resultSvg: null,
    nextNum: 1,
    drawMode: "reta", // reta | curva | livre
    // gradient: { id, n, kind, pts:[{x,y}...], stops, applications:[{shapeKey,x1,y1,x2,y2}] }
    gradients: [],
    activeGradId: null,
    selectedApp: null,
    drafting: null, // { kind, pts }
    drag: null,
    selectedPoint: null, // { gradId, index }
    hoverGradId: null,
    shapeIndex: [],
    vecRaster: null,
    imgView: { zoom: 1, panX: 0, panY: 0, space: false },
    vecView: { zoom: 1, panX: 0, panY: 0, space: false },
    history: [],
    future: [],
    maxHistory: 80,
    applyingHistory: false,
  };

  function setStatus(msg, kind) {
    statusEl.textContent = msg;
    statusEl.className = "status" + (kind ? " " + kind : "");
  }

  function cloneStateSnap() {
    return JSON.stringify({
      nextNum: state.nextNum,
      gradients: state.gradients,
      activeGradId: state.activeGradId,
      selectedApp: state.selectedApp,
    });
  }

  function loadStateSnap(json) {
    const s = JSON.parse(json);
    state.nextNum = s.nextNum;
    state.gradients = s.gradients;
    state.activeGradId = s.activeGradId;
    state.selectedApp = s.selectedApp;
  }

  function pushHistory() {
    if (state.applyingHistory) return;
    state.history.push(cloneStateSnap());
    if (state.history.length > state.maxHistory) state.history.shift();
    state.future = [];
    updateUndoButtons();
  }

  function undo() {
    if (!state.history.length) return;
    state.applyingHistory = true;
    state.future.push(cloneStateSnap());
    loadStateSnap(state.history.pop());
    state.applyingHistory = false;
    afterHistoryChange();
  }

  function redo() {
    if (!state.future.length) return;
    state.applyingHistory = true;
    state.history.push(cloneStateSnap());
    loadStateSnap(state.future.pop());
    state.applyingHistory = false;
    afterHistoryChange();
  }

  function afterHistoryChange() {
    updateUndoButtons();
    refreshList();
    updatePrompt();
    rebuildSvg();
    paintVecBase();
    paintImgOverlay();
    paintVecOverlay();
  }

  function updateUndoButtons() {
    $("btnUndo").disabled = !state.history.length;
    $("btnRedo").disabled = !state.future.length;
  }

  function parseViewBox(svg) {
    const vb = svg.getAttribute("viewBox");
    if (vb) {
      const p = vb.trim().split(/[\s,]+/).map(Number);
      return { x: p[0], y: p[1], w: p[2], h: p[3] };
    }
    return { x: 0, y: 0, w: parseFloat(svg.getAttribute("width")) || 1000, h: parseFloat(svg.getAttribute("height")) || 1000 };
  }

  function parseStyleFills(svg) {
    const map = {};
    svg.querySelectorAll("style").forEach((st) => {
      const text = st.textContent || "";
      const re = /\.([A-Za-z_][\w-]*)\s*\{([^}]*)\}/g;
      let m;
      while ((m = re.exec(text))) {
        const fillM = /fill\s*:\s*([^;}\s]+)/i.exec(m[2]);
        if (fillM) map[m[1]] = fillM[1].trim();
      }
    });
    return map;
  }

  function resolveFill(el, classFills) {
    const attr = el.getAttribute("fill");
    if (attr && attr !== "none") return attr;
    const style = el.getAttribute("style") || "";
    const sm = /fill\s*:\s*([^;]+)/i.exec(style);
    if (sm && sm[1].trim() !== "none") return sm[1].trim();
    for (const c of (el.getAttribute("class") || "").split(/\s+/)) {
      if (classFills[c] && classFills[c] !== "none") return classFills[c];
    }
    return null;
  }

  function isFilledShape(el, classFills) {
    const tag = el.tagName.toLowerCase();
    if (!["path", "rect", "polygon", "polyline", "circle", "ellipse"].includes(tag)) return false;
    const fill = resolveFill(el, classFills);
    return !!(fill && fill !== "none");
  }

  function collectFilledShapes(svg) {
    const classFills = parseStyleFills(svg);
    const out = [];
    const walk = (n) => {
      if (n.nodeType !== 1) return;
      if (isFilledShape(n, classFills)) out.push(n);
      for (const c of n.children) walk(c);
    };
    walk(svg);
    return { shapes: out, classFills };
  }

  function ensureImgData() {
    if (!state.imgData && state.imgCtx) {
      state.imgData = state.imgCtx.getImageData(0, 0, state.imgCanvas.width, state.imgCanvas.height).data;
    }
  }

  function isBg(r, g, b, a) {
    if (a < 20) return true;
    if (r >= 240 && g >= 240 && b >= 240) return true;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    return max > 232 && max - min < 10;
  }

  function sampleRaw(ix, iy) {
    const c = state.imgCanvas;
    const x = Math.round(ix), y = Math.round(iy);
    if (x < 0 || y < 0 || x >= c.width || y >= c.height) return null;
    const i = (y * c.width + x) * 4;
    const d = state.imgData;
    return [d[i], d[i + 1], d[i + 2], d[i + 3]];
  }

  function sampleContent(ix, iy, radius = 2) {
    for (let r = 0; r <= radius; r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (r > 0 && Math.abs(dx) !== r && Math.abs(dy) !== r) continue;
          const raw = sampleRaw(ix + dx, iy + dy);
          if (!raw || isBg(raw[0], raw[1], raw[2], raw[3])) continue;
          return [raw[0], raw[1], raw[2]];
        }
      }
    }
    const raw = sampleRaw(ix, iy);
    if (raw && raw[3] >= 20) {
      const max = Math.max(raw[0], raw[1], raw[2]), min = Math.min(raw[0], raw[1], raw[2]);
      if (max - min >= 6 || raw[1] > 180) return [raw[0], raw[1], raw[2]];
    }
    return null;
  }

  function rgbHex(c) {
    const h = (n) => Math.max(0, Math.min(255, n | 0)).toString(16).padStart(2, "0");
    return `#${h(c[0])}${h(c[1])}${h(c[2])}`;
  }
  function avg(colors) {
    if (!colors.length) return null;
    let r = 0, g = 0, b = 0;
    for (const c of colors) { r += c[0]; g += c[1]; b += c[2]; }
    const n = colors.length;
    return [Math.round(r / n), Math.round(g / n), Math.round(b / n)];
  }
  function median(colors) {
    if (!colors.length) return null;
    if (colors.length < 3) return avg(colors);
    const ch = (k) => {
      const a = colors.map((c) => c[k]).sort((x, y) => x - y);
      return a[Math.floor(a.length / 2)];
    };
    return [ch(0), ch(1), ch(2)];
  }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function lerpPt(a, b, t) { return { x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t) }; }

  // ---- path geometry ----
  function quadPoint(p0, c, p1, t) {
    const u = 1 - t;
    return {
      x: u * u * p0.x + 2 * u * t * c.x + t * t * p1.x,
      y: u * u * p0.y + 2 * u * t * c.y + t * t * p1.y,
    };
  }

  function densifyQuad(p0, c, p1, stepPx, out, skipFirst) {
    let len = 0, prev = p0;
    for (let i = 1; i <= 40; i++) {
      const p = quadPoint(p0, c, p1, i / 40);
      len += Math.hypot(p.x - prev.x, p.y - prev.y);
      prev = p;
    }
    const n = Math.max(8, Math.ceil(len / stepPx));
    for (let i = skipFirst ? 1 : 0; i <= n; i++) out.push(quadPoint(p0, c, p1, i / n));
  }

  function densifyPath(kind, pts, stepPx = 2) {
    if (!pts || pts.length < 2) return [];
    const out = [];
    if (kind === "reta" || (kind === "livre" && pts.length === 2)) {
      const [a, b] = [pts[0], pts[pts.length - 1]];
      const dist = Math.hypot(b.x - a.x, b.y - a.y) || 1;
      const n = Math.max(2, Math.ceil(dist / stepPx));
      for (let i = 0; i <= n; i++) out.push(lerpPt(a, b, i / n));
      return out;
    }
    if (kind === "curva" && pts.length >= 3) {
      // Chain of quadratics: [p0, c0, p1, c1, p2, ...] (odd length).
      // A single 3-point curve is unchanged (one quadratic, lilac mid-control).
      for (let i = 0; i <= pts.length - 3; i += 2) {
        densifyQuad(pts[i], pts[i + 1], pts[i + 2], stepPx, out, i > 0);
      }
      if (pts.length % 2 === 0) {
        const a = out.length ? out[out.length - 1] : pts[pts.length - 2];
        const b = pts[pts.length - 1];
        const dist = Math.hypot(b.x - a.x, b.y - a.y) || 1;
        const n = Math.max(1, Math.ceil(dist / stepPx));
        for (let k = 1; k <= n; k++) out.push(lerpPt(a, b, k / n));
      }
      return out;
    }
    // livre: polyline
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i], b = pts[i + 1];
      const dist = Math.hypot(b.x - a.x, b.y - a.y) || 1;
      const n = Math.max(1, Math.ceil(dist / stepPx));
      for (let k = 0; k < n; k++) out.push(lerpPt(a, b, k / n));
    }
    out.push(pts[pts.length - 1]);
    return out;
  }

  function projectOnQuad(p0, c, p1, pt) {
    let best = { t: 0, dist: Infinity, point: p0 };
    const n = 80;
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      const p = quadPoint(p0, c, p1, t);
      const d = Math.hypot(p.x - pt.x, p.y - pt.y);
      if (d < best.dist) best = { t, dist: d, point: p };
    }
    return best;
  }

  function projectOnCurve(pts, pt) {
    if (!pts || pts.length < 3) return null;
    let best = null;
    for (let i = 0; i <= pts.length - 3; i += 2) {
      const r = projectOnQuad(pts[i], pts[i + 1], pts[i + 2], pt);
      if (!best || r.dist < best.dist) best = { ...r, seg: i };
    }
    return best;
  }

  function insertCurvePointAt(g, pt, minDist) {
    if (!g || g.kind !== "curva" || g.pts.length < 3) return null;
    const proj = projectOnCurve(g.pts, pt);
    if (!proj || (minDist != null && proj.dist > minDist)) return null;
    if (proj.t < 0.04 || proj.t > 0.96) return null;
    const i = proj.seg;
    const p0 = g.pts[i], c = g.pts[i + 1], p1 = g.pts[i + 2];
    const A = lerpPt(p0, c, proj.t);
    const B = lerpPt(c, p1, proj.t);
    const M = lerpPt(A, B, proj.t);
    g.pts.splice(i + 1, 1, A, M, B);
    return { index: i + 2, point: M };
  }

  function deleteCurvePointAt(g, index) {
    if (!g || g.kind !== "curva") return false;
    const pts = g.pts;
    const n = pts.length;
    if (index < 0 || index >= n) return false;
    if (n <= 2) return false;
    if (n === 3) {
      // Only the mid control can go: the curve becomes the original chord.
      if (index !== 1) return false;
      g.pts = [pts[0], pts[2]];
      return true;
    }
    if (index % 2 === 1) {
      // Control: flatten this segment (handle moves onto the chord).
      pts[index] = lerpPt(pts[index - 1], pts[index + 1], 0.5);
      return true;
    }
    if (index === 0) {
      g.pts.splice(0, 2);
      return true;
    }
    if (index === n - 1) {
      g.pts.splice(n - 2, 2);
      return true;
    }
    // Interior on-curve join: merge the two adjacent quadratics.
    const newC = lerpPt(pts[index - 1], pts[index + 1], 0.5);
    g.pts.splice(index - 1, 3, newC);
    return true;
  }

  function pathEnds(kind, pts) {
    if (!pts || !pts.length) return { a: { x: 0, y: 0 }, b: { x: 0, y: 0 } };
    return { a: pts[0], b: pts[pts.length - 1] };
  }

  function sampleAlongPath(kind, pts, numStops) {
    ensureImgData();
    const dense = densifyPath(kind, pts, 1.5);
    if (dense.length < 2) return [];
    // arc-length parameterization
    const seg = [0];
    for (let i = 1; i < dense.length; i++) {
      seg.push(seg[i - 1] + Math.hypot(dense[i].x - dense[i - 1].x, dense[i].y - dense[i - 1].y));
    }
    const total = seg[seg.length - 1] || 1;
    const bins = Array.from({ length: numStops }, () => []);
    for (let i = 0; i < dense.length; i++) {
      const t = seg[i] / total;
      const bi = Math.max(0, Math.min(numStops - 1, Math.round(t * (numStops - 1))));
      const col = sampleContent(dense[i].x, dense[i].y, 2);
      if (col) bins[bi].push(col);
    }
    const stops = [];
    let last = [2, 140, 60];
    for (let i = 0; i < numStops; i++) {
      let col = median(bins[i]) || avg(bins[i]);
      if (!col) col = last; else last = col;
      stops.push({ offset: numStops === 1 ? 0.5 : i / (numStops - 1), rgb: col, color: rgbHex(col) });
    }
    return stops;
  }

  function swatchCss(stops) {
    if (!stops || !stops.length) return "#444";
    return "linear-gradient(90deg," + stops.map((s) => `${s.color} ${(s.offset * 100).toFixed(1)}%`).join(",") + ")";
  }

  function makeLG(doc, id, x1, y1, x2, y2, stops) {
    const lg = doc.createElementNS(NS, "linearGradient");
    lg.setAttribute("id", id);
    lg.setAttribute("gradientUnits", "userSpaceOnUse");
    lg.setAttribute("x1", Number(x1).toFixed(3));
    lg.setAttribute("y1", Number(y1).toFixed(3));
    lg.setAttribute("x2", Number(x2).toFixed(3));
    lg.setAttribute("y2", Number(y2).toFixed(3));
    for (const s of stops) {
      const st = doc.createElementNS(NS, "stop");
      st.setAttribute("offset", (s.offset * 100).toFixed(2) + "%");
      st.setAttribute("stop-color", s.color);
      lg.appendChild(st);
    }
    return lg;
  }

  function ensureDefs(svg) {
    let defs = svg.querySelector(":scope > defs");
    if (!defs) {
      defs = svg.ownerDocument.createElementNS(NS, "defs");
      svg.insertBefore(defs, svg.firstChild);
    }
    return defs;
  }

  function stripStylesAndClasses(svg) {
    svg.querySelectorAll("style").forEach((s) => s.remove());
    const walk = (el) => {
      if (el.nodeType !== 1) return;
      el.removeAttribute("class");
      let style = el.getAttribute("style") || "";
      style = style.replace(/fill\s*:[^;]+;?/gi, "").trim();
      if (style) el.setAttribute("style", style); else el.removeAttribute("style");
      for (const c of [...el.children]) walk(c);
    };
    walk(svg);
  }

  function buildPath2D(el) {
    const tag = el.tagName.toLowerCase();
    try {
      if (tag === "path") return new Path2D(el.getAttribute("d"));
      if (tag === "rect") {
        const p = new Path2D();
        p.rect(+el.getAttribute("x") || 0, +el.getAttribute("y") || 0, +el.getAttribute("width") || 0, +el.getAttribute("height") || 0);
        return p;
      }
      if (tag === "polygon" || tag === "polyline") {
        const pts = (el.getAttribute("points") || "").trim().split(/[\s,]+/).map(Number);
        const p = new Path2D();
        if (pts.length >= 6) {
          p.moveTo(pts[0], pts[1]);
          for (let i = 2; i < pts.length; i += 2) p.lineTo(pts[i], pts[i + 1]);
          p.closePath();
        }
        return p;
      }
      if (tag === "circle") {
        const p = new Path2D();
        p.arc(+el.getAttribute("cx") || 0, +el.getAttribute("cy") || 0, +el.getAttribute("r") || 0, 0, Math.PI * 2);
        return p;
      }
      if (tag === "ellipse") {
        const p = new Path2D();
        p.ellipse(+el.getAttribute("cx") || 0, +el.getAttribute("cy") || 0, +el.getAttribute("rx") || 0, +el.getAttribute("ry") || 0, 0, 0, Math.PI * 2);
        return p;
      }
    } catch (_) {}
    return null;
  }

  function buildShapeIndex(svg) {
    const { shapes, classFills } = collectFilledShapes(svg);
    const index = [];
    shapes.forEach((el, i) => {
      const key = "s" + i;
      el.setAttribute("data-gid", key);
      let bb;
      try { bb = el.getBBox(); } catch (_) { bb = { x: 0, y: 0, width: 0, height: 0 }; }
      const origFill = resolveFill(el, classFills) || "#016108";
      index.push({
        key, el, tag: el.tagName.toLowerCase(), bb,
        path2d: buildPath2D(el),
        origFill: String(origFill).startsWith("url(") ? "#888888" : origFill,
      });
    });
    state.shapeIndex = index;
    return index;
  }

  function hitShape(svgX, svgY) {
    const ctx = document.createElement("canvas").getContext("2d");
    for (let i = state.shapeIndex.length - 1; i >= 0; i--) {
      const s = state.shapeIndex[i];
      if (s.path2d && ctx.isPointInPath(s.path2d, svgX, svgY)) return s;
    }
    for (let i = state.shapeIndex.length - 1; i >= 0; i--) {
      const s = state.shapeIndex[i], b = s.bb;
      if (svgX >= b.x && svgY >= b.y && svgX <= b.x + b.width && svgY <= b.y + b.height) return s;
    }
    return null;
  }

  function fountainAcrossShape(shape, kind, pts) {
    const { a, b } = pathEnds(kind, pts);
    const ang = Math.atan2(b.y - a.y, b.x - a.x);
    const ux = Math.cos(ang), uy = Math.sin(ang);
    const bb = shape.bb;
    const cx = bb.x + bb.width / 2;
    const cy = bb.y + bb.height / 2;
    const corners = [
      [bb.x, bb.y], [bb.x + bb.width, bb.y],
      [bb.x, bb.y + bb.height], [bb.x + bb.width, bb.y + bb.height],
    ];
    let minP = Infinity, maxP = -Infinity;
    for (const [x, y] of corners) {
      const p = (x - cx) * ux + (y - cy) * uy;
      if (p < minP) minP = p;
      if (p > maxP) maxP = p;
    }
    return { x1: cx + ux * minP, y1: cy + uy * minP, x2: cx + ux * maxP, y2: cy + uy * maxP };
  }

  function findApp(gradId, shapeKey) {
    const g = state.gradients.find((x) => x.id === gradId);
    if (!g) return null;
    return g.applications.find((a) => a.shapeKey === shapeKey) || null;
  }

  function findAppByShape(shapeKey) {
    for (const g of state.gradients) {
      const a = g.applications.find((x) => x.shapeKey === shapeKey);
      if (a) return { grad: g, app: a };
    }
    return null;
  }

  function rebuildSvg() {
    if (!state.svgText) return null;
    const doc = new DOMParser().parseFromString(state.svgText, "image/svg+xml");
    const svg = doc.documentElement;
    const host = document.createElement("div");
    host.style.cssText = "position:fixed;left:-12000px;top:0;width:700px;height:700px;opacity:0;pointer-events:none";
    host.appendChild(svg);
    document.body.appendChild(host);

    buildShapeIndex(svg);
    const defs = ensureDefs(svg);
    defs.querySelectorAll('[id^="ifg_"]').forEach((n) => n.remove());
    stripStylesAndClasses(svg);

    for (const s of state.shapeIndex) {
      s.el.setAttribute("fill", s.origFill === "none" ? "#016108" : s.origFill);
    }

    for (const g of state.gradients) {
      for (const app of g.applications) {
        const shape = state.shapeIndex.find((s) => s.key === app.shapeKey);
        if (!shape) continue;
        const gid = `ifg_${g.n}_${app.shapeKey}`;
        const old = defs.querySelector("#" + gid);
        if (old) old.remove();
        defs.appendChild(makeLG(doc, gid, app.x1, app.y1, app.x2, app.y2, g.stops));
        shape.el.setAttribute("fill", `url(#${gid})`);
      }
    }

    svg.querySelectorAll("image, pattern").forEach((n) => n.remove());
    let out = new XMLSerializer().serializeToString(svg);
    if (!out.startsWith("<?xml")) out = '<?xml version="1.0" encoding="UTF-8"?>\n' + out;
    if (/<image[\s>]|data:image\//i.test(out)) throw new Error("SVG continha imagem embutida");
    state.resultSvg = out;
    document.body.removeChild(host);
    $("btnDlSvg").disabled = false;
    $("btnDlPng").disabled = false;
    return out;
  }

  function fitView(view, cw, ch, vw, vh) {
    const z = Math.min(vw / cw, vh / ch) * 0.92;
    view.zoom = z;
    view.panX = (vw - cw * z) / 2;
    view.panY = (vh - ch * z) / 2;
  }

  function applyTransform(base, ov, view) {
    const t = `translate(${view.panX}px,${view.panY}px) scale(${view.zoom})`;
    base.style.transform = t;
    ov.style.transform = t;
    base.style.width = base.width + "px";
    base.style.height = base.height + "px";
    ov.style.width = ov.width + "px";
    ov.style.height = ov.height + "px";
  }

  function screenToContent(view, rect, clientX, clientY) {
    return {
      x: (clientX - rect.left - view.panX) / view.zoom,
      y: (clientY - rect.top - view.panY) / view.zoom,
    };
  }

  function paintVecBase() {
    if (!state.vecRaster) return;
    const { w, h } = state.vecRaster;
    const canvas = $("vecBase");
    const ctx = canvas.getContext("2d");
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, w, h);
    const src = state.resultSvg || state.svgText;
    if (!src) return;
    const doc = new DOMParser().parseFromString(src, "image/svg+xml");
    const svg = doc.documentElement;
    svg.setAttribute("width", String(w));
    svg.setAttribute("height", String(h));
    if (!svg.getAttribute("xmlns")) svg.setAttribute("xmlns", NS);
    const url = URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(svg)], { type: "image/svg+xml;charset=utf-8" }));
    const img = new Image();
    img.onload = () => { ctx.drawImage(img, 0, 0, w, h); URL.revokeObjectURL(url); };
    img.onerror = () => URL.revokeObjectURL(url);
    img.src = url;
  }

  function strokePath(ctx, kind, pts, color, width) {
    if (!pts || pts.length < 2) return;
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.beginPath();
    if (kind === "curva" && pts.length >= 3) {
      const dense = densifyPath("curva", pts, 2);
      ctx.moveTo(dense[0].x, dense[0].y);
      for (let i = 1; i < dense.length; i++) ctx.lineTo(dense[i].x, dense[i].y);
    } else {
      ctx.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    }
    ctx.stroke();
  }

  function drawPointHandle(ctx, p, color, r, square) {
    ctx.fillStyle = color;
    ctx.strokeStyle = COLORS.handleStroke;
    ctx.lineWidth = r * 0.25;
    if (square) {
      ctx.fillRect(p.x - r, p.y - r, r * 2, r * 2);
      ctx.strokeRect(p.x - r, p.y - r, r * 2, r * 2);
    } else {
      ctx.beginPath();
      ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
  }

  function paintImgOverlay() {
    const c = $("imgOverlay");
    if (!c.width) return;
    const ctx = c.getContext("2d");
    ctx.clearRect(0, 0, c.width, c.height);
    const z = Math.max(0.001, state.imgView.zoom);
    const lw = 3 / z;
    const hr = 5 / z;

    for (const g of state.gradients) {
      let color = COLORS.applied;
      if (g.id === state.activeGradId && !g.applications.length) color = COLORS.waiting;
      if (g.id === state.activeGradId && g.applications.length) color = COLORS.selected;
      if (g.id === state.hoverGradId) color = COLORS.selected;
      strokePath(ctx, g.kind, g.pts, color, lw);
      // editable handles
      if (g.kind === "curva" && g.pts.length >= 3) {
        // control arms (one lilac mid-control per quadratic segment)
        ctx.strokeStyle = COLORS.control;
        ctx.lineWidth = 1 / z;
        ctx.setLineDash([4 / z, 3 / z]);
        ctx.beginPath();
        for (let i = 0; i <= g.pts.length - 3; i += 2) {
          ctx.moveTo(g.pts[i].x, g.pts[i].y);
          ctx.lineTo(g.pts[i + 1].x, g.pts[i + 1].y);
          ctx.lineTo(g.pts[i + 2].x, g.pts[i + 2].y);
        }
        ctx.stroke();
        ctx.setLineDash([]);
        for (let i = 0; i < g.pts.length; i++) {
          const isCtrl = i % 2 === 1;
          drawPointHandle(ctx, g.pts[i], isCtrl ? COLORS.control : color, isCtrl ? hr * 1.1 : hr, isCtrl);
        }
      } else if (g.kind === "livre" && g.pts.length > 2) {
        // show start/end + a few intermediate editable points (every ~N)
        drawPointHandle(ctx, g.pts[0], color, hr, false);
        drawPointHandle(ctx, g.pts[g.pts.length - 1], color, hr, false);
        const step = Math.max(1, Math.floor(g.pts.length / 6));
        for (let i = step; i < g.pts.length - 1; i += step) {
          drawPointHandle(ctx, g.pts[i], color, hr * 0.75, true);
        }
      } else {
        drawPointHandle(ctx, g.pts[0], color, hr, false);
        drawPointHandle(ctx, g.pts[g.pts.length - 1], color, hr, false);
      }
      const mid = densifyPath(g.kind, g.pts, 4);
      const mp = mid[Math.floor(mid.length / 2)] || g.pts[0];
      ctx.font = `bold ${13 / z}px Segoe UI`;
      ctx.lineWidth = 3 / z;
      ctx.strokeStyle = "#000";
      ctx.fillStyle = color;
      ctx.strokeText(String(g.n), mp.x + 8 / z, mp.y - 8 / z);
      ctx.fillText(String(g.n), mp.x + 8 / z, mp.y - 8 / z);
    }
    if (state.drafting) {
      strokePath(ctx, state.drafting.kind, state.drafting.pts, COLORS.draft, lw);
      for (const p of state.drafting.pts) drawPointHandle(ctx, p, COLORS.draft, hr * 0.8, false);
    }
  }

  function paintVecOverlay() {
    const c = $("vecOverlay");
    if (!c.width || !state.vecRaster) return;
    const ctx = c.getContext("2d");
    ctx.clearRect(0, 0, c.width, c.height);
    const { scale, ox, oy } = state.vecRaster;
    const z = Math.max(0.001, state.vecView.zoom);
    const toC = (sx, sy) => ({ x: (sx - ox) * scale, y: (sy - oy) * scale });

    const drawHandles = (app, color) => {
      const a = toC(app.x1, app.y1);
      const b = toC(app.x2, app.y2);
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.5 / z;
      ctx.setLineDash([6 / z, 4 / z]);
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      ctx.setLineDash([]);
      const hs = 7 / z;
      ctx.fillStyle = COLORS.handle;
      ctx.strokeStyle = COLORS.handleStroke;
      ctx.lineWidth = 1.2 / z;
      ctx.fillRect(a.x - hs / 2, a.y - hs / 2, hs, hs);
      ctx.strokeRect(a.x - hs / 2, a.y - hs / 2, hs, hs);
      ctx.fillStyle = color;
      ctx.fillRect(b.x - hs / 2, b.y - hs / 2, hs, hs);
      ctx.strokeRect(b.x - hs / 2, b.y - hs / 2, hs, hs);
    };

    for (const g of state.gradients) {
      for (const app of g.applications) {
        const selected = state.selectedApp && state.selectedApp.gradId === g.id && state.selectedApp.shapeKey === app.shapeKey;
        const activeGrad = state.activeGradId === g.id;
        if (selected || activeGrad) drawHandles(app, selected ? COLORS.selected : COLORS.waiting);
      }
    }
  }

  function refreshList() {
    const ul = $("lineList");
    ul.innerHTML = "";
    for (const g of state.gradients) {
      const li = document.createElement("li");
      if (g.id === state.activeGradId) li.classList.add("active");
      const num = document.createElement("div");
      num.className = "num";
      num.textContent = g.n;
      num.style.background = g.applications.length ? COLORS.applied : COLORS.waiting;
      num.style.color = "#111";
      const meta = document.createElement("div");
      meta.className = "meta";
      const kindLabel = g.kind === "curva" ? "curva" : g.kind === "livre" ? "livre" : "reta";
      meta.innerHTML = `<div class="name">Gradiente ${g.n} <span class="sub">(${kindLabel})</span></div><div class="sub">${g.applications.length} forma(s)</div>`;
      const strip = document.createElement("div");
      strip.className = "swatch-strip";
      strip.style.background = swatchCss(g.stops);
      meta.appendChild(strip);
      const del = document.createElement("button");
      del.className = "tiny";
      del.textContent = "Excluir";
      del.onclick = (e) => {
        e.stopPropagation();
        pushHistory();
        state.gradients = state.gradients.filter((x) => x.id !== g.id);
        if (state.activeGradId === g.id) state.activeGradId = null;
        if (state.selectedApp && state.selectedApp.gradId === g.id) state.selectedApp = null;
        updatePrompt();
        refreshList();
        rebuildSvg();
        paintVecBase();
        paintImgOverlay();
        paintVecOverlay();
      };
      li.appendChild(num); li.appendChild(meta); li.appendChild(del);
      li.onmouseenter = () => { state.hoverGradId = g.id; paintImgOverlay(); };
      li.onmouseleave = () => { state.hoverGradId = null; paintImgOverlay(); };
      li.onclick = () => {
        state.activeGradId = g.id;
        state.selectedApp = g.applications[0] ? { gradId: g.id, shapeKey: g.applications[0].shapeKey } : null;
        updatePrompt(); refreshList(); paintImgOverlay(); paintVecOverlay();
      };
      ul.appendChild(li);
    }
    $("btnClear").disabled = !state.gradients.length;
  }

  function updatePrompt() {
    if (!state.imgCanvas || !state.svgText) {
      setStatus("Envie a imagem e o SVG para começar.", "warn");
      return;
    }
    if (state.activeGradId) {
      const g = state.gradients.find((x) => x.id === state.activeGradId);
      if (g && !g.applications.length) {
        setStatus(`Gradiente ${g.n}: clique na forma do vetor para aplicar.`, "warn");
        return;
      }
      if (g) {
        setStatus(`Gradiente ${g.n} ativo — clique em mais formas, arraste as alças, ou trace uma nova linha. Esc cancela.`, "ok");
        return;
      }
    }
    const tip = state.drawMode === "curva"
      ? "Curva: arraste a corda e depois puxe o ponto lilás do meio. Clique duplo na curva adiciona ponto; arraste para ajustar; botão direito ou Delete remove."
      : state.drawMode === "livre"
        ? "Livre: desenhe à mão na imagem."
        : "Reta: arraste uma linha na imagem.";
    setStatus(`Trace a linha ${state.nextNum} (${tip})`, "warn");
  }

  function resizeCanvases() {
    if (!state.imgCanvas || !state.svgText) return;
    const imgVp = $("imgViewport"), vecVp = $("vecViewport");
    const imgBase = $("imgBase"), imgOv = $("imgOverlay");
    const vecBase = $("vecBase"), vecOv = $("vecOverlay");
    const iw = state.imgCanvas.width, ih = state.imgCanvas.height;
    imgBase.width = iw; imgBase.height = ih;
    imgOv.width = iw; imgOv.height = ih;
    imgBase.getContext("2d").drawImage(state.imgCanvas, 0, 0);
    fitView(state.imgView, iw, ih, imgVp.clientWidth || 500, imgVp.clientHeight || 500);
    applyTransform(imgBase, imgOv, state.imgView);

    const doc = new DOMParser().parseFromString(state.svgText, "image/svg+xml");
    const svg = doc.documentElement;
    const host = document.createElement("div");
    host.style.cssText = "position:fixed;left:-12000px;opacity:0;width:500px;height:500px";
    host.appendChild(svg);
    document.body.appendChild(host);
    state.viewBox = parseViewBox(svg);
    buildShapeIndex(svg);
    const vb = state.viewBox;
    const maxSide = 1000;
    const sc = Math.min(maxSide / vb.w, maxSide / vb.h);
    const vw = Math.max(2, Math.round(vb.w * sc));
    const vh = Math.max(2, Math.round(vb.h * sc));
    state.vecRaster = { scale: sc, ox: vb.x, oy: vb.y, w: vw, h: vh, vb };
    vecBase.width = vw; vecBase.height = vh;
    vecOv.width = vw; vecOv.height = vh;
    document.body.removeChild(host);
    fitView(state.vecView, vw, vh, vecVp.clientWidth || 500, vecVp.clientHeight || 500);
    applyTransform(vecBase, vecOv, state.vecView);
    rebuildSvg();
    paintVecBase();
    paintImgOverlay();
    paintVecOverlay();
    updatePrompt();
  }

  function effectiveDrawMode(e) {
    if (e && e.altKey) return "livre";
    return state.drawMode;
  }

  function finishDraft() {
    const d = state.drafting;
    state.drafting = null;
    if (!d || d.pts.length < 2) { paintImgOverlay(); return; }
    // simplify livre
    let pts = d.pts;
    if (d.kind === "livre") {
      const simplified = [pts[0]];
      for (let i = 1; i < pts.length; i++) {
        const prev = simplified[simplified.length - 1];
        if (Math.hypot(pts[i].x - prev.x, pts[i].y - prev.y) >= 2.5) simplified.push(pts[i]);
      }
      if (simplified.length < 2) simplified.push(pts[pts.length - 1]);
      pts = simplified;
    }
    if (d.kind === "reta" || d.kind === "curva") {
      if (Math.hypot(pts[pts.length - 1].x - pts[0].x, pts[pts.length - 1].y - pts[0].y) < 4) {
        paintImgOverlay(); return;
      }
    }
    if (d.kind === "curva") {
      // ensure 3 points: start, mid control, end
      const a = pts[0], b = pts[pts.length - 1];
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      pts = [a, mid, b];
    }
    const stops = sampleAlongPath(d.kind, pts, parseInt($("lineStops").value, 10));
    pushHistory();
    const id = "G" + Date.now() + "_" + Math.random().toString(36).slice(2, 5);
    const g = { id, n: state.nextNum++, kind: d.kind, pts, stops, applications: [] };
    state.gradients.push(g);
    state.activeGradId = id;
    state.selectedApp = null;
    refreshList();
    updatePrompt();
    paintImgOverlay();
    paintVecOverlay();
  }

  function hitImgHandle(pt, g, hitR) {
    if (g.kind === "curva" && g.pts.length >= 3) {
      let best = null, bestD = Infinity;
      for (let i = 0; i < g.pts.length; i++) {
        const isCtrl = i % 2 === 1;
        const r = isCtrl ? hitR * 1.2 : hitR;
        const d = Math.hypot(pt.x - g.pts[i].x, pt.y - g.pts[i].y);
        if (d <= r && d < bestD) {
          bestD = d;
          best = { which: isCtrl ? "c" : (i === 0 ? "a" : i === g.pts.length - 1 ? "b" : "p"), index: i };
        }
      }
      return best;
    }
    if (g.kind === "livre" && g.pts.length > 2) {
      for (let i = 0; i < g.pts.length; i++) {
        const step = Math.max(1, Math.floor(g.pts.length / 6));
        const isKey = i === 0 || i === g.pts.length - 1 || (i % step === 0);
        if (!isKey) continue;
        if (Math.hypot(pt.x - g.pts[i].x, pt.y - g.pts[i].y) <= hitR) return { which: "p", index: i };
      }
      return null;
    }
    if (Math.hypot(pt.x - g.pts[0].x, pt.y - g.pts[0].y) <= hitR) return { which: "a", index: 0 };
    if (Math.hypot(pt.x - g.pts[g.pts.length - 1].x, pt.y - g.pts[g.pts.length - 1].y) <= hitR) return { which: "b", index: g.pts.length - 1 };
    return null;
  }

  function resyncAppsFromPath(g) {
    g.stops = sampleAlongPath(g.kind, g.pts, parseInt($("lineStops").value, 10));
    for (const app of g.applications) {
      const shape = state.shapeIndex.find((s) => s.key === app.shapeKey);
      if (shape) Object.assign(app, fountainAcrossShape(shape, g.kind, g.pts));
    }
  }

  function bindInteractions() {
    const imgVp = $("imgViewport");
    const vecVp = $("vecViewport");

    const wheel = (view, base, ov, vp) => (e) => {
      e.preventDefault();
      const rect = vp.getBoundingClientRect();
      const before = screenToContent(view, rect, e.clientX, e.clientY);
      const f = e.deltaY < 0 ? 1.12 : 1 / 1.12;
      view.zoom = Math.min(24, Math.max(0.04, view.zoom * f));
      view.panX = e.clientX - rect.left - before.x * view.zoom;
      view.panY = e.clientY - rect.top - before.y * view.zoom;
      applyTransform(base, ov, view);
    };
    imgVp.addEventListener("wheel", wheel(state.imgView, $("imgBase"), $("imgOverlay"), imgVp), { passive: false });
    vecVp.addEventListener("wheel", wheel(state.vecView, $("vecBase"), $("vecOverlay"), vecVp), { passive: false });

    function syncAfterPathEdit(g) {
      if (!g) return;
      resyncAppsFromPath(g);
      refreshList();
      rebuildSvg();
      paintVecBase();
      paintImgOverlay();
      paintVecOverlay();
    }

    imgVp.addEventListener("pointerdown", (e) => {
      imgVp.setPointerCapture(e.pointerId);
      const rect = imgVp.getBoundingClientRect();
      const pt = screenToContent(state.imgView, rect, e.clientX, e.clientY);
      const hitR = 10 / state.imgView.zoom;
      if (e.button === 2) {
        for (const g of state.gradients) {
          const h = hitImgHandle(pt, g, hitR);
          if (h) {
            pushHistory();
            if (deleteCurvePointAt(g, h.index)) {
              state.activeGradId = g.id;
              state.selectedPoint = null;
              syncAfterPathEdit(g);
            }
            return;
          }
        }
      }
      if (e.button === 1 || e.button === 2 || state.imgView.space) {
        state.drag = { type: "pan", view: "img", x: e.clientX, y: e.clientY, panX: state.imgView.panX, panY: state.imgView.panY };
        return;
      }
      for (const g of state.gradients) {
        const h = hitImgHandle(pt, g, hitR);
        if (h) {
          pushHistory();
          state.drag = { type: "imgHandle", gradId: g.id, index: h.index };
          state.activeGradId = g.id;
          state.selectedPoint = { gradId: g.id, index: h.index };
          return;
        }
      }
      state.selectedPoint = null;
      const kind = effectiveDrawMode(e);
      state.drafting = { kind, pts: [{ x: pt.x, y: pt.y }, { x: pt.x, y: pt.y }] };
      paintImgOverlay();
    });

    imgVp.addEventListener("dblclick", (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      state.drafting = null;
      const rect = imgVp.getBoundingClientRect();
      const pt = screenToContent(state.imgView, rect, e.clientX, e.clientY);
      const hitR = 10 / state.imgView.zoom;
      const thresh = 10 / state.imgView.zoom;
      for (const g of state.gradients) {
        if (hitImgHandle(pt, g, hitR)) return;
      }
      // Prefer the active curve, then any curve close enough.
      const order = [];
      if (state.activeGradId) {
        const ag = state.gradients.find((x) => x.id === state.activeGradId);
        if (ag) order.push(ag);
      }
      for (const g of state.gradients) if (!order.includes(g)) order.push(g);
      for (const g of order) {
        if (g.kind !== "curva") continue;
        pushHistory();
        const added = insertCurvePointAt(g, pt, thresh);
        if (!added) {
          state.history.pop();
          updateUndoButtons();
          continue;
        }
        state.activeGradId = g.id;
        state.selectedPoint = { gradId: g.id, index: added.index };
        syncAfterPathEdit(g);
        updatePrompt();
        return;
      }
    });

    imgVp.addEventListener("pointermove", (e) => {
      if (state.drag && state.drag.type === "pan" && state.drag.view === "img") {
        state.imgView.panX = state.drag.panX + (e.clientX - state.drag.x);
        state.imgView.panY = state.drag.panY + (e.clientY - state.drag.y);
        applyTransform($("imgBase"), $("imgOverlay"), state.imgView);
        return;
      }
      const rect = imgVp.getBoundingClientRect();
      const pt = screenToContent(state.imgView, rect, e.clientX, e.clientY);
      if (state.drag && state.drag.type === "imgHandle") {
        const g = state.gradients.find((x) => x.id === state.drag.gradId);
        if (g && g.pts[state.drag.index]) {
          g.pts[state.drag.index] = { x: pt.x, y: pt.y };
          paintImgOverlay();
        }
        return;
      }
      if (state.drafting) {
        if (state.drafting.kind === "livre") {
          const last = state.drafting.pts[state.drafting.pts.length - 1];
          if (Math.hypot(pt.x - last.x, pt.y - last.y) >= 2) state.drafting.pts.push({ x: pt.x, y: pt.y });
        } else {
          state.drafting.pts[state.drafting.pts.length - 1] = { x: pt.x, y: pt.y };
        }
        paintImgOverlay();
      }
    });

    imgVp.addEventListener("pointerup", () => {
      if (state.drag && state.drag.type === "pan" && state.drag.view === "img") { state.drag = null; return; }
      if (state.drag && state.drag.type === "imgHandle") {
        const g = state.gradients.find((x) => x.id === state.drag.gradId);
        state.drag = null;
        if (g) {
          resyncAppsFromPath(g);
          refreshList();
          rebuildSvg();
          paintVecBase();
          paintImgOverlay();
          paintVecOverlay();
        }
        return;
      }
      if (state.drafting) finishDraft();
    });
    imgVp.addEventListener("contextmenu", (e) => e.preventDefault());

    vecVp.addEventListener("pointerdown", (e) => {
      vecVp.setPointerCapture(e.pointerId);
      if (e.button === 1 || e.button === 2 || state.vecView.space) {
        state.drag = { type: "pan", view: "vec", x: e.clientX, y: e.clientY, panX: state.vecView.panX, panY: state.vecView.panY };
        return;
      }
      if (!state.vecRaster) return;
      const rect = vecVp.getBoundingClientRect();
      const pt = screenToContent(state.vecView, rect, e.clientX, e.clientY);
      const { scale, ox, oy } = state.vecRaster;
      const svgX = ox + pt.x / scale;
      const svgY = oy + pt.y / scale;

      const hs = 10 / state.vecView.zoom;
      for (const g of state.gradients) {
        for (const app of g.applications) {
          if (!(state.activeGradId === g.id || (state.selectedApp && state.selectedApp.gradId === g.id))) continue;
          const a = { x: (app.x1 - ox) * scale, y: (app.y1 - oy) * scale };
          const b = { x: (app.x2 - ox) * scale, y: (app.y2 - oy) * scale };
          if (Math.abs(pt.x - a.x) <= hs && Math.abs(pt.y - a.y) <= hs) {
            pushHistory();
            state.drag = { type: "vecHandle", gradId: g.id, shapeKey: app.shapeKey, which: "a" };
            state.selectedApp = { gradId: g.id, shapeKey: app.shapeKey };
            state.activeGradId = g.id;
            return;
          }
          if (Math.abs(pt.x - b.x) <= hs && Math.abs(pt.y - b.y) <= hs) {
            pushHistory();
            state.drag = { type: "vecHandle", gradId: g.id, shapeKey: app.shapeKey, which: "b" };
            state.selectedApp = { gradId: g.id, shapeKey: app.shapeKey };
            state.activeGradId = g.id;
            return;
          }
        }
      }

      if (!state.shapeIndex.length) {
        const doc = new DOMParser().parseFromString(state.svgText, "image/svg+xml");
        const host = document.createElement("div");
        host.style.cssText = "position:fixed;left:-12000px;opacity:0;width:400px;height:400px";
        host.appendChild(doc.documentElement);
        document.body.appendChild(host);
        buildShapeIndex(doc.documentElement);
        document.body.removeChild(host);
      }

      const hit = hitShape(svgX, svgY);
      if (!hit) { setStatus("Clique dentro de uma forma preenchida.", "err"); return; }

      const active = state.activeGradId && state.gradients.find((g) => g.id === state.activeGradId);
      const existing = findAppByShape(hit.key);

      if (active) {
        pushHistory();
        let app = findApp(active.id, hit.key);
        if (!app) {
          const coords = fountainAcrossShape(hit, active.kind, active.pts);
          app = { shapeKey: hit.key, ...coords };
          for (const g of state.gradients) g.applications = g.applications.filter((a) => a.shapeKey !== hit.key);
          active.applications.push(app);
        }
        state.selectedApp = { gradId: active.id, shapeKey: hit.key };
        refreshList(); updatePrompt(); rebuildSvg(); paintVecBase(); paintVecOverlay(); paintImgOverlay();
        return;
      }

      if (existing) {
        state.activeGradId = existing.grad.id;
        state.selectedApp = { gradId: existing.grad.id, shapeKey: hit.key };
        refreshList(); updatePrompt(); paintVecOverlay(); paintImgOverlay();
        return;
      }
      setStatus("Trace uma linha na imagem antes de aplicar.", "err");
    });

    vecVp.addEventListener("pointermove", (e) => {
      if (state.drag && state.drag.type === "pan" && state.drag.view === "vec") {
        state.vecView.panX = state.drag.panX + (e.clientX - state.drag.x);
        state.vecView.panY = state.drag.panY + (e.clientY - state.drag.y);
        applyTransform($("vecBase"), $("vecOverlay"), state.vecView);
        return;
      }
      if (state.drag && state.drag.type === "vecHandle") {
        const rect = vecVp.getBoundingClientRect();
        const pt = screenToContent(state.vecView, rect, e.clientX, e.clientY);
        const { scale, ox, oy } = state.vecRaster;
        const sx = ox + pt.x / scale;
        const sy = oy + pt.y / scale;
        const g = state.gradients.find((x) => x.id === state.drag.gradId);
        const app = g && g.applications.find((a) => a.shapeKey === state.drag.shapeKey);
        if (!app) return;
        if (state.drag.which === "a") { app.x1 = sx; app.y1 = sy; }
        else { app.x2 = sx; app.y2 = sy; }
        paintVecOverlay();
      }
    });

    vecVp.addEventListener("pointerup", () => {
      if (state.drag && state.drag.type === "pan" && state.drag.view === "vec") { state.drag = null; return; }
      if (state.drag && state.drag.type === "vecHandle") {
        state.drag = null;
        rebuildSvg();
        paintVecBase();
        paintVecOverlay();
      }
    });
    vecVp.addEventListener("contextmenu", (e) => e.preventDefault());

    function isTypingTarget(t) {
      if (!t || !t.tagName) return false;
      const tag = t.tagName.toLowerCase();
      return tag === "input" || tag === "textarea" || tag === "select" || t.isContentEditable;
    }

    window.addEventListener("keydown", (e) => {
      if (e.code === "Space" && !isTypingTarget(e.target)) {
        state.imgView.space = true; state.vecView.space = true;
      }
      if (e.key === "Escape") {
        state.drafting = null; state.drag = null;
        state.activeGradId = null; state.selectedApp = null;
        updatePrompt(); refreshList(); paintImgOverlay(); paintVecOverlay();
      }
      if (isTypingTarget(e.target)) return;
      if ((e.key === "Delete" || e.key === "Backspace") && state.selectedPoint) {
        const g = state.gradients.find((x) => x.id === state.selectedPoint.gradId);
        if (g) {
          e.preventDefault();
          pushHistory();
          if (deleteCurvePointAt(g, state.selectedPoint.index)) {
            state.selectedPoint = null;
            syncAfterPathEdit(g);
          } else {
            state.history.pop();
            updateUndoButtons();
          }
        }
      }
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === "z" && !e.shiftKey) { e.preventDefault(); undo(); }
      if (mod && (e.key.toLowerCase() === "y" || (e.key.toLowerCase() === "z" && e.shiftKey))) { e.preventDefault(); redo(); }
    });
    window.addEventListener("keyup", (e) => {
      if (e.code === "Space") { state.imgView.space = false; state.vecView.space = false; }
    });
    window.addEventListener("resize", () => {
      if (state.imgCanvas && state.svgText) resizeCanvases();
    });
  }

  function loadImageFile(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        const c = document.createElement("canvas");
        c.width = img.naturalWidth; c.height = img.naturalHeight;
        const ctx = c.getContext("2d", { willReadFrequently: true });
        ctx.drawImage(img, 0, 0);
        URL.revokeObjectURL(url);
        resolve({ img, canvas: c, ctx });
      };
      img.onerror = reject;
      img.src = url;
    });
  }

  async function onImage(file) {
    setStatus("Carregando imagem…");
    const { img, canvas, ctx } = await loadImageFile(file);
    state.img = img; state.imgCanvas = canvas; state.imgCtx = ctx; state.imgData = null;
    if (state.svgText) resizeCanvases();
    else setStatus("Imagem OK. Envie o SVG.");
  }

  async function onSvg(file) {
    setStatus("Carregando SVG…");
    const text = await file.text();
    if (new DOMParser().parseFromString(text, "image/svg+xml").querySelector("parsererror")) {
      setStatus("SVG inválido.", "err"); return;
    }
    state.svgText = text;
    state.gradients = [];
    state.activeGradId = null;
    state.selectedApp = null;
    state.nextNum = 1;
    state.resultSvg = null;
    state.history = [];
    state.future = [];
    updateUndoButtons();
    refreshList();
    if (state.imgCanvas) resizeCanvases();
    else setStatus("SVG OK. Envie a imagem de referência.");
  }

  function downloadText(name, text, mime) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([text], { type: mime }));
    a.download = name; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1500);
  }

  async function getPngDataURL(maxSide = 1400) {
    if (!state.resultSvg) return null;
    const doc = new DOMParser().parseFromString(state.resultSvg, "image/svg+xml");
    const vb = parseViewBox(doc.documentElement);
    const scale = Math.min(maxSide / vb.w, maxSide / vb.h);
    const w = Math.max(1, Math.round(vb.w * scale));
    const h = Math.max(1, Math.round(vb.h * scale));
    const clone = doc.documentElement.cloneNode(true);
    clone.setAttribute("width", String(w));
    clone.setAttribute("height", String(h));
    if (!clone.getAttribute("xmlns")) clone.setAttribute("xmlns", NS);
    const url = URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(clone)], { type: "image/svg+xml;charset=utf-8" }));
    const img = new Image();
    await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = url; });
    const c = document.createElement("canvas");
    c.width = w; c.height = h;
    const ctx = c.getContext("2d");
    ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, w, h);
    ctx.drawImage(img, 0, 0, w, h);
    URL.revokeObjectURL(url);
    return c.toDataURL("image/png");
  }

  function setDrawMode(mode) {
    state.drawMode = mode;
    document.querySelectorAll("#drawTools button").forEach((b) => {
      b.classList.toggle("active", b.getAttribute("data-mode") === mode);
    });
    updatePrompt();
  }

  $("imgFile").addEventListener("change", (e) => { const f = e.target.files && e.target.files[0]; if (f) onImage(f); });
  $("svgFile").addEventListener("change", (e) => { const f = e.target.files && e.target.files[0]; if (f) onSvg(f); });
  $("lineStops").addEventListener("input", () => {
    $("lineStopsVal").textContent = $("lineStops").value;
  });
  $("lineStops").addEventListener("change", () => {
    // re-sample active gradients with new stop count
    if (!state.gradients.length) return;
    pushHistory();
    for (const g of state.gradients) resyncAppsFromPath(g);
    refreshList(); rebuildSvg(); paintVecBase(); paintImgOverlay(); paintVecOverlay();
  });
  $("btnClear").addEventListener("click", () => {
    pushHistory();
    state.gradients = [];
    state.activeGradId = null;
    state.selectedApp = null;
    state.nextNum = 1;
    refreshList(); rebuildSvg(); paintVecBase(); paintImgOverlay(); paintVecOverlay(); updatePrompt();
  });
  $("btnUndo").addEventListener("click", () => undo());
  $("btnRedo").addEventListener("click", () => redo());
  $("btnDlSvg").addEventListener("click", () => {
    if (state.resultSvg) downloadText("resultado-gradiente.svg", state.resultSvg, "image/svg+xml");
  });
  $("btnDlPng").addEventListener("click", async () => {
    const u = await getPngDataURL(1600);
    if (!u) return;
    const a = document.createElement("a");
    a.href = u; a.download = "resultado-gradiente.png"; a.click();
  });
  document.querySelectorAll("#drawTools button").forEach((b) => {
    b.addEventListener("click", () => setDrawMode(b.getAttribute("data-mode")));
  });

  bindInteractions();
  $("lineStopsVal").textContent = $("lineStops").value;
  updateUndoButtons();
  updatePrompt();

  window.GradienteApp = {
    state,
    setDrawMode,
    undo, redo,
    insertCurvePointAt,
    deleteCurvePointAt,
    projectOnCurve,
    densifyPath,
    resyncAppsFromPath,
    paintImgOverlay,
    paintVecOverlay,
    rebuildSvg,
    loadImageFromURL: async (url) => {
      const blob = await (await fetch(url)).blob();
      await onImage(new File([blob], "ref.png", { type: blob.type || "image/png" }));
    },
    loadSvgFromURL: async (url) => {
      const text = await (await fetch(url)).text();
      await onSvg(new File([text], "vetor.svg", { type: "image/svg+xml" }));
    },
    getResultSvg: () => state.resultSvg,
    getPngDataURL,
    async testCurveAndApply(opts) {
      // opts: { kind, pts, svgPoint, undoAfter }
      const stops = sampleAlongPath(opts.kind, opts.pts, parseInt($("lineStops").value, 10));
      pushHistory();
      const id = "Gtest_" + Date.now();
      const g = { id, n: state.nextNum++, kind: opts.kind, pts: opts.pts.map((p) => ({ ...p })), stops, applications: [] };
      state.gradients.push(g);
      state.activeGradId = id;
      if (!state.shapeIndex.length) {
        const doc = new DOMParser().parseFromString(state.svgText, "image/svg+xml");
        const host = document.createElement("div");
        host.style.cssText = "position:fixed;left:-12000px;opacity:0;width:400px;height:400px";
        host.appendChild(doc.documentElement);
        document.body.appendChild(host);
        buildShapeIndex(doc.documentElement);
        document.body.removeChild(host);
      }
      const hit = hitShape(opts.svgPoint.x, opts.svgPoint.y);
      if (!hit) return { ok: false };
      const coords = fountainAcrossShape(hit, g.kind, g.pts);
      g.applications.push({ shapeKey: hit.key, ...coords });
      state.selectedApp = { gradId: id, shapeKey: hit.key };
      if (opts.bend) {
        // move control point
        if (g.kind === "curva" && g.pts.length >= 3) {
          g.pts[1].x += opts.bend.dx || 0;
          g.pts[1].y += opts.bend.dy || 0;
          resyncAppsFromPath(g);
        }
      }
      refreshList();
      rebuildSvg();
      paintVecBase(); paintImgOverlay(); paintVecOverlay();
      const beforeUndo = state.resultSvg;
      if (opts.undoAfter) {
        undo();
      }
      return {
        ok: true,
        hit: hit.key,
        kind: g.kind,
        grads: ((state.resultSvg || beforeUndo || "").match(/<linearGradient/g) || []).length,
        hasImage: /<image[\s>]|data:image\//i.test(state.resultSvg || ""),
        canUndo: state.history.length > 0,
        canRedo: state.future.length > 0,
        svg: state.resultSvg,
      };
    },
  };
})();
