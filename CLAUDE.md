# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

gCoded is a browser-based image → G-code converter for pen plotters. A user loads a raster image, picks a fill/outline engine, and the app emits G-code (`.nc`) plus a live toolpath preview.

## Running

Zero dependencies, no build step, no test suite, no package manager. Three files: `index.html`, `app.js`, `style.css`.

Open `index.html` directly in a browser, or serve the directory:

```
python3 -m http.server 8000
```

Testing is manual: load an image, click **Generate G-Code**, and check the toolpath preview canvas and the first-100-lines text preview.

## Architecture

### Data flow

1. `imageLoader` change → `FileReader` → `Image` → drawn to `#imageCanvas` at the image's **native pixel size** (the canvas is never resized to fit; CSS scales it).
2. `ctx.getImageData(...).data` is cached in the module-global `imgPixels` (raw RGBA `Uint8ClampedArray`). All engines read brightness as `(r+g+b)/3` from this array — no separate grayscale buffer.
3. `generateGCode()` builds `brightnessMap` (greyscale, optionally blurred), then runs a four-stage pipeline:

   `engines → emitStroke() → planStrokes() → serializeGCode()`

   Engines never touch `gcodeLines`. They hand densely sampled millimetre paths to `emitStroke()`, which simplifies them into `collectedStrokes`. Only once every stroke is known does `planStrokes()` decide the pen route and `serializeGCode()` write the file — global ordering is impossible if engines emit as they go.
4. Download joins `gcodeLines` with newlines into a Blob (filename hardcoded `cool.nc`).

Shared state: `imgPixels`, `brightnessMap`, `collectedStrokes`, `previewPaths`, `gcodeLines`.

### The three engines

- **`executeAdvancedPass(thresholdList, activeIndex)`** — fill engine. Sub-engines by `layer.pattern`: `concentric` (polar sweep from outside in), `diagonal` (hardcoded both-direction diagonal scan), and `hatch`/`crosshatch`, which both go through `renderLineAngle(angle)` — an arbitrary-angle rotational scanner; crosshatch just calls it twice with `angle1` and `angle2`.
- **`outlineImage(threshold)`** — standalone tracer, **marching squares** over the greyscale `brightnessMap`. Each cell emits segments between its crossed edges, the crossing is interpolated along the edge (sub-pixel, so contours are smooth not stair-stepped), and segments are linked into contours via an edge-id adjacency map. Open ends are walked first so a contour running off the image is traced from its end. Do not go back to scanning for edges: the previous version marked transition pixels into a grid and chained them 8-connected, which **filled in** any edge whose mark band was thicker than one pixel — i.e. every soft or anti-aliased edge — because the greedy walk snaked through the band.
- **`drawGCodePreview()`** — renders `previewPaths` (real geometry in mm), not re-parsed G-code text. It sizes its backing store to the canvas's *displayed* size × `devicePixelRatio` and strokes at the user's real pen width, so packing lines tighter than the pen can resolve visibly reads as solid fill — which is the point of the preview.

### Conventions any new engine must follow

- **Route all output through `emitStroke(path)`.** It RDP-simplifies (epsilon 0.05 mm), drops strokes under `MIN_STROKE_MM`, emits `G0` travel → pen-down → `G1` moves → pen-up, and records the path for the preview. Sample densely (per pixel) and let it collapse the geometry; do **not** emit a move per sampled pixel.
- **Scale**: always `getScale()` (mm per source pixel, from `getLayout()`). Never recompute it inline — user-facing distances must not depend on input image resolution.
- **Never add the page offset yourself.** Engines emit in the image's own coordinate frame; `emitStroke()` is the one place `layout.originX/originY` is applied, so no engine needs to know about paper size or margins.
- **Spacing inputs are millimetres**, converted to a pixel step via `getScale()` inside each engine. The `diagonal` pattern multiplies by `Math.SQRT2` because its `k` step runs along an axis, not perpendicular to the lines.
- **Y flip**: `mmY = (canvas.height - y) * scale`, because G-code origin is bottom-left and canvas origin is top-left.
- **Don't round coordinates before simplifying** — quantising first puts jitter on straight runs and stops RDP collapsing them. `emitStroke` formats at 3 decimals on output.
- **Typed-array indices must be integers.** `binaryImage[5.5]` is `undefined`, which equals neither `1` nor `0`; a fractional scan step silently does nothing.
- **Read brightness from `brightnessMap`**, not `imgPixels`. It is prepared once per run and carries the blur; sampling raw pixels bypasses smoothing and re-does the `(r+g+b)/3` per sample.
- **Every program ends** with pen-up, `G0 X0 Y0`, `M2`. A `G4` dwell follows each pen command when `#penDwell` is non-zero, so servo pens reach the paper before the next move.

### Page layout

`computeLayout()` (cached in `layout`, rebuilt per run) fits the image inside `#paperWidth` × `#paperHeight` minus `#margin` on all sides, preserving aspect ratio, and centres it. `scale` is the fitted mm-per-pixel; `originX/originY` place it on the sheet. `#paperPreset` just writes width/height and flips to "Custom" when either is edited by hand. The preview canvas draws the whole sheet with a dashed margin guide, not just the drawing's bounding box.

### Pen route planning

`planStrokes()` is why plot times are sane. Emitted in raw scan order, travel exceeded drawing distance (215% on shading); greedy nearest-neighbour over *both* endpoints of every stroke — reversing where that's closer — cuts it to under 10%, and produces serpentine hatch ordering for free. A uniform spatial grid over endpoints keeps the search out of O(n²); the ring search exits once the next ring can't beat the current best.

Strokes whose endpoints fall within `joinTolerance` (the pen width) are concatenated into one polyline rather than closing and reopening the pen — a gap narrower than the pen is invisible on paper, so lifting there is wasted motion.

`refineWithTwoOpt()` then runs a 2-opt pass over that route (toggle `#optimizePath`, 1.5 s budget). Reversing a run of strokes is free — a stroke draws the same in either direction — and the gaps *inside* a reversed run keep their lengths, so each move's delta is just the two boundary gaps: `dist(A,C) + dist(B,D)` vs `dist(A,B) + dist(C,D)`. It buys another 20–42% on top of nearest-neighbour. `j` is windowed to 200 above 2000 strokes; NN order is already spatially coherent, so improving pairs sit close together in the sequence.

### Preview navigation and path editing

The preview pans and zooms (wheel, drag, and the −/+/Fit buttons; zoom clamped to 1–60×). `previewView` — written by `drawGCodePreview()` — is the single mm↔device mapping used for *both* rendering and hit-testing, which is what keeps a click landing on the ink it appears to be over. `zoomAbout()` anchors the zoom on the cursor by converting to mm first, then correcting pan afterwards.

`clampPan()` must derive its scale from `view.zoom`, **not** `previewView.scale`: mid-zoom, `previewView` still holds the previous frame's transform, and reading it there clamps the zoom anchor correction back to zero.

Hovering highlights the path under the cursor, clicking deletes it, and Undo/Restore reverse that. A drag that ends over a path is a pan, not a delete (`pointerMoved` guard). Deletions mutate `previewPaths` and call `rebuildOutput()`, which re-runs `serializeGCode()` from scratch — so the downloaded file always matches what is on screen. Deleting does **not** re-run the planner; the route keeps its order minus the removed path.

Hit-testing reuses `getPerpendicularDistance()` (which clamps to the segment, so it is true point-to-segment distance); `hitToleranceMm()` scales the target with zoom so it stays ~10 screen pixels wide.

### Threshold layers

`bw` mode builds a single-element threshold list from the `#bw*` inputs; `shading` mode reads dynamically created `.layer-row` elements. Layers are sorted ascending by `cutoff`, and `executeAdvancedPass` derives `minBright` from the *previous* layer's cutoff + 1, so layers form non-overlapping brightness bands — order matters, and a layer's own `cutoff` is only its upper bound.

`createLayerRow()` builds rows via `innerHTML`; `generateGCode()` reads them back by class (`.layer-cutoff`, `.layer-spacing`, `.layer-pattern`, `.layer-angle1`, `.layer-angle2`). Those class names are the contract between the two — changing markup requires updating both. Three default layers are created at load.

### UI wiring

`app.js` is a flat script (no modules, no `DOMContentLoaded` — it relies on `<script>` being last in `<body>`) that grabs elements by ID at top level, so every ID in `index.html` is load-bearing. Panel visibility is hand-managed in `updateUiPanels()` by toggling `style.display`; much of the layout styling lives in inline `style` attributes in `index.html` alongside `style.css`.

Note the misspelled-but-consistent `gcode-preveiw-container` / `preveiw-content` classes shared by `index.html` and `style.css` — rename in both or neither.
