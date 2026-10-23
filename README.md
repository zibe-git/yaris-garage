# Yaris Garage

The four Yaris apps in one phone-first page, drawn with raw **WebGL2** (no three.js or other 3D library):

| | |
|---|---|
| **Explode** `#explode` | All 926 parts of the FE model. Drag to turn, pinch to zoom, slide to explode; a group chip shows that group alone and explodes just it; tap a part for its name, mass, sheet thickness, material and welds; double-tap pulls it out. Colour by group / thickness / mass. |
| **Drive** `#drive` | Slow-roads style endless road over procedural terrain with lakes and forest, auto-drive or touch pedals, four cameras, time of day, paint. |
| **Rally** `#rally` | Night gravel stage in a storm: jumps, slides, headlights, rain, lightning and thunder, synthesised engine; an AI drives until you take over. |
| **Puzzle** `#puzzle` | Rebuild the car part by part: 13 campaign levels plus free play, easy / normal / hard, pegs and holes, hints, best scores. |

```bash
npm install && npx playwright install chromium
npm run model       # download the CCSA model (42 MB, checksummed) → convert → bake public/model/car.*
npm run dev         # http://localhost:5182
npm test            # production build + Lighthouse + per-app vitals (real GPU on macOS, 4× CPU throttle)
```

Every push to `main` runs the tests and deploys `dist/` to GitHub Pages (`.github/workflows/pages.yml`); pull requests
run the tests only. Enable it once under Settings → Pages → Source: GitHub Actions.

Other checks: `node tests/puzzle.mjs http://localhost:5182/ --gpu` (puzzle e2e), `node tests/rally-sim.mjs 120 11`
(headless AI rally run), `npm run shot -- 'http://localhost:5182/#rally' out.png` (phone-sized GPU screenshot).

## Web vitals

`npm test` asserts Lighthouse (mobile preset: slow 4G, 4× CPU) scores **100** for performance, accessibility, best
practices and SEO on the launcher, then opens every app from its card and checks interaction latency (Event Timing,
INP proxy) ≤ 200 ms, zero layout shift and no console errors or warnings. Current run: FCP 0.8 s, LCP 0.9 s, TBT 0 ms,
CLS 0; slowest interaction 64–80 ms per app.

How it stays fast:
- The launcher is static HTML with inline CSS and SVG, no web fonts, and a 1.4 kB router. App code and the shared
  shell load only when a card is tapped (and are warmed on `pointerdown`).
- The car is baked once into GPU-ready buffers (`tools/bake.mjs`: meshoptimizer-simplified to 359k triangles, 12 bytes
  per vertex, 7.2 MB, shipped as a 3.9 MB `.gz` unpacked by the browser's `DecompressionStream`), fetched only when an
  app opens and shared by all four apps. No parsing at load.
- Whole car = one draw call. Per-part state (explode offset, colour, visibility, rotation, wheel spin) lives in a float
  texture the vertex shader reads, so explode / puzzle / wheel animation are table writes, not geometry updates.
- Terrain, road and trees are built in time-sliced jobs (4 ms per frame); taps never do heavy work synchronously
  (Explode picks with an async pixel-buffer read-back; Rally starts Web Audio after the tap's frame is painted).
- The frame loop sleeps in hidden tabs and lowers the pixel ratio when frames run slow.

## Layout

```
index.html            launcher (inline critical CSS)
src/main.js           hash router, lazy app loading
src/shell.js, ui.css  app chrome: canvas + WebGL2 context, top bar, HUD layer, loading bar, toasts
src/gl/               gl.js (programs, buffers, loop), math.js, orbit.js (touch camera), model.js (the car)
src/apps/             explode.js, drive.js, rally.js, puzzle.js
src/world/            terrain, road, stage, sky, water, trees, rain, vehicle physics, AI pilot, audio (Drive + Rally)
src/puzzle/           puzzle game, peg / hole guides, styles
src/shared/           three-free modules copied from the desktop Yaris apps (puzzle rules, levels, sound, noise)
tools/model/          CCSA download + LS-DYNA keyword converter (parts, groups, welds / bolts / joints)
tools/bake.mjs        model bake      tools/shot.mjs   screenshots
tests/                vitals.mjs (npm test), puzzle.mjs, rally-sim.mjs
```

## Credits

Car geometry: **2010 Toyota Yaris finite element model, Center for Collision Safety and Analysis (CCSA), George Mason
University, developed under FHWA / NHTSA sponsorship** — please acknowledge CCSA at GMU and FHWA when using it. The
model is downloaded from CCSA at build time and is not part of this repository.

## License

[MIT](LICENSE) for the code in this repository. The CCSA model data is not covered by it.
