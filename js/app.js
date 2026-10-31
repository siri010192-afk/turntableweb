// 화면 조립: 연결 방식 선택(Spotify / 데모), 렌더 루프, 제스처, 컨트롤, 설정.

import { SPOTIFY_CLIENT_ID } from '../config.js?v=202610311708';
import { LyricsService, lineIndexAt } from './lyrics.js?v=202610311708';
import { MockProvider } from './mock-provider.js?v=202610311708';
import { MotionSpec, TimeText } from './motion.js?v=202610311708';
import { TurntableRenderer } from './renderer.js?v=202610311708';
import { SpotifyAuth, safeStorage } from './spotify-auth.js?v=202610311708';
import { SpotifyProvider } from './spotify-provider.js?v=202610311708';
import { PlayerStore } from './store.js?v=202610311708';

// 배포 버전. scripts/bump_web_version.py가 version.json·파일 주소의 ?v=와 함께 올린다.
const APP_VERSION = '202610311708';

/** Document Picture-in-Picture 창 (Chrome·Edge). 열려 있으면 LP와 곡 정보·버튼이 그 창에 있다. */
let pipWindow = null;
// 요소가 PiP 창으로 옮겨가 있어도 찾는다.
const $ = (id) => document.getElementById(id) || (pipWindow ? pipWindow.document.getElementById(id) : null);
const storage = safeStorage();
const prefs = {
  get(key, fallback) {
    try {
      const value = storage.getItem(`tt.pref.${key}`);
      return value == null ? fallback : JSON.parse(value);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    storage.setItem(`tt.pref.${key}`, JSON.stringify(value));
  },
};

// Spotify 대시보드에 등록한 Redirect URI와 정확히 같아야 한다 (예: https://<아이디>.github.io/turntableweb/).
const redirectUri = new URL('./', location.origin + location.pathname).href;
// 실제 33⅓ RPM은 작은 화면에서 빠르게 느껴져서 기본은 느리게 (설정에서 바꿀 수 있다).
const DEFAULT_RPM = 8;
const auth = new SpotifyAuth({ clientId: SPOTIFY_CLIENT_ID, redirectUri, storage });
const canvas = $('stage');

let store = null;
let renderer = null;
let provider = null;
let lastTrackId = undefined;
let toastTimer = 0;
let frames = 0;
let fpsStart = performance.now();
let fps = 0;
let lastHaptic = '-';
let loopToken = 0;
const lyricsService = new LyricsService();
let lyricsTrackId = undefined; // 가사를 띄운 곡 (undefined면 다시 불러온다)
let lyricsLines = []; // 시간 맞춘 가사 줄 (없으면 안내 문구만)
let lyricsIndex = -2; // 지금 강조한 줄 (-2: 아직 배치 전)

checkForUpdate();
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) checkForUpdate();
});
boot();

/**
 * 브라우저가 예전 파일을 캐시해 두었을 수 있어서(GitHub Pages는 10분 캐시), 서버의 version.json을
 * 캐시 없이 읽어 다르면 한 번 새로고침한다. 새로고침은 페이지를 서버에 다시 확인하므로 새 파일이 실린다.
 */
async function checkForUpdate() {
  if (APP_VERSION === 'dev') return; // 로컬 개발 중
  try {
    const response = await fetch(`version.json?t=${Date.now()}`, { cache: 'no-store' });
    const { version } = await response.json();
    if (!version || version === APP_VERSION) return;
    const key = `tt.reloadedFor.${version}`;
    let alreadyTried = false;
    try {
      alreadyTried = sessionStorage.getItem(key) === '1';
      sessionStorage.setItem(key, '1');
    } catch {
      /* 저장소가 막혀 있으면 한 번만 시도하는 보장 없이 진행 */
    }
    if (!alreadyTried && !pipWindow) location.reload();
  } catch {
    /* 오프라인 등: 다음 기회에 */
  }
}

async function boot() {
  try {
    if (await auth.completeLogin(location.href)) prefs.set('mode', 'spotify');
  } catch (error) {
    showToast(error.userMessage || 'Spotify 로그인에 실패했어요. 다시 시도해 주세요.');
  }
  if (location.search) history.replaceState(null, '', redirectUri);

  const mode = prefs.get('mode', null);
  if (mode === 'spotify' && auth.isLoggedIn) startSpotify();
  else if (mode === 'demo') startDemo();
  else showWelcome();
}

// ---------- 연결 방식 ----------

function showWelcome() {
  $('welcome').hidden = false;
  $('app').hidden = true;
  if (!auth.isConfigured) {
    $('connect').disabled = true;
    $('connect-note').textContent = 'config.js에 Spotify Client ID를 넣어야 연결할 수 있어요. 지금은 데모만 쓸 수 있어요.';
  }
}

async function connectSpotify() {
  if (!auth.isConfigured) {
    showToast('config.js에 Spotify Client ID가 없어요.');
    return;
  }
  location.assign(await auth.loginURL());
}

function startDemo() {
  prefs.set('mode', 'demo');
  start(new MockProvider());
}

/** 휴대기기(iPhone·iPad·Android)인지. iPadOS는 Mac처럼 보이므로 터치 지원으로 구분한다. */
function isMobileDevice() {
  const ua = navigator.userAgent;
  return /iPhone|iPad|iPod|Android/i.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
}

function startSpotify() {
  // PC에서 열면 쉬는 Spotify를 깨울 때 PC의 Spotify 앱을, 휴대기기에서는 그 기기를 우선한다.
  const spotify = new SpotifyProvider(auth, { preferredDeviceType: isMobileDevice() ? 'Smartphone' : 'Computer' });
  spotify.onStatus(() => renderStatus());
  spotify.start();
  // 화면이 보이지 않으면 상태 읽기를 멈춘다 (배터리). 단 PiP 창이 떠 있으면 계속 읽는다.
  document.addEventListener('visibilitychange', syncPolling);
  start(spotify);
}

function start(p) {
  provider = p;
  store = new PlayerStore(p);
  store.onToast = (message) => (message ? showToast(message) : null);
  store.onHaptic = (kind) => {
    lastHaptic = kind; // iPhone Safari는 진동을 지원하지 않는다. 디버그에만 표시.
    if (navigator.vibrate) navigator.vibrate(kind === 'light' ? 8 : 15);
  };
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)');
  store.reduceMotion = reduce.matches;
  reduce.addEventListener('change', (e) => { store.reduceMotion = e.matches; });
  store.setRpm(currentRpm());

  renderer = new TurntableRenderer(canvas, store);
  renderer.useCoverBackground = prefs.get('coverBg', true);
  renderer.sleeveOnTop = prefs.get('sleeveOnTop', false);
  renderer.lyricsPosition = lyricsPositionFromPref(prefs.get('lyrics', 'off'));

  $('welcome').hidden = true;
  $('app').hidden = false;
  new ResizeObserver(() => relayout()).observe(canvas);
  relayout();
  bindGestures();
  bindControls();
  syncSettings();
  renderStatus();
  if ('documentPictureInPicture' in window && !isMobileDevice()) $('pip').hidden = false;
  scheduleLoop();
}

/** 렌더러 배치를 다시 계산하고, 제목 칸 폭이 바뀌었을 수 있으니 전광판이 필요한지 다시 잰다. */
function relayout() {
  const ok = renderer.layout();
  if (ok) {
    applyPipMode();
    applyLyricsBox();
    updateMarquee();
  }
  return ok;
}

// ---------- 가사 ----------

/** 예전에 저장한 'bottom'도 켜짐으로 읽는다 (위치는 오른쪽 하나로 정리됨) */
function lyricsPositionFromPref(value) {
  return value === 'right' || value === 'bottom' ? 'right' : null;
}

/** 배치가 정한 가사 칸에 맞춘다. 끄거나 작은 창이면 숨긴다. */
function applyLyricsBox() {
  const el = document.getElementById('lyrics');
  if (!el) return;
  const box = renderer.lyricsBox;
  el.hidden = !box || Boolean(pipWindow);
  if (el.hidden) return;
  Object.assign(el.style, { left: `${box.x}px`, top: `${box.y}px`, width: `${box.w}px`, height: `${box.h}px` });
  // 오른쪽 칸은 왼쪽 정렬, 세로 화면의 아래 칸은 가운데 정렬
  el.classList.toggle('align-center', renderer.mode !== 'landscape');
  lyricsIndex = -2; // 칸 크기가 바뀌었으니 다시 가운데 맞춤
  if (!lyricsLines.length) centerLyricsOn(document.getElementById('lyrics-lines').firstElementChild);
}

function updateLyrics(t, track) {
  if (!renderer.lyricsPosition || pipWindow) return;
  const id = track ? track.id : null;
  if (id !== lyricsTrackId) {
    lyricsTrackId = id;
    lyricsLines = [];
    showLyricsMessage(track ? '가사를 찾는 중…' : '');
    if (track) {
      lyricsService.load(track).then((result) => {
        if (lyricsTrackId === id) renderLyrics(result);
      });
    }
  }
  if (!lyricsLines.length) return;
  // 화면에 그려지는 순간보다 조금 앞서 바꿔야 노래와 맞게 느껴진다
  const index = lineIndexAt(lyricsLines, store.displayPosition(t) + 0.25);
  if (index !== lyricsIndex) setLyricsIndex(index);
}

function renderLyrics(result) {
  if (result.status !== 'synced') {
    const messages = {
      plain: '이 곡은 시간이 맞춰진 가사가 없어요',
      instrumental: '연주곡이에요',
      error: '가사를 불러오지 못했어요',
    };
    showLyricsMessage(messages[result.status] || '가사를 찾지 못했어요');
    return;
  }
  const inner = document.getElementById('lyrics-lines');
  inner.replaceChildren(...result.lines.map((line) => {
    const p = document.createElement('p');
    p.textContent = line.text || '♪';
    return p;
  }));
  lyricsLines = result.lines;
  lyricsIndex = -2;
}

function showLyricsMessage(text) {
  lyricsLines = [];
  const inner = document.getElementById('lyrics-lines');
  const p = document.createElement('p');
  p.className = 'message';
  p.textContent = text;
  inner.replaceChildren(p);
  lyricsIndex = -2;
  centerLyricsOn(p);
}

/** index 줄을 진하게, 바로 옆 줄은 조금 덜 연하게, 그 줄을 칸 가운데로 */
function setLyricsIndex(index) {
  lyricsIndex = index;
  const lines = document.getElementById('lyrics-lines').children;
  for (let i = 0; i < lines.length; i += 1) {
    lines[i].classList.toggle('current', i === index);
    lines[i].classList.toggle('near', Math.abs(i - index) === 1 && index >= 0);
  }
  centerLyricsOn(lines[Math.max(0, index)]);
}

function centerLyricsOn(line) {
  const el = document.getElementById('lyrics');
  const inner = document.getElementById('lyrics-lines');
  if (!line || el.hidden) return;
  const offset = el.clientHeight / 2 - (line.offsetTop + line.offsetHeight / 2);
  inner.style.transform = `translateY(${Math.round(offset)}px)`;
}

/** 작은 창이면 크기 구간(tiny / normal / wide)을 클래스로 붙이고, wide면 정보 패널 시작 위치를 알려 준다. */
function applyPipMode() {
  const stage = canvas.parentElement;
  if (!stage) return;
  stage.classList.remove('pip-tiny', 'pip-normal', 'pip-wide');
  const hud = $('hud');
  if (pipWindow && renderer.pipMode) {
    stage.classList.add(`pip-${renderer.pipMode}`);
    if (hud && renderer.panelLeft) hud.style.setProperty('--pip-panel-left', `${Math.round(renderer.panelLeft)}px`);
  } else if (hud) {
    hud.style.removeProperty('--pip-panel-left');
  }
}

function syncPolling() {
  if (!provider || provider.kind !== 'spotify') return;
  if (document.hidden && !pipWindow) provider.stop();
  else provider.start();
}

// ---------- 루프 ----------

/**
 * 다음 프레임 예약. PiP 창이 열려 있으면 그 창의 프레임으로 돌린다
 * (브라우저를 최소화하면 원래 창의 프레임은 멈추기 때문). 이전 예약은 무효로 한다.
 */
function scheduleLoop() {
  const token = ++loopToken;
  (pipWindow || window).requestAnimationFrame(() => {
    if (token === loopToken) loop();
  });
}

function loop() {
  scheduleLoop();
  // 크기가 바뀌었으면(창 크기 조절, PiP 창이 막 열림 등) 다시 배치한다. 아직 크기가 없으면 건너뛴다.
  if ((canvas.clientWidth !== renderer.width || canvas.clientHeight !== renderer.height) && !relayout()) return;
  // 창마다 rAF 시간 기준이 달라서, 상태와 같은 시계(이 창의 performance.now)를 쓴다.
  const nowMs = performance.now();
  const t = nowMs / 1000;
  renderer.draw(t);
  updateInfo(t);
  frames += 1;
  if (nowMs - fpsStart >= 500) {
    fps = Math.round((frames * 1000) / (nowMs - fpsStart));
    frames = 0;
    fpsStart = nowMs;
    if (!$('debug').hidden) renderDebug();
  }
}

function updateInfo(t) {
  const track = store.displayedTrack;
  const id = track ? track.id : null;
  if (id !== lastTrackId) {
    lastTrackId = id;
    setTitle(track ? track.title : provider.kind === 'spotify' ? '재생 중인 곡 없음' : 'TurnTable');
    $('sub').textContent = track ? track.artist : ''; // 앨범 제목은 표시하지 않는다 (사용자 요청)
    renderStatus();
  }
  const duration = store.timeline.duration;
  const elapsedText = TimeText.mmss(store.displayPosition(t));
  const totalText = duration > 0 ? TimeText.mmss(duration) : '--:--';
  const text = `${elapsedText} / ${totalText}`;
  if ($('time').textContent !== text) $('time').textContent = text;
  const elapsed = $('progress-elapsed');
  if (elapsed && elapsed.textContent !== elapsedText) elapsed.textContent = elapsedText;
  const total = $('progress-total');
  if (total && total.textContent !== totalText) total.textContent = totalText;
  const fill = $('progress-fill');
  if (fill) {
    const position = store.displayPosition(t);
    const ratio = duration > 0 && position != null ? Math.min(1, Math.max(0, position / duration)) : 0;
    const width = `${(ratio * 100).toFixed(2)}%`;
    if (fill.style.width !== width) fill.style.width = width;
  }
  updateLyrics(t, track);
  const playing = store.phase === 'playing' || store.phase === 'loading';
  // SVG 요소는 .hidden 속성이 없어서 hidden 특성을 직접 바꾼다.
  $('icon-play').toggleAttribute('hidden', playing);
  $('icon-pause').toggleAttribute('hidden', !playing);
  $('playpause').setAttribute('aria-label', playing ? '일시정지' : '재생');
}

/** 제목을 넣는다. 안쪽 span이 있어야 전광판처럼 흘릴 수 있다. */
function setTitle(text) {
  const title = $('title');
  const inner = title.ownerDocument.createElement('span');
  inner.className = 'marquee-inner';
  inner.textContent = text;
  title.replaceChildren(inner);
  updateMarquee();
}

/** 제목이 칸보다 길면 넘친 만큼 흘리고(초당 약 30px + 앞뒤 멈춤), 짧으면 멈춘다. */
function updateMarquee() {
  const title = $('title');
  const inner = title && title.querySelector('.marquee-inner');
  if (!inner) return;
  title.classList.remove('scrolling');
  const overflow = inner.getBoundingClientRect().width - title.clientWidth;
  if (overflow > 2) {
    const distance = Math.ceil(overflow + 14);
    title.style.setProperty('--marquee-distance', `${distance}px`);
    title.style.setProperty('--marquee-time', `${(distance / 30 / 0.64).toFixed(1)}s`); // 이동 구간이 전체의 64%
    title.classList.add('scrolling');
  }
}

function renderStatus() {
  if (!provider) return;
  let text = '';
  if (provider.kind === 'mock') {
    text = '데모 모드 · 소리 없이 가짜로 재생해요';
  } else if (provider.status === 'connecting') {
    text = 'Spotify에 연결하는 중…';
  } else if (provider.status === 'noDevice') {
    text = provider.snapshot.track
      ? '마지막으로 들은 곡이에요. 라벨을 탭하면 이어서 재생해요.'
      : 'Spotify 앱에서 음악을 재생하면 여기에 나타나요.';
  } else if (provider.status === 'error' && provider.lastError) {
    text = provider.lastError.userMessage || 'Spotify와 통신하지 못했어요.';
  } else if (!provider.snapshot.track) {
    text = '지금 재생 중인 것은 음악이 아니에요.';
  }
  if ($('status').textContent !== text) $('status').textContent = text;
  // Spotify 앱이 꺼져 있으면 웹에서 깨울 수 없으니 앱을 여는 버튼을 보인다.
  $('open-spotify').hidden = !(provider.kind === 'spotify' && provider.status === 'noDevice');
}

function currentRpm() {
  const saved = prefs.get('rpm', null);
  if (saved != null) return Number(saved);
  return prefs.get('rpm45', false) ? MotionSpec.rpm45 : DEFAULT_RPM; // 예전 설정(45 RPM 체크) 이어받기
}

function renderDebug() {
  const lines = [
    `상태 ${store.phase}`,
    `드래그 이동 ${store.dragMoveCount}회`,
    `FPS ${fps}`,
    `햅틱 ${lastHaptic}`,
    `프로바이더 ${provider.kind}${provider.status ? ` / ${provider.status}` : ''}`,
  ];
  if (provider.seekCallCount != null) lines.push(`seek ${provider.seekCallCount}회`);
  $('debug').textContent = lines.join('\n');
}

// ---------- 제스처 ----------

function bindGestures() {
  let drag = null;
  const pointOf = (e) => {
    const r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  canvas.addEventListener('pointerdown', (e) => {
    const p = pointOf(e);
    const frame = store.frame(performance.now() / 1000);
    if (renderer.hitsArm(p, frame.armAngle)) {
      if (!store.armPressBegan(renderer.fingerAngle(p))) return;
      drag = { id: e.pointerId, start: p, target: 'arm' };
    } else if (renderer.hitsLabel(p)) {
      drag = { id: e.pointerId, start: p, target: 'label' };
    } else if (renderer.hitsSleeve(p)) {
      drag = { id: e.pointerId, start: p, target: 'sleeve' };
    } else {
      return;
    }
    canvas.setPointerCapture(e.pointerId);
    e.preventDefault();
  });

  canvas.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id || drag.target !== 'arm') return;
    const p = pointOf(e);
    // 6pt 넘게 움직여야 톤암이 들린다 (살짝 누른 것은 탭)
    if (!store.isArmLifted && Math.hypot(p.x - drag.start.x, p.y - drag.start.y) < 6) return;
    store.armDragChanged(renderer.fingerAngle(p));
  });

  const end = (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const d = drag;
    drag = null;
    if (d.target === 'arm') {
      store.armPressEnded();
    } else if (e.type === 'pointerup') {
      const p = pointOf(e);
      if (Math.hypot(p.x - d.start.x, p.y - d.start.y) >= 10) return;
      if (d.target === 'label') {
        store.tapLabel();
      } else {
        // 앨범 재킷을 누르면 재킷과 LP의 앞뒤를 바꾼다 (마지막 상태를 기억)
        renderer.sleeveOnTop = !renderer.sleeveOnTop;
        prefs.set('sleeveOnTop', renderer.sleeveOnTop);
      }
    }
  };
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);
}

// ---------- 컨트롤 · 설정 ----------

function bindControls() {
  $('prev').addEventListener('click', () => store.skip(-1));
  $('next').addEventListener('click', () => store.skip(1));
  $('playpause').addEventListener('click', () => store.tapLabel());
  $('back10').addEventListener('click', () => store.adjustPosition(-10));
  $('fwd10').addEventListener('click', () => store.adjustPosition(10));
  $('open-settings').addEventListener('click', () => {
    syncSettings();
    $('settings').showModal();
  });
  document.addEventListener('keydown', onKeyDown);
  $('pip').addEventListener('click', () => openPip());
  $('pip-back').addEventListener('click', () => { if (pipWindow) pipWindow.close(); });
}

/** PC 키보드: 스페이스 재생/일시정지, ←/→ 10초 이동, Shift+←/→ 이전/다음 곡 */
function onKeyDown(e) {
  if ($('settings').open || e.ctrlKey || e.metaKey || e.altKey) return;
  const target = e.target;
  if (target && target.closest && (target.closest('input, select, textarea') || (target.closest('button') && e.key === ' '))) return;
  if (e.key === ' ') {
    store.tapLabel();
  } else if (e.key === 'ArrowLeft') {
    if (e.shiftKey) store.skip(-1);
    else store.adjustPosition(-10);
  } else if (e.key === 'ArrowRight') {
    if (e.shiftKey) store.skip(1);
    else store.adjustPosition(10);
  } else {
    return;
  }
  e.preventDefault();
}

// ---------- 작은 창 (Document Picture-in-Picture, Chrome·Edge) ----------

/** LP와 곡 정보·버튼을 항상 위에 떠 있는 작은 창으로 옮긴다. 브라우저를 최소화해도 계속 돈다. */
async function openPip() {
  if (pipWindow || !('documentPictureInPicture' in window)) return;
  let pip;
  try {
    pip = await window.documentPictureInPicture.requestWindow({ width: 340, height: 380 });
  } catch (error) {
    showToast('작은 창을 열지 못했어요. Chrome이나 Edge 최신 버전에서 다시 시도해 주세요.');
    return;
  }
  pipWindow = pip;
  pip.document.title = 'TurnTable';
  const link = pip.document.createElement('link');
  link.rel = 'stylesheet';
  // 원래 창이 불러온 것과 같은 스타일 (index.html의 ?v= 버전 표시 포함)
  const mainSheet = document.querySelector('link[rel="stylesheet"]');
  link.href = mainSheet ? mainSheet.href : new URL('styles.css', location.href).href;
  pip.document.head.append(link);
  const stage = pip.document.createElement('main');
  stage.className = 'app pip';
  stage.append(canvas, $('hud'));
  pip.document.body.append(stage);
  $('pip-note').hidden = false;
  $('pip').hidden = true;
  pip.document.addEventListener('keydown', onKeyDown);
  pip.addEventListener('resize', () => relayout());
  pip.addEventListener('pagehide', closePip, { once: true });
  relayout();
  scheduleLoop();
  syncPolling();
}

/** PiP 창이 닫히면(닫기 버튼, 원래 창으로 돌아가기) LP를 원래 자리로 되돌린다. */
function closePip() {
  if (!pipWindow) return;
  const app = $('app');
  const hud = pipWindow.document.getElementById('hud');
  app.insertBefore(canvas, app.firstChild);
  if (hud) app.insertBefore(hud, document.querySelector('.sr-only'));
  pipWindow = null;
  $('pip-note').hidden = true;
  $('pip').hidden = false;
  relayout();
  scheduleLoop();
  syncPolling();
}

function syncSettings() {
  const spotify = provider && provider.kind === 'spotify';
  $('connection-text').textContent = spotify
    ? 'Spotify에 연결되어 있어요. 이 기기나 다른 기기의 Spotify 앱을 원격으로 조종해요.'
    : '데모 모드예요. 소리 없이 가짜로 재생해요.';
  $('connection-action').textContent = spotify ? 'Spotify 연결 끊기' : 'Spotify 연결';
  $('switch-demo').hidden = !spotify;
  $('opt-coverbg').checked = renderer ? renderer.useCoverBackground : prefs.get('coverBg', true);
  const rpm = currentRpm();
  const options = [...$('opt-rpm').options];
  const closest = options.reduce((best, o) => (Math.abs(Number(o.value) - rpm) < Math.abs(Number(best.value) - rpm) ? o : best), options[0]);
  $('opt-rpm').value = closest.value;
  $('opt-debug').checked = !$('debug').hidden;
  $('opt-lyrics').checked = Boolean(renderer && renderer.lyricsPosition);
}

$('connect').addEventListener('click', () => connectSpotify());
$('demo').addEventListener('click', () => startDemo());

$('connection-action').addEventListener('click', () => {
  if (provider && provider.kind === 'spotify') {
    auth.logout();
    prefs.set('mode', null);
    location.replace(redirectUri);
  } else {
    connectSpotify();
  }
});

$('switch-demo').addEventListener('click', () => {
  prefs.set('mode', 'demo');
  location.replace(redirectUri);
});

$('opt-coverbg').addEventListener('change', (e) => {
  prefs.set('coverBg', e.target.checked);
  if (renderer) renderer.useCoverBackground = e.target.checked;
});

$('opt-rpm').addEventListener('change', (e) => {
  const rpm = Number(e.target.value);
  prefs.set('rpm', rpm);
  if (store) store.setRpm(rpm);
});

$('opt-lyrics').addEventListener('change', (e) => {
  const value = e.target.checked ? 'right' : 'off';
  prefs.set('lyrics', value);
  if (!renderer) return;
  renderer.lyricsPosition = lyricsPositionFromPref(value);
  lyricsTrackId = undefined; // 켜면 지금 곡 가사부터 불러온다
  relayout();
});

$('opt-debug').addEventListener('change', (e) => {
  $('debug').hidden = !e.target.checked;
  if (e.target.checked && store) renderDebug();
});

function showToast(message) {
  const el = $('toast');
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
}
