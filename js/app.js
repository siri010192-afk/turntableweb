// 화면 조립: 연결 방식 선택(Spotify / 데모), 렌더 루프, 제스처, 컨트롤, 설정.

import { SPOTIFY_CLIENT_ID } from '../config.js';
import { MockProvider } from './mock-provider.js';
import { MotionSpec, TimeText } from './motion.js';
import { TurntableRenderer } from './renderer.js';
import { SpotifyAuth, safeStorage } from './spotify-auth.js';
import { SpotifyProvider } from './spotify-provider.js';
import { PlayerStore } from './store.js';

const $ = (id) => document.getElementById(id);
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

boot();

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

function startSpotify() {
  const spotify = new SpotifyProvider(auth);
  spotify.onStatus(() => renderStatus());
  spotify.start();
  // 화면이 보이지 않으면 상태 읽기를 멈춘다 (배터리)
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) spotify.stop();
    else spotify.start();
  });
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

  $('welcome').hidden = true;
  $('app').hidden = false;
  new ResizeObserver(() => renderer.layout()).observe(canvas);
  renderer.layout();
  bindGestures();
  bindControls();
  syncSettings();
  renderStatus();
  requestAnimationFrame(loop);
}

// ---------- 루프 ----------

function loop(nowMs) {
  requestAnimationFrame(loop);
  if (!renderer.width && !renderer.layout()) return; // 아직 크기가 없음
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
    $('title').textContent = track ? track.title : provider.kind === 'spotify' ? '재생 중인 곡 없음' : 'TurnTable';
    $('sub').textContent = track ? [track.artist, track.album].filter(Boolean).join(' · ') : '';
    renderStatus();
  }
  const duration = store.timeline.duration;
  const text = `${TimeText.mmss(store.displayPosition(t))} / ${duration > 0 ? TimeText.mmss(duration) : '--:--'}`;
  if ($('time').textContent !== text) $('time').textContent = text;
  const playing = store.phase === 'playing' || store.phase === 'loading';
  // SVG 요소는 .hidden 속성이 없어서 hidden 특성을 직접 바꾼다.
  $('icon-play').toggleAttribute('hidden', playing);
  $('icon-pause').toggleAttribute('hidden', !playing);
  $('playpause').setAttribute('aria-label', playing ? '일시정지' : '재생');
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
      if (Math.hypot(p.x - d.start.x, p.y - d.start.y) < 10) store.tapLabel();
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
}

function syncSettings() {
  const spotify = provider && provider.kind === 'spotify';
  $('connection-text').textContent = spotify
    ? 'Spotify에 연결되어 있어요. iPhone의 Spotify 앱을 원격으로 조종해요.'
    : '데모 모드예요. 소리 없이 가짜로 재생해요.';
  $('connection-action').textContent = spotify ? 'Spotify 연결 끊기' : 'Spotify 연결';
  $('switch-demo').hidden = !spotify;
  $('opt-coverbg').checked = renderer ? renderer.useCoverBackground : prefs.get('coverBg', true);
  const rpm = currentRpm();
  const options = [...$('opt-rpm').options];
  const closest = options.reduce((best, o) => (Math.abs(Number(o.value) - rpm) < Math.abs(Number(best.value) - rpm) ? o : best), options[0]);
  $('opt-rpm').value = closest.value;
  $('opt-debug').checked = !$('debug').hidden;
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
