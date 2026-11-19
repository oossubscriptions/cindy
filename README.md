# Rep Sheet: camera rep counter

A browser app that counts your reps through the camera for CrossFit-style workouts. It started with the benchmark **"Cindy"** and now handles any workout.

- **Auto-detect:** pick it in the sidebar, press Start and do any exercise. Rep Sheet works out what you're doing, counts the reps and groups them into sets. It recognises the 8 camera movements below by name. It also names curls, shoulder press, hip hinges (swings, deadlifts) and glute bridges, and counts anything else you repeat steadily as "Other movement".
- **Library:** benchmarks plus warm-ups (Full warm-up, Upper warm-up, Run prep, Hip mobility), resistance band (Thera-Band) workouts (Band upper body, Band lower body, Band shoulders, Band arms, Band push & pull) and core sessions (Core burner, Core ladder).
- **Benchmarks built in:** Cindy, Fran, Angie, Chelsea, Annie, Murph, 100 Burpees and an alternating leg EMOM.
- **Build your own:** AMRAP, For time (with rounds) or EMOM (every movement each minute, or alternating), with any mix of movements.
- **Movements counted by camera:** pull-ups, push-ups, air squats, sit-ups, thrusters, burpees, lunges and jumping jacks, each with a full range-of-motion check.
- **Tap-counted movements** for things the camera can't judge: runs, double-unders and "other". Use +1, or **Done** to finish the set.
- Clock that fits the format (countdown, count-up with a cap, or per-minute), voice coach, round or minute splits, and history with personal bests. Everything is saved in the browser.
- Pose detection runs on the device (MediaPipe Pose Landmarker, vendored in `vendor/` + `models/`). No video leaves the browser.
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

Place the camera 2–3 m away at hip height, about 45° to your side, so your head, hands and feet stay in view. Jumping jacks are the exception: face the camera for those. The app shows tips for the movements in the selected workout.

| Movement | Counts a rep when… |
|---|---|
| Pull-up | your mouth rises above your hands, after a full hang with straight arms |
| Push-up | you lock out again after your elbows bend to ~100° (in a plank) |
| Air squat | you stand up tall after your hips drop to knee height |
| Sit-up | your shoulders come up over your hips after lying back |
| Thruster | the bar locks out overhead after a squat to depth |
| Burpee | you stand back up after your chest goes to the floor |
| Lunge | you stand tall after the front knee bends to ~100° |
| Jumping jack | your hands go overhead and your feet go wide |

If counting is too picky or too loose, change **Counting strictness** in Settings.

## Exercises the camera can count

- **Full rep check** (a strict two-position rep): pull-ups, push-ups, air squats, lunges, sit-ups, thrusters, burpees, jumping jacks.
- **By rhythm** (counted after 3 steady reps, then all 3 added): high knees, marching, butt kicks, arm circles, side bends, torso twists, calf raises, toe touches, hip hinges (swings, deadlifts, good mornings), mountain climbers, lateral steps (band walks, skaters), glute bridges, leg raises, clamshells, kickbacks, curls, triceps pushdowns, triceps extensions, shoulder press, lateral raises, front raises, pull-aparts, rows / chest press, face pulls, upright rows.
- **Tap to count:** double-unders, runs, anything else.

A camera can't see a resistance band, so band and dumbbell versions of an exercise look the same and are counted the same way. Rows and chest presses look alike from the side, so they share one entry.

## How auto-detect works

`detect.js` runs every movement detector from `counter.js` on each frame. A resolver settles overlaps: a burpee contains a push-up-like plank and a squat-like stand, so it wins over both. A thruster wins over a squat. Lunges are told apart from squats by a split stance. Push-ups need straight legs, and pull-ups need the body (not the hands) to move. For everything else, a rhythm counter (`rhythm.js`) finds the body signal with the biggest steady swing (wrists, elbows, hips) and counts its cycles once it has seen three in a row. A new movement, or a 20-second pause, starts a new set.

Telling movements apart works best side-on to the camera. Facing the camera, lunges can look like squats.

## Tests

```bash
npm test
```

The tests cover rep detection for every camera movement on synthetic poses, scoring for all three formats (`counter.js`), and auto-detect: recognising each movement, resolving overlaps, counting unknown movements and grouping sets (`detect.js`).
