// 브라우저에서 돌리는 단위 테스트 (tests.html). Swift Core 테스트와 같은 시나리오를 확인한다.

import { MockProvider } from './mock-provider.js';
import { Easing, MotionSpec, PlaybackTimeline, SpinRamp, TimeText, TonearmRig, Tween } from './motion.js';
import { SpotifyAuth } from './spotify-auth.js';
import { SpotifyProvider, mapTrack } from './spotify-provider.js';
import { PlayerStore } from './store.js';
import { computeLayout } from './renderer.js';

const results = [];
const tests = [];
const test = (name, fn) => tests.push({ name, fn });
function expect(condition, message) {
  if (!condition) throw new Error(message || '기대와 다름');
}
const near = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;
const flush = async () => { for (let i = 0; i < 50; i++) await Promise.resolve(); };

// ---------- 모션 모델 ----------

test('Easing 넓이 공식이 수치 적분과 같다', () => {
  for (const easing of Object.values(Easing)) {
    for (const p of [0.1, 0.3, 0.5, 0.7, 1]) {
      let sum = 0;
      const steps = 20000;
      for (let i = 0; i < steps; i++) sum += (easing.value(((i + 0.5) / steps) * p) * p) / steps;
      expect(near(easing.integral(p), sum, 1e-6), `p=${p}`);
    }
  }
});

test('Tween 보간과 이어받기', () => {
  const tw = new Tween(0, 10, 5, 2, Easing.linear);
  expect(tw.valueAt(4) === 0 && tw.valueAt(6) === 5 && tw.valueAt(9) === 10);
  expect(tw.retargeted(0, 1, Easing.linear, 6).valueAt(6) === 5);
});

test('33⅓ RPM은 초당 200°, 스핀업 후 정속', () => {
  const speed = MotionSpec.degreesPerSecond(MotionSpec.rpm33);
  expect(near(speed, 200, 1e-9));
  const ramp = SpinRamp.stopped().ramp(speed, 0.8, Easing.easeIn, 0);
  expect(near(ramp.angleAt(2.8) - ramp.angleAt(1.8), 200, 1e-9));
});

test('일시정지·재생 사이 회전 각도가 끊기지 않는다', () => {
  const speed = 200;
  const wrap = (a) => ((a % 360) + 360) % 360;
  const playing = SpinRamp.stopped().ramp(speed, 0.8, Easing.easeIn, 0);
  const stopping = playing.ramp(0, 1.2, Easing.easeOut, 3.3);
  const restarting = stopping.ramp(speed, 0.8, Easing.easeIn, 3.9);
  expect(near(wrap(playing.angleAt(3.3)), wrap(stopping.angleAt(3.3)), 1e-9));
  expect(near(wrap(stopping.angleAt(3.9)), wrap(restarting.angleAt(3.9)), 1e-9));
});

test('재생 위치 보간', () => {
  const tl = new PlaybackTimeline(10, 100, true, 200);
  expect(tl.positionAt(101.5) === 11.5 && tl.positionAt(1000) === 200);
  expect(tl.pausedAt(103).position === 13);
  expect(TimeText.mmss(83) === '01:23' && TimeText.mmss(null) === '--:--');
});

test('톤암 바늘이 첫 홈·마지막 홈에 닿고 휴식 위치는 판 밖', () => {
  const rig = TonearmRig.standard;
  const len = (v) => Math.hypot(v.x, v.y);
  expect(rig.fitError < 0.01, `fitError ${rig.fitError}`);
  expect(near(len(rig.needleAt(18)), 0.94, 0.01) && near(len(rig.needleAt(48)), 0.42, 0.01));
  expect(len(rig.needleAt(0)) > 1.05);
  for (const a of [0, 18, 33, 48]) expect(near(rig.angleTowards(rig.needleAt(a)), a, 1e-9));
});

// ---------- PlayerStore (가짜 시계 + 즉시 끝나는 sleep) ----------

function makeStore(tracks) {
  const clock = { t: 100 };
  const mock = new MockProvider({ now: () => clock.t, seekLatency: 0, tracks });
  const store = new PlayerStore(mock, {
    now: () => clock.t,
    sleep: async (s) => { clock.t += s; await Promise.resolve(); },
  });
  const settle = async () => {
    await flush();
    await store.waitForSequence();
    await flush();
    await store.waitForSequence();
  };
  const startPlaying = async () => {
    await settle();
    store.tapLabel();
    await settle();
  };
  return { clock, mock, store, settle, startPlaying, cleanup: () => mock.stopEndWatcher() };
}

test('라벨 탭 → 바늘이 내려가며 재생 (seek 1회)', async () => {
  const s = makeStore();
  await s.startPlaying();
  expect(s.store.phase === 'playing', s.store.phase);
  expect(s.mock.seekCallCount === 1);
  expect(s.mock.snapshot.timeline.isPlaying);
  s.cleanup();
});

test('드래그 중 seek 0회, 놓을 때 1회', async () => {
  const s = makeStore();
  await s.startPlaying();
  const start = s.store.frame(s.clock.t).armAngle;
  expect(s.store.armPressBegan(start));
  for (let a = start; a <= 33; a += 1.5) s.store.armDragChanged(a);
  s.store.armDragChanged(33);
  await s.settle();
  expect(s.store.phase === 'armLifted', s.store.phase);
  expect(s.store.dragMoveCount > 5);
  expect(s.mock.seekCallCount === 1, `seek ${s.mock.seekCallCount}`);
  s.store.armPressEnded();
  await s.settle();
  const expected = ((33 - 18) / 30) * s.mock.snapshot.timeline.duration;
  expect(s.mock.seekCallCount === 2);
  expect(near(s.mock.snapshot.timeline.position, expected), `${s.mock.snapshot.timeline.position} vs ${expected}`);
  expect(s.store.phase === 'playing');
  s.cleanup();
});

test('홈 밖에 놓으면 휴식 위치 + 위치 기억, seek 없음', async () => {
  const s = makeStore();
  await s.startPlaying();
  s.clock.t += 30;
  const before = s.mock.snapshot.timeline.positionAt(s.clock.t);
  const start = s.store.frame(s.clock.t).armAngle;
  s.store.armPressBegan(start);
  s.store.armDragChanged(start - 5);
  s.store.armDragChanged(5);
  s.store.armPressEnded();
  await s.settle();
  expect(s.store.phase === 'armAtRest', s.store.phase);
  expect(near(s.store.resumePosition, before));
  expect(s.mock.seekCallCount === 1);
  expect(!s.mock.snapshot.timeline.isPlaying);
  s.cleanup();
});

test('휴식 위치의 톤암 탭 → 기억한 위치부터 이어서', async () => {
  const s = makeStore();
  await s.startPlaying();
  s.clock.t += 30;
  s.store.armPressBegan(s.store.frame(s.clock.t).armAngle);
  s.store.armDragChanged(2);
  s.store.armPressEnded();
  await s.settle();
  const remembered = s.store.resumePosition;
  s.store.armPressBegan(s.store.frame(s.clock.t).armAngle);
  s.store.armPressEnded();
  await s.settle();
  expect(s.store.phase === 'playing');
  expect(near(s.mock.snapshot.timeline.position, remembered));
  s.cleanup();
});

test('seek 실패 → 토스트 + 원래 위치에서 계속 재생', async () => {
  const s = makeStore();
  await s.startPlaying();
  s.clock.t += 20;
  const before = s.mock.snapshot.timeline.positionAt(s.clock.t);
  s.mock.failSeeks = true;
  s.store.armPressBegan(s.store.frame(s.clock.t).armAngle);
  s.store.armDragChanged(40);
  s.store.armPressEnded();
  await s.settle();
  expect(s.store.phase === 'playing');
  expect(s.store.toastMessage != null);
  expect(near(s.mock.snapshot.timeline.position, before));
  expect(s.mock.snapshot.timeline.isPlaying);
  s.cleanup();
});

test('재생 중 라벨 탭 → 일시정지, 다시 탭 → 재생', async () => {
  const s = makeStore();
  await s.startPlaying();
  s.store.tapLabel();
  await s.settle();
  expect(s.store.phase === 'paused' && !s.mock.snapshot.timeline.isPlaying);
  s.store.tapLabel();
  await s.settle();
  expect(s.store.phase === 'playing' && s.mock.snapshot.timeline.isPlaying);
  s.cleanup();
});

test('다음 곡 → 디스크 교체 후 처음부터', async () => {
  const s = makeStore();
  await s.startPlaying();
  s.clock.t += 40;
  s.store.skip(1);
  await s.settle();
  expect(s.store.displayedTrack.id === 'mock-2');
  expect(s.store.phase === 'playing');
  expect(s.mock.snapshot.timeline.position === 0 && s.mock.snapshot.timeline.isPlaying);
  // 음악을 멈추거나 다시 seek하지 않는다 (끊김 없음)
  expect(!s.mock.pauseCallCount, `pause ${s.mock.pauseCallCount}`);
  expect(s.mock.seekCallCount === 1, `seek ${s.mock.seekCallCount}`);
  s.cleanup();
});

test('곡이 자연히 넘어가도 음악을 멈추지 않는다 (연출만)', async () => {
  const s = makeStore();
  await s.startPlaying();
  s.clock.t += s.mock.snapshot.timeline.duration + 1;
  s.mock.checkForTrackEnd();
  await s.settle();
  expect(s.store.displayedTrack.id === 'mock-2' && s.store.phase === 'playing');
  expect(!s.mock.pauseCallCount && s.mock.seekCallCount === 1);
  // 연출 동안 흐른 시간만큼 바늘이 이미 들어가 있다
  const angle = s.store.frame(s.clock.t).armAngle;
  expect(angle > 18, `angle ${angle}`);
  s.cleanup();
});

test('곡이 바뀌는 순간 톤암이 새 곡 위치로 순간이동하지 않는다', async () => {
  const s = makeStore();
  await s.startPlaying();
  s.clock.t += s.mock.snapshot.timeline.duration - 0.01;
  const before = s.store.frame(s.clock.t).armAngle;
  s.clock.t += 0.02;
  s.mock.checkForTrackEnd(); // 동기적으로 새 곡 스냅샷이 들어온다
  const after = s.store.frame(s.clock.t).armAngle;
  expect(Math.abs(after - before) < 0.5, `${before} → ${after}`);
  await s.settle();
  s.cleanup();
});

test('곡이 끝나면 다음 곡으로, 마지막 곡이 끝나면 정지', async () => {
  const s = makeStore();
  await s.startPlaying();
  s.clock.t += s.mock.snapshot.timeline.duration + 1;
  s.mock.checkForTrackEnd();
  await s.settle();
  expect(s.store.displayedTrack.id === 'mock-2' && s.store.phase === 'playing');
  s.store.skip(1);
  await s.settle();
  s.clock.t += s.mock.snapshot.timeline.duration + 1;
  s.mock.checkForTrackEnd();
  await s.settle();
  expect(s.store.phase === 'idle', s.store.phase);
  s.cleanup();
});

test('외부(제어센터 등) 일시정지·재생을 따른다', async () => {
  const s = makeStore();
  await s.startPlaying();
  await s.mock.pause();
  await s.settle();
  expect(s.store.phase === 'paused', s.store.phase);
  await s.mock.play();
  await s.settle();
  expect(s.store.phase === 'playing', s.store.phase);
  s.cleanup();
});

test('외부에서 재생이 시작되면 휴식 위치의 톤암이 내려간다 (seek 없음)', async () => {
  const s = makeStore();
  await s.settle();
  await s.mock.play();
  await s.settle();
  expect(s.store.phase === 'playing', s.store.phase);
  expect(s.mock.seekCallCount === 0);
  s.cleanup();
});

test('곡 길이를 모르면 톤암이 잠긴다', async () => {
  const s = makeStore([{ id: 'live', title: 'Live', artist: '', album: '', duration: 0, artworkURL: null }]);
  expect(!s.store.armPressBegan(0));
  expect(s.store.toastMessage != null);
  s.cleanup();
});

test('일시정지 순간 회전 각도가 이어지고 바로 멈추지 않는다', async () => {
  const s = makeStore();
  await s.startPlaying();
  s.clock.t += 5;
  const before = s.store.frame(s.clock.t).discAngle;
  s.store.tapLabel();
  expect(near(before, s.store.frame(s.clock.t).discAngle, 1e-9));
  expect(s.store.frame(s.clock.t + 0.1).discAngle !== s.store.frame(s.clock.t).discAngle);
  s.cleanup();
});

// ---------- Spotify (가짜 서버 응답) ----------

function jsonResponse(status, body, headers = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (k) => headers[k] ?? null },
    text: async () => (body == null ? '' : JSON.stringify(body)),
    json: async () => body,
  };
}

function fakeAuth() {
  return { refreshed: 0, accessToken: async () => 'TOKEN', refresh: async function () { this.refreshed += 1; } };
}

const ITEM = {
  type: 'track', id: 'abc', name: '노래', duration_ms: 200000,
  artists: [{ name: 'A' }, { name: 'B' }],
  album: { name: '앨범', images: [{ url: 'big', width: 1000 }, { url: 'mid', width: 640 }, { url: 'small', width: 64 }] },
};

test('Spotify 곡 정보 변환', () => {
  const t = mapTrack(ITEM);
  expect(t.id === 'abc' && t.artist === 'A, B' && t.album === '앨범' && t.duration === 200 && t.artworkURL === 'mid');
});

test('재생 상태 읽기 → 스냅샷', async () => {
  let clock = 50;
  const p = new SpotifyProvider(fakeAuth(), {
    now: () => clock,
    fetchFn: async () => jsonResponse(200, { is_playing: true, progress_ms: 30000, item: ITEM }),
  });
  await p.refresh();
  expect(p.status === 'ok');
  expect(p.snapshot.track.id === 'abc');
  expect(p.snapshot.timeline.isPlaying && near(p.snapshot.timeline.position, 30));
});

test('재생 기기가 없으면(204) 안내 상태', async () => {
  const p = new SpotifyProvider(fakeAuth(), { fetchFn: async () => jsonResponse(204, null) });
  await p.refresh();
  expect(p.status === 'noDevice' && p.snapshot.track === null);
});

test('NO_ACTIVE_DEVICE → 사용자 안내 오류', async () => {
  const p = new SpotifyProvider(fakeAuth(), {
    fetchFn: async () => jsonResponse(404, { error: { status: 404, message: 'Player command failed: No active device found', reason: 'NO_ACTIVE_DEVICE' } }),
    setTimer: () => 0, clearTimer: () => {},
  });
  let error = null;
  try { await p.play(); } catch (e) { error = e; }
  expect(error && error.code === 'noDevice' && error.userMessage.includes('Spotify 앱'));
});

test('토큰 만료(401) → 갱신 후 다시 시도', async () => {
  const auth = fakeAuth();
  let calls = 0;
  const p = new SpotifyProvider(auth, {
    fetchFn: async () => (++calls === 1 ? jsonResponse(401, { error: { status: 401 } }) : jsonResponse(204, null)),
    setTimer: () => 0, clearTimer: () => {},
  });
  await p.pause();
  expect(auth.refreshed === 1 && calls === 2);
});

test('seek은 position_ms(밀리초)로 보낸다', async () => {
  let url = '';
  const p = new SpotifyProvider(fakeAuth(), {
    fetchFn: async (u) => { url = u; return jsonResponse(204, null); },
    setTimer: () => 0, clearTimer: () => {},
  });
  await p.seek(83.4567);
  expect(url.includes('/me/player/seek') && url.includes('position_ms=83457'), url);
});

test('조종 명령 전에 보낸 상태 읽기 응답은 버린다', async () => {
  let release;
  const pending = new Promise((r) => { release = r; });
  let call = 0;
  const p = new SpotifyProvider(fakeAuth(), {
    fetchFn: async () => {
      call += 1;
      if (call === 1) { await pending; return jsonResponse(200, { is_playing: true, progress_ms: 1000, item: ITEM }); }
      return jsonResponse(204, null);
    },
    setTimer: () => 0, clearTimer: () => {},
  });
  const poll = p.refresh();
  await flush();
  await p.pause(); // 그 사이 일시정지 명령
  release();
  await poll;
  expect(p.snapshot.track === null, '오래된 응답이 반영됨');
});

test('PKCE 로그인 주소와 토큰 교환', async () => {
  const store = new Map();
  const storage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v), removeItem: (k) => store.delete(k) };
  let posted = null;
  const auth = new SpotifyAuth({
    clientId: 'CID', redirectUri: 'https://example.github.io/turntable-web/', storage, now: () => 1000,
    fetchFn: async (u, init) => { posted = new URLSearchParams(init.body); return jsonResponse(200, { access_token: 'A', refresh_token: 'R', expires_in: 3600 }); },
  });
  const login = new URL(await auth.loginURL());
  expect(login.searchParams.get('code_challenge_method') === 'S256');
  expect(login.searchParams.get('redirect_uri') === 'https://example.github.io/turntable-web/');
  const state = login.searchParams.get('state');
  expect(await auth.completeLogin(`https://example.github.io/turntable-web/?code=XYZ&state=${state}`));
  expect(posted.get('grant_type') === 'authorization_code' && posted.get('code') === 'XYZ' && posted.get('code_verifier'));
  expect(auth.isLoggedIn && (await auth.accessToken()) === 'A');
});

test('state가 다르면 로그인 거부', async () => {
  const store = new Map();
  const storage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v), removeItem: (k) => store.delete(k) };
  const auth = new SpotifyAuth({ clientId: 'CID', redirectUri: 'https://x/', storage, fetchFn: async () => jsonResponse(200, {}) });
  await auth.loginURL();
  let error = null;
  try { await auth.completeLogin('https://x/?code=1&state=WRONG'); } catch (e) { error = e; }
  expect(error && error.code === 'auth' && !auth.isLoggedIn);
});

test('토큰 갱신 응답에 refresh_token이 없으면 기존 것을 유지', async () => {
  const store = new Map();
  const storage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v), removeItem: (k) => store.delete(k) };
  let now = 0;
  let n = 0;
  const auth = new SpotifyAuth({
    clientId: 'C', redirectUri: 'https://x/', storage, now: () => now,
    fetchFn: async () => jsonResponse(200, ++n === 1 ? { access_token: 'A1', refresh_token: 'R1', expires_in: 3600 } : { access_token: 'A2', expires_in: 3600 }),
  });
  const login = new URL(await auth.loginURL());
  await auth.completeLogin(`https://x/?code=1&state=${login.searchParams.get('state')}`);
  now = 3600 * 1000; // 만료
  expect((await auth.accessToken()) === 'A2' && auth.tokens.refreshToken === 'R1');
});

// ---------- 화면 배치 ----------

test('세로·가로·iPad 배치에서 톤암이 홈에 맞고 화면 안에 있다', () => {
  const screens = [
    { w: 390, h: 844, insets: { top: 47, bottom: 34, left: 0, right: 0 } },
    { w: 844, h: 390, insets: { top: 0, bottom: 21, left: 47, right: 47 } },
    { w: 820, h: 1180, insets: { top: 24, bottom: 20, left: 0, right: 0 } },
    { w: 1180, h: 820, insets: { top: 24, bottom: 20, left: 0, right: 0 } },
    { w: 375, h: 667, insets: { top: 20, bottom: 0, left: 0, right: 0 } },
  ];
  for (const s of screens) {
    const layout = computeLayout(s.w, s.h, s.insets);
    const rig = new TonearmRig({ maxRight: layout.maxRight, maxUp: layout.maxUp });
    const label = `${s.w}x${s.h} ${layout.mode}`;
    expect(rig.fitError < 0.02, `${label} fitError ${rig.fitError.toFixed(3)}`);
    const pivotX = layout.center.x + rig.pivot.x * layout.radius;
    const pivotY = layout.center.y + rig.pivot.y * layout.radius;
    expect(pivotX < s.w + layout.radius * 0.05 && pivotY > 0, `${label} 피벗이 화면 밖 (${pivotX.toFixed(0)}, ${pivotY.toFixed(0)})`);
    if (layout.mode === 'portrait') expect(layout.radius >= s.w * 0.4, `${label} LP가 작음`);
    if (layout.sleeve) expect(layout.sleeve.x + layout.sleeve.size < layout.center.x, `${label} 재킷이 라벨을 가림`);
  }
});

// ---------- Spotify: 활성 기기가 없을 때 ----------

/** 경로·메서드별로 응답을 정하는 가짜 서버. 보낸 요청을 기록한다. */
function fakeSpotify(routes) {
  const calls = [];
  const fetchFn = async (url, init = {}) => {
    const u = new URL(url);
    const key = `${init.method || 'GET'} ${u.pathname.replace('/v1', '')}`;
    calls.push({ key, query: Object.fromEntries(u.searchParams), body: init.body ? JSON.parse(init.body) : undefined });
    const handler = routes[key];
    if (!handler) return jsonResponse(404, { error: { status: 404, message: `no route ${key}` } });
    return typeof handler === 'function' ? handler(calls[calls.length - 1], calls) : handler;
  };
  return { fetchFn, calls };
}

const RECENT = {
  items: [{ track: { ...ITEM, uri: 'spotify:track:abc' }, context: { uri: 'spotify:album:xyz' } }],
};

test('기기가 쉬고 있으면(204) 마지막으로 들은 곡을 판에 올린다', async () => {
  const server = fakeSpotify({ 'GET /me/player': jsonResponse(204, null), 'GET /me/player/recently-played': jsonResponse(200, RECENT) });
  const p = new SpotifyProvider(fakeAuth(), { fetchFn: server.fetchFn, setTimer: () => 0, clearTimer: () => {} });
  await p.refresh();
  expect(p.status === 'noDevice');
  expect(p.snapshot.track && p.snapshot.track.id === 'abc', '마지막 곡 없음');
  expect(!p.snapshot.timeline.isPlaying && p.snapshot.timeline.duration === 200);
  await p.refresh(); // 최근 재생은 한 번만 읽는다
  expect(server.calls.filter((c) => c.key === 'GET /me/player/recently-played').length === 1);
});

test('기기가 쉬고 있을 때 바늘을 내리면 그 기기에서 앨범 순서대로 이어서 재생', async () => {
  const server = fakeSpotify({
    'GET /me/player': jsonResponse(204, null),
    'GET /me/player/recently-played': jsonResponse(200, RECENT),
    'GET /me/player/devices': jsonResponse(200, { devices: [{ id: 'mac', type: 'Computer', is_active: false }, { id: 'iphone', type: 'Smartphone', is_active: false }] }),
    'PUT /me/player/play': jsonResponse(204, null),
  });
  const p = new SpotifyProvider(fakeAuth(), { fetchFn: server.fetchFn, setTimer: () => 0, clearTimer: () => {} });
  await p.refresh();
  await p.seek(42.5); // 아직 기기가 없으니 기억만 한다
  expect(!server.calls.some((c) => c.key === 'PUT /me/player/seek'));
  await p.play();
  const put = server.calls.find((c) => c.key === 'PUT /me/player/play');
  expect(put && put.query.device_id === 'iphone', JSON.stringify(put));
  expect(put.body.context_uri === 'spotify:album:xyz' && put.body.offset.uri === 'spotify:track:abc' && put.body.position_ms === 42500);
  expect(p.status === 'ok' && p.snapshot.timeline.isPlaying);
});

test('문맥으로 재생이 안 되면 곡만으로 다시 시도한다', async () => {
  const server = fakeSpotify({
    'GET /me/player': jsonResponse(204, null),
    'GET /me/player/recently-played': jsonResponse(200, RECENT),
    'GET /me/player/devices': jsonResponse(200, { devices: [{ id: 'iphone', type: 'Smartphone' }] }),
    'PUT /me/player/play': (call) => (call.body && call.body.context_uri ? jsonResponse(403, { error: { status: 403, reason: 'UNKNOWN' } }) : jsonResponse(204, null)),
  });
  const p = new SpotifyProvider(fakeAuth(), { fetchFn: server.fetchFn, setTimer: () => 0, clearTimer: () => {} });
  await p.refresh();
  await p.play();
  const puts = server.calls.filter((c) => c.key === 'PUT /me/player/play');
  expect(puts.length === 2 && puts[1].body.uris[0] === 'spotify:track:abc');
  expect(p.status === 'ok');
});

test('쓸 수 있는 기기가 없으면 Spotify 앱을 열라고 안내', async () => {
  const server = fakeSpotify({
    'GET /me/player': jsonResponse(204, null),
    'GET /me/player/recently-played': jsonResponse(200, RECENT),
    'GET /me/player/devices': jsonResponse(200, { devices: [] }),
  });
  const p = new SpotifyProvider(fakeAuth(), { fetchFn: server.fetchFn, setTimer: () => 0, clearTimer: () => {} });
  await p.refresh();
  let error = null;
  try { await p.play(); } catch (e) { error = e; }
  expect(error && error.code === 'noDevice' && error.userMessage.includes('Spotify 앱을 열어'), error && error.userMessage);
});

// ---------- 실행 ----------

for (const { name, fn } of tests) {
  try {
    await fn();
    results.push({ ok: true, name });
  } catch (error) {
    results.push({ ok: false, name, message: error && error.message });
  }
}
const failed = results.filter((r) => !r.ok).length;
document.getElementById('summary').textContent = failed ? `실패 ${failed} / ${results.length}` : `모두 통과 ${results.length} / ${results.length}`;
document.getElementById('summary').className = failed ? 'fail' : 'pass';
const list = document.getElementById('results');
for (const r of results) {
  const li = document.createElement('li');
  li.className = r.ok ? 'pass' : 'fail';
  li.textContent = `${r.ok ? '✓' : '✗'} ${r.name}${r.ok ? '' : ` — ${r.message}`}`;
  list.appendChild(li);
}
window.__testResults = results;
