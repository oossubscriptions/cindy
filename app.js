import { PoseLandmarker, FilesetResolver, DrawingUtils } from './vendor/vision_bundle.mjs';
import { RepDetector, Session, Smoother, WORKOUTS, MOVES, FORMAT_NAMES, describe, stepName, clock } from './counter.js';

const $ = s => document.querySelector(s);
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const store = {
  get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage unavailable */ } },
};
const DEFAULTS = { workout: 'cindy', level: 'standard', model: 'lite', mirror: true, voice: true, countAloud: true, camera: '' };
const settings = { ...DEFAULTS, ...store.get('cindy.settings', {}) };
let custom = store.get('cindy.custom', []);

const video = $('#video'), canvas = $('#canvas'), ctx = canvas.getContext('2d');
const drawer = new DrawingUtils(ctx);
const smoother = new Smoother(0.55);

let landmarker = null, loadedModel = '', loading = null;
let stream = null, sourceOn = false, lastVT = -1;
let def = null, session = null, detector = null;
let phase = 'idle';            // idle | countdown | running | paused | done
let startAt = 0, pausedTotal = 0, pauseAt = 0, endedAt = 0, countdownTimer = 0, endArmed = 0;
let announced = new Set(), wakeLock = null, audio = null, lastLive = null, lastLm = null;

const allWorkouts = () => [...WORKOUTS, ...custom];
const durationMs = () => def.minutes * 60000;
function elapsedMs() {
  if (phase === 'running') return performance.now() - startAt - pausedTotal;
  if (phase === 'paused') return pauseAt - startAt - pausedTotal;
  if (phase === 'done') return endedAt;
  return 0;
}
const idle = () => phase === 'idle' || phase === 'done';
const sayTime = ms => { const s = Math.round(ms / 1000), m = Math.floor(s / 60); return `${m ? `${m} minute${m > 1 ? 's' : ''} ` : ''}${s % 60} seconds`; };

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
  await new Promise(r => (video.readyState >= 2 ? r() : video.addEventListener('loadeddata', r, { once: true })));
  sourceOn = true; // waits on its first frame until the countdown ends
}
async function listCameras() {
  const sel = $('#sCam');
  try {
    const cams = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'videoinput');
    sel.innerHTML = '<option value="">Default camera</option>' +
      cams.map((c, i) => `<option value="${esc(c.deviceId)}">${esc(c.label || `Camera ${i + 1}`)}</option>`).join('');
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
  const active = phase === 'running' && !session.resting && !session.done;
  if (active) {
    live = detector.update(lm, now, video.videoWidth / video.videoHeight);
    if (live.rep) addRep();
    if (MOVES[session.step.key]?.manual) live.hint = `${stepName(session.step)}: tap +1 or Done`;
  }
  const color = live.phase === 'B' ? '#ffffff' : (MOVES[session.step.key] || MOVES.other).color;
  drawer.drawConnectors(lm, PoseLandmarker.POSE_CONNECTIONS, { color, lineWidth: Math.max(3, canvas.width / 300) });
  drawer.drawLandmarks(lm, { color: '#ffffff', fillColor: color, radius: Math.max(3, canvas.width / 400), lineWidth: 1 });
  showLive(live);
}
function showLive(r) {
  const key = `${r.hint}|${r.label}|${r.value?.toFixed?.(1)}|${r.phase}`;
  if (key === lastLive) return; lastLive = key;
  $('#hint').textContent = r.hint || '';
  const m = $('#meter');
  m.hidden = r.value == null;
  if (r.value != null) {
    const v = r.unit === '°' ? `${Math.round(r.value)}°` : `${r.value.toFixed(1)}${r.unit}`;
    m.textContent = `${r.label} ${v} · ${r.phase === 'B' ? 'end of range' : r.phase === 'A' ? 'ready' : 'get set'}`;
  }
}

/* ---------- workout flow ---------- */
function newDetector() { detector = new RepDetector(session.step.key, settings.level); }

function selectWorkout(id) {
  if (!idle()) return;
  def = allWorkouts().find(w => w.id === id) || WORKOUTS[0];
  settings.workout = def.id; store.set('cindy.settings', settings);
  phase = 'idle'; session = new Session(def); newDetector();
  renderPicker(); renderTitle(); renderTips(); render();
  if (def.id.startsWith('c-')) loadDraft(def, true);
}

function flashStage() { const st = $('#stage'); st.classList.remove('flash'); void st.offsetWidth; st.classList.add('flash'); }
function onEvent(ev, countAloud) {
  if (!ev) return;
  flashStage();
  if (ev === 'rep') {
    beep(880, 0.06);
    if (countAloud && settings.countAloud) say(String(session.reps), true);
  } else if (ev === 'done') {
    finish(false); return;
  } else if (ev === 'minute') {
    beep(1320, 0.18); say('Rest', true);
  } else {
    newDetector(); beep(1320, 0.18);
    const name = stepName(session.step);
    say(ev === 'round' && session.format === 'amrap' ? `Round ${session.rounds} done. ${name}` : name, true);
  }
  render();
}
function addRep() { if (phase === 'running') onEvent(session.add(elapsedMs()), true); }
function doneMove() { if (phase === 'running') onEvent(session.complete(elapsedMs()), false); }
function undoRep() {
  if (phase === 'idle' || phase === 'countdown') return;
  if (session.undo()) { newDetector(); render(); if (phase === 'done') saveResult(true); }
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
  session = new Session(def); newDetector(); announced = new Set();
  phase = 'countdown'; render(); renderPicker();
  let n = 10;
  const ov = $('#overlay'); ov.hidden = false;
  const tick = () => {
    if (n === 0) {
      ov.hidden = true; clearInterval(countdownTimer);
      phase = 'running'; startAt = performance.now(); pausedTotal = 0;
      if (video.src) { video.currentTime = 0; video.play().catch(() => {}); }
      beep(1320, 0.4); say(`Go! ${stepName(session.step)}`, true);
      requestWake(); render(); return;
    }
    ov.innerHTML = `${n}<small>${n > 3 ? `First up: ${esc(stepName(session.step))}` : 'Ready'}</small>`;
    if (n === 10) say(`Ten seconds. ${def.name}`); else if (n <= 3) { say(String(n), true); beep(660, 0.12); }
    n--;
  };
  tick(); countdownTimer = setInterval(tick, 1000);
}

function finish(early) {
  if (phase !== 'running' && phase !== 'paused') return;
  endedAt = session.done ? session.doneAt : early ? elapsedMs() : durationMs();
  phase = 'done';
  if (video.src) video.pause();
  beep(440, 0.8);
  if (session.format === 'amrap') say(`Time! ${session.rounds} rounds and ${session.partial} reps.`, true);
  else if (session.format === 'fortime') say(session.done ? `Done! ${sayTime(session.doneAt)}.` : `Time cap. ${session.total} reps.`, true);
  else say(`Done. ${session.minutesDone} of ${def.minutes} minutes completed.`, true);
  releaseWake(); saveResult(); render(); renderPicker(); showResult();
}
function resetWorkout() {
  clearInterval(countdownTimer); $('#overlay').hidden = true;
  phase = 'idle'; session = new Session(def); newDetector(); releaseWake(); render(); renderPicker();
}

function timerTick() {
  if (phase !== 'running') return;
  const el = elapsedMs(), left = durationMs() - el;
  if (session.format === 'emom') {
    const m = Math.floor(el / 60000);
    if (m >= def.minutes) { finish(false); return; }
    if (m > session.minute) {
      const ok = session.tick(m);
      newDetector(); beep(1320, 0.3);
      say(`${ok ? '' : 'Next minute. '}Minute ${m + 1}. ${stepName(session.step)}`, true);
    }
    const inMin = 60000 - (el % 60000), s = Math.ceil(inMin / 1000);
    if (s <= 3 && !announced.has(`m${m}s${s}`)) { announced.add(`m${m}s${s}`); beep(660, 0.12); }
  } else {
    const calls = [[600000, '10 minutes left'], [300000, '5 minutes left'], [60000, 'One minute left'], [10000, '10 seconds']];
    for (const [ms, text] of calls) {
      if (left <= ms && left > ms - 2000 && durationMs() > ms && !announced.has(ms)) { announced.add(ms); say(text); }
    }
    if (left <= 3000 && left > 0) { const s = Math.ceil(left / 1000); if (!announced.has('c' + s)) { announced.add('c' + s); beep(660, 0.12); } }
    if (left <= 0) { finish(false); return; }
  }
  renderClock();
  if (session.resting) renderNow();
}

async function requestWake() { try { wakeLock = await navigator.wakeLock?.request('screen'); } catch { /* not supported */ } }
function releaseWake() { wakeLock?.release().catch(() => {}); wakeLock = null; }

/* ---------- history + result ---------- */
function history() {
  // Entries from the first, Cindy-only version have no id: convert them.
  return store.get('cindy.history', []).map(h => (h.id ? h : {
    ...h, id: h.minutes === 20 && String(h.reps) === '5,10,15' ? 'cindy' : 'cindy-old',
    name: h.minutes === 20 ? 'Cindy' : `Cindy ${h.minutes}′`, format: 'amrap',
    score: `${h.rounds} + ${h.partial}`, rank: h.total,
  }));
}
function saveResult(update = false) {
  const hist = history();
  session.date = session.date || new Date().toISOString();
  const entry = {
    id: def.id, name: def.name, format: def.format, date: session.date,
    score: session.score, total: session.total, rank: session.rank, done: session.done, splits: session.roundTimes(),
  };
  const i = hist.findIndex(h => h.date === entry.date);
  if (i >= 0) hist[i] = entry; else if (!update) hist.unshift(entry);
  store.set('cindy.history', hist.slice(0, 200));
  renderHistory(); renderTitle();
}
const bestOf = (hist, id) => hist.filter(h => h.id === id).reduce((b, h) => (!b || h.rank > b.rank ? h : b), null);

function summary() {
  return `${def.name} (${describe(def)}): ${session.score}` +
    (session.format === 'emom' ? ` minutes, ${session.total} reps` : session.format === 'fortime' && session.done ? '' : ` · ${session.total} total reps`);
}
function showResult() {
  const t = session.roundTimes(), max = Math.max(...t, 1), f = session.format;
  $('#resTitle').textContent = f === 'fortime' ? (session.done ? `${def.name}: finished` : `${def.name}: time cap`) : `${def.name}: complete`;
  $('#resScore').textContent = session.score;
  const unit = f === 'emom' ? 'Minute' : 'Round';
  let sub = `${session.total} total reps in ${clock(endedAt)}`;
  if (f === 'emom') sub = `${session.minutesDone} of ${def.minutes} minutes completed · ${session.total} reps`;
  if (t.length > 1 || (t.length && f === 'amrap')) if (f !== 'emom') sub += ` · average round ${clock(t.reduce((a, b) => a + b, 0) / t.length)}`;
  $('#resSub').textContent = sub;
  const shown = f === 'fortime' && t.length < 2 ? [] : t; // one round = the whole time, already shown
  $('#resSplits').innerHTML = shown.map((ms, i) =>
    `<div class="split"><span>${unit} ${i + 1}</span><span class="bar"><i style="width:${(ms / max * 100).toFixed(1)}%"></i></span><span class="r">${clock(ms)}</span></div>`).join('');
  $('#modal').hidden = false; $('#closeBtn').focus();
}

/* ---------- rendering ---------- */
function renderPicker() {
  const list = allWorkouts();
  $('#picker').innerHTML = list.map(w =>
    `<button class="pick${w.id.startsWith('c-') ? ' custom' : ''}" data-id="${esc(w.id)}" aria-pressed="${w.id === def.id}" ${idle() ? '' : 'disabled'}>${esc(w.name)}</button>`).join('') +
    `<button class="pick add" data-new="1" ${idle() ? '' : 'disabled'}>+ Build your own</button>`;
}
function renderTitle() {
  $('#wName').textContent = def.name;
  $('#wDesc').textContent = describe(def);
  $('#wFormat').textContent = def.format === 'fortime' ? `For time · ${def.minutes}-min cap` : `${FORMAT_NAMES[def.format]} · ${def.minutes} min`;
  const best = bestOf(history(), def.id);
  $('#wBest').textContent = best ? `Best ${best.score}${best.format === 'emom' ? ' min' : ''}` : '';
}
function renderTips() {
  const keys = [...new Set(def.seq.map(s => s.key))];
  $('#tips').innerHTML = '<li><b>Placement:</b> 2–3 m away at hip height, about 45° to your side, so your head, hands and feet stay in view for every movement.</li>' +
    keys.map(k => `<li><b>${esc(MOVES[k].name)}:</b> ${esc(MOVES[k].tip)}</li>`).join('') +
    '<li>The app moves on to the next movement by itself once you finish its reps.</li>' +
    '<li>Video never leaves your device. Pose detection runs in this browser tab.</li>';
}
function renderClock() {
  const el = elapsedMs(), f = session.format, c = $('#clock');
  let big, lab, low = false;
  if (f === 'amrap') {
    big = clock(Math.ceil((durationMs() - el) / 1000) * 1000);
    lab = phase === 'idle' ? `${def.minutes}-minute AMRAP` : `Remaining · ${clock(el)} elapsed`;
    low = durationMs() - el <= 60000;
  } else if (f === 'fortime') {
    big = clock(el);
    lab = `Elapsed · ${def.minutes}:00 cap`;
    low = durationMs() - el <= 60000;
  } else {
    const inMin = phase === 'idle' ? 60000 : 60000 - (el % 60000);
    big = clock(Math.ceil(inMin / 1000) * 1000);
    lab = phase === 'idle' ? `Every minute for ${def.minutes} minutes`
      : `Minute ${Math.min(def.minutes, Math.floor(el / 60000) + 1)} of ${def.minutes} · ${clock(el)} elapsed`;
    low = inMin <= 10000;
  }
  c.textContent = big;
  c.classList.toggle('low', phase === 'running' && low);
  $('#clockLab').textContent = lab;
}
function renderNow() {
  const w = session, st = w.step, now = $('#now');
  if (w.format === 'emom' && phase === 'done') {
    now.style.setProperty('--c', '#9a958a');
    $('#moveName').textContent = 'Finished';
    $('#moveReps').innerHTML = `${w.minutesDone}<small>/${def.minutes}</small>`;
    $('#moveSub').textContent = 'minutes completed';
    return;
  }
  if (w.format === 'emom' && w.resting) {
    const left = 60000 - (elapsedMs() % 60000);
    now.style.setProperty('--c', '#9a958a');
    $('#moveName').textContent = 'Rest';
    $('#moveReps').innerHTML = `${Math.ceil(left / 1000)}<small>s</small>`;
    $('#moveSub').textContent = `Minute ${w.minute + 1} done · next: ${stepName(w.blocks[(w.minute + 1) % w.blocks.length][0])}`;
    return;
  }
  now.style.setProperty('--c', (MOVES[st.key] || MOVES.other).color);
  $('#moveName').textContent = stepName(st);
  $('#moveReps').innerHTML = `${w.done ? st.reps : w.reps}<small>/${st.reps}</small>`;
  let sub;
  if (phase === 'done') sub = 'Finished';
  else if (w.format === 'amrap') sub = `Round ${w.rounds + 1}`;
  else if (w.format === 'fortime') sub = w.totalRounds > 1 ? `Round ${w.rounds + 1} of ${w.totalRounds}` : `Movement ${w.idx + 1} of ${w.flat.length}`;
  else sub = `Minute ${w.minute + 1} of ${def.minutes}`;
  $('#moveSub').textContent = sub + (phase === 'paused' ? ' · paused' : '');
}
function render() {
  renderClock(); renderNow();
  const w = session, f = w.format;
  if (f === 'amrap') { $('#score').textContent = w.score; $('#scoreLab').textContent = `rounds + reps · ${w.total} total`; }
  else if (f === 'fortime') {
    const all = w.flat.reduce((n, s) => n + s.reps, 0);
    $('#score').textContent = w.done ? w.score : `${w.total}`;
    $('#scoreLab').textContent = w.done ? `finished · ${w.total} reps` : `of ${all} reps`;
  } else { $('#score').textContent = w.score; $('#scoreLab').textContent = `minutes done · ${w.total} reps`; }
  $('#ladder').innerHTML = w.chunk().map((st, i, arr) => {
    const cur = !w.done && !w.resting && st.done < st.reps && arr.slice(0, i).every(x => x.done === x.reps);
    return `<div class="rung${cur ? ' cur' : ''}" style="--c:${(MOVES[st.key] || MOVES.other).color}"><span>${esc(stepName(st))}</span>` +
      `<span class="bar"><i style="width:${(st.done / st.reps * 100).toFixed(1)}%"></i></span><span class="n">${st.done}/${st.reps}</span></div>`;
  }).join('');
  const go = $('#goBtn');
  go.textContent = { idle: 'Start workout', countdown: 'Starting…', running: 'Pause', paused: 'Resume', done: 'Start again' }[phase];
  go.disabled = phase === 'countdown';
  $('#endBtn').disabled = !(phase === 'running' || phase === 'paused');
  $('#endBtn').textContent = endArmed ? 'Tap again' : 'End';
  const canCount = phase === 'running' && !w.resting && !w.done;
  $('#plusBtn').disabled = !canCount;
  $('#doneBtn').disabled = !canCount;
  $('#minusBtn').disabled = phase === 'idle' || phase === 'countdown' || w.total === 0;
}
function renderHistory() {
  const hist = history();
  $('#histEmpty').hidden = hist.length > 0;
  const bests = new Map();
  for (const h of hist) { const b = bests.get(h.id); if (!b || h.rank > b.rank) bests.set(h.id, h); }
  const counts = hist.reduce((m, h) => m.set(h.id, (m.get(h.id) || 0) + 1), new Map());
  $('#hist').innerHTML = hist.map(h => {
    const d = new Date(h.date).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    const pr = counts.get(h.id) > 1 && bests.get(h.id) === h ? '<span class="pr">PR</span>' : '';
    return `<tr><td>${d}</td><td>${esc(h.name)}</td><td class="r">${esc(h.score)}${h.format === 'emom' ? ' min' : ''}${pr}</td><td class="r">${h.total}</td></tr>`;
  }).join('');
}

/* ---------- workout builder ---------- */
let draft = null;
const moveOptions = sel => Object.entries(MOVES).map(([k, m]) =>
  `<option value="${k}"${k === sel ? ' selected' : ''}>${esc(m.name)}${m.manual ? ' (tap to count)' : ''}</option>`).join('');
function loadDraft(src, editing = false) {
  draft = {
    id: editing ? src.id : null, name: editing ? src.name : src ? `${src.name} (my version)` : '',
    format: src?.format || 'amrap', minutes: src?.minutes || 12, rounds: src?.rounds || 1, emomMode: src?.emomMode || 'all',
    seq: src ? src.seq.map(s => ({ ...s })) : [{ key: 'burpee', reps: 10 }, { key: 'squat', reps: 15 }],
  };
  renderBuilder();
}
function renderBuilder() {
  $('#bTitle').textContent = draft.id ? 'Edit workout' : 'Build a workout';
  $('#bName').value = draft.name;
  $('#bFormat').value = draft.format;
  $('#bMin').value = draft.minutes;
  $('#bRounds').value = draft.rounds;
  $('#bMode').value = draft.emomMode;
  $('#bMinLab').textContent = { amrap: 'Minutes', fortime: 'Time cap (minutes)', emom: 'Minutes' }[draft.format];
  $('#bRoundsWrap').hidden = draft.format !== 'fortime';
  $('#bModeWrap').hidden = draft.format !== 'emom';
  $('#bDelete').hidden = !draft.id;
  $('#bMoves').innerHTML = draft.seq.map((s, i) => `<div class="mv" data-i="${i}">
      <select aria-label="Movement ${i + 1}" data-f="key">${moveOptions(s.key)}</select>
      <input type="number" aria-label="Reps for movement ${i + 1}" data-f="reps" min="1" max="500" value="${s.reps}">
      <button aria-label="Remove movement ${i + 1}" data-rm="${i}" ${draft.seq.length < 2 ? 'disabled' : ''}>×</button></div>`).join('');
}
const clampInt = (v, lo, hi, d) => { const n = parseInt(v, 10); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };
function readDraft() {
  draft.name = $('#bName').value.trim();
  draft.format = $('#bFormat').value;
  draft.minutes = clampInt($('#bMin').value, 1, 120, 12);
  draft.rounds = clampInt($('#bRounds').value, 1, 50, 1);
  draft.emomMode = $('#bMode').value;
  document.querySelectorAll('#bMoves .mv').forEach(row => {
    const s = draft.seq[+row.dataset.i];
    s.key = row.querySelector('[data-f=key]').value;
    s.reps = clampInt(row.querySelector('[data-f=reps]').value, 1, 500, s.reps);
    delete s.label;
  });
}
function bindBuilder() {
  $('#builder').addEventListener('change', e => { if (e.target.matches('input, select')) { readDraft(); renderBuilder(); } });
  $('#bMoves').addEventListener('click', e => {
    const i = e.target.dataset.rm; if (i == null) return;
    readDraft(); draft.seq.splice(+i, 1); renderBuilder();
  });
  $('#bAdd').onclick = () => { readDraft(); draft.seq.push({ key: 'squat', reps: 10 }); renderBuilder(); };
  $('#bNew').onclick = () => { loadDraft(null); $('#bName').focus(); };
  $('#bSave').onclick = () => {
    readDraft();
    if (!idle()) { $('#bMsg').textContent = 'Finish or reset the current workout first.'; return; }
    const w = {
      id: draft.id || `c-${Date.now().toString(36)}`, name: draft.name || 'My workout', format: draft.format,
      minutes: draft.minutes, seq: draft.seq.map(s => ({ ...s })),
      ...(draft.format === 'fortime' ? { rounds: draft.rounds } : {}), ...(draft.format === 'emom' ? { emomMode: draft.emomMode } : {}),
    };
    const i = custom.findIndex(c => c.id === w.id);
    if (i >= 0) custom[i] = w; else custom.push(w);
    store.set('cindy.custom', custom);
    $('#bMsg').textContent = `Saved “${w.name}”.`;
    selectWorkout(w.id);
    window.scrollTo({ top: 0, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  };
  let delArmed = 0;
  $('#bDelete').onclick = () => {
    if (!delArmed) { $('#bDelete').textContent = 'Tap again to delete'; delArmed = setTimeout(() => { delArmed = 0; $('#bDelete').textContent = 'Delete'; }, 3000); return; }
    clearTimeout(delArmed); delArmed = 0; $('#bDelete').textContent = 'Delete';
    custom = custom.filter(c => c.id !== draft.id); store.set('cindy.custom', custom);
    $('#bMsg').textContent = 'Deleted.';
    loadDraft(null);
    if (def.id.startsWith('c-') && !custom.some(c => c.id === def.id)) selectWorkout('cindy'); else renderPicker();
  };
}

/* ---------- settings ---------- */
function bindSettings() {
  const f = { sLevel: 'level', sModel: 'model', sMirror: 'mirror', sVoice: 'voice', sCount: 'countAloud', sCam: 'camera' };
  for (const [id, k] of Object.entries(f)) {
    const el = $('#' + id);
    if (el.type === 'checkbox') el.checked = settings[k]; else el.value = settings[k];
    el.addEventListener('change', () => {
      settings[k] = el.type === 'checkbox' ? el.checked : el.value;
      store.set('cindy.settings', settings);
      if (id === 'sLevel') newDetector();
      if (id === 'sMirror' && !video.src) $('#stage').classList.toggle('mirror', settings.mirror);
      if (id === 'sCam' && stream) startCamera();
      if (id === 'sModel' && sourceOn) loadModel();
    });
  }
}

/* ---------- events ---------- */
$('#picker').onclick = e => {
  const b = e.target.closest('button'); if (!b || b.disabled) return;
  if (b.dataset.new) { loadDraft(null); $('#builder').scrollIntoView(); $('#bName').focus(); return; }
  selectWorkout(b.dataset.id);
};
$('#copyWod').onclick = () => {
  loadDraft(def, def.id.startsWith('c-'));
  $('#builder').scrollIntoView(); $('#bName').focus();
};
$('#camBtn').onclick = startCamera;
$('#fileIn').onchange = e => { const f = e.target.files[0]; if (f) startFile(f); };
$('#goBtn').onclick = () => { if (phase === 'done') resetWorkout(); startWorkout(); };
$('#plusBtn').onclick = addRep;
$('#doneBtn').onclick = doneMove;
$('#minusBtn').onclick = undoRep;
$('#resetBtn').onclick = resetWorkout;
$('#endBtn').onclick = () => {
  if (endArmed) { clearTimeout(endArmed); endArmed = 0; finish(true); return; }
  endArmed = setTimeout(() => { endArmed = 0; render(); }, 4000); render();
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
  if (clearArmed) { clearTimeout(clearArmed); clearArmed = 0; store.set('cindy.history', []); renderHistory(); renderTitle(); $('#clearBtn').textContent = 'Clear history'; return; }
  $('#clearBtn').textContent = 'Tap again to clear';
  clearArmed = setTimeout(() => { clearArmed = 0; $('#clearBtn').textContent = 'Clear history'; }, 3000);
};
document.addEventListener('keydown', e => {
  if (e.target.matches('input, select, textarea')) return;
  if (e.key === 'Escape') $('#modal').hidden = true;
  else if (e.code === 'Space') { e.preventDefault(); addRep(); }
  else if (e.key === 'Backspace') { e.preventDefault(); undoRep(); }
  else if (e.key === 'd' || e.key === 'D') doneMove();
  else if (e.key === 'p' || e.key === 'P') { if (phase === 'running' || phase === 'paused') startWorkout(); }
});
video.addEventListener('ended', () => { if (video.src && phase === 'running') finish(true); });
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && phase === 'running') requestWake(); });

bindSettings();
bindBuilder();
loadDraft(null);
selectWorkout(settings.workout);
renderHistory();
setInterval(timerTick, 200);
requestAnimationFrame(frame);
window.__cindy = {
  get phase() { return phase; }, get session() { return session; }, get ready() { return !!landmarker; },
  get landmarks() { return lastLm; }, get detector() { return detector; },
};
