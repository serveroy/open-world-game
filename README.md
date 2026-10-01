# Crimson Coast

An original, mobile-first open-world action-crime game that runs in the browser. You play
Nico Reyes, a getaway driver back in **Port Solano** after five years inside. The city,
characters, story and vehicles are all original. There is no third-party IP and no real car
brands.

- **World**: a 3.2 × 2.4 km map with downtown, docks, Rustvale, Velvet Row's neon strip,
  Palm Heights, a marina, two islands and the Sal Mesa desert. Chunks stream in as you move,
  with day/night and weather (rain, fog, sandstorms).
- **Gameplay**: drive, carjack or lockpick 18 vehicles (cars, bikes, boats and a helicopter).
  There are 10 weapons with lock-on and a 5-star police system (foot cops, pursuit cruisers,
  roadblocks, SWAT and a spotlight helicopter). Ragdolls, vehicle damage and explosions are
  physics-driven.
- **Story**: 23 data-driven missions across 3 acts, with cutscenes, choices and two endings.
- **Economy**:
  - Safehouses with save points and garages, plus businesses that earn passive income.
  - Gun shop, barber, clothing store, tattoo parlour, a mod shop (engine, brakes, tyres,
    armour, turbo, paint, repair) and respray garages.
- **Side activities**: 3 street races, taxi fares, courier deliveries, theft contracts,
  4 rampages, random street events, 30 hidden Saint Shells, and two nightclubs (rhythm
  dance game, bar, and an off-screen VIP lounge).
- **Phone**: a GPS map with waypoints, jobs, contacts, property, stats, settings and saving.
- **Audio**: 100% procedural. Engine RPM synthesis, sirens, horns, alarms, guns, ambience,
  and three generative radio stations: Neon FM, Dust Radio and Low Tide.
- **Platform**: an installable PWA that works offline, with fullscreen and landscape lock.
  The game auto-saves to IndexedDB.

## Controls

| Action | Touch | Keyboard / mouse | Gamepad |
|---|---|---|---|
| Move / steer | Left half: floating joystick | WASD | Left stick |
| Look / aim | Drag right half | Mouse (click to lock pointer) | Right stick |
| Attack / shoot | ✊ button | Left mouse | RT |
| Aim (lock-on) | ◎ button (hold) | Right mouse | LT |
| Switch target | Swipe while aiming / ⇆ | T / middle mouse | RB |
| Jump / handbrake | ⤒ / HB | Space | A / RB |
| Sprint | » | Shift | L3 |
| Enter / exit vehicle | ENTER / EXIT | F | B |
| Use (shops, jobs, doors) | USE (appears when available) | E | X |
| Reload | ⟳ | R | X |
| Cover / crouch | ▣ | Q / Ctrl | Y |
| Weapon wheel | ⊕ (hold and slide) | Tab | LB |
| Gas / brake (driving) | ▲ / ▼ | W / S | RT / LT |
| Helicopter up / down | ⇧ / ⇩ | Shift / Ctrl (or V / Z) | RB / LB |
| Horn · camera · radio | 📯 · 🎥 · 📻 | H · C · N | D-pad ↓ · R3 · D-pad ↑ |
| Phone · pause | 📱 · II | M · Esc | Back · Start |
| Skip dialogue | Tap the screen | Enter | RT |

In menus, use arrow keys or WASD, Space or Enter, and Esc. On a gamepad, use the stick or
D-pad with A to confirm and B to go back. To rearrange the touch buttons, go to
**Settings → HUD & Touch → Edit layout**, drag the buttons, then tap Done.

## Run locally

Requires Node 20+.

```bash
npm install
npm run dev          # http://localhost:5173  (add --host to test on a phone over LAN)
npm run build        # type-check + production build into dist/
npm run preview      # serve dist/ at http://localhost:4173 (service worker active)
npm test             # Vitest unit tests (physics, AI, missions, economy, saves, audio…)
npm run smoke        # headless browser smoke test against dist/ (needs a build first)
```

Useful URL parameters:

| Parameter | Effect |
|---|---|
| `?quality=low\|med\|high` | Choose the quality preset |
| `?debug=1` | FPS / draw-call overlay |
| `?play=1` | Skip the title screen |
| `?mission=m05_shotsfired` | Jump straight to a mission |
| `?time=22` | Start at a set hour |
| `?weather=rain` | Start in a set weather |
| `?test=1` | Physics sandbox |

`window.__game` exposes the running game for debugging, for example `__game.teleport(x, z)`,
`__game.debugSpawn('aurelia', true)`, `__game.debugArm()` and `__game.perf()`.

## Deploy to Vercel

The project is a static site, and `vercel.json` already sets the build command, the output
directory and the cache headers. The cache headers make hashed assets immutable and keep
`sw.js` uncached.

**Dashboard:**
1. Push the repo to GitHub.
2. In Vercel, choose **Add New → Project** and import the repo.
3. Keep the framework preset as **Other**. Vercel picks up `npm run build` and `dist` from
   `vercel.json`.
4. Click **Deploy**.

**CLI:**
```bash
npm i -g vercel
vercel            # preview deployment
vercel --prod     # production
```

Any static host works: upload the contents of `dist/`. The build uses relative paths, so it
also runs from a sub-folder.

## Performance

- **Quality presets** (Low, Medium, High) are auto-detected from the device and can be
  changed in Settings. High adds bloom, a vignette and film grain.
- **Dynamic resolution** holds 60 fps, or 30 fps when the 30 fps battery cap is set.
- **Rendering cost** is kept low:
  - Each streamed 200 m chunk is a single merged mesh, with a collapsed far-LOD terrain and
    skyline.
  - Characters, wheels and props are drawn with instancing, and entities and particles are
    pooled.
  - Measured on High in busy downtown scenes: about 130–170 draw calls.
- **Download size**: about 5.3 MB raw, or about 1.9 MB gzipped (JS and CSS). No art or audio
  files are downloaded; everything is generated at load time.

## Project layout

See [`PLAN.md`](PLAN.md) for the design document, architecture, milestone log and
deviations, and [`CLAUDE.md`](CLAUDE.md) for contributor conventions. Licences are listed in
[`CREDITS.md`](CREDITS.md).

```
src/
  core/        rng, math, events, settings, IndexedDB save system
  render/      renderer + presets, world shader, sky, water, particles, post FX
  world/       map data, terrain, city generation, chunk streaming, time & weather
  physics/     Rapier wrapper + collision groups
  input/       unified input: keyboard/mouse, touch, gamepad, gyro
  player/      player controller, camera rig, vitals
  characters/  procedural humanoids, poses, ragdolls
  vehicles/    vehicle data, meshes, handling, damage, traffic AI
  peds/        pedestrians, reactions, lockpick
  combat/      weapons, shooting, melee, FX
  police/      wanted system + dispatcher
  missions/    JSON mission schema, runner, live host
  economy/     wallet, properties/businesses, shop catalogues
  activities/  races, jobs, theft contracts, rampages, events, collectibles, nightlife
  audio/       procedural SFX bank (Howler), engines/sirens/ambience, generative radio
  ecs/         miniplex entity index
  ui/          HUD, minimap, phone, shops, settings, menus
  data/        characters, tips, missions/*.json
```
