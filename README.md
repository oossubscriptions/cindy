# Cindy Tracker

A browser app that tracks the CrossFit benchmark **"Cindy"** (20-minute AMRAP of 5 pull-ups, 10 push-ups and 15 air squats) using your camera.

- Detects your pose on-device (MediaPipe Pose Landmarker, vendored in `vendor/` + `models/`). No video leaves the browser.
- Counts pull-ups, push-ups and air squats with full range-of-motion checks, and moves on to the next movement by itself.
- Countdown clock, rounds + reps score, voice coach, round split times, and history saved in the browser.
- Manual +1 / −1 (or Space / Backspace) to correct any missed or extra reps.
- Settings: time cap, reps per movement (e.g. half Cindy), counting strictness, fast or accurate model, camera choice.
- You can also analyse a recorded video file instead of the live camera.

## Run it

Browsers only allow camera access on `https://` pages or on `localhost`, so serve the folder instead of opening the file directly:

```bash
cd cindy-tracker
python3 -m http.server 8000
```

Then open http://localhost:8000.

To use it on a **phone**, host the folder on any HTTPS static host (GitHub Pages, Netlify, Cloudflare Pages, Vercel) and open that URL. Everything is static files (~30 MB, mostly the model and the WebAssembly runtime).

## Camera setup

Place the camera 2–3 m away at hip height, about 45° to your side, so your head, hands and feet stay in view both at the bar and on the floor.

| Movement | Counts a rep when… |
|---|---|
| Pull-up | your mouth rises above your hands, after a full hang with straight arms |
| Push-up | you lock out again after your elbows bend to ~100° (in a plank) |
| Air squat | you stand up tall after your hips drop to knee height |

If counting is too picky or too loose, change **Counting strictness** in Settings.

## Tests

```bash
npm test
```

The tests cover rep detection on synthetic poses and the AMRAP score bookkeeping (`counter.js`).
