const imageLoader = document.getElementById("imageLoader");
const canvas = document.getElementById("imageCanvas");
const ctx = canvas.getContext("2d", { willReadFrequently: true });
const processBtn = document.getElementById("processBtn");

// UI Panel Reference Declarations
const engineMode = document.getElementById("engineMode");
const fillPattern = document.getElementById("fillPattern");
const bwOptionsPanel = document.getElementById("bwOptionsPanel");
const shadingOptionsPanel = document.getElementById("shadingOptionsPanel");
const outlineOptionsPanel = document.getElementById("outlineOptionsPanel");
const enableOutlineCheckbox = document.getElementById("enableOutlineOverlay");
const outlineOverlayContainer = document.getElementById("outlineOverlayContainer");

const globalPatternContainer = document.getElementById("globalPatternContainer");
const globalAngleContainer = document.getElementById("globalAngleContainer");
const angle1Block = document.getElementById("angle1Block");
const angle2Block = document.getElementById("angle2Block");

let imgPixels = null;
let gcodeLines = [];
// Geometry of every emitted stroke, in millimetres. Built by emitStroke() alongside
// gcodeLines so the preview renders real paths instead of re-parsing G-code text.
let previewPaths = [];

// =========================================================================
// OUTPUT GEOMETRY - single source of truth for the pixel -> millimetre mapping
// =========================================================================
function getPaperWidth() {
    return parseFloat(document.getElementById("paperWidth").value) || 100;
}

function getPaperHeight() {
    return parseFloat(document.getElementById("paperHeight").value) || 100;
}

function getMargin() {
    const mm = parseFloat(document.getElementById("margin").value);
    return isNaN(mm) || mm < 0 ? 0 : mm;
}

// How the image sits on the sheet: scaled to fit inside the margins without distorting
// its aspect ratio, then centred. Computed once per run and cached in `layout`.
let layout = null;

function computeLayout() {
    const paperW = getPaperWidth();
    const paperH = getPaperHeight();
    const margin = getMargin();

    // A margin bigger than the sheet would invert the drawing area.
    const usableW = Math.max(1, paperW - 2 * margin);
    const usableH = Math.max(1, paperH - 2 * margin);

    const imgW = canvas.width || 1;
    const imgH = canvas.height || 1;
    const scale = Math.min(usableW / imgW, usableH / imgH);

    return {
        paperW, paperH, margin, scale,
        drawW: imgW * scale,
        drawH: imgH * scale,
        originX: margin + (usableW - imgW * scale) / 2,
        originY: margin + (usableH - imgH * scale) / 2
    };
}

function getLayout() {
    return layout || (layout = computeLayout());
}

// Millimetres per source-image pixel. Every engine must scale through this.
function getScale() {
    return getLayout().scale;
}

function getPenWidth() {
    return parseFloat(document.getElementById("penWidth").value) || 0.4;
}

function getFeedRate() {
    return parseInt(document.getElementById("feedRate").value) || 1500;
}

// Servo pens need time to physically reach the paper before the next move starts.
function getDwellSeconds() {
    const ms = parseFloat(document.getElementById("penDwell").value);
    return isNaN(ms) || ms <= 0 ? 0 : ms / 1000;
}

function getBrightnessAdj() {
    return parseFloat(document.getElementById("brightness").value) || 0;
}

function getContrastAdj() {
    return parseFloat(document.getElementById("contrast").value) || 0;
}

// Stored as 10..300 so it can live on an integer slider.
function getGamma() {
    const raw = parseFloat(document.getElementById("gamma").value);
    return isNaN(raw) || raw <= 0 ? 1 : raw / 100;
}

function isInverted() {
    const el = document.getElementById("invertImage");
    return !!(el && el.checked);
}

function isAutoLevels() {
    const el = document.getElementById("autoLevels");
    return !!(el && el.checked);
}

function getSmoothMode() {
    const el = document.getElementById("smoothMode");
    return el ? el.value : "box";
}

function getSmoothing() {
    const mm = parseFloat(document.getElementById("smoothing").value);
    return isNaN(mm) || mm < 0 ? 0 : mm;
}

// Assumed rapid rate, used only for the plot-time estimate shown in the sidebar.
const ASSUMED_RAPID_MM_MIN = 3000;

function numField(id, fallback) {
    const v = parseFloat(document.getElementById(id).value);
    return isNaN(v) ? fallback : v;
}

// Servo pens are told to move with a spindle command; Z-axis pens are lifted by moving
// the Z axis. Everything downstream just asks for "the lines that put the pen down".
function getPenMode() {
    const profile = document.getElementById("machineProfile").value;
    return (profile === "grbl-z" || profile === "marlin-z") ? "z" : "servo";
}

function penDownLines() {
    if (getPenMode() === "z") {
        return [`G1 Z${numField("penDownZ", 0).toFixed(2)} F${Math.round(numField("zFeed", 500))}`];
    }
    return [document.getElementById("penDownCmd").value];
}

function penUpLines() {
    if (getPenMode() === "z") return [`G0 Z${numField("penUpZ", 5).toFixed(2)}`];
    return [document.getElementById("penUpCmd").value];
}

function customLines(id) {
    const raw = document.getElementById(id).value.trim();
    return raw ? raw.split(/\r?\n/).filter(line => line.trim()) : [];
}

// Strokes shorter than a single pen dot are image noise, not drawing.
const MIN_STROKE_MM = 0.4;

// Greyscale of the source image, optionally blurred. Built once per run so the scan
// loops don't recompute (r+g+b)/3 millions of times.
let brightnessMap = null;

// Separable box blur. Run before thresholding: film grain flips pixels in and out of a
// brightness band, which shatters long strokes into thousands of unplottable specks.
function boxBlur(src, w, h, radius) {
    const win = radius * 2 + 1;
    const tmp = new Float32Array(w * h);
    const out = new Uint8ClampedArray(w * h);

    for (let y = 0; y < h; y++) {
        const row = y * w;
        let sum = 0;
        for (let x = -radius; x <= radius; x++) sum += src[row + Math.min(w - 1, Math.max(0, x))];
        for (let x = 0; x < w; x++) {
            tmp[row + x] = sum / win;
            sum += src[row + Math.min(w - 1, x + radius + 1)] - src[row + Math.max(0, x - radius)];
        }
    }
    for (let x = 0; x < w; x++) {
        let sum = 0;
        for (let y = -radius; y <= radius; y++) sum += tmp[Math.min(h - 1, Math.max(0, y)) * w + x];
        for (let y = 0; y < h; y++) {
            out[y * w + x] = sum / win;
            sum += tmp[Math.min(h - 1, y + radius + 1) * w + x] - tmp[Math.max(0, y - radius) * w + x];
        }
    }
    return out;
}

// Median filter. Unlike a blur it removes grain without softening edges, which matters
// because every engine here thresholds - a softened edge becomes a thick transition band.
function medianFilter(src, w, h, radius) {
    const out = new Uint8ClampedArray(w * h);
    const window = [];
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            window.length = 0;
            for (let dy = -radius; dy <= radius; dy++) {
                const sy = Math.min(h - 1, Math.max(0, y + dy));
                for (let dx = -radius; dx <= radius; dx++) {
                    const sx = Math.min(w - 1, Math.max(0, x + dx));
                    window.push(src[sy * w + sx]);
                }
            }
            window.sort((a, b) => a - b);
            out[y * w + x] = window[window.length >> 1];
        }
    }
    return out;
}

// Thresholds are absolute numbers, so they only mean something relative to the image's
// actual tonal range. This maps tone before any engine looks at it.
function buildToneLut(loInput, hiInput) {
    const brightness = getBrightnessAdj();
    const contrast = getContrastAdj();
    const gamma = getGamma();
    const invert = isInverted();
    // Standard contrast curve, pivoting about mid grey.
    const factor = (259 * (contrast + 255)) / (255 * (259 - contrast));

    const lut = new Uint8ClampedArray(256);
    for (let i = 0; i < 256; i++) {
        let v = i;
        if (hiInput > loInput) v = ((v - loInput) / (hiInput - loInput)) * 255;
        v = Math.max(0, Math.min(255, v));
        v += brightness * 2.55;
        v = factor * (v - 128) + 128;
        v = Math.max(0, Math.min(255, v));
        v = 255 * Math.pow(v / 255, 1 / gamma);
        lut[i] = invert ? 255 - v : v;
    }
    return lut;
}

function buildBrightnessMap() {
    const w = canvas.width, h = canvas.height;
    const map = new Uint8ClampedArray(w * h);
    for (let i = 0; i < w * h; i++) {
        const idx = i * 4;
        map[i] = (imgPixels[idx] + imgPixels[idx + 1] + imgPixels[idx + 2]) / 3;
    }

    // Auto levels: find the real range, ignoring the extreme 0.5% at each end so a few
    // stray black or blown-out pixels don't waste the whole scale.
    let lo = 0, hi = 255;
    if (isAutoLevels()) {
        const counts = new Uint32Array(256);
        for (let i = 0; i < map.length; i++) counts[map[i]]++;
        const clip = Math.floor(map.length * 0.005);
        let seen = 0;
        for (let i = 0; i < 256; i++) { seen += counts[i]; if (seen > clip) { lo = i; break; } }
        seen = 0;
        for (let i = 255; i >= 0; i--) { seen += counts[i]; if (seen > clip) { hi = i; break; } }
        if (hi <= lo) { lo = 0; hi = 255; }
    }

    const lut = buildToneLut(lo, hi);
    for (let i = 0; i < map.length; i++) map[i] = lut[map[i]];

    // Smoothing is specified in mm so it means the same thing at any input resolution.
    const radius = Math.round(getSmoothing() / getScale());
    if (radius < 1) return map;
    return getSmoothMode() === "median"
        ? medianFilter(map, w, h, Math.min(radius, 2))
        : boxBlur(map, w, h, radius);
}

// =========================================================================
// HISTOGRAM
// Shows the tone distribution AFTER adjustments, with the active thresholds drawn on
// it - so it is visible why one image needs a cutoff of 210 and another needs 90.
// =========================================================================
function drawHistogram() {
    const hCanvas = document.getElementById("histogramCanvas");
    if (!hCanvas) return;
    const hCtx = hCanvas.getContext("2d");

    const dpr = window.devicePixelRatio || 1;
    const cssWidth = hCanvas.clientWidth || 300;
    hCanvas.width = Math.round(cssWidth * dpr);
    hCanvas.height = Math.round(64 * dpr);

    hCtx.fillStyle = "#0b0b0d";
    hCtx.fillRect(0, 0, hCanvas.width, hCanvas.height);

    if (!brightnessMap) {
        hCtx.fillStyle = "#3f3f46";
        hCtx.font = `${11 * dpr}px ui-monospace, monospace`;
        hCtx.fillText("load an image", 8 * dpr, 36 * dpr);
        return;
    }

    const counts = new Uint32Array(256);
    for (let i = 0; i < brightnessMap.length; i++) counts[brightnessMap[i]]++;
    let peak = 0;
    for (let i = 0; i < 256; i++) if (counts[i] > peak) peak = counts[i];
    if (!peak) return;

    const barW = hCanvas.width / 256;
    hCtx.fillStyle = "#3f3f46";
    for (let i = 0; i < 256; i++) {
        // Square root keeps small but meaningful populations visible next to a huge peak.
        const barH = Math.sqrt(counts[i] / peak) * hCanvas.height;
        hCtx.fillRect(i * barW, hCanvas.height - barH, Math.ceil(barW), barH);
    }

    hCtx.strokeStyle = "#00f5d4";
    hCtx.lineWidth = Math.max(1, dpr);
    for (const cutoff of activeThresholds()) {
        const x = (cutoff / 255) * hCanvas.width;
        hCtx.beginPath();
        hCtx.moveTo(x, 0);
        hCtx.lineTo(x, hCanvas.height);
        hCtx.stroke();
    }
}

// Whichever cutoffs the current mode will actually use.
function activeThresholds() {
    const mode = engineMode.value;
    if (mode === "outline") return [parseInt(document.getElementById("outlineThresh").value) || 128];
    if (mode === "shading") {
        return [...document.querySelectorAll(".layer-row")]
            .map(row => parseInt(row.querySelector(".layer-cutoff").value) || 0);
    }
    const list = [parseInt(document.getElementById("bwThresh").value) || 0];
    if (enableOutlineCheckbox && enableOutlineCheckbox.checked) {
        list.push(parseInt(document.getElementById("outlineThresh").value) || 128);
    }
    return list;
}

// Recompute tone and redraw the histogram without regenerating the whole plot.
function refreshTonePreview() {
    ["brightness", "contrast", "gamma"].forEach(id => {
        const el = document.getElementById(id + "Val");
        if (!el) return;
        el.textContent = id === "gamma" ? getGamma().toFixed(2) : document.getElementById(id).value;
    });
    if (!imgPixels) { drawHistogram(); return; }
    layout = computeLayout();
    brightnessMap = buildBrightnessMap();
    drawHistogram();
}

// RDP is recursive; chunk very long sampled paths so deep strokes can't blow the stack.
function simplifyLarge(path, epsilon) {
    const CHUNK = 2000;
    if (path.length <= CHUNK) return simplifyPathRDP(path, epsilon);
    let out = [];
    for (let i = 0; i < path.length - 1; i += CHUNK) {
        const part = simplifyPathRDP(path.slice(i, Math.min(i + CHUNK + 1, path.length)), epsilon);
        out = out.length ? out.concat(part.slice(1)) : part;
    }
    return out;
}

// Paths removed by clicking the preview, newest last, so Undo can put them back.
let deletedPaths = [];
let lastRouteGain = 0;

// Strokes collected this run, before ordering. Engines call emitStroke; nothing is
// written to gcodeLines until every stroke is known and the pen route is planned.
let collectedStrokes = [];

// The ONLY entry point for engine output. Takes a densely sampled path in mm and
// collapses it to real geometry.
function emitStroke(path, minLengthMm) {
    if (path.length < 2) return;

    const simplified = simplifyLarge(path, 0.05);
    if (simplified.length < 2) return;

    // Engines work from the image's own corner; shift onto the sheet so the drawing
    // lands inside the margins. Single choke point, so no engine has to know about paper.
    const place = getLayout();
    for (const point of simplified) {
        point.x += place.originX;
        point.y += place.originY;
    }

    let length = 0;
    for (let i = 1; i < simplified.length; i++) {
        length += Math.hypot(simplified[i].x - simplified[i - 1].x, simplified[i].y - simplified[i - 1].y);
    }
    if (length < (minLengthMm === undefined ? MIN_STROKE_MM : minLengthMm)) return;

    collectedStrokes.push(simplified);
}

// =========================================================================
// PEN ROUTE PLANNER
// Emitted in raw scan order the pen retraces the whole image between lines, so travel
// exceeds drawing distance. Greedy nearest-neighbour over both endpoints of every
// stroke - reversing where that is closer - collapses that, and naturally produces
// serpentine ordering for hatch fills. A uniform grid keeps it out of O(n^2).
// =========================================================================
function planStrokes(list) {
    if (!list.length) return [];

    const endOf = (s, end) => (end === 0 ? s[0] : s[s.length - 1]);

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const s of list) {
        for (const p of [s[0], s[s.length - 1]]) {
            if (p.x < minX) minX = p.x;
            if (p.x > maxX) maxX = p.x;
            if (p.y < minY) minY = p.y;
            if (p.y > maxY) maxY = p.y;
        }
    }

    const span = Math.max(maxX - minX, maxY - minY) || 1;
    const cell = span / Math.max(4, Math.ceil(Math.sqrt(list.length)));
    const cols = Math.floor((maxX - minX) / cell) + 1;
    const rows = Math.floor((maxY - minY) / cell) + 1;

    const buckets = new Map();
    const colOf = (p) => Math.min(cols - 1, Math.max(0, Math.floor((p.x - minX) / cell)));
    const rowOf = (p) => Math.min(rows - 1, Math.max(0, Math.floor((p.y - minY) / cell)));
    list.forEach((s, i) => {
        for (const end of [0, 1]) {
            const p = endOf(s, end);
            const key = rowOf(p) * cols + colOf(p);
            if (!buckets.has(key)) buckets.set(key, []);
            buckets.get(key).push({ i, end });
        }
    });

    const used = new Uint8Array(list.length);

    function nearestUnused(from) {
        const pcx = colOf(from), pcy = rowOf(from);
        let best = null, bestD = Infinity;
        const maxRing = Math.max(cols, rows);

        for (let k = 0; k <= maxRing; k++) {
            // Any endpoint in a ring further out is at least (k-1) cells away.
            if (best && (k - 1) * cell > bestD) break;
            for (let cy = pcy - k; cy <= pcy + k; cy++) {
                if (cy < 0 || cy >= rows) continue;
                for (let cx = pcx - k; cx <= pcx + k; cx++) {
                    if (cx < 0 || cx >= cols) continue;
                    // Perimeter of the ring only; inner cells were covered already.
                    if (k > 0 && cx !== pcx - k && cx !== pcx + k && cy !== pcy - k && cy !== pcy + k) continue;
                    const bucket = buckets.get(cy * cols + cx);
                    if (!bucket) continue;
                    for (const cand of bucket) {
                        if (used[cand.i]) continue;
                        const q = endOf(list[cand.i], cand.end);
                        const d = Math.hypot(q.x - from.x, q.y - from.y);
                        if (d < bestD) { bestD = d; best = cand; }
                    }
                }
            }
        }
        return best ? { cand: best, dist: bestD } : null;
    }

    // Gaps this small are narrower than the pen: draw straight through instead of
    // lifting, which removes pen-up/down cycles from fragmented outlines.
    const joinTolerance = Math.max(0.15, getPenWidth());

    const planned = [];
    let cursor = { x: 0, y: 0 };
    let remaining = list.length;

    while (remaining > 0) {
        const found = nearestUnused(cursor);
        if (!found) break;
        used[found.cand.i] = 1;
        remaining--;

        let path = list[found.cand.i];
        if (found.cand.end === 1) path = path.slice().reverse();

        if (planned.length && found.dist <= joinTolerance) {
            const tail = planned[planned.length - 1];
            const start = found.dist < 1e-6 ? 1 : 0;
            for (let i = start; i < path.length; i++) tail.push(path[i]);
        } else {
            planned.push(path.slice());
        }

        const tail = planned[planned.length - 1];
        cursor = tail[tail.length - 1];
    }
    return planned;
}

// =========================================================================
// 2-OPT ROUTE REFINEMENT
// Nearest-neighbour is greedy: it paints itself into corners and pays for them with
// long jumps later. 2-opt repeatedly reverses a run of strokes when doing so shortens
// the route. Reversing a run is free here because a stroke draws identically in either
// direction, and the gaps *inside* the reversed run keep their lengths - so the whole
// delta is the two gaps at the ends:
//     before   dist(A,B) + dist(C,D)
//     after    dist(A,C) + dist(B,D)
// Windowing j keeps this near-linear on big plots; NN order is already spatially
// coherent, so improving pairs are nearly always close together in the sequence.
// =========================================================================
function refineWithTwoOpt(paths, budgetMs) {
    const n = paths.length;
    if (n < 4) return paths;

    const first = (p) => p[0];
    const last = (p) => p[p.length - 1];
    const gap = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
    const ORIGIN = { x: 0, y: 0 };

    const window = n > 2000 ? 200 : n;
    const deadline = Date.now() + budgetMs;
    let improved = true;

    while (improved) {
        improved = false;
        for (let i = 0; i < n - 1; i++) {
            if (Date.now() > deadline) return paths;

            const A = i === 0 ? ORIGIN : last(paths[i - 1]);
            const B = first(paths[i]);
            const distAB = gap(A, B);
            const limit = Math.min(n - 1, i + window);

            for (let j = i + 1; j <= limit; j++) {
                const C = last(paths[j]);
                const D = j === n - 1 ? ORIGIN : first(paths[j + 1]);

                const delta = (gap(A, C) + gap(B, D)) - (distAB + gap(C, D));
                if (delta < -1e-9) {
                    // Reverse the run, and each stroke inside it, so ends still meet.
                    const block = paths.slice(i, j + 1).reverse();
                    for (let k = 0; k < block.length; k++) block[k] = block[k].slice().reverse();
                    for (let k = 0; k < block.length; k++) paths[i + k] = block[k];
                    improved = true;
                    break;
                }
            }
        }
    }
    return paths;
}

function routeCost(paths) {
    let total = 0;
    let cursor = { x: 0, y: 0 };
    for (const path of paths) {
        total += Math.hypot(path[0].x - cursor.x, path[0].y - cursor.y);
        cursor = path[path.length - 1];
    }
    return total + Math.hypot(cursor.x, cursor.y);
}

// Turns the planned route into G-code and reports what the plot will cost.
function serializeGCode(planned) {
    const down = penDownLines();
    const up = penUpLines();
    const dwell = getDwellSeconds();
    const dwellLine = dwell > 0 ? `G4 P${dwell.toFixed(3)}` : null;

    gcodeLines.push("(--- gCoded Initialization ---)");
    gcodeLines.push("G21 (Set units to millimeters)");
    gcodeLines.push("G90 (Absolute positioning mode)");
    // Without a modal feedrate GRBL rejects the first G1 with "error:22".
    gcodeLines.push(`F${getFeedRate()} (Feedrate for drawing moves)`);
    for (const line of customLines("preamble")) gcodeLines.push(line);
    for (const line of up) gcodeLines.push(line);

    let drawDist = 0, travelDist = 0;
    let maxX = 0, maxY = 0;
    let cursor = { x: 0, y: 0 };

    for (const path of planned) {
        travelDist += Math.hypot(path[0].x - cursor.x, path[0].y - cursor.y);
        gcodeLines.push(`G0 X${path[0].x.toFixed(3)} Y${path[0].y.toFixed(3)}`);
        for (const line of down) gcodeLines.push(line);
        if (dwellLine) gcodeLines.push(dwellLine);

        for (let i = 1; i < path.length; i++) {
            drawDist += Math.hypot(path[i].x - path[i - 1].x, path[i].y - path[i - 1].y);
            gcodeLines.push(`G1 X${path[i].x.toFixed(3)} Y${path[i].y.toFixed(3)}`);
        }
        for (const point of path) {
            if (point.x > maxX) maxX = point.x;
            if (point.y > maxY) maxY = point.y;
        }

        for (const line of up) gcodeLines.push(line);
        if (dwellLine) gcodeLines.push(dwellLine);
        cursor = path[path.length - 1];
    }

    travelDist += Math.hypot(cursor.x, cursor.y);
    gcodeLines.push("G0 X0 Y0 (Return to origin)");
    for (const line of customLines("postamble")) gcodeLines.push(line);
    gcodeLines.push("M2 (Program end)");

    return { drawDist, travelDist, maxX, maxY };
}

// Re-writes the G-code, stats and preview from previewPaths. Called after generating
// and after every path deletion, so the download always matches what is on screen.
function rebuildOutput() {
    gcodeLines = [];
    showStats(serializeGCode(previewPaths), previewPaths);
    document.getElementById("gcodeDisplayBox").textContent = gcodeLines.slice(0, 100).join('\n');
    drawGCodePreview();
}

// Warn before the machine finds out the hard way.
function boundsWarning(stats) {
    const limitX = numField("machineMaxX", 0);
    const limitY = numField("machineMaxY", 0);
    const over = [];
    if (limitX > 0 && stats.maxX > limitX) over.push(`X ${stats.maxX.toFixed(0)} &gt; ${limitX}`);
    if (limitY > 0 && stats.maxY > limitY) over.push(`Y ${stats.maxY.toFixed(0)} &gt; ${limitY}`);
    if (!over.length) return "";
    return `<br><span style="color:#ff3b6b">exceeds machine travel: ${over.join(", ")}</span>`;
}

function showStats(stats, planned) {
    const place = getLayout();
    const minutes = stats.drawDist / getFeedRate()
        + stats.travelDist / ASSUMED_RAPID_MM_MIN
        + (planned.length * 2 * getDwellSeconds()) / 60;
    document.getElementById("gcodeStats").innerHTML =
        `<strong>${planned.length}</strong> strokes &middot; ` +
        `<strong>${gcodeLines.length.toLocaleString()}</strong> lines<br>` +
        `draw <strong>${(stats.drawDist / 1000).toFixed(2)} m</strong> &middot; ` +
        `travel <strong>${(stats.travelDist / 1000).toFixed(2)} m</strong> ` +
        `(${Math.round(100 * stats.travelDist / Math.max(stats.drawDist, 1e-9))}%)<br>` +
        `drawing <strong>${place.drawW.toFixed(0)} &times; ${place.drawH.toFixed(0)} mm</strong> ` +
        `<span style="color:#52525b">on ${place.paperW} &times; ${place.paperH}</span><br>` +
        `est. plot time <strong>${minutes < 1 ? "<1" : Math.round(minutes)} min</strong> ` +
        `<span style="color:#52525b">@ ${getFeedRate()} mm/min</span>` +
        (lastRouteGain > 0.001 ? `<br><span style="color:#52525b">2-opt cut travel a further ${(lastRouteGain * 100).toFixed(0)}%</span>` : "") +
        boundsWarning(stats) +
        (deletedPaths.length ? `<br><span style="color:#52525b">${deletedPaths.length} path(s) deleted by hand</span>` : "");
}

imageLoader.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (event) => {
        const img = new Image();
        img.onload = () => {
            canvas.width = img.width;
            canvas.height = img.height;
            ctx.drawImage(img, 0, 0);

            const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
            imgPixels = imgData.data;

            refreshTonePreview();
            console.log("Image Loaded Successfully!");
        };
        img.src = event.target.result;
    };
    reader.readAsDataURL(file);
});

// --- Global App Triggers ---
processBtn.addEventListener("click", () => {
    if (!imgPixels) {
        alert("No image selected!");
        return;
    }
    generateGCode();
});

function saveFile(text, filename, mime) {
    const blob = new Blob([text], { type: mime });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(link.href);
}

document.getElementById("downloadBtn").addEventListener("click", () => {
    if (!gcodeLines || gcodeLines.length === 0) {
        alert("Please generate G-Code first!");
        return;
    }
    saveFile(gcodeLines.join("\n"), "gcoded.nc", "text/plain");
});

// SVG is the interchange format for AxiDraw, Inkscape and friends, so the same plot
// can go somewhere other than straight down a serial port.
function buildSvg() {
    const place = getLayout();
    const w = place.paperW, h = place.paperH;
    const out = [
        `<?xml version="1.0" encoding="UTF-8"?>`,
        `<svg xmlns="http://www.w3.org/2000/svg" width="${w}mm" height="${h}mm" viewBox="0 0 ${w} ${h}">`,
        `<g fill="none" stroke="#000000" stroke-width="${getPenWidth()}" stroke-linecap="round" stroke-linejoin="round">`
    ];
    for (const path of previewPaths) {
        // SVG measures Y downwards from the top; our millimetres run up from the bottom.
        const points = path.map(pt => `${pt.x.toFixed(3)},${(h - pt.y).toFixed(3)}`).join(" ");
        out.push(`<polyline points="${points}"/>`);
    }
    out.push("</g>", "</svg>");
    return out.join("\n");
}

document.getElementById("saveSvgBtn").addEventListener("click", () => {
    if (!previewPaths.length) {
        alert("Please generate G-Code first!");
        return;
    }
    saveFile(buildSvg(), "gcoded.svg", "image/svg+xml");
});

function generateGCode() {
    gcodeLines = [];
    previewPaths = [];
    collectedStrokes = [];
    layout = computeLayout();
    brightnessMap = buildBrightnessMap();
    drawHistogram();

    let myThresholds = [];
    let outlineThreshold = parseInt(document.getElementById("outlineThresh").value) || 128;

    if (engineMode.value === "bw") {
        myThresholds = [{
            cutoff: parseInt(document.getElementById("bwThresh").value),
            spacing: parseFloat(document.getElementById("bwDensity").value),
            pattern: fillPattern.value,
            angle1: parseFloat(document.getElementById("fillAngle1").value) || 0,
            angle2: parseFloat(document.getElementById("fillAngle2").value) || 90
        }];
    } else if (engineMode.value === "shading") {
        const rows = document.querySelectorAll(".layer-row");
        rows.forEach(row => {
            myThresholds.push({
                cutoff: parseInt(row.querySelector(".layer-cutoff").value) || 255,
                spacing: parseFloat(row.querySelector(".layer-spacing").value) || 1.5,
                pattern: row.querySelector(".layer-pattern").value,
                angle1: parseFloat(row.querySelector(".layer-angle1").value) || 0,
                angle2: parseFloat(row.querySelector(".layer-angle2").value) || 0
            });
        });
        myThresholds.sort((a, b) => a.cutoff - b.cutoff);
    } else if (engineMode.value === "outline") {
        outlineImage(outlineThreshold);
    }

    // 2. Fire Fill Pass Generators
    if (engineMode.value !== "outline") {
        myThresholds.forEach((layer, index) => {
            executeAdvancedPass(myThresholds, index);
        });
    }

    // 3. Fire Overlay Outliner
    if (enableOutlineCheckbox && enableOutlineCheckbox.checked && engineMode.value !== "outline") {
        outlineImage(outlineThreshold);
    }

    const planned = planStrokes(collectedStrokes);

    const optimize = document.getElementById("optimizePath");
    if (optimize && optimize.checked) {
        const before = routeCost(planned);
        refineWithTwoOpt(planned, 1500);
        lastRouteGain = before > 0 ? 1 - routeCost(planned) / before : 0;
    } else {
        lastRouteGain = 0;
    }

    previewPaths = planned;
    deletedPaths = [];
    updateEditButtons();
    rebuildOutput();
}

// =========================================================================
// UNIVERSAL RADIAL & TRIGONOMETRIC MULTI-PATTERN CORE ENGINE
// =========================================================================
function executeAdvancedPass(thresholdList, activeIndex) {
    const layer = thresholdList[activeIndex];
    const minBright = activeIndex === 0 ? 0 : thresholdList[activeIndex - 1].cutoff + 1;
    const maxBright = layer.cutoff;

    const scale = getScale();
    // layer.spacing is millimetres on the paper; the scan loops below work in pixels.
    const spacing = Math.max(1, layer.spacing / scale);

    function isTargetPixel(x, y) {
        if (x < 0 || x >= canvas.width || y < 0 || y >= canvas.height) return false;
        const brightness = brightnessMap[Math.floor(y) * canvas.width + Math.floor(x)];
        return (brightness >= minBright && brightness <= maxBright);
    }

    // Sampling stays per-pixel for accuracy; points are buffered and only collapsed
    // into real geometry on liftPen, so a straight hatch run costs 2 moves, not 300.
    let currentStroke = [];

    function addPoint(x, y) {
        currentStroke.push({ x: x * scale, y: (canvas.height - y) * scale });
    }

    function liftPen() {
        if (currentStroke.length) {
            emitStroke(currentStroke);
            currentStroke = [];
        }
    }

    // --- TOPOGRAPHIC ISO-CONTOURS ---
    if (layer.pattern === "contour") {
        const levels = getContourLevels();
        for (let i = 1; i <= levels; i++) {
            const level = minBright + ((maxBright - minBright) * i) / (levels + 1);
            for (const path of contoursToMm(traceIsoContours(level), scale)) emitStroke(path);
        }
        return;
    }

    // --- STIPPLE DOTS ---
    if (layer.pattern === "stipple") {
        // A dot is plotted as a dash one pen-width long; anything shorter is a pen
        // touch the machine may not register.
        const dash = Math.max(0.12, getPenWidth() * 0.6);
        for (const dot of stipplePoints(spacing, minBright, maxBright)) {
            const x = dot.x * scale, y = (canvas.height - dot.y) * scale;
            emitStroke([{ x: x - dash / 2, y: y }, { x: x + dash / 2, y: y }], 0);
        }
        return;
    }

    // --- ONE CONTINUOUS LINE THROUGH EVERY DOT ---
    if (layer.pattern === "tsp") {
        const dots = stipplePoints(spacing, minBright, maxBright)
            .map(d => ({ x: d.x * scale, y: (canvas.height - d.y) * scale }));
        if (dots.length >= 2) emitStroke(tspTour(dots), 0);
        return;
    }

    // --- FLOW FIELD ---
    if (layer.pattern === "flowfield") {
        flowFieldPass(layer, spacing, scale, isTargetPixel);
        return;
    }

    // --- 1. CONCENTRIC SPIRAL SUB-ENGINE ---
    if (layer.pattern === "concentric") {
        let cx = canvas.width / 2;
        let cy = canvas.height / 2;
        let maxRadius = Math.max(canvas.width, canvas.height) / Math.sqrt(2);

        for (let r = maxRadius; r > 0; r -= spacing) {
            let steps = Math.floor(2 * Math.PI * r);
            for (let s = 0; s <= steps; s++) {
                let theta = (s / steps) * 2 * Math.PI;
                let px = cx + r * Math.cos(theta);
                let py = cy + r * Math.sin(theta);

                if (isTargetPixel(px, py)) {
                    addPoint(px, py);
                } else {
                    liftPen();
                }
            }
            liftPen();
        }
        return;
    }

    // --- 2. OLD-SCHOOL HARDCODED DIAGONAL FALLBACK ---
    if (layer.pattern === "diagonal") {
        let maxK = canvas.width + canvas.height;
        const kStep = spacing * Math.SQRT2; // perpendicular gap == requested spacing
        for (let k = 1; k < maxK; k += kStep) {
            for (let x = 0; x < canvas.width; x++) {
                let y = k - x;
                if (isTargetPixel(x, y)) addPoint(x, y);
                else liftPen();
            }
            liftPen();
        }
        for (let k = 1; k < maxK; k += kStep) {
            for (let x = 0; x < canvas.width; x++) {
                let targetX = (canvas.width - 1) - x;
                let y = k - x;
                if (isTargetPixel(targetX, y)) addPoint(targetX, y);
                else liftPen();
            }
            liftPen();
        }
        return;
    }

    // --- 3. CUSTOM ROTATIONAL TRIGONOMETRIC LINE ENGINE (Hatch / Cross-Hatch) ---
    function renderLineAngle(angle) {
        let rad = (angle * Math.PI) / 180;
        let cos = Math.cos(rad);
        let sin = Math.sin(rad);
        let diag = Math.hypot(canvas.width, canvas.height);

        for (let offset = -diag; offset < diag; offset += spacing) {
            for (let step = -diag; step < diag; step += 1) {
                let px = canvas.width / 2 + offset * (-sin) + step * cos;
                let py = canvas.height / 2 + offset * cos + step * sin;

                if (isTargetPixel(px, py)) {
                    addPoint(px, py);
                } else {
                    liftPen();
                }
            }
            liftPen();
        }
    }

    if (layer.pattern === "hatch" || layer.pattern === "crosshatch") {
        renderLineAngle(layer.angle1);
    }
    if (layer.pattern === "crosshatch") {
        renderLineAngle(layer.angle2);
    }
}

// =========================================================================
// STIPPLING
// Error diffusion over a coarse grid: each cell's wanted ink coverage is rounded to a
// dot or no dot and the rounding error is pushed to neighbours, so dot DENSITY tracks
// tone without the dots landing on a visible lattice.
// =========================================================================
function getContourLevels() {
    const n = parseInt(document.getElementById("contourLevels").value);
    return isNaN(n) ? 12 : Math.max(1, Math.min(64, n));
}

// Deterministic jitter, so regenerating the same image gives the same plot.
function jitter(c, r) {
    const v = Math.sin(c * 127.1 + r * 311.7) * 43758.5453;
    return v - Math.floor(v) - 0.5;
}

function stipplePoints(spacingPx, minBright, maxBright) {
    const w = canvas.width, h = canvas.height;
    const cell = Math.max(1, spacingPx);
    const cols = Math.max(1, Math.floor(w / cell));
    const rows = Math.max(1, Math.floor(h / cell));

    // Wanted ink coverage per cell, 0..1, counting only pixels inside this layer's band.
    const want = new Float32Array(cols * rows);
    for (let r = 0; r < rows; r++) {
        const y0 = Math.floor(r * cell), y1 = Math.min(h, Math.floor((r + 1) * cell));
        for (let c = 0; c < cols; c++) {
            const x0 = Math.floor(c * cell), x1 = Math.min(w, Math.floor((c + 1) * cell));
            let darkness = 0;
            for (let y = y0; y < y1; y++) {
                for (let x = x0; x < x1; x++) {
                    const v = brightnessMap[y * w + x];
                    if (v >= minBright && v <= maxBright) darkness += (255 - v) / 255;
                }
            }
            const area = Math.max(1, (x1 - x0) * (y1 - y0));
            want[r * cols + c] = darkness / area;
        }
    }

    const points = [];
    for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
            const i = r * cols + c;
            const on = want[i] > 0.5 ? 1 : 0;
            const err = want[i] - on;
            if (on) {
                points.push({
                    x: (c + 0.5 + jitter(c, r) * 0.7) * cell,
                    y: (r + 0.5 + jitter(r, c) * 0.7) * cell
                });
            }
            // Floyd-Steinberg weights.
            if (c + 1 < cols) want[i + 1] += err * 7 / 16;
            if (r + 1 < rows) {
                if (c > 0) want[i + cols - 1] += err * 3 / 16;
                want[i + cols] += err * 5 / 16;
                if (c + 1 < cols) want[i + cols + 1] += err * 1 / 16;
            }
        }
    }
    return points;
}

// =========================================================================
// TSP TOUR - one unbroken line through every stipple dot
// =========================================================================
function buildPointGrid(points) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of points) {
        if (p.x < minX) minX = p.x;
        if (p.x > maxX) maxX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.y > maxY) maxY = p.y;
    }
    const span = Math.max(maxX - minX, maxY - minY) || 1;
    const cell = span / Math.max(4, Math.ceil(Math.sqrt(points.length)));
    const cols = Math.floor((maxX - minX) / cell) + 1;
    const rows = Math.floor((maxY - minY) / cell) + 1;
    const buckets = new Map();
    const colOf = (p) => Math.min(cols - 1, Math.max(0, Math.floor((p.x - minX) / cell)));
    const rowOf = (p) => Math.min(rows - 1, Math.max(0, Math.floor((p.y - minY) / cell)));
    points.forEach((p, i) => {
        const key = rowOf(p) * cols + colOf(p);
        if (!buckets.has(key)) buckets.set(key, []);
        buckets.get(key).push(i);
    });
    return { cell, cols, rows, buckets, colOf, rowOf };
}

function tspTour(points) {
    const n = points.length;
    if (n < 3) return points.slice();

    const grid = buildPointGrid(points);
    const used = new Uint8Array(n);

    function nearestUnused(from) {
        const pcx = grid.colOf(from), pcy = grid.rowOf(from);
        let best = -1, bestD = Infinity;
        const maxRing = Math.max(grid.cols, grid.rows);
        for (let k = 0; k <= maxRing; k++) {
            if (best >= 0 && (k - 1) * grid.cell > bestD) break;
            for (let cy = pcy - k; cy <= pcy + k; cy++) {
                if (cy < 0 || cy >= grid.rows) continue;
                for (let cx = pcx - k; cx <= pcx + k; cx++) {
                    if (cx < 0 || cx >= grid.cols) continue;
                    if (k > 0 && cx !== pcx - k && cx !== pcx + k && cy !== pcy - k && cy !== pcy + k) continue;
                    for (const i of grid.buckets.get(cy * grid.cols + cx) || []) {
                        if (used[i]) continue;
                        const d = Math.hypot(points[i].x - from.x, points[i].y - from.y);
                        if (d < bestD) { bestD = d; best = i; }
                    }
                }
            }
        }
        return best;
    }

    const tour = [points[0]];
    used[0] = 1;
    let cursor = points[0];
    for (let k = 1; k < n; k++) {
        const next = nearestUnused(cursor);
        if (next < 0) break;
        used[next] = 1;
        cursor = points[next];
        tour.push(cursor);
    }

    // Same 2-opt argument as the stroke router: reversing an interior run leaves every
    // gap inside it unchanged, so the delta is just the two gaps at the ends.
    const gap = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
    const deadline = Date.now() + 2000;
    const window = tour.length > 2000 ? 200 : tour.length;
    let improved = true;
    while (improved) {
        improved = false;
        for (let i = 1; i < tour.length - 2; i++) {
            if (Date.now() > deadline) return tour;
            const limit = Math.min(tour.length - 2, i + window);
            for (let j = i + 1; j <= limit; j++) {
                const delta = (gap(tour[i - 1], tour[j]) + gap(tour[i], tour[j + 1]))
                            - (gap(tour[i - 1], tour[i]) + gap(tour[j], tour[j + 1]));
                if (delta < -1e-9) {
                    let a = i, b = j;
                    while (a < b) { const t = tour[a]; tour[a] = tour[b]; tour[b] = t; a++; b--; }
                    improved = true;
                    break;
                }
            }
        }
    }
    return tour;
}

// =========================================================================
// FLOW FIELD HATCHING
// Hatch lines follow the image's own structure instead of a fixed angle: the Sobel
// gradient points across an edge, so travelling PERPENDICULAR to it runs along the
// form. Streamlines are seeded on a grid and stop when they reach ground another
// streamline already covers, which keeps them evenly spaced (Jobard & Lefer).
// =========================================================================
function flowFieldPass(layer, spacingPx, scale, isTargetPixel) {
    const w = canvas.width, h = canvas.height;
    const cell = Math.max(1, spacingPx);
    const gCols = Math.ceil(w / cell), gRows = Math.ceil(h / cell);
    const occupied = new Uint8Array(gCols * gRows);
    const fallback = (layer.angle1 * Math.PI) / 180;

    function direction(x, y) {
        const xi = Math.min(w - 2, Math.max(1, Math.floor(x)));
        const yi = Math.min(h - 2, Math.max(1, Math.floor(y)));
        const at = (dx, dy) => brightnessMap[(yi + dy) * w + (xi + dx)];
        const gx = (at(1, -1) + 2 * at(1, 0) + at(1, 1)) - (at(-1, -1) + 2 * at(-1, 0) + at(-1, 1));
        const gy = (at(-1, 1) + 2 * at(0, 1) + at(1, 1)) - (at(-1, -1) + 2 * at(0, -1) + at(1, -1));
        const mag = Math.hypot(gx, gy);
        // Flat ground has no meaningful gradient; fall back to the layer's angle.
        if (mag < 12) return { x: Math.cos(fallback), y: Math.sin(fallback) };
        return { x: -gy / mag, y: gx / mag };
    }

    const cellAt = (x, y) => Math.floor(y / cell) * gCols + Math.floor(x / cell);

    function streamline(startX, startY, initialSign) {
        const pts = [];
        let x = startX, y = startY, prev = null;
        for (let step = 0; step < 4000; step++) {
            if (x < 0 || x >= w || y < 0 || y >= h) break;
            if (!isTargetPixel(x, y)) break;
            if (pts.length > 2 && occupied[cellAt(x, y)]) break;
            pts.push({ x, y });

            let d = direction(x, y);
            // The field is undirected, so keep stepping the same way we were going.
            if (prev === null) d = { x: d.x * initialSign, y: d.y * initialSign };
            else if (d.x * prev.x + d.y * prev.y < 0) d = { x: -d.x, y: -d.y };
            prev = d;
            x += d.x;
            y += d.y;
        }
        return pts;
    }

    for (let sy = cell / 2; sy < h; sy += cell) {
        for (let sx = cell / 2; sx < w; sx += cell) {
            if (!isTargetPixel(sx, sy)) continue;
            if (occupied[cellAt(sx, sy)]) continue;

            const forward = streamline(sx, sy, 1);
            const backward = streamline(sx, sy, -1);
            const full = backward.slice(1).reverse().concat(forward);
            if (full.length < 3) continue;

            for (const p of full) {
                const c = cellAt(p.x, p.y);
                if (c >= 0 && c < occupied.length) occupied[c] = 1;
            }
            emitStroke(full.map(p => ({ x: p.x * scale, y: (h - p.y) * scale })));
        }
    }
}

// =========================================================================
// LOOKS - named presets
// Presets are pure DATA over the same controls Pro mode exposes, never a separate code
// path. That is what lets Baby mode hand off to Pro with your values carried over,
// instead of the two modes drifting apart.
// =========================================================================
const LOOKS = {
    portrait: {
        hint: "Crosshatched tonal portrait in three shading layers.",
        settings: { engineMode: "shading", smoothMode: "median", smoothing: "0.25",
                    gamma: "115", contrast: "10", autoLevels: true, optimizePath: true,
                    enableOutlineOverlay: false, penDwell: "120" },
        layers: [{ cutoff: 70, spacing: 0.7, pattern: "crosshatch", a1: 45, a2: 135 },
                 { cutoff: 140, spacing: 1.2, pattern: "crosshatch", a1: 0, a2: 90 },
                 { cutoff: 205, spacing: 2.0, pattern: "hatch", a1: 20, a2: 110 }]
    },
    sketch: {
        hint: "Hatching that follows the form, the way pencil shading does.",
        settings: { engineMode: "shading", smoothMode: "median", smoothing: "0.3",
                    gamma: "110", contrast: "5", autoLevels: true, optimizePath: true },
        layers: [{ cutoff: 90, spacing: 0.8, pattern: "flowfield", a1: 45, a2: 135 },
                 { cutoff: 170, spacing: 1.4, pattern: "flowfield", a1: 45, a2: 135 },
                 { cutoff: 225, spacing: 2.4, pattern: "flowfield", a1: 45, a2: 135 }]
    },
    lineart: {
        hint: "Outlines only, no fill. Fastest thing here to plot.",
        settings: { engineMode: "outline", outlineThresh: "128", smoothMode: "median",
                    smoothing: "0.3", contrast: "25", autoLevels: true }
    },
    topographic: {
        hint: "Nested iso-brightness contours, like a map.",
        settings: { engineMode: "bw", fillPattern: "contour", bwThresh: "255",
                    contourLevels: "16", smoothMode: "box", smoothing: "0.4", autoLevels: true }
    },
    stipple: {
        hint: "Dot density follows tone. Slow to plot, lovely up close.",
        settings: { engineMode: "bw", fillPattern: "stipple", bwThresh: "235",
                    bwDensity: "0.8", smoothing: "0.2", gamma: "110", autoLevels: true }
    },
    oneline: {
        hint: "One unbroken line through the whole image. The pen never lifts.",
        settings: { engineMode: "bw", fillPattern: "tsp", bwThresh: "235",
                    bwDensity: "1.0", smoothing: "0.25", penDwell: "0", autoLevels: true }
    },
    poster: {
        hint: "Coarse, high contrast, quick to plot.",
        settings: { engineMode: "bw", fillPattern: "crosshatch", bwThresh: "150",
                    bwDensity: "2.2", contrast: "45", smoothing: "0.35",
                    enableOutlineOverlay: true, outlineThresh: "110", autoLevels: true }
    },
    engraving: {
        hint: "Very fine dense hatching. Long plot, high detail.",
        settings: { engineMode: "shading", smoothMode: "median", smoothing: "0.15",
                    gamma: "105", autoLevels: true },
        layers: [{ cutoff: 60, spacing: 0.35, pattern: "crosshatch", a1: 45, a2: 135 },
                 { cutoff: 120, spacing: 0.55, pattern: "crosshatch", a1: 15, a2: 105 },
                 { cutoff: 180, spacing: 0.85, pattern: "hatch", a1: 75, a2: 165 },
                 { cutoff: 230, spacing: 1.4, pattern: "hatch", a1: 45, a2: 135 }]
    }
};

// Set while a preset is being applied, so the resulting change events don't immediately
// flip the look back to "Custom".
let applyingPreset = false;

function applyLook(name) {
    const look = LOOKS[name];
    const hint = document.getElementById("lookHint");
    if (!look) {
        if (hint) hint.textContent = "Every setting is yours to change.";
        return;
    }

    applyingPreset = true;
    for (const [id, value] of Object.entries(look.settings)) {
        const el = document.getElementById(id);
        if (!el) continue;
        if (el.type === "checkbox") el.checked = !!value;
        else el.value = value;
    }

    if (look.layers) {
        layersContainer.innerHTML = "";
        for (const l of look.layers) createLayerRow(l.cutoff, l.spacing, l.pattern, l.a1, l.a2);
    }

    if (hint) hint.textContent = look.hint;
    applyingPreset = false;

    updateUiPanels();
    refreshTonePreview();
}

const lookPreset = document.getElementById("lookPreset");
lookPreset.addEventListener("change", () => applyLook(lookPreset.value));

// Touching any control by hand means this is no longer one of the named looks.
document.querySelector(".sidebar").addEventListener("input", (e) => {
    if (applyingPreset) return;
    if (e.target.id === "lookPreset" || e.target.id === "uiMode") return;
    if (lookPreset.value !== "custom") {
        lookPreset.value = "custom";
        const hint = document.getElementById("lookHint");
        if (hint) hint.textContent = "Every setting is yours to change.";
    }
});

const uiMode = document.getElementById("uiMode");
function applyUiMode() {
    document.body.classList.toggle("baby-mode", uiMode.value === "baby");
}
uiMode.addEventListener("change", applyUiMode);

// Machine profile decides whether the pen is a servo or a Z axis.
const machineProfile = document.getElementById("machineProfile");
function applyMachineProfile() {
    const zMode = getPenMode();
    document.getElementById("servoPenBlock").style.display = zMode === "z" ? "none" : "block";
    document.getElementById("zPenBlock").style.display = zMode === "z" ? "block" : "none";
}
machineProfile.addEventListener("change", applyMachineProfile);

// =========================================================================
// UNIFIED UI SIDEBAR MANAGER
// =========================================================================
function updateUiPanels() {
    const mode = engineMode.value;
    const pattern = fillPattern.value;

    if (mode === "bw") {
        bwOptionsPanel.style.display = "block";
        shadingOptionsPanel.style.display = "none";
        globalPatternContainer.style.display = "block";
    } else if (mode === "shading") {
        bwOptionsPanel.style.display = "none";
        shadingOptionsPanel.style.display = "block";
        globalPatternContainer.style.display = "none";
    } else if (mode === "outline") {
        bwOptionsPanel.style.display = "none";
        shadingOptionsPanel.style.display = "none";
        globalPatternContainer.style.display = "none";
    }

    if (mode === "bw" && (pattern === "hatch" || pattern === "crosshatch" || pattern === "flowfield")) {
        globalAngleContainer.style.display = "block";
        angle2Block.style.display = (pattern === "crosshatch") ? "block" : "none";
    } else {
        globalAngleContainer.style.display = "none";
    }

    const contourBlock = document.getElementById("contourLevelsBlock");
    if (contourBlock) contourBlock.style.display = (mode === "bw" && pattern === "contour") ? "block" : "none";

    if (mode === "outline" || enableOutlineCheckbox.checked) {
        outlineOptionsPanel.style.display = "block";
    } else {
        outlineOptionsPanel.style.display = "none";
    }

    if (mode === "outline") {
        outlineOverlayContainer.style.display = "none";
    } else {
        outlineOverlayContainer.style.display = "block";
    }
}

const paperPreset = document.getElementById("paperPreset");
paperPreset.addEventListener("change", () => {
    if (paperPreset.value === "custom") return;
    const [w, h] = paperPreset.value.split("x");
    document.getElementById("paperWidth").value = w;
    document.getElementById("paperHeight").value = h;
});

// Typing a size by hand means it is no longer one of the presets.
["paperWidth", "paperHeight"].forEach(id => {
    document.getElementById(id).addEventListener("input", () => {
        const current = `${getPaperWidth()}x${getPaperHeight()}`;
        paperPreset.value = [...paperPreset.options].some(o => o.value === current) ? current : "custom";
    });
});

["brightness", "contrast", "gamma", "autoLevels", "invertImage", "smoothMode", "smoothing"]
    .forEach(id => {
        const el = document.getElementById(id);
        if (el) el.addEventListener("input", refreshTonePreview);
    });

engineMode.addEventListener("change", updateUiPanels);
fillPattern.addEventListener("change", updateUiPanels);
enableOutlineCheckbox.addEventListener("change", updateUiPanels);

// =========================================================================
// DYNAMIC SHADING MULTI-TIER ENGINE INJECTOR
// =========================================================================
const layersContainer = document.getElementById("layersContainer");
const addLayerBtn = document.getElementById("addLayerBtn");

function createLayerRow(cutoffVal = 128, spacingVal = 1.5, patternVal = "crosshatch", angle1Val = 45, angle2Val = 135) {
    const row = document.createElement("div");
    row.className = "layer-row";

    // Each field is wrapped, so the grid in style.css places whole label+input blocks
    // rather than depending on the order of loose children.
    row.innerHTML = `
        <div class="layer-head">
            <strong>Layer</strong>
            <button type="button" class="remove-layer-btn" title="Remove this layer">&times;</button>
        </div>

        <div class="layer-field">
            <label>Threshold</label>
            <input type="number" class="layer-cutoff" value="${cutoffVal}" min="0" max="255">
        </div>

        <div class="layer-field">
            <label>Spacing (mm)</label>
            <input type="number" class="layer-spacing" value="${spacingVal}" min="0.05" step="0.1">
        </div>

        <div class="layer-field layer-span">
            <label>Pattern</label>
            <select class="layer-pattern">
                <option value="crosshatch" ${patternVal === 'crosshatch' ? 'selected' : ''}>Cross-Hatch</option>
                <option value="hatch" ${patternVal === 'hatch' ? 'selected' : ''}>Hatch</option>
                <option value="diagonal" ${patternVal === 'diagonal' ? 'selected' : ''}>Diagonal</option>
                <option value="concentric" ${patternVal === 'concentric' ? 'selected' : ''}>Concentric / Spiral</option>
                <option value="flowfield" ${patternVal === 'flowfield' ? 'selected' : ''}>Flow Field</option>
                <option value="contour" ${patternVal === 'contour' ? 'selected' : ''}>Topographic Contours</option>
                <option value="stipple" ${patternVal === 'stipple' ? 'selected' : ''}>Stipple Dots</option>
                <option value="tsp" ${patternVal === 'tsp' ? 'selected' : ''}>One Continuous Line</option>
            </select>
        </div>

        <div class="layer-field l-angle1-block">
            <label>Angle 1</label>
            <input type="number" class="layer-angle1" value="${angle1Val}" min="0" max="360">
        </div>

        <div class="layer-field l-angle2-block">
            <label>Angle 2</label>
            <input type="number" class="layer-angle2" value="${angle2Val}" min="0" max="360">
        </div>
    `;

    const patternSelect = row.querySelector(".layer-pattern");
    const angle1Block = row.querySelector(".l-angle1-block");
    const angle2Block = row.querySelector(".l-angle2-block");

    function adjustRowAngleVisibility() {
        const p = patternSelect.value;
        if (p === "hatch" || p === "crosshatch" || p === "flowfield") {
            angle1Block.style.display = "flex";
            angle2Block.style.display = (p === "crosshatch") ? "flex" : "none";
        } else {
            angle1Block.style.display = "none";
            angle2Block.style.display = "none";
        }
    }

    patternSelect.addEventListener("change", adjustRowAngleVisibility);
    adjustRowAngleVisibility();

    row.querySelector(".remove-layer-btn").addEventListener("click", () => row.remove());
    layersContainer.appendChild(row);
}

addLayerBtn.addEventListener("click", () => {
    createLayerRow(128, 1.5, "crosshatch", 45, 135);
});

// Setup baseline crosshatch layered defaults safely
createLayerRow(64, 0.8, "crosshatch", 45, 135);
createLayerRow(128, 1.4, "crosshatch", 0, 90);
createLayerRow(192, 2.4, "crosshatch", 15, 105);

// Core Input Range Valuations
document.getElementById("bwThresh").addEventListener("change", (e) => {
    let val = parseInt(e.target.value);
    if (isNaN(val) || val < 1) e.target.value = 1;
    else if (val > 255) e.target.value = 255;
});
document.getElementById("bwDensity").addEventListener("change", (e) => {
    let val = parseFloat(e.target.value);
    if (isNaN(val) || val < 0.05) e.target.value = 0.05;
});
document.getElementById("outlineThresh").addEventListener("change", (e) => {
    let val = parseInt(e.target.value);
    if (isNaN(val) || val < 0) e.target.value = 0;
    else if (val > 255) e.target.value = 255;
});

updateUiPanels();
applyUiMode();
applyMachineProfile();
applyLook(lookPreset.value);
refreshTonePreview();

// =========================================================================
// RDP VECTOR OUTLINE GENERATION ENGINE
// =========================================================================
// Returns iso-contours of the brightness field at `threshold`, as chains of points in
// PIXEL space. Shared by the outline engine and the topographic fill pattern.
function traceIsoContours(threshold) {
    const width = canvas.width;
    const height = canvas.height;
    const field = brightnessMap;

    // Marching squares over the GREYSCALE field. The old detector scanned diagonals and
    // marked transition pixels into a grid, then chained them 8-connected - wherever that
    // mark band was thicker than one pixel (any soft or anti-aliased edge) the greedy walk
    // snaked through it and filled the band in. Marching squares instead emits one clean
    // curve per boundary, and interpolating the crossing along each cell edge puts it at
    // sub-pixel position, so contours come out smooth instead of stair-stepped.
    const edgePoints = new Map();
    const adj = new Map();

    const hId = (x, y) => (y * width + x) * 2;
    const vId = (x, y) => (y * width + x) * 2 + 1;

    // Where along this cell edge does the brightness actually cross the threshold?
    function crossing(a, b) {
        if (a === b) return 0.5;
        return Math.max(0, Math.min(1, (threshold - a) / (b - a)));
    }
    function hPoint(x, y) {
        return { x: x + crossing(field[y * width + x], field[y * width + x + 1]), y: y };
    }
    function vPoint(x, y) {
        return { x: x, y: y + crossing(field[y * width + x], field[(y + 1) * width + x]) };
    }

    function link(idA, pointA, idB, pointB) {
        if (!edgePoints.has(idA)) edgePoints.set(idA, pointA);
        if (!edgePoints.has(idB)) edgePoints.set(idB, pointB);
        if (!adj.has(idA)) adj.set(idA, []);
        if (!adj.has(idB)) adj.set(idB, []);
        adj.get(idA).push(idB);
        adj.get(idB).push(idA);
    }

    const isDark = (x, y) => (field[y * width + x] <= threshold ? 1 : 0);

    for (let y = 0; y < height - 1; y++) {
        for (let x = 0; x < width - 1; x++) {
            const code = isDark(x, y) * 8 + isDark(x + 1, y) * 4
                       + isDark(x + 1, y + 1) * 2 + isDark(x, y + 1);
            if (code === 0 || code === 15) continue;

            const top    = () => [hId(x, y),     hPoint(x, y)];
            const bottom = () => [hId(x, y + 1), hPoint(x, y + 1)];
            const left   = () => [vId(x, y),     vPoint(x, y)];
            const right  = () => [vId(x + 1, y), vPoint(x + 1, y)];
            const connect = (from, to) => {
                const [idA, pointA] = from();
                const [idB, pointB] = to();
                link(idA, pointA, idB, pointB);
            };

            switch (code) {
                case 1: case 14: connect(left, bottom); break;
                case 2: case 13: connect(bottom, right); break;
                case 3: case 12: connect(left, right); break;
                case 4: case 11: connect(top, right); break;
                case 6: case 9:  connect(top, bottom); break;
                case 7: case 8:  connect(top, left); break;
                // Ambiguous saddles - resolved consistently rather than by corner average.
                case 5:  connect(top, left); connect(bottom, right); break;
                case 10: connect(top, right); connect(left, bottom); break;
            }
        }
    }

    // Link the segments into contours. Open ends first, so a contour that runs off the
    // edge of the image is traced from its end rather than being started in the middle.
    const contours = [];
    const visited = new Set();
    const order = [];
    for (const [id, neighbours] of adj) if (neighbours.length === 1) order.push(id);
    for (const id of adj.keys()) order.push(id);

    for (const start of order) {
        if (visited.has(start)) continue;

        const chain = [];
        let current = start;
        let previous = -1;

        while (current !== undefined && !visited.has(current)) {
            visited.add(current);
            chain.push(edgePoints.get(current));
            let next;
            for (const candidate of adj.get(current) || []) {
                if (candidate !== previous && !visited.has(candidate)) { next = candidate; break; }
            }
            previous = current;
            current = next;
        }

        if (chain.length < 2) continue;
        // Close the loop when the trace came back around to where it started.
        if ((adj.get(previous) || []).includes(start)) chain.push(chain[0]);

        contours.push(chain);
    }
    return contours;
}

// Pixel-space chains -> millimetres, ready for emitStroke.
function contoursToMm(contours, scale) {
    const height = canvas.height;
    return contours.map(chain => chain.map(p => ({ x: p.x * scale, y: (height - p.y) * scale })));
}

function outlineImage(threshold) {
    const scale = getScale();
    for (const path of contoursToMm(traceIsoContours(threshold), scale)) emitStroke(path);
}

function drawGCodePreview() {
    const gCanvas = document.getElementById("gcodeCanvas");
    const gCtx = gCanvas.getContext("2d");

    const place = getLayout();
    const paperW = place.paperW;
    const paperH = place.paperH;

    // Back the canvas at the size it is actually DISPLAYED at. Using the source image
    // resolution meant a 2000px photo was downscaled into the sidebar, smearing every
    // hatch line into uniform grey.
    const dpr = window.devicePixelRatio || 1;
    const cssWidth = gCanvas.clientWidth || 600;
    const canvasW = Math.round(cssWidth * dpr);
    const canvasH = Math.round(canvasW * (paperH / paperW));

    if (gCanvas.width !== canvasW || gCanvas.height !== canvasH) {
        gCanvas.width = canvasW;
        gCanvas.height = canvasH;
    }

    // At zoom 1 the sheet exactly fills the canvas; zooming scales about the centre and
    // pan shifts from there. previewView is the single mapping used for both drawing and
    // hit-testing, so a click always lands where the ink appears.
    const fitScale = canvasW / paperW;
    const scale = fitScale * view.zoom;
    previewView = {
        scale: scale,
        originX: (canvasW - paperW * scale) / 2 + view.panX,
        originY: (canvasH - paperH * scale) / 2 + view.panY,
        paperH: paperH
    };

    const toScreenX = (mmX) => previewView.originX + mmX * scale;
    const toScreenY = (mmY) => previewView.originY + (paperH - mmY) * scale;

    // Everything outside the sheet.
    gCtx.fillStyle = "#0b0b0d";
    gCtx.fillRect(0, 0, canvasW, canvasH);

    // The sheet itself.
    gCtx.fillStyle = "#111113";
    gCtx.fillRect(previewView.originX, previewView.originY, paperW * scale, paperH * scale);
    gCtx.strokeStyle = "#2d2d34";
    gCtx.lineWidth = 1;
    gCtx.strokeRect(previewView.originX, previewView.originY, paperW * scale, paperH * scale);

    // Margin guide, so it is obvious what will fall outside the drawable area.
    if (place.margin > 0) {
        gCtx.setLineDash([4, 4]);
        gCtx.strokeRect(
            toScreenX(place.margin),
            toScreenY(paperH - place.margin),
            (paperW - 2 * place.margin) * scale,
            (paperH - 2 * place.margin) * scale
        );
        gCtx.setLineDash([]);
    }

    // Stroke at the true pen width so the preview shows honestly when lines are packed
    // tighter than the pen can resolve and the fill will plot as solid black.
    gCtx.strokeStyle = "#ffffff";
    gCtx.lineWidth = Math.max(0.75, getPenWidth() * scale);
    gCtx.lineCap = "round";
    gCtx.lineJoin = "round";

    const trace = (path) => {
        gCtx.moveTo(toScreenX(path[0].x), toScreenY(path[0].y));
        for (let i = 1; i < path.length; i++) {
            gCtx.lineTo(toScreenX(path[i].x), toScreenY(path[i].y));
        }
    };

    gCtx.beginPath();
    previewPaths.forEach((path, idx) => {
        if (idx !== hoveredPathIndex) trace(path);
    });
    gCtx.stroke();

    // Draw the path under the cursor last, in the delete colour, so it reads as armed.
    if (hoveredPathIndex >= 0 && previewPaths[hoveredPathIndex]) {
        gCtx.strokeStyle = "#ff3b6b";
        gCtx.lineWidth = Math.max(2, getPenWidth() * scale * 1.8);
        gCtx.beginPath();
        trace(previewPaths[hoveredPathIndex]);
        gCtx.stroke();
    }

    const zoomLabel = document.getElementById("zoomLevel");
    if (zoomLabel) zoomLabel.textContent = `${Math.round(view.zoom * 100)}%`;
}

// =========================================================================
// PREVIEW NAVIGATION AND CLICK-TO-DELETE PATH EDITING
// =========================================================================
let previewView = { scale: 1, originX: 0, originY: 0, paperH: 100 };
let view = { zoom: 1, panX: 0, panY: 0 };
let hoveredPathIndex = -1;

const MIN_ZOOM = 1;
const MAX_ZOOM = 60;

// Pointer position -> device pixels on the backing store, undoing the CSS scaling of
// the canvas element.
function pointerToDevice(evt) {
    const gCanvas = document.getElementById("gcodeCanvas");
    const rect = gCanvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    return {
        x: (evt.clientX - rect.left) * (gCanvas.width / rect.width),
        y: (evt.clientY - rect.top) * (gCanvas.height / rect.height)
    };
}

// Device pixels -> millimetres, inverting the zoom/pan transform and the bottom-left
// G-code origin.
function deviceToMm(point) {
    return {
        x: (point.x - previewView.originX) / previewView.scale,
        y: previewView.paperH - (point.y - previewView.originY) / previewView.scale
    };
}

function pointerToMm(evt) {
    const device = pointerToDevice(evt);
    return device ? deviceToMm(device) : null;
}

// Index of the path nearest the point, or -1. getPerpendicularDistance clamps to the
// segment, so this is true point-to-segment distance, not distance to the infinite line.
function pathIndexNear(point, toleranceMm) {
    let bestIndex = -1;
    let bestDist = toleranceMm;
    for (let idx = 0; idx < previewPaths.length; idx++) {
        const path = previewPaths[idx];
        for (let i = 1; i < path.length; i++) {
            const d = getPerpendicularDistance(point, path[i - 1], path[i]);
            if (d < bestDist) { bestDist = d; bestIndex = idx; }
        }
    }
    return bestIndex;
}

// A forgiving target in mm that stays ~10 screen pixels wide at any zoom level.
function hitToleranceMm() {
    return 10 / Math.max(previewView.scale, 1e-6);
}

// Keep the sheet from being dragged entirely out of view. Derives the scale from
// view.zoom rather than previewView, which still holds the previous frame's transform
// when this is called mid-zoom - reading it there clamped the zoom anchor correction away.
function clampPan() {
    const gCanvas = document.getElementById("gcodeCanvas");
    const place = getLayout();
    const scale = (gCanvas.width / place.paperW) * view.zoom;
    const limitX = Math.max(0, (place.paperW * scale - gCanvas.width) / 2);
    const limitY = Math.max(0, (place.paperH * scale - gCanvas.height) / 2);
    view.panX = Math.max(-limitX, Math.min(limitX, view.panX));
    view.panY = Math.max(-limitY, Math.min(limitY, view.panY));
}

// Zoom about a fixed device point, so whatever is under the cursor stays under it.
function zoomAbout(devicePoint, nextZoom) {
    const clamped = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, nextZoom));
    if (clamped === view.zoom) return;

    const anchor = devicePoint || { x: 0, y: 0 };
    const before = deviceToMm(anchor);
    view.zoom = clamped;

    // Recompute the transform at the new zoom, then shift so `before` maps back to anchor.
    const gCanvas = document.getElementById("gcodeCanvas");
    const place = getLayout();
    const fitScale = gCanvas.width / place.paperW;
    const scale = fitScale * view.zoom;
    const originX = (gCanvas.width - place.paperW * scale) / 2 + view.panX;
    const originY = (gCanvas.height - place.paperH * scale) / 2 + view.panY;

    view.panX += anchor.x - (originX + before.x * scale);
    view.panY += anchor.y - (originY + (place.paperH - before.y) * scale);

    clampPan();
    drawGCodePreview();
}

function updateEditButtons() {
    const undoBtn = document.getElementById("undoDeleteBtn");
    const restoreBtn = document.getElementById("restorePathsBtn");
    if (!undoBtn || !restoreBtn) return;
    undoBtn.disabled = deletedPaths.length === 0;
    restoreBtn.disabled = deletedPaths.length === 0;
}

const gcodeCanvasEl = document.getElementById("gcodeCanvas");

let panPointer = null;
let pointerMoved = false;

gcodeCanvasEl.addEventListener("wheel", (e) => {
    e.preventDefault();
    // Fixed ratio per notch so zooming in then out returns to the same place.
    const factor = Math.pow(1.0015, -e.deltaY);
    zoomAbout(pointerToDevice(e), view.zoom * factor);
}, { passive: false });

gcodeCanvasEl.addEventListener("mousedown", (e) => {
    panPointer = { x: e.clientX, y: e.clientY };
    pointerMoved = false;
});

window.addEventListener("mouseup", () => {
    panPointer = null;
    gcodeCanvasEl.classList.remove("is-panning");
});

gcodeCanvasEl.addEventListener("mousemove", (e) => {
    if (panPointer) {
        const gCanvas = gcodeCanvasEl;
        const rect = gCanvas.getBoundingClientRect();
        const dx = (e.clientX - panPointer.x) * (gCanvas.width / rect.width);
        const dy = (e.clientY - panPointer.y) * (gCanvas.height / rect.height);
        if (Math.abs(e.clientX - panPointer.x) > 3 || Math.abs(e.clientY - panPointer.y) > 3) {
            pointerMoved = true;
            gcodeCanvasEl.classList.add("is-panning");
        }
        panPointer = { x: e.clientX, y: e.clientY };
        view.panX += dx;
        view.panY += dy;
        clampPan();
        drawGCodePreview();
        return;
    }

    if (!previewPaths.length) return;
    const point = pointerToMm(e);
    if (!point) return;
    const found = pathIndexNear(point, hitToleranceMm());
    if (found !== hoveredPathIndex) {
        hoveredPathIndex = found;
        gcodeCanvasEl.classList.toggle("is-hovering-path", found >= 0);
        drawGCodePreview();
    }
});

gcodeCanvasEl.addEventListener("mouseleave", () => {
    if (hoveredPathIndex !== -1) {
        hoveredPathIndex = -1;
        gcodeCanvasEl.classList.remove("is-hovering-path");
        drawGCodePreview();
    }
});

gcodeCanvasEl.addEventListener("click", (e) => {
    // A drag that ended over a path is a pan, not a delete.
    if (pointerMoved) { pointerMoved = false; return; }
    if (!previewPaths.length) return;
    const point = pointerToMm(e);
    if (!point) return;
    const found = pathIndexNear(point, hitToleranceMm());
    if (found < 0) return;

    deletedPaths.push({ index: found, path: previewPaths[found] });
    previewPaths.splice(found, 1);
    hoveredPathIndex = -1;
    gcodeCanvasEl.classList.remove("is-hovering-path");
    updateEditButtons();
    rebuildOutput();
});

document.getElementById("zoomInBtn").addEventListener("click", () => {
    const gCanvas = gcodeCanvasEl;
    zoomAbout({ x: gCanvas.width / 2, y: gCanvas.height / 2 }, view.zoom * 1.4);
});

document.getElementById("zoomOutBtn").addEventListener("click", () => {
    const gCanvas = gcodeCanvasEl;
    zoomAbout({ x: gCanvas.width / 2, y: gCanvas.height / 2 }, view.zoom / 1.4);
});

document.getElementById("zoomFitBtn").addEventListener("click", () => {
    view = { zoom: 1, panX: 0, panY: 0 };
    drawGCodePreview();
});

document.getElementById("undoDeleteBtn").addEventListener("click", () => {
    const restored = deletedPaths.pop();
    if (!restored) return;
    previewPaths.splice(Math.min(restored.index, previewPaths.length), 0, restored.path);
    updateEditButtons();
    rebuildOutput();
});

document.getElementById("restorePathsBtn").addEventListener("click", () => {
    // Oldest first, so each recorded index lands where it was taken from.
    for (const entry of deletedPaths) {
        previewPaths.splice(Math.min(entry.index, previewPaths.length), 0, entry.path);
    }
    deletedPaths = [];
    updateEditButtons();
    rebuildOutput();
});

function simplifyPathRDP(path, epsilon) {
    if (path.length < 3) return path;
    let maxDist = 0;
    let index = 0;
    const end = path.length - 1;

    for (let i = 1; i < end; i++) {
        let dist = getPerpendicularDistance(path[i], path[0], path[end]);
        if (dist > maxDist) {
            index = i;
            maxDist = dist;
        }
    }

    if (maxDist > epsilon) {
        let results1 = simplifyPathRDP(path.slice(0, index + 1), epsilon);
        let results2 = simplifyPathRDP(path.slice(index), epsilon);
        return results1.slice(0, results1.length - 1).concat(results2);
    } else {
        return [path[0], path[end]];
    }
}

function getPerpendicularDistance(p, p1, p2) {
    let dx = p2.x - p1.x;
    let dy = p2.y - p1.y;
    if (dx === 0 && dy === 0) return Math.hypot(p.x - p1.x, p.y - p1.y);
    let t = ((p.x - p1.x) * dx + (p.y - p1.y) * dy) / (dx * dx + dy * dy);
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(p.x - (p1.x + t * dx), p.y - (p1.y + t * dy));
}