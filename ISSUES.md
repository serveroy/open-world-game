# Known Issues & Follow-ups

These are open issues found during M1–M9 development and the final review. Each one is tagged
by severity:
- 🔴 **bug**: wrong behaviour players will notice
- 🟠 **gap**: a feature is missing or simplified
- 🟡 **verify**: needs testing on real hardware or by a human
- ⚪ **polish**: cosmetic or tuning

Tick each one off here, or move it to GitHub Issues, as it gets addressed.

## Bugs
- [ ] 🔴 **Gamepad: RT both accelerates and fires while driving.** In `Gamepad.ts`, RT maps to
  both `gas` and `attack`. `CombatSystem.ts:667` treats a held `attack` in a vehicle as a
  drive-by aim. With a gun equipped, accelerating on a controller therefore fires drive-by
  shots. *Fix:* in vehicles, move gamepad drive-by to LB+RT, or ignore the `attack` source bit
  coming from RT while driving.
- [ ] 🔴 **Saving while driving doesn't save the car.** `SaveManager.gather()` records the car's
  position but not the car itself. After loading, the player is on foot where the car was.
  *Fix:* serialise the current vehicle (def, paint, mods, health) and respawn the player in it.
- [ ] 🔴 **Pooled Howler sounds may keep 3D panning.** Spatial one-shots set `pos()` on a sound
  id; if Howler reuses that pooled node for a non-spatial play, it may still be panned. UI and
  world sounds currently use separate sound names, but this hasn't been tested on a device.
  *Fix:* keep separate Howl instances for spatial and 2D playback.

## Gaps / simplifications
- [ ] 🟠 **Club interiors are a stylised full-screen overlay**, not walkable 3D rooms. See the
  PLAN §11 deviation log.
- [ ] 🟠 **Wasted always respawns at the hospital**, even if you own a closer safehouse.
  `SaveManager.nearestSafehouse()` exists but isn't used by `Respawn`.
- [ ] 🟠 **Mid-game Load and New Game reload the page** to get a clean state. This adds a few
  seconds of loading.
- [ ] 🟠 **miniplex is only used as an entity index** (vehicles and peds, with `siren` and
  `hostile` tags). Game systems are ordinary classes.
- [ ] 🟠 **Some settings need a restart:** quality preset, shadows and view distance. The
  settings screen says so.
- [ ] 🟠 **Story missions were auto-played in headless tests against a fake host.** They still
  need a full play-through in a real browser to catch spawn-position or pacing problems.

## Verify on real devices
- [ ] 🟡 **FPS on real phones.** The headless browser renders in software, so only draw calls
  (about 130–170 on High) were measured. High draws about 520k triangles downtown, which may
  be too much for mid-range phones; check the automatic quality choice in
  `Renderer.detectQuality`.
- [ ] 🟡 **Audio by ear.** Check the mix levels for engines, sirens, radio and ambience; whether
  the radio music sounds good; and that audio starts after the first tap on iOS Safari.
- [ ] 🟡 **iPhone has no Fullscreen API or orientation lock** in Safari. Adding the game to the
  Home Screen gives fullscreen; otherwise the "rotate your device" hint is shown. Confirm this
  works well.
- [ ] 🟡 **Touch layout on small or notched phones.** Check safe-area insets, buttons
  overlapping the minimap or phone, and the shop panel at heights of 360 px or less.
- [ ] 🟡 **Service worker update flow.** A new deploy should replace the old cache on the next
  visit; confirm there is no stale-cache loop on Vercel.

## Polish
- [ ] ⚪ Barber, clothing and tattoo preview camera: framing can be dark or tight against
  building walls.
- [ ] ⚪ Vehicle-shop beacons (mod shop, respray, garages) are large when seen from a car.
- [ ] ⚪ Phone home screen: the footer line is cut off on very short screens (you can scroll to
  it).
- [ ] ⚪ Bloom strength was tuned on one Velvet Row night scene; check it in rain and sandstorms.
- [ ] ⚪ Theft-contract cars spawn in random parking spots; some may be awkward to reach.
- [ ] ⚪ Race rival pace and rubber-banding need tuning by feel (`Race.ts`, `pace`).
