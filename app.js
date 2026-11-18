import { PoseLandmarker, FilesetResolver, DrawingUtils } from './vendor/vision_bundle.mjs';
import { RepDetector, Workout, Smoother, CINDY } from './counter.js';

const $ = s => document.querySelector(s);
const store = {
  get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage unavailable */ } },
};
const DEFAULTS = { minutes: 20, reps: [5, 10, 15], level: 'standard', model: 'lite', mirror: true, voice: true, countAloud: true, camera: '' };
const settings = { ...DEFAULTS, ...store.get('cindy.settings', {}) };
const COLORS = { pullup: 'var(--pull)', pushup: 'var(--push)', squat: 'var(--squat)' };
const DRAW = { pullup: '#2f6fdb', pushup: '#e23b2e', squat: '#f0a316' };

const video = $('#video'), canvas = $('#canvas'), ctx = canvas.getContext('2d');
const drawer = new DrawingUtils(ctx);
const smoother = new Smoother(0.55);

let landmarker = null, loadedModel = '', loading = null;
let stream = null, sourceOn = false, lastVT = -1;
let workout = new Workout(cfg()), detector = null;
let phase = 'idle';            // idle | countdown | running | paused | done
let startAt = 0, pausedTotal = 0, pauseAt = 0, countdownTimer = 0, endArmed = 0;
let announced = new Set(), wakeLock = null, audio = null, lastLive = null, lastLm = null;

function cfg() {
  return { minutes: settings.minutes, moves: CINDY.moves.map((m, i) => ({ ...m, reps: settings.reps[i] })) };
}
const durationMs = () => workout.cfg.minutes * 60000;
function elapsedMs() {
  if (phase === 'running') return performance.now() - startAt - pausedTotal;
  if (phase === 'paused') return pauseAt - startAt - pausedTotal;
  if (phase === 'done') return Math.min(workout.endedAt ?? durationMs(), durationMs());
  return 0;
}
const fmt = ms => { const s = Math.max(0, Math.ceil(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
const fmtSplit = ms => { const s = Math.round(ms / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };

/* ---------- audio + voice ---------- */
function beep(freq = 880, dur = 0.08) {
  try {
    audio = audio || new AudioContext();
    const o = audio.createOscillator(), g = audio.createGain();
    o.frequency.value = freq; g.gain.value = 0.15;
    o.connect(g).connect(audio.destination);
    o.start(); g.gain.exponentialRampToValueAtTime(0.0001, audio.currentTime + dur); o.stop(audio.currentTime + dur + 0.02);
  } catch { /* no audio */ }
}
function say(text, interrupt = false) {
  if (!settings.voice || !('speechSynthesis' in window)) return;
  if (interrupt) speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text); u.rate = 1.15;
  speechSynthesis.speak(u);
}

/* ---------- pose model + camera ---------- */
function setStatus(text, kind = '') {
  $('#chip').hidden = false; $('#status').textContent = text;
  $('#dot').className = 'dot ' + kind;
}
async function loadModel() {
  if (landmarker && loadedModel === settings.model) return;
  if (loading) return loading;
  loading = (async () => {
    setStatus('Loading pose model…', 'warn');
    const fileset = await FilesetResolver.forVisionTasks(new URL('./vendor/wasm', location.href).href);
    const opts = delegate => ({
      baseOptions: { modelAssetPath: new URL(`./models/pose_landmarker_${settings.model}.task`, location.href).href, delegate },
      runningMode: 'VIDEO', numPoses: 1,
      minPoseDetectionConfidence: 0.5, minPosePresenceConfidence: 0.5, minTrackingConfidence: 0.5,
    });
    landmarker?.close();
    try { landmarker = await PoseLandmarker.createFromOptions(fileset, opts('GPU')); }
    catch { landmarker = await PoseLandmarker.createFromOptions(fileset, opts('CPU')); }
    loadedModel = settings.model;
    setStatus('Looking for you…', 'warn');
  })();
  try { await loading; } finally { loading = null; }
}

function stopSource() {
  stream?.getTracks().forEach(t => t.stop()); stream = null;
  if (video.src) { URL.revokeObjectURL(video.src); video.removeAttribute('src'); }
  video.srcObject = null; sourceOn = false;
}
async function startCamera() {
  $('#camErr').textContent = '';
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
    $('#camErr').textContent = 'Camera needs a secure page: open this app over https:// or from http://localhost.';
    return;
  }
  try {
    stopSource();
    const size = { width: { ideal: 1280 }, height: { ideal: 720 } };
    const v = settings.camera ? { deviceId: { exact: settings.camera }, ...size } : { facingMode: 'user', ...size };
    stream = await navigator.mediaDevices.getUserMedia({ video: v, audio: false });
    video.srcObject = stream; video.loop = false;
    await video.play();
    sourceOn = true;
    $('#stage').classList.toggle('mirror', settings.mirror);
    $('#empty').hidden = true;
    listCameras();
    await loadModel();
  } catch (e) {
    $('#camErr').textContent = e.name === 'NotAllowedError'
      ? 'Camera permission was blocked. Allow it in the browser’s address bar, then try again.'
      : `Could not start the camera (${e.message || e.name}).`;
    $('#empty').hidden = false;
  }
}
async function startFile(file) {
  stopSource();
  video.src = URL.createObjectURL(file); video.loop = false;
  $('#stage').classList.remove('mirror');
  $('#empty').hidden = true;
  await loadModel();
  await new Promise(r => video.readyState >= 2 ? r() : video.addEventListener('loadeddata', r, { once: true }));
  sourceOn = true; // waits on its first frame until the countdown ends
}
async function listCameras() {
  const sel = $('#sCam');
  try {
    const cams = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'videoinput');
    sel.innerHTML = '<option value="">Default camera</option>' +
      cams.map((c, i) => `<option value="${c.deviceId}">${(c.label || `Camera ${i + 1}`).replace(/</g, '&lt;')}</option>`).join('');
    sel.value = cams.some(c => c.deviceId === settings.camera) ? settings.camera : '';
  } catch { /* enumerate unsupported */ }
}

/* ---------- frame loop ---------- */
function frame() {
  requestAnimationFrame(frame);
  if (!landmarker || !sourceOn || video.readyState < 2 || video.currentTime === lastVT) return;
  lastVT = video.currentTime;
  if (canvas.width !== video.videoWidth || canvas.height !== video.videoHeight) {
    canvas.width = video.videoWidth; canvas.height = video.videoHeight;
    $('#stage').style.aspectRatio = `${video.videoWidth} / ${video.videoHeight}`;
  }
  const now = performance.now();
  let res;
  try { res = landmarker.detectForVideo(video, now); } catch { return; }
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const raw = res.landmarks?.[0];
  if (!raw) {
    smoother.reset();
    setStatus('No one in view', 'warn');
    showLive({ hint: phase === 'running' ? 'Step into the frame' : '' });
    return;
  }
  const lm = smoother.push(raw); lastLm = lm;
  setStatus('Tracking', 'on');
  let live = { hint: '' };
  if (phase === 'running') {
    live = detector.update(lm, now, video.videoWidth / video.videoHeight);
    if (live.rep) addRep();
  }
  const color = live.phase === 'B' ? '#ffffff' : DRAW[workout.move.key];
  drawer.drawConnectors(lm, PoseLandmarker.POSE_CONNECTIONS, { color, lineWidth: Math.max(3, canvas.width / 300) });
  drawer.drawLandmarks(lm, { color: '#ffffff', fillColor: color, radius: Math.max(3, canvas.width / 400), lineWidth: 1 });
  showLive(live);
}
function showLive(r) {
  const key = `${r.hint}|${r.label}|${Math.round(r.value ?? 0)}|${r.phase}`;
  if (key === lastLive) return; lastLive = key;
  $('#hint').textContent = r.hint || '';
  const m = $('#meter');
  m.hidden = r.value == null;
  if (r.value != null) m.textContent = `${r.label} ${Math.round(r.value)}° · ${r.phase === 'B' ? 'bottom/top reached' : r.phase === 'A' ? 'ready' : 'get set'}`;
}

/* ---------- workout flow ---------- */
function newDetector() { detector = new RepDetector(workout.move.key, settings.level); }

function addRep() {
  if (phase !== 'running') return;
  const ev = workout.add(elapsedMs());
  const st = $('#stage'); st.classList.remove('flash'); void st.offsetWidth; st.classList.add('flash');
  if (ev === 'rep') {
    beep(880, 0.06);
    if (settings.countAloud) say(String(workout.reps), true);
  } else {
    newDetector();
    beep(1320, 0.18);
    say(ev === 'round' ? `Round ${workout.rounds} done. ${workout.move.name}` : workout.move.name, true);
  }
  render();
}
function undoRep() {
  if (phase !== 'running' && phase !== 'paused' && phase !== 'done') return;
  if (workout.undo()) { newDetector(); render(); if (phase === 'done') saveResult(true); }
}

async function startWorkout() {
  if (phase === 'paused') {
    pausedTotal += performance.now() - pauseAt; phase = 'running';
    if (video.src && video.paused) video.play().catch(() => {});
    say('Go', true); render(); return;
  }
  if (phase === 'running') {
    pauseAt = performance.now(); phase = 'paused';
    if (video.src) video.pause();
    say('Paused', true); render(); return;
  }
  if (!sourceOn) await startCamera();
  if (!sourceOn) return;
  beep(1, 0.01); // unlock audio inside the click
  workout = new Workout(cfg()); newDetector(); announced = new Set();
  phase = 'countdown'; render();
  let n = 10;
  const ov = $('#overlay'); ov.hidden = false;
  const tick = () => {
    if (n === 0) {
      ov.hidden = true; clearInterval(countdownTimer);
      phase = 'running'; startAt = performance.now(); pausedTotal = 0;
      if (video.src) { video.currentTime = 0; video.play().catch(() => {}); }
      beep(1320, 0.4); say(`Go! ${workout.move.name}`, true);
      requestWake(); render(); return;
    }
    ov.innerHTML = `${n}<small>${n > 3 ? 'Get to the bar' : 'Ready'}</small>`;
    if (n === 10) say('Ten seconds'); else if (n <= 3) { say(String(n), true); beep(660, 0.12); }
    n--;
  };
  tick(); countdownTimer = setInterval(tick, 1000);
}

function finish(early = false) {
  if (phase !== 'running' && phase !== 'paused') return;
  workout.endedAt = early ? elapsedMs() : durationMs();
  phase = 'done';
  if (video.src) video.pause();
  beep(440, 0.8); say(`Time! ${workout.rounds} rounds and ${workout.partial} reps.`, true);
  releaseWake(); saveResult(); render(); showResult();
}
function resetWorkout() {
  clearInterval(countdownTimer); $('#overlay').hidden = true;
  phase = 'idle'; workout = new Workout(cfg()); newDetector(); releaseWake(); render();
}

function timerTick() {
  if (phase !== 'running') return;
  const left = durationMs() - elapsedMs();
  const calls = [[600000, '10 minutes left'], [300000, '5 minutes left'], [60000, 'One minute left'], [10000, '10 seconds']];
  for (const [ms, text] of calls) {
    if (left <= ms && left > ms - 2000 && durationMs() > ms && !announced.has(ms)) { announced.add(ms); say(text); }
  }
  if (left <= 3000 && left > 0) { const s = Math.ceil(left / 1000); if (!announced.has('c' + s)) { announced.add('c' + s); beep(660, 0.12); } }
  if (left <= 0) finish();
  renderClock();
}

async function requestWake() { try { wakeLock = await navigator.wakeLock?.request('screen'); } catch { /* not supported */ } }
function releaseWake() { wakeLock?.release().catch(() => {}); wakeLock = null; }

/* ---------- history + result ---------- */
function saveResult(update = false) {
  const hist = store.get('cindy.history', []);
  const entry = {
    date: workout.date || (workout.date = new Date().toISOString()),
    minutes: workout.cfg.minutes, reps: workout.cfg.moves.map(m => m.reps),
    rounds: workout.rounds, partial: workout.partial, total: workout.total, splits: workout.roundTimes(),
  };
  const i = hist.findIndex(h => h.date === entry.date);
  if (i >= 0) hist[i] = entry; else if (!update) hist.unshift(entry);
  store.set('cindy.history', hist.slice(0, 100));
  renderHistory();
}
function summary() {
  const t = workout.roundTimes();
  const reps = workout.cfg.moves.map(m => m.reps).join('-');
  return `Cindy (${workout.cfg.minutes} min AMRAP ${reps}): ${workout.score} — ${workout.total} total reps` +
    (t.length ? `. Rounds: ${t.map(fmtSplit).join(', ')}` : '');
}
function showResult() {
  const t = workout.roundTimes(), max = Math.max(...t, 1);
  $('#resScore').textContent = workout.score;
  $('#resSub').textContent = `${workout.total} total reps in ${fmt(workout.endedAt)}` +
    (t.length ? ` · average round ${fmtSplit(t.reduce((a, b) => a + b, 0) / t.length)}` : '');
  $('#resSplits').innerHTML = t.map((ms, i) =>
    `<div class="split"><span>Round ${i + 1}</span><span class="bar"><i style="width:${(ms / max * 100).toFixed(1)}%"></i></span><span class="r">${fmtSplit(ms)}</span></div>`).join('');
  $('#modal').hidden = false; $('#closeBtn').focus();
}
function renderHistory() {
  const hist = store.get('cindy.history', []);
  $('#histEmpty').hidden = hist.length > 0;
  $('#hist').innerHTML = hist.map(h => {
    const avg = h.splits.length ? fmtSplit(h.splits.reduce((a, b) => a + b, 0) / h.splits.length) : '–';
    const d = new Date(h.date).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
    const tag = h.minutes !== 20 || h.reps.join() !== '5,10,15' ? ` <span class="muted">(${h.minutes}′ ${h.reps.join('-')})</span>` : '';
    return `<tr><td>${d}${tag}</td><td class="r">${h.rounds} + ${h.partial}</td><td class="r">${h.total}</td><td class="r">${avg}</td></tr>`;
  }).join('');
}

/* ---------- rendering ---------- */
function renderClock() {
  const left = durationMs() - elapsedMs();
  const c = $('#clock'); c.textContent = fmt(left);
  c.classList.toggle('low', phase === 'running' && left <= 60000);
  $('#elapsed').textContent = phase === 'idle' ? 'Time cap' : `Remaining · ${fmt(elapsedMs())} elapsed`;
}
function render() {
  renderClock();
  const w = workout, m = w.move;
  $('#score').textContent = w.score;
  $('#total').textContent = `rounds + reps · ${w.total} total`;
  $('#now').style.setProperty('--c', COLORS[m.key]);
  $('#moveName').textContent = m.name;
  $('#moveReps').innerHTML = `${w.reps}<small>/${m.reps}</small>`;
  $('#moveSub').textContent = phase === 'done' ? 'Finished' : `Round ${w.rounds + 1}${phase === 'paused' ? ' · paused' : ''}`;
  $('#ladder').innerHTML = w.cfg.moves.map((mv, i) => {
    const done = i < w.mi ? mv.reps : i === w.mi ? w.reps : 0;
    return `<div class="rung${i === w.mi ? ' cur' : ''}" style="--c:${COLORS[mv.key]}"><span>${mv.name}</span>` +
      `<span class="bar"><i style="width:${(done / mv.reps * 100).toFixed(1)}%"></i></span><span class="n">${done}/${mv.reps}</span></div>`;
  }).join('');
  const go = $('#goBtn');
  go.textContent = { idle: 'Start workout', countdown: 'Starting…', running: 'Pause', paused: 'Resume', done: 'Start again' }[phase];
  go.disabled = phase === 'countdown';
  $('#endBtn').disabled = !(phase === 'running' || phase === 'paused');
  $('#endBtn').textContent = endArmed ? 'Tap again to end' : 'End';
  $('#plusBtn').disabled = phase !== 'running';
  $('#minusBtn').disabled = !(phase === 'running' || phase === 'paused' || phase === 'done') || w.total === 0;
  const reps = w.cfg.moves.map(mv => `${mv.reps} ${mv.name.toLowerCase()}`).join(' · ');
  $('#wodline').innerHTML = `<b>${w.cfg.minutes}-min AMRAP</b> · ${reps}`;
}

/* ---------- settings ---------- */
function bindSettings() {
  const f = { sMin: 'minutes', sLevel: 'level', sModel: 'model', sMirror: 'mirror', sVoice: 'voice', sCount: 'countAloud', sCam: 'camera' };
  for (const [id, k] of Object.entries(f)) {
    const el = $('#' + id);
    if (el.type === 'checkbox') el.checked = settings[k]; else el.value = settings[k];
  }
  settings.reps.forEach((r, i) => { $('#sR' + i).value = r; });
  const save = async e => {
    const id = e.target.id;
    if (f[id]) settings[f[id]] = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
    settings.minutes = clampInt($('#sMin').value, 1, 60, 20);
    settings.reps = [0, 1, 2].map(i => clampInt($('#sR' + i).value, 1, 50, DEFAULTS.reps[i]));
    store.set('cindy.settings', settings);
    if (phase === 'idle' || phase === 'done') { workout = new Workout(cfg()); phase = 'idle'; }
    newDetector(); render();
    if (id === 'sMirror' && !video.src) $('#stage').classList.toggle('mirror', settings.mirror);
    if (id === 'sCam' && stream) startCamera();
    if (id === 'sModel' && sourceOn) loadModel();
  };
  document.querySelectorAll('.form input, .form select').forEach(el => el.addEventListener('change', save));
  const preset = (min, reps) => {
    $('#sMin').value = min; reps.forEach((r, i) => { $('#sR' + i).value = r; });
    $('#sMin').dispatchEvent(new Event('change'));
  };
  $('#miniBtn').onclick = () => preset(10, [5, 10, 15]);
  $('#stdBtn').onclick = () => preset(20, [5, 10, 15]);
}
const clampInt = (v, lo, hi, d) => { const n = parseInt(v, 10); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };

/* ---------- events ---------- */
$('#camBtn').onclick = startCamera;
$('#fileIn').onchange = e => { const f = e.target.files[0]; if (f) startFile(f); };
$('#goBtn').onclick = () => { if (phase === 'done') resetWorkout(); startWorkout(); };
$('#plusBtn').onclick = addRep;
$('#minusBtn').onclick = undoRep;
$('#resetBtn').onclick = resetWorkout;
$('#endBtn').onclick = () => {
  if (endArmed) { clearTimeout(endArmed); endArmed = 0; finish(true); return; }
  endArmed = setTimeout(() => { endArmed = 0; render(); }, 3000); render();
};
$('#closeBtn').onclick = () => { $('#modal').hidden = true; };
$('#modal').onclick = e => { if (e.target.id === 'modal') $('#modal').hidden = true; };
$('#copyBtn').onclick = async () => {
  try { await navigator.clipboard.writeText(summary()); $('#copyBtn').textContent = 'Copied'; }
  catch { $('#copyBtn').textContent = 'Copy failed'; }
  setTimeout(() => { $('#copyBtn').textContent = 'Copy result'; }, 2000);
};
let clearArmed = 0;
$('#clearBtn').onclick = () => {
  if (clearArmed) { clearTimeout(clearArmed); clearArmed = 0; store.set('cindy.history', []); renderHistory(); $('#clearBtn').textContent = 'Clear history'; return; }
  $('#clearBtn').textContent = 'Tap again to clear';
  clearArmed = setTimeout(() => { clearArmed = 0; $('#clearBtn').textContent = 'Clear history'; }, 3000);
};
document.addEventListener('keydown', e => {
  if (e.target.matches('input, select')) return;
  if (e.key === 'Escape') $('#modal').hidden = true;
  else if (e.code === 'Space') { e.preventDefault(); addRep(); }
  else if (e.key === 'Backspace') { e.preventDefault(); undoRep(); }
  else if (e.key === 'p' || e.key === 'P') { if (phase === 'running' || phase === 'paused') startWorkout(); }
});
video.addEventListener('ended', () => { if (video.src && phase === 'running') finish(true); });
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && phase === 'running') requestWake(); });

bindSettings();
newDetector();
render();
renderHistory();
setInterval(timerTick, 200);
requestAnimationFrame(frame);
window.__cindy = { get phase() { return phase; }, get workout() { return workout; }, get ready() { return !!landmarker; }, get landmarks() { return lastLm; }, get detector() { return detector; } };
