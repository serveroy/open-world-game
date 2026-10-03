# CRIMSON COAST — Game Design & Production Plan

> Original, mobile-first, open-world action-crime game for the browser.
> 100% original IP: no real brands, logos, cities, or characters from existing franchises.
> **Status: all milestones M0–M9 complete.** Resume from §0 for follow-up work.
>
> Engine: Vite + TypeScript (strict) + Three.js (WebGL2) + Rapier physics + miniplex ECS.

---

## 0. Progress Tracker (update after every milestone)

| Milestone | Status | Notes |
|-----------|--------|-------|
| M0 Plan + scaffold + build pipeline | ✅ done | build/test/smoke pipeline green |
| M1 Player controller, camera, touch controls, test area | ✅ done | `?test=1` sandbox: vault/climb/swim/cover verified via smoke |
| M2 World streaming, districts, roads, lighting, day/night, weather | ✅ done | ~120 draw calls downtown (High), 1 draw call per chunk via world shader |
| M3 Vehicles: models, handling, damage, traffic AI | ✅ done | 18 procedural vehicles; handling + traffic AI unit-tested headless; radio & engine audio in M9 |
| M4 Pedestrians + carjacking & theft | ✅ done | instanced peds with routines & reactions; carjack, smash, lockpick mini-game, alarms, hot cars |
| M5 Weapons, shooting, melee, ragdolls | ✅ done | 10 weapons, wheel, lock-on/swipe/gyro aim, throwables + fire zones, 7-body ragdolls, wasted flow; gun shop in M8 |
| M6 Police & wanted system | ✅ done | wanted logic unit-tested; foot cops (arrest/cover/flank), cruisers (route pursuit, ram/PIT), roadblocks + spikes, SWAT, spotlight heli, search cones |
| M7 Mission system + full story, desert & sea content | ✅ done | JSON missions (23 incl. 2 endings) schema-validated & auto-played in tests; runner w/ checkpoints, fail/retry, cutscenes, choices |
| M8 Economy, properties, shops, side activities, phone UI | ✅ done | Estate (4 safehouses + garages, 5 businesses), 6 shop types, 3 races, taxi/delivery/theft/rampage, street events, 30 shells, clubs, phone, settings + HUD editor, title/pause, IndexedDB saves |
| M9 Audio, polish, perf tuning, PWA, Vercel, README | ✅ done | Procedural SFX bank (offline-rendered → Howler, spatial), live engines/sirens/horns/alarms/skids/ambience, 3 generative radio stations; High-preset bloom/vignette/grain; SW registration; ECS index; README; ~130–170 draw calls on High, 1.9 MB gzipped |

**Resume rule:** if a session ends, open this table, find the first milestone that is not ✅,
read its acceptance criteria in §9 and the "Deviations & Notes" log in §11, then continue.

---

## 1. Vision & Pillars

**Logline:** Nico Reyes, a getaway driver fresh out of prison, returns to the sun-bleached
coastal city of **Port Solano** to find the people who sold him out — and must decide whether
to escape the life or take the whole coast for himself.

**Pillars**
1. **Pocket-sized freedom** — a seamless coast/city/desert/sea map you can cross in ~4 minutes
   by car, dense with things to do, playable one-handed-ish on a phone.
2. **Instant mayhem, readable systems** — every car is stealable, every crime has a clear,
   escalating, escapable police response.
3. **Stylized realism** — cohesive low-poly procedural art, strong sun/neon lighting, fog,
   tone-mapped colour grading. Looks intentional at 30–60 FPS on phones.
4. **Respect the session** — auto-save, checkpoints, 5–10 minute missions, fast load.

**Tone:** sun-soaked neo-noir. Humour in side content, sincerity in the main story.
Adult nightlife content is implied only (fade-to-black); no explicit content.

---

## 2. World: "Costa Carmesí" region

World units = meters. +X = east, −Z = north. World bounds X ∈ [−1600, 1600], Z ∈ [−1200, 1200].

```
 Z=-1200 ┌────────────────────────────────────────────────────────────────┐
         │ SEA      │ DOCKS  │ RUSTVALE (slums)  │       SAL MESA DESERT  │
         │  ~ Coral │ cranes │                   │  mesas   ⛽ Pump 49    │
         │   Keys   ├────────┼───────┬───────────┤        \               │
         │  (isle)  │ VELVET │DOWNTWN│  MIDTOWN  │==== Route 9 highway =====│
 Z=0     │          │  ROW   │ towers│           │          \  DUSTWATER  │
         │          │(neon)  │       │           │  ⛽ Last   \  (town)    │
         │  ~ Pelican├───────┴───────┴───────────┤   Chance               │
         │   Isle   │MARINA│   PALM HEIGHTS (suburbs) │     dunes          │
 Z=1200  └────────────────────────────────────────────────────────────────┘
        X=-1600     -800                          300                  1600
```

| Area | Bounds (x / z) | Character |
|------|----------------|-----------|
| Open sea | x < −820 | Waves, boats, two islands |
| **Coral Keys** (island) | ~(−1250, −650), r≈160 | Smugglers' cove, hidden stash, boat missions |
| **Pelican Isle** (island) | ~(−1200, 600), r≈130 | Lighthouse, villa (Act 3) |
| **Docks** | x −800…−480, z −1000…−320 | Containers, cranes, warehouses, Dima's yard |
| **Rustvale** (slums) | x −480…300, z −1000…−340 | Low shacks, graffiti, gangs, Lena's garage |
| **Velvet Row** (nightlife) | x −800…−460, z −320…360 | Neon clubs, beach boulevard, Club Halcyon |
| **Downtown** | x −460…−60, z −320…360 | Towers, Police HQ, bank, heli pad |
| **Midtown** | x −60…300, z −320…360 | Mixed shops, gun shop, hospital |
| **Gull Point Marina** | x −800…−500, z 360…900 | Piers, boat rental, yachts |
| **Palm Heights** (suburbs) | x −500…300, z 360…1000 | Houses, lawns, safehouse #1 |
| **Sal Mesa Desert** | x > 300 | Dunes, mesas, Route 9 highway, two gas stations |
| **Dustwater** (town) | ~(1180, 320) | Small main street, diner, sheriff, Old Sal's |

Terrain: one analytic height function `terrainHeight(x,z)` (seeded fBm noise) → Rapier heightfield
(4 m cells) + per-chunk render meshes. City is flat (y=0), shoreline slopes into the sea
(floor −14 m), desert has dunes (≤ 22 m) and flattened corridors along roads.
Water plane at y = 0 with animated shader; swimming/boat buoyancy use the same constant.

**Roads:** procedural city grid with district-specific block sizes (downtown 90 m, suburbs 130 m)
plus hand-placed Beach Boulevard, Route 9 highway (spline to Dustwater) and desert spur roads.
Road graph (nodes = intersections, edges = segments) drives traffic AI, GPS (A*), police
pursuit routing, and roadblock placement. 4-way intersections have traffic lights.

**Landmarks (hand-tuned):** Police HQ (downtown), Solano General Hospital (midtown),
Club Halcyon (Velvet Row), Volk Shipping yard (docks), Reyes' Body & Paint / respray (Rustvale),
Ammo-Nation-style gun shop "Iron & Ember" (midtown), "Chrome Daddy" mod shop, barber
"Fade Factory", clothing "Threadline", tattoo "Ink Tide", Pump 49 & Last Chance gas stations,
Dustwater diner, lighthouse on Pelican Isle, downtown heli pad.

Day/night: 24 min real-time per game day (configurable). Sun/moon directional light, sky
gradient shader, stars, emissive windows & neon at night, streetlights as instanced glow.
Weather: clear / overcast / rain (particles + wet road tint + darker fog) /
sandstorm (desert only: orange fog, particles, reduced visibility). Weather state machine with
weighted random transitions every 3–6 game hours.

---

## 3. Systems Design

### 3.1 Player
- Third-person kinematic character (Rapier `KinematicCharacterController`, capsule).
- Walk / sprint (stamina) / jump / auto-vault low walls (≤ 1.6 m, raycast probe) / swim
  (water depth > 1.2 m, stamina drain, drown at 0) / cover (snap to nearest wall, crouch, peek).
- Health 100, armor 0–100 (absorbs 70% of damage), stamina 100.
- Camera: orbit follow with spring smoothing, collision via raycast, aim zoom shoulder offset,
  vehicle chase cam with speed-based FOV, hood cam toggle.

### 3.2 Input (unified `InputState`)
- Touch: floating virtual joystick (left 45% of screen), look-drag (right side), contextual
  buttons (Jump/Sprint, Attack, Aim, Enter, Reload, Weapon wheel, Cover; in car: Gas, Brake,
  Handbrake, Horn, Camera, Shoot). Layout & sizes customizable in Settings (persisted).
- Keyboard/mouse: WASD, Shift sprint, Space jump/handbrake, F enter, R reload, Q cover,
  Tab/hold wheel, LMB fire, RMB aim, C camera, H horn, M map/phone, Esc pause.
- Gamepad API: standard mapping.
- Haptics via `navigator.vibrate` (toggleable).

### 3.3 Vehicles (all original designs, procedural meshes)
| # | Name | Class | Notes |
|---|------|-------|-------|
| 1 | Pico | compact | light, nimble, slow |
| 2 | Meridian | sedan | balanced |
| 3 | Bruiser | muscle | torque, loose rear |
| 4 | Stiletto | sports | grip, fast |
| 5 | Aurelia GT | supercar | top speed, low |
| 6 | Ranger XT | SUV | heavy, high |
| 7 | Mule | pickup | bed, sturdy |
| 8 | Courier | van | slow, heavy |
| 9 | Solano Cab | taxi | sedan variant, taxi jobs |
| 10 | Interceptor | police cruiser | sirens, PIT |
| 11 | Medic One | ambulance | sirens |
| 12 | Coastliner | bus | very heavy |
| 13 | Enforcer | SWAT van | armored |
| 14 | Wasp 250 | motorbike | agile |
| 15 | Thunder 900 | motorbike | fast cruiser |
| 16 | Skiff | boat | small, quick |
| 17 | Marlin | boat | speedboat |
| 18 | Kestrel | helicopter | police + civilian livery |

- Ground vehicles: Rapier `DynamicRayCastVehicleController` (raycast suspension), per-model
  handling data (mass, engine force, top speed, brake, grip/frictionSlip, steer angle, COM).
- Bikes: same controller + upright stabilising torque + visual lean.
- Boats: buoyancy samples + thrust + rudder. Helicopter: lift + attitude PD controller.
- Lights: headlights (real SpotLight for player car on Med/High; glow sprites elsewhere),
  brake/reverse/indicator lights via instanced glow quads; sirens with light bars.
- Damage: health 0–1000; per-impact vertex dents in impact region, glass break, smoke < 35%,
  fire < 15% (timer → explosion), tires can be shot out.
- Radio: 3 procedural stations (Neon FM synthwave, Dust Radio desert twang, Low Tide lo-fi).

### 3.4 Traffic AI
- Lane-following on road graph (right-hand traffic), PID steering, target speed per edge,
  car-following via forward spatial queries, obeys traffic-light phases, honks when blocked,
  swerves/brakes for obstacles, panics (flees at speed) when shot at, reacts to collisions.
- Spawn ring 60–220 m around player, despawn > 260 m; pooled.

### 3.5 Pedestrians
- Instanced procedural humanoids (one `InstancedMesh` per body part → ~10 draw calls for all).
- Routines by game hour: commute/walk, idle/chat in pairs, sit, nightlife crowds at night.
- Reactions: flee (gunfire/explosions), fight back (brave archetype), call police
  (phone animation, adds wanted star after delay if not stopped), scream, hide (crouch).
- Carjacking: player runs to driver door → open → pull NPC out (animated) → enter.
  Driver reaction: flee / fight / chase on foot / call police.
- Parked cars: locked → choose smash window (fast, noisy, alarm likely) or lockpick
  (timed sweet-spot mini-game). Alarm may sound and attract police.
- Police/emergency vehicles stealable (instant 1–2 stars). Stolen cars "hot" until resprayed.

### 3.6 Weapons
| Weapon | Slot | Notes |
|--------|------|-------|
| Fists, Bat, Knife | melee | combos, knockdown |
| Pistol "P9 Viper" | handgun | 12 rnd |
| SMG "Hornet" | smg | 30 rnd, drive-by capable |
| Shotgun "Breaker" | shotgun | pellets, spread |
| Rifle "AR-K Tidal" | rifle | 30 rnd |
| Sniper "Longshot" | sniper | scope zoom |
| Grenade, Molotov | thrown | arc preview, fire area |

- Hitscan via Rapier ray casts; tracers, muzzle flash, impact sparks/decals, shell casings
  (pooled particles), hit markers, recoil, reload animation (procedural arm motion).
- Mobile aim: auto lock-on to nearest visible target in cone, swipe to cycle target,
  optional free-aim, optional gyro aim (DeviceOrientation).
- Ragdolls: 7-body Rapier ragdoll (pelvis, torso, head, 2 arms, 2 legs) — max 6 active, pooled.

### 3.7 Police & Wanted (1–5 ★)
- Crime events (assault, theft, carjacking, shooting, police assault/kill, explosions) → heat;
  witnesses (peds who can see you) report after a delay; cops seeing it = instant.
- ★1 foot cops pursue · ★2 cruisers chase & ram · ★3 roadblocks + spike strips + more units ·
  ★4 SWAT vans + helicopter w/ spotlight · ★5 armored Enforcers + aggressive helicopter.
- Search mode: when no unit has LOS for 4 s → stars flash, search radius centred on last seen
  position shown on minimap with cop vision cones; leave radius / stay hidden for the decay
  timer to lose stars. Respray shop clears stars (if unseen).
- Busted: lose 10% cash (≤ $5k) + weapons, respawn at Police HQ. Wasted: hospital, $500 fee.

### 3.8 Economy & Customisation
- Cash, properties (safehouses: save point + garage, 3 purchasable), businesses (5) with
  passive income per game day collected at the property.
- Barber (hair & beard style/colour), Threadline clothing (top/bottom/shoes colour & style),
  Ink Tide tattoos (arm/neck patterns), Chrome Daddy mod shop (paint, wheels, engine, brakes,
  armor, nitrous-free "turbo"), respray (clears hot status & stars).

### 3.9 Side Activities
Street races (3 courses), taxi fares, deliveries, vehicle theft contracts (export list),
rampages (timed kill count), random street events (mugging in progress, carjack victim,
runaway car), 30 collectibles ("Saint Shells"), nightlife (clubs: dance mini-game; companion
visit → fade-to-black, health refill).

### 3.10 Phone (in-game menu)
Map (pan/zoom, set waypoint, GPS route via A* on road graph), Missions, Contacts (call to
start missions / services: taxi, mechanic delivers your car), Stats, Settings, Save.

---

## 4. Story — "Crimson Coast" (3 acts, 22 missions, 2 endings)

**Characters**
- **Nico Reyes** — protagonist, ex-getaway driver, 5 years inside. Wants the truth; must choose
  between loyalty and escape.
- **Lena Reyes** — Nico's younger sister, runs Reyes' Body & Paint in Rustvale. His conscience.
- **Theo Marsh** — Nico's old partner. Everyone thinks he died in the job that got Nico caught.
- **Dmitri "Dima" Volk** — dock boss who controls smuggling through Port Solano.
- **Isabel "Izzy" Navarro** — owner of Club Halcyon, info broker, plays every side.
- **Captain Harlan Price** — corrupt SPD captain who runs the city's protection racket.
- **Old Sal Moreno** — Dustwater fixer, Nico's mentor from the driving days.
- **Juno Park** — teenage hacker/dispatcher who works the radio for Lena.

**Act 1 — "Back on the Block"** (city)
1. *Homecoming* — tutorial: walk, sprint, jump, steal Lena's car back from a joyrider, drive to garage.
2. *Paint Job* — steal 3 hot cars for Lena's respray racket; first wanted star tutorial & respray.
3. *Dock Work* — meet Dima; drive a container truck route (escort/time), defend from rival crew.
4. *Velvet Ropes* — meet Izzy at Club Halcyon; tail a courier (stealth follow) through Velvet Row.
5. *Shots Fired* — gun shop intro; shootout at Rustvale warehouse (weapons/cover tutorial).
6. *Hot Pursuit* — steal an Interceptor from Police HQ lot, lose a 3★ chase.
7. *The Ghost* — photos show Theo alive; chase Theo's car across downtown (he escapes).

**Act 2 — "Sal Mesa"** (desert, sea)
8. *Route 9* — drive to Dustwater, meet Old Sal; highway race against Sal's nephew.
9. *Dust Devils* — ambush a smuggling convoy on Route 9 during a sandstorm.
10. *Last Chance* — defend Last Chance gas station from Price's dirty cops (survive waves).
11. *Coral Run* — take a Marlin speedboat to Coral Keys, collect stash, outrun coast guard.
12. *Rooftops* — helicopter flight downtown: pick up Juno from rooftop, evade police heli.
13. *Halcyon Nights* — Izzy's party: stealth through the club, plant a bug, fade-to-black alibi.
14. *Iron Price* — **Twist 1:** Izzy sells you out; Price's cops ambush the meet. Escape 4★.
15. *Brother's Keeper* — rescue Lena from Price's men at the docks (escort her out alive).

**Act 3 — "High Tide"** (whole map)
16. *Old Friends* — **Twist 2:** Theo reveals Price framed them both and Dima financed it.
17. *Paper Trail* — heist the Police HQ evidence room (stealth or loud), escape by helicopter.
18. *Breakwater* — sink Dima's shipment at the docks with molotovs; boat chase.
19. *Sal's Last Ride* — Sal is attacked in Dustwater; defend the town, sniper overwatch.
20. *Pelican Isle* — assault Price's villa on Pelican Isle; capture evidence.
21. *The Choice* — Theo and Price both at the lighthouse: choose.
22a. *Ending A — "Clean Getaway"*: hand the evidence to the feds, escort Lena out of the city
    across Route 9 while the whole force (5★) chases you. Credits roll on the open highway.
22b. *Ending B — "King of the Coast"*: kill Price, take Dima's docks in a final shootout;
    Lena leaves you. You own the city; dark credits.

Each mission: 3–8 objectives, checkpoints, dialogue lines with subtitles, optional cutscene
camera shots, fail conditions (death, target lost, vehicle destroyed, timer), retry from checkpoint.

---

## 5. Architecture

```
src/
  main.ts                 bootstrap: loading screen → init physics → Game
  game/Game.ts            owns systems, fixed-step loop, state machine (boot/menu/play/pause)
  core/                   events, time, rng, math, pool, spatial hash, settings, save (IndexedDB)
  ecs/                    miniplex world + component types
  input/                  InputState, keyboard/mouse, touch controls, gamepad, gyro, haptics
  physics/                Rapier wrapper, collision groups, collider→entity map, queries
  render/                 renderer, quality presets, dynamic resolution, post FX, sky, lights,
                          particles, decals, glow sprites
  world/                  map definition, terrain, roads graph, districts, chunk streaming,
                          building/prop generation, water, landmarks, day/night, weather
  characters/             instanced humanoid renderer, procedural animation, ragdolls
  player/                 player controller, camera rig, player state
  vehicles/               vehicle data, procedural meshes, ground vehicle, bike, boat, heli,
                          damage, lights, traffic AI, AI driver
  peds/                   ped manager, routines, reactions, carjacking
  combat/                 weapons data/logic, hitscan, projectiles, explosions, melee
  police/                 wanted system (pure logic), dispatcher, police AI, roadblocks
  missions/               mission schema, runner, objectives, dialogue, cutscenes
  economy/                wallet, properties, shops, businesses
  activities/             races, jobs, rampages, collectibles, street events
  ui/                     HUD, minimap, phone, weapon wheel, settings, menus, loading, toasts
  audio/                  Web Audio engine, procedural SFX, engine synth, radio, Howler bank
  data/                   JSON: vehicles, weapons, missions, shops, properties, tips
tests/                    Vitest unit tests (pure logic only)
public/                   manifest, icons, sw (generated at build)
scripts/                  smoke test (Playwright), icon generation
```

**Loop:** `requestAnimationFrame` → accumulate → fixed physics steps at 60 Hz (max 4/frame) →
systems `fixedUpdate(dt)` → `update(dt)` (animation, camera, UI) → render.
**ECS usage:** miniplex world holds entities (`vehicle`, `ped`, `pickup`, `blip`, `police` …);
systems query archetypes. Heavy objects (Vehicle, Ped) are class instances stored as components.
**Events:** typed event bus (`crime`, `explosion`, `damage`, `missionEvent`, …) decouples systems.
**Determinism:** seeded RNG for world gen so the map is identical on every device.

## 6. Asset Strategy
- All 3D content is **procedurally generated at runtime** (buildings, cars, characters,
  props, terrain, water, sky) — zero download, consistent art direction, tiny bundle.
- Audio is **procedurally synthesised** (Web Audio), including 3 radio stations; one-shot SFX
  are rendered offline into buffers and played through Howler.js (WAV data URIs).
- Loader path for external CC0 GLB (GLTFLoader + meshopt decoder) exists for future swaps;
  every external asset must be logged in CREDITS.md.
- Textures: procedural canvas textures (windows, road markings, signs) generated once,
  power-of-two, mipmapped. No KTX2 needed because no bitmap assets ship (noted deviation).

## 7. Performance Budgets
| Budget | Target |
|--------|--------|
| FPS | 60 on iPhone 12+/recent Android; ≥30 mid-range |
| Draw calls | < 300 (High), < 150 (Low) |
| Initial download | < 15 MB (target ≈ 3 MB gz) |
| Triangles in view | < 400k High, < 150k Low |
| Active peds / traffic | High 36/18, Med 26/14, Low 14/8 |
| Physics | 60 Hz fixed, ≤ 4 substeps |

Techniques: merged per-chunk building geometry (vertex colours, 1 shader), instanced props,
instanced humanoid parts, instanced wheels and glow quads, chunk streaming (200 m chunks, view
radius by preset), distance LOD (far chunks use box-only imposters), fog-limited far plane,
frustum culling, object pools (peds, cars, bullets, particles, decals), dynamic resolution
scaling (pixel ratio 0.5–1.0× adjusted by frame time), auto quality detection on first run.

## 8. Quality Presets
- **Low:** pixelRatio ≤ 1, no shadows, no bloom, view radius 1 chunk ring, 14 peds / 8 cars.
- **Med:** pixelRatio ≤ 1.5, 1024 shadow map, no bloom, radius 2, 26/14.
- **High:** pixelRatio ≤ 2, 2048 shadows, bloom + vignette/grade, radius 2–3, 36/18.

## 9. Milestones & Acceptance Criteria

**M0 — Plan + scaffold + build pipeline**
- PLAN.md, CLAUDE.md, package.json, tsconfig (strict), vite config, vitest, vercel.json,
  index.html with loading screen; `npm run build` and `npm test` pass; app boots to a 3D scene.

**M1 — Player controller, camera, touch controls, test area**
- Rapier initialised; test ground + ramps + walls; player walks/sprints/jumps/vaults/swims;
  orbit camera with collision; virtual joystick + buttons + keyboard + gamepad all drive player.

**M2 — World**
- Full map generated deterministically; terrain heightfield; road graph; districts with
  buildings & props; chunk streaming; water; sky; day/night; weather (clear/rain/sandstorm);
  minimap. Draw calls < 300 in downtown.

**M3 — Vehicles**
- 18 vehicles defined with unique handling and procedural meshes; enter/exit; chase/hood cam;
  lights; damage (dents, glass, smoke, fire, explosion); skid marks, tire smoke; traffic AI
  obeying lights; boats float; helicopter flies; bikes lean.

**M4 — Pedestrians & theft**
- Pooled instanced peds with routines; reactions (flee/fight/call police/hide); carjacking with
  pull-out animation; parked-car smash/lockpick mini-game; alarms; hot cars.

**M5 — Weapons**
- All weapons; weapon wheel; ammo/reload; auto-aim lock-on & target switching; tracers,
  flashes, sparks, decals, casings; melee; grenades/molotov; ragdolls; drive-by; tires/windows.

**M6 — Police**
- Wanted logic (unit-tested); dispatcher per star; foot cops, cruisers (chase/ram/PIT),
  roadblocks, spikes, SWAT, helicopter + spotlight; search mode + vision cones on minimap;
  busted / wasted flows; respray clears.

**M7 — Missions & story**
- JSON mission schema + runner (unit-tested); dialogue/subtitles; cutscene camera; checkpoints
  & retry; 22 story missions across Acts 1–3 with two endings; desert & sea content.

**M8 — Economy & activities**
- Wallet, properties w/ save + garage, businesses income; barber/clothes/tattoo; mod shop &
  respray; races, taxi, delivery, theft contracts, rampages, street events, collectibles;
  phone UI (map + GPS, missions, contacts, stats, settings).

**M9 — Audio, polish, PWA, deploy**
- Procedural audio (engine RPM, guns, sirens, ambience, 3 radio stations); haptics; screen
  shake; settings (graphics/audio/sensitivity/aim assist/subtitles/colourblind); PWA manifest +
  service worker (offline) + landscape lock; vercel.json; README; perf pass; smoke test passes.

## 10. Testing Strategy
- Vitest unit tests for pure logic: RNG, math, road graph & A*, map determinism, wanted system,
  weapon ammo/reload, damage model, mission runner, economy, save serialisation, lockpick,
  settings migration, pools.
- `npm run smoke`: Playwright (pre-installed Chromium) loads the production preview, waits for
  `window.__game.ready`, checks for console errors, records FPS/draw calls, screenshots.

## 11. Deviations & Notes Log
- (M0) Pinned TypeScript 5.9 / Vite 7 / Vitest 3 (newer majors available but less proven).
- (M2) WATER_Y = −1 m (city ground at 0) to avoid z-fighting; Rapier heightfield uses the
  anti-diagonal triangle split — `Terrain.sample` and chunk meshes match it (unit-tested).
- (M2) Static world (terrain, roads, sidewalks, buildings) is merged into ONE mesh per 200 m
  chunk using a patched standard material (procedural windows via `uvm`/`wparams`, `flat`
  varyings to avoid hash flicker). Far terrain + skyline are single meshes whose vertices are
  collapsed for loaded chunks via a 16×12 mask texture (no z-fighting with near chunks).
- (M3) Rapier user forces persist between steps → vehicles call `resetForces/resetTorques`
  at the start of every fixed step. Positive Rapier wheel steering turns left (we negate).
- (M3) Car-vs-human hits use OBB proximity tests (no physical contact), so cars never stop
  dead against a kinematic capsule. Breakable props become short-lived debris bodies.
- (M3) Car radio & engine audio are implemented with the audio milestone (M9).
- (M6) Police helicopter uses velocity-steered flight (not the player heli PD controller) for
  stable orbiting; foot cops are moved by PoliceManager (ped state `scripted`).
- (M7) Missions live in `src/data/missions/act{1,2,3}.json`; `MissionRunner` is pure and driven by
  `MissionManager` (the MissionHost). Checkpoint sections must be self-contained (spawn what they
  need after the checkpoint) — retry resumes right after the checkpoint step.
- (M8) Club interiors are a stylised full-screen overlay (animated lights + crowd) rather than
  3D interiors: keeps draw calls/memory flat and the adult VIP option strictly off-screen (fade
  to black, time skip). Dance mini-game is DOM-driven (keyboard / D-pad / touch pads).
- (M8) Mid-game "Load" and "New Game" reload the page with a sessionStorage flag so every system
  starts from clean state; loading from the title screen applies the save in place.
- (M8) Side activities reuse MissionManager's tagged spawning (`spawnWave`, `makeHostile`) for
  rampages/muggers; one activity runs at a time and blocks story mission starts.
- (M8) Saves: IndexedDB `crimson-coast/saves` (auto + 3 manual slots), localStorage then memory
  fallback; auto-save on mission pass, purchases, collectibles, every 3 min of safe free roam and
  when the tab is hidden. `?play=1` skips the title (used by screenshot scripts).
- (M9) Simulation stays in explicit System classes; miniplex is the shared entity index (every
  vehicle/ped registered on spawn, tag components `siren`/`hostile`) used for cross-system
  queries (audio voice assignment). Full ECS migration judged not worth the regression risk.
- (M9) Sound effects are synthesised in an OfflineAudioContext at boot, WAV-encoded and played via
  Howler (pooling + spatial panners); continuous sounds (engines, sirens, radio, ambience) are live
  Web Audio graphs on Howler's AudioContext so one master volume/unlock covers everything.
- (M9) Post FX (UnrealBloom + grade + OutputPass) only on the High preset; Low/Med render direct.
- (Post-M9) In-car mix: radio is the foreground (compressed, about −16 dBFS RMS). The player's vehicle goes through a cabin bus that is ducked about 9 dB and muffled while the radio plays. Warning sounds (skids, crashes, guns, sirens, horns) bypass the duck. Levels were tuned against measured bus RMS (`CABIN_UNDER_RADIO`, `RADIO_MAKEUP`).
- (M0) All art/audio procedural → no KTX2/Draco assets shipped; GLB/meshopt loader path kept
  for future CC0 imports. See CREDITS.md.
- (Post-M9) Characters: the instanced box humanoids were replaced by dressed, skinned characters with motion-capture animation, all CC0 from Quaternius.
  - Bodies come from Ultimate Modular Men / Women (16 outfits, head / body / legs / feet parts). Animation comes from Universal Animation Library 1+2 (51 clips).
  - `scripts/build-characters.mjs` rebinds every part onto the animation skeleton per gender: UAL rest rotations with the modular joint positions, a pelvis offset and a leg-length scale for gait speed. It writes everything to `src/assets/chars.bin` (about 2.6 MB, 1.4 MB gzipped).
  - Rendering is GPU skinning with instancing. Each character owns a row of skin matrices in a float texture.
  - Each distinct part combination is merged into one mesh on demand and cached, then drawn once for everyone wearing it. Only combinations near the camera cast shadows.
  - Clothes, skin and hair are tinted per instance from paint slots baked per material. Faces get painted stubble or a goatee, and arms and neck get tattoos. Hats are fitted to each head, and held items are per-instance variants.
  - `rig/wardrobe.ts` maps the classic `Appearance` fields onto parts, so the shops, barber, police and SWAT still work.
  - `AnimGraph` maps `AnimState` to clip layers: speed-matched gait blending, full-body and upper-body cross-fades, and FK overrides for strafing twist and lean.
  - The mocap jog and sprint have leaping strides (their feet imply about 6 and 9 m/s). Their leg swing is pulled about 30% toward each cycle's average leg pose (`STRIDE`) and the cycles are pinned to 3.9 and 6.9 m/s (`GAIT_SPEED`), so runs keep a natural cadence with planted feet.
  - The lower-body strafe twist only applies while aiming.
  - The mocap jog was airborne about 92% of its cycle with a 24 cm bounce, which looked like skipping. The rise above its lowest point is cut to 40% (sprint 60%, `BOUNCE`).
  - Lowering the body alone made the push-off toe scrape forward along the floor for about 0.1 s per step. `runFit` now precomputes, per body type and run frame, a pelvis curve and a lift per ankle. Two-bone leg IK (`rig/LegIK.ts`, applied in `AnimController.groundFix`) puts a foot sweeping back at ground speed onto the floor and keeps a pushing-off or swinging foot 3 cm clear.
  - The ground lock (dressed legs are longer than the clips' skeleton) raises a foot that would still dip below the floor by bending that knee. It used to lift the whole body, which jolted the walk upward at every heel strike (vertical acceleration spikes of 17 m/s², versus about 6 from the clip itself).
  - Result: jog bob 10 cm (sprint 8 cm), planted feet move at about 98% of ground speed, and toes never sink.
  - On foot, the stick has two gaits instead of a speed ramp: a light push walks at 1.4 m/s, a push past about 2/3 runs at 4.6 m/s (with hysteresis), and full forward sprints. Keyboard: hold Alt to walk. Nearly any walk-range push gives the full walk (a slower walk played the cycle in slow motion).
  - Dynamic resolution now tests each resolution drop: if the next 1.5 s window isn't at least ~7% faster, the browser is pacing frames (iOS Low Power Mode or a throttled web view caps pages at 30 Hz). It then restores the resolution, holds off for 30 s, and the FPS overlay reports "browser-capped". Before, a 30 Hz cap drove the resolution to its minimum for nothing.
  - Taxi fares and other seated passengers (`Ped.riding`) are excluded from vehicle-vs-pedestrian hits. The cab used to "run over" its own passenger (they sit at the cab's position) once it passed 2.5 m/s, which was a witnessed hit-and-run and a wanted star. The old ramp passed through a slow-jog band that read as "running slowly".
  - Actions with no clip (hands up, cower, kick, lockpick, wave, bike) retarget the old procedural `Pose` onto the skeleton (`ProcPose`).
  - The ragdoll is now 11 bodies on real bones, with hinge-limited elbows and knees.
  - `__game.lineup()` shows a QA row of animated characters.
