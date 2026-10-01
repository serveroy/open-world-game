# CLAUDE.md — Crimson Coast

Mobile-first open-world crime game. Vite + TypeScript (strict) + Three.js + Rapier + miniplex.
Read `PLAN.md` first: §0 tracks milestone progress, §11 logs deviations.

## Commands
- `npm run dev` — dev server (http://localhost:5173, `--host` for phone testing on LAN)
- `npm run build` — typecheck (`tsc --noEmit`) + production build to `dist/`
- `npm run preview` — serve `dist/` (http://localhost:4173)
- `npm test` — Vitest unit tests (pure logic, node env)
- `npm run smoke` — build must exist; Playwright headless smoke test (screenshots in `scripts/out/`)
  - `SMOKE_SCRIPT='js'` runs JS after load (then `_2.png` screenshot); `SMOKE_MOBILE=1` emulates a phone
- `node scripts/shots.mjs "?quality=high" shots.json` — batch visual QA screenshots (`[{name, js, wait}]`); `SMOKE_MOBILE=1 SHOT_W=572 SHOT_H=307 SHOT_DPR=3` + `?framed=1` emulates a phone inside the Claude app viewer
- `node scripts/render-radio.mjs <dir>` — render the three radio stations to WAV (needs a build)

## Conventions
- TypeScript strict; no `any` unless interfacing with untyped browser APIs (comment why).
- ES modules, named exports, one main class/concept per file. File names: `PascalCase.ts`
  for classes, `camelCase.ts` for function/util modules, data in `src/data/*.json|ts`.
- Units: meters, seconds, radians. +Y up, +X east, −Z north. Models (cars, characters) are
  built facing local **+Z**; heading angle `h` means forward = (sin h, 0, cos h).
- Pure game logic (wanted, economy, missions, weapons, roads) must not import three/rapier
  so it stays unit-testable in Node. Rendering/physics adapters live beside it.
- Never allocate in per-frame hot paths: reuse module-level scratch `Vector3`/`Quaternion`
  (`const _v = new THREE.Vector3()`), use pools from `core/Pool.ts`.
- Systems communicate through `core/events.ts` (typed bus) rather than direct imports where
  it avoids cycles.
- Rendering budget: prefer `InstancedMesh` / merged geometry; one shared material per family.
- Physics: all colliders get collision groups from `physics/groups.ts`; collider handles map
  to game entities via `Physics.ownerOf(collider)`.
- No real-world brands, logos, cities, or franchise IP in names, art, or text.
- All third-party assets must be CC0/permissive and logged in `CREDITS.md`.
- Keep PLAN.md §0 progress table and §11 deviations log updated at each milestone; commit
  after every milestone with message `Mx: <summary>`.

## Debug
- `window.__game` exposes the running Game (stats, teleport, spawn helpers) in all builds.
- URL params: `?quality=low|med|high`, `?seed=N`, `?debug=1` (FPS/draw-call overlay),
  `?test=1` (M1 test area instead of full world), `?mission=<id>` (start mission).
