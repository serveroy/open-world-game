# Known Issues & Follow-ups

This file tracks open issues, tagged by severity:
- 🔴 **bug**: wrong behaviour players will notice
- 🟠 **gap**: a feature is missing or simplified
- 🟡 **verify**: needs testing on real hardware or by a human
- ⚪ **polish**: cosmetic or tuning

✅ = fixed (kept for history).

## Fixed in the characters round
- [x] ✅ 🟠 **Blocky box people.** Characters are now dressed, low-poly people from the CC0 Quaternius Ultimate Modular Men and Women packs: 16 outfits whose heads, tops, trousers and shoes mix and match, tinted per person. They move with motion-captured animation from the CC0 Quaternius Universal Animation Library: walk, jog, sprint, crouch, swim, jump and land, two-handed aiming that follows the aim pitch, punches, bat swings, throws, reloads, phone calls, talking, dancing, sitting, driving, hit reactions, knock-downs and getting up. The barber, clothes shop and tattoo parlour still restyle everyone (painted stubble and goatees, modelled full beards). Police wear navy uniforms with caps; SWAT wear armour. Characters are drawn in instanced batches: one draw per outfit combination, so a squad of cops is one draw. Ragdolls use the real skeleton (11 bodies; knees and elbows only bend the right way).

## Fixed in the phone-feedback round
- [x] ✅ 🔴 **Blurry rendering on phones.** The Low preset capped the render at 1 pixel per CSS pixel, and dynamic resolution dropped to half of that. In landscape inside an app (about 572×307 CSS px at 3×), the world was drawn at roughly a third of the screen's resolution. Rendering now targets a render height per preset (Low 600, Medium 780, High 1080 device px), with a pixel budget and a floor for dynamic resolution (`renderPixelRatio`, unit-tested). iPhones now auto-select Medium, which has MSAA.
- [x] ✅ 🔴 **Touch controls overlapped each other and the HUD** on short screens. Buttons now scale to fit below the top-right HUD, with separate layouts on foot, in a car, in a boat and in the helicopter. EXIT is no longer under the attack button. The top-right HUD is a compact two-row block. Objective and subtitles moved left of the button cluster. Inside an app frame, everything clears the app header (`html.framed`).
- [x] ✅ 🟠 **Car sounds drowned out the radio.** Measured in the browser, the player's engine was about 14 dB *louder* than the radio in every driving state. The radio now goes through a broadcast-style compressor with make-up gain, so the music bus sits at about −15 to −18 dBFS RMS. The player's own vehicle (engine, wind) runs on a "cabin" bus that drops about 9 dB and is low-passed to about 2.6 kHz while the radio plays, and a bit further under speech. Tyre skids, crashes, gunshots, sirens and horns are not ducked, because they are gameplay information. Result: the music leads by +13 dB at idle, +9 dB cruising and +6 dB at full throttle. With the radio off, the engine is back to full level.
- [x] ✅ 🔴 **Radio (and engines, ambience, babble) silent on phones.** On the first Howl, Howler's auto-unlock closes and recreates the AudioContext when its sample rate isn't 44.1 kHz. iPhones and most Androids run at 48 kHz, so every live graph built on the old context went dead, while one-shot sound effects kept working on the new one. Desktop tests ran at 44.1 kHz and never hit it. Auto-unlock is now off (the game unlocks on gestures itself), and a safety net rebuilds every live graph if the context is ever replaced. Verified in a browser forced to 48 kHz: the context stays the same and running, and the radio reaches the master output (RMS about 0.09) after 40 s. A forced replacement rebuilds the graphs.
- [x] ✅ 🔴 **Radio went silent after about 30 s.** Howler auto-suspends its AudioContext 30 s after its last one-shot sound, which also killed the live radio, engine and ambience graphs on that context. Auto-suspend is now off, and a watchdog resumes audio after the phone interrupts it. Checked in the browser: still running at 40 s, with real output level.
- [x] ✅ 🟠 **Radio didn't sound like songs.** Songs now follow a real song structure: intro, verse, chorus, verse, chorus, bridge, chorus, outro. The chorus has its own chord progression, a sung hook (a synthesized formant "voice") and a crash cymbal. Drum fills mark section ends, there's reverb, and outros fade. A DJ voice links songs ("That was … by …"), and the HUD shows artist and title. `scripts/render-radio.mjs` renders samples to WAV.
- [x] ✅ 🟠 **Places were hard to find or recognise.** Every landmark now has a lit name sign on its facade (one atlas, one draw call). Floating labels over nearby places show the name and what you can do there ("Buy Taco Tide — $8,000"). The phone map has a **Key** that explains every icon and jumps to the nearest one.
- [x] ✅ 🔴 **Couldn't get out of a stopped car.** The EXIT tap got the player out, but the same tap, still marked as pressed in that frame, triggered the "enter nearby car" check and put them straight back in. The exit now consumes the press. Touch buttons also no longer fail if `setPointerCapture` throws. Checked in the browser by tapping the real EXIT button.
- [x] ✅ 🔴 **Sometimes the car wouldn't let you out.** While waiting for the car to stop, the game held the foot brake, which turns into reverse at low speed. On a slope, in traffic or while being rammed, the car never stopped. It now uses the handbrake and forces the exit after 1.1 s.
- [x] ✅ 🔴 **No audio on iPhone.** iOS silences Web Audio while the ringer switch is on silent. The game now requests a `playback` audio session, with a silent looping `<audio>` element as a fallback. Audio is unlocked in the capture phase, so even buttons that stop the tap event unlock it. **Settings → Audio → Test sound** plays a quick check.
- [x] ✅ 🟠 **Dialogue had no sound.** Lines are now spoken with the device's speech engine, with a stable voice and pitch per character. Babble is the fallback if no speech engine exists, or you can choose it or turn voices off in Settings → Audio. Dialogue waits for the spoken line to finish.
- [x] ✅ 🔴 **Gamepad RT both accelerated and fired while driving.** In vehicles the triggers are now only gas and brake; drive-by fire is on **Y**.
- [x] ✅ 🔴 **Saving while driving lost the car.** Saves now store the car (model, paint, mods, condition), and you load back in it.
- [x] ✅ 🔴 **Pooled Howler sounds could keep 3D panning.** 2D and 3D playback now use separate Howl instances.
- [x] ✅ 🟠 **Wasted always sent you to the hospital.** If an owned safehouse is closer, a medic patches you up there for a smaller fee.
- [x] ✅ 🟠 **View distance needed a restart.** It now applies live.
- [x] ✅ ⚪ **Phone design.** It is now a landscape phone: status bar, next-job widget with one-tap GPS, a 4-column grid of line icons, and a side rail for close, home and back. It fits short screens.
- [x] ✅ ⚪ **Vehicle-shop beacons were too large** when seen from a car. They are now smaller.
- [x] ✅ ⚪ **Shop preview camera was dark.** Exposure is lifted while you browse.

## Still open
- [ ] 🟠 **Club interiors are a stylised overlay**, not walkable 3D rooms. See the PLAN §11 deviation log.
- [ ] 🟠 **Mid-game Load and New Game reload the page** to get a clean state (a few seconds of loading).
- [ ] 🟠 **miniplex is only used as an entity index.** Game systems are ordinary classes. This is by design.
- [ ] 🟠 **Quality preset and shadows still need a restart.**
- [ ] 🟠 **Story missions were auto-played in headless tests**; a full play-through in a real browser is still needed.
- [ ] 🟠 **Car and building models are procedural and blocky.** See "Art upgrade" below.
- [ ] 🟡 **Character rendering cost on real phones.** GPU skinning of about 3.5k vertices (6.5k triangles) per visible character, one draw per outfit combination (plus its shadow when near). CPU animation measured at about 5 µs per character in a headless desktop browser. Check FPS with a crowd on Low and Medium.
- [ ] ⚪ The character asset is 2.6 MB (1.4 MB gzipped). Meshopt compression could roughly halve it.
- [ ] 🟡 **FPS on real phones.** Turn on Settings → Graphics → "Show FPS counter" and report numbers on Low, Medium and High.
- [ ] 🟡 **Audio by ear on iPhone and Android.** Check engine, siren and radio levels, and how good the device voices sound.
- [ ] 🟡 **Service worker update flow** on a real Vercel or Pages deploy.
- [ ] ⚪ Bloom strength in rain and sandstorms.
- [ ] ⚪ Theft-contract cars spawn in random parking spots; some may be awkward to reach.
- [ ] ⚪ Race rival pace and rubber-banding need tuning by feel (`Race.ts`, `pace`).

## Art upgrade (deferred, planned)
1. ✅ **People.** Done: dressed CC0 modular characters with CC0 motion-capture animation (see above).
2. **Cars.** Bevelled bodies, wheel arches, separate glass and lights, and a proper paint shader.
3. **Buildings.** Storefront ground floors, window frames, roof clutter (AC units, water tanks) and a few hero landmarks.

Each step must stay inside the draw-call and download budgets; add only CC0 assets and log them in CREDITS.md.
