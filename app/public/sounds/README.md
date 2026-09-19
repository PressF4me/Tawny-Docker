# Chime sounds

The five clips the Viewer can play on the Monitor to get a pet's attention.
Bundled in the APK (`syncWebAssets` copies this folder into
`android/app/src/main/assets/web/`, minus `_src/`) and fetched same-origin at
runtime — nothing is streamed and nothing is downloaded at use time.

## The set

| Slug | Button | File | Length | Source |
|---|---|---|---|---|
| `bark` | "Dog toy" | `bark.ogg` | 1.6 s | `_src/dog toy - dog.mp3`, 3 hits |
| `pspsps` | "Psp psp psp" | `pspsps.ogg` | 1.2 s | `_src/pspsps - internal.m4a`, 1.0–2.2 s |
| `meow` | "Meow" | `meow.ogg` | 1.1 s | `_src/meow - cat.wav`, the 4th meow (5.35–6.40 s) |
| `goodboy` | "Good boy" | `goodboy.ogg` | 0.8 s | `_src/goodboy - dog.mp3` |
| `bell` | "Bell" | `bell.ogg` | 1.8 s | FM synthesis (no source file) |

The original recordings the first four are trimmed and normalised from are
**not in this repository**: the Pixabay licence covers them inside the app, not
as loose downloadable files, and `pspsps` is an internal recording. Keep them
locally in `_src/` (git-ignored) or point `TAWNY_SOUNDS_SRC` at them. They are
the master copy: edit those, or the trim windows in `tools/gen-chimes.sh`, and
re-run that script to rebuild the whole set. `_src/` is excluded from the APK.

## Licensing — nothing here needs a credit line

| `_src/` file | Origin | Licence | Attribution |
|---|---|---|---|
| `dog toy - dog.mp3` | Pixabay Sound Effects #5987 (`film-special-effects-dog-toy`) | Pixabay Content License — commercial OK | not required |
| `goodboy - dog.mp3` | Pixabay Sound Effects #352699 (`people-good-boy-male-voice-praise`) | Pixabay Content License | not required |
| `meow - cat.wav` | freesound.org **582745** "Stereo cat complaint" by *itinerantmonk108* | **CC0** | not required |
| `pspsps - internal.m4a` | Internal recording, supplied for this app | internal use only | not required |

**Pixabay Content License:** fine to bundle in a commercial app, no attribution.
Cannot be resold as a standalone file or used for ML training — neither applies
here. Keep the download page for your records.

**`pspsps`:** was previously freesound.org 654284 ("Female calling a cat" by
Jolindi, CC BY 4.0), which needed an in-app credit — see git history if that
clip is ever needed again. Replaced 2026-09-04 with an internal recording
supplied for this app specifically, so the credit in the About screen's
"Sound credits" section (`showAbout()` in `MainActivity.kt`) came out too.

## Format

For every shipped clip, and anything that replaces one:

- **Ogg Vorbis**, **mono**, **32 kHz** (`tools/gen-chimes.sh` uses `-q:a 3`)
- **0.3 – 2.0 s**, **under 40 KB** (current set: 8–17 KB each, ~58 KB total)
- levelled to about −1.5 dBFS with a limiter; per-clip trim also lives in the
  `CHIMES` table in `public/app.js`, so a replacement need not match exactly
- Vorbis not Opus: Chromium decodes Vorbis in-process for Web Audio on every
  platform we ship to; Opus-in-Ogg is only guaranteed from Android API 29 and
  `minSdk` is 26

Drop a raw recording into `_src/` (any format ffmpeg reads; it stays out of git), point
`tools/gen-chimes.sh` at it, re-run, then rebuild the debug APK so the mirror in
`android/app/src/main/assets/web/sounds/` updates, and commit both copies.

## `bell` stays synthesised

FM synthesis with an inharmonic modulator (the Chowning bell) — how bells have
been made since 1973. No sample beats it at 8 KB, and there is no licence
question. Expression is in `tools/gen-chimes.sh`.

## Failure behaviour

Every slug also has a synthesised fallback in `synthChime()` in `public/app.js`.
If a clip 404s or fails to decode, the Monitor plays the oscillator version
rather than nothing — the Viewer has already been told the chime played, so
silence would be a lie. The failure is written to the diagnostics log.
