// TurnTable 위젯 (Scriptable 스크립트)
// 홈 화면(작은·중간)과 잠금화면(원형·가로형·한 줄) 위젯. 지금 듣는 Spotify 곡을 LP로 보여 준다.
// 설치 방법: https://siri010192-afk.github.io/turntableweb/widget/
//
// - 위젯은 정지된 그림이다. 언제 다시 그릴지는 iOS가 정한다 (보통 몇 분~십몇 분 간격).
// - 위젯을 탭하면 TurnTable 웹앱이 열린다.
// - Spotify 토큰은 이 iPhone의 Keychain에만 저장한다.

const VERSION = 1;
const CLIENT_ID = '8b5542b1fa9b416d961fa106d5210ffa';
const SITE = 'https://siri010192-afk.github.io/turntableweb/';
const REDIRECT_URI = SITE + 'widget-callback.html';
const SCOPES = 'user-read-playback-state user-read-currently-playing user-read-recently-played';
const TOKEN_URL = 'https://accounts.spotify.com/api/token';
const API = 'https://api.spotify.com/v1';
const KEY_TOKENS = 'turntable.widget.tokens';
const KEY_PKCE = 'turntable.widget.pkce';
const CACHE_FILE = 'turntable-widget-state.json';

// 웹앱(DesignTokens/RenderTokens)과 같은 색
const COLORS = {
  background: '#0e0d0c',
  backgroundEdge: '#0b0a09',
  vinyl: '#161514',
  vinylEdge: '#0b0b0b',
  armBase: '#211f1c',
  armTube: '#c9c4bd',
  counterweight: '#8e8880',
  headshell: '#2b2825',
  accent: '#e0703f',
  pivotCap: '#b9b3ab',
  text: '#f2ede6',
  muted: '#c9c1b6',
};
const PALETTE = { base: '#d9643a', band: '#f3d9b1', ink: '#2a140b', tint: '#2b1a12' };

// 톤암 각도(도): 휴식 0°, 첫 홈 18°, 마지막 홈 48° (웹앱 ToneArmGeometry와 같다)
const ARM = { rest: 0, start: 18, end: 48, length: 1.1, outer: 0.94, inner: 0.42, label: 0.34 };

// ---------------------------------------------------------------- 진입점

const params = args.queryParameters || {};
if (config.runsInWidget) {
  Script.setWidget(await buildWidget(config.widgetFamily || 'small'));
} else if (params.code || params.error) {
  await finishLogin(params);
} else {
  await showMenu();
}
Script.complete();

// ---------------------------------------------------------------- 앱에서 실행했을 때

async function showMenu() {
  const loggedIn = Boolean(readTokens());
  const alert = new Alert();
  alert.title = 'TurnTable 위젯';
  alert.message = loggedIn
    ? 'Spotify에 연결되어 있어요. 홈 화면을 길게 눌러 Scriptable 위젯을 추가하고, 위젯 편집에서 이 스크립트를 고르세요.'
    : '먼저 Spotify에 연결해 주세요. 로그인 후 "Scriptable을 열겠습니까?"가 나오면 열기를 누르세요.';
  const actions = loggedIn
    ? ['작은 위젯 미리보기', '중간 위젯 미리보기', 'Spotify 다시 연결', '연결 끊기']
    : ['Spotify 연결'];
  actions.forEach((title) => alert.addAction(title));
  alert.addCancelAction('닫기');
  const choice = await alert.presentSheet();
  const action = actions[choice];
  if (action === 'Spotify 연결' || action === 'Spotify 다시 연결') return startLogin();
  if (action === '작은 위젯 미리보기') return (await buildWidget('small')).presentSmall();
  if (action === '중간 위젯 미리보기') return (await buildWidget('medium')).presentMedium();
  if (action === '연결 끊기') {
    if (Keychain.contains(KEY_TOKENS)) Keychain.remove(KEY_TOKENS);
    await notify('연결을 끊었어요.');
  }
}

async function notify(message) {
  const alert = new Alert();
  alert.title = 'TurnTable 위젯';
  alert.message = message;
  alert.addAction('확인');
  await alert.presentAlert();
}

// ---------------------------------------------------------------- Spotify 로그인 (PKCE)

function startLogin() {
  const verifier = (UUID.string() + UUID.string() + UUID.string()).replace(/-/g, '');
  // state 뒤에 스크립트 이름을 붙여 두면 중계 페이지가 이 스크립트를 다시 연다
  const state = UUID.string().replace(/-/g, '') + '.' + encodeURIComponent(Script.name());
  Keychain.set(KEY_PKCE, JSON.stringify({ verifier, state }));
  const challenge = base64Url(sha256(asciiBytes(verifier)));
  Safari.open('https://accounts.spotify.com/authorize?' + query({
    response_type: 'code',
    client_id: CLIENT_ID,
    scope: SCOPES,
    redirect_uri: REDIRECT_URI,
    state,
    code_challenge_method: 'S256',
    code_challenge: challenge,
  }));
}

async function finishLogin(p) {
  if (p.error) return notify(p.error === 'access_denied' ? 'Spotify 연결을 취소했어요.' : 'Spotify 로그인에 실패했어요. 다시 시도해 주세요.');
  const pkce = Keychain.contains(KEY_PKCE) ? JSON.parse(Keychain.get(KEY_PKCE)) : null;
  if (Keychain.contains(KEY_PKCE)) Keychain.remove(KEY_PKCE);
  if (!pkce || pkce.state !== p.state) return notify('로그인 확인에 실패했어요. 스크립트를 다시 실행해 연결해 주세요.');
  try {
    const body = await tokenRequest({
      grant_type: 'authorization_code',
      code: p.code,
      redirect_uri: REDIRECT_URI,
      client_id: CLIENT_ID,
      code_verifier: pkce.verifier,
    });
    saveTokens(body);
    await notify('연결됐어요. 홈 화면을 길게 눌러 + → Scriptable 위젯을 추가하고, 위젯을 길게 눌러 "위젯 편집"에서 이 스크립트를 고르세요.');
  } catch (error) {
    await notify('Spotify 로그인에 실패했어요: ' + error.message);
  }
}

async function tokenRequest(fields) {
  const request = new Request(TOKEN_URL);
  request.method = 'POST';
  request.headers = { 'Content-Type': 'application/x-www-form-urlencoded' };
  request.body = query(fields);
  const body = await request.loadJSON();
  if (request.response.statusCode !== 200) throw new Error(body.error_description || body.error || String(request.response.statusCode));
  return body;
}

function readTokens() {
  if (!Keychain.contains(KEY_TOKENS)) return null;
  try { return JSON.parse(Keychain.get(KEY_TOKENS)); } catch (e) { return null; }
}

function saveTokens(body) {
  const old = readTokens();
  Keychain.set(KEY_TOKENS, JSON.stringify({
    accessToken: body.access_token,
    refreshToken: body.refresh_token || (old && old.refreshToken),
    expiresAt: Date.now() + (Number(body.expires_in) || 3600) * 1000,
  }));
}

async function accessToken(forceRefresh) {
  const tokens = readTokens();
  if (!tokens) throw new Error('not connected');
  if (!forceRefresh && Date.now() < tokens.expiresAt - 60000) return tokens.accessToken;
  saveTokens(await tokenRequest({ grant_type: 'refresh_token', refresh_token: tokens.refreshToken, client_id: CLIENT_ID }));
  return readTokens().accessToken;
}

async function api(path, retried) {
  const request = new Request(API + path);
  request.headers = { Authorization: 'Bearer ' + (await accessToken(retried)) };
  const text = await request.loadString();
  const status = request.response.statusCode;
  if (status === 401 && !retried) return api(path, true);
  if (status === 204 || !text) return null;
  if (status >= 400) throw new Error('Spotify ' + status);
  return JSON.parse(text);
}

// ---------------------------------------------------------------- 지금 곡 읽기

function mapTrack(item) {
  const images = (item.album && item.album.images ? item.album.images.slice() : []).sort((a, b) => (b.width || 0) - (a.width || 0));
  const art = images.find((img) => (img.width || 0) <= 640) || images[0];
  return {
    id: item.id,
    title: item.name || '',
    artist: (item.artists || []).map((a) => a.name).join(', '),
    duration: (item.duration_ms || 0) / 1000,
    artworkURL: art ? art.url : null,
  };
}

/** { track, isPlaying, position, stale, error } — 실패하면 마지막으로 성공한 상태를 쓴다. */
async function loadState() {
  const fm = FileManager.local();
  const cachePath = fm.joinPath(fm.cacheDirectory(), CACHE_FILE);
  if (!readTokens()) return { error: '스크립트를 실행해 연결하세요' };
  try {
    let state = null;
    const player = await api('/me/player');
    if (player && player.item && player.item.type === 'track') {
      state = { track: mapTrack(player.item), isPlaying: Boolean(player.is_playing), position: (player.progress_ms || 0) / 1000 };
    } else {
      const recent = await api('/me/player/recently-played?limit=1');
      const entry = recent && recent.items && recent.items[0];
      if (entry && entry.track) state = { track: mapTrack(entry.track), isPlaying: false, position: 0 };
    }
    if (state) fm.writeString(cachePath, JSON.stringify(state));
    return state || { error: 'Spotify에서 재생해 보세요' };
  } catch (error) {
    if (fm.fileExists(cachePath)) {
      const cached = JSON.parse(fm.readString(cachePath));
      cached.stale = true;
      return cached;
    }
    return { error: 'Spotify 연결 안 됨' };
  }
}

async function loadCover(url) {
  if (!url) return null;
  const fm = FileManager.local();
  const path = fm.joinPath(fm.cacheDirectory(), 'turntable-cover-' + url.replace(/[^a-zA-Z0-9]/g, '').slice(-40) + '.jpg');
  try {
    if (fm.fileExists(path)) return fm.readImage(path);
    const image = await new Request(url).loadImage();
    fm.writeImage(path, image);
    return image;
  } catch (e) {
    return null;
  }
}

// ---------------------------------------------------------------- 위젯 조립

async function buildWidget(family) {
  const state = await loadState();
  const cover = state.track ? await loadCover(state.track.artworkURL) : null;
  const widget = new ListWidget();
  widget.url = SITE;
  widget.setPadding(0, 0, 0, 0);
  // 재생 중이면 조금 자주(곡이 끝날 즈음), 아니면 드물게 다시 그려 달라고 요청한다 (실제 시점은 iOS가 정한다)
  const remaining = state.track && state.isPlaying ? Math.max(60, state.track.duration - state.position) : 0;
  widget.refreshAfterDate = new Date(Date.now() + (state.isPlaying ? Math.min(remaining, 300) : 1800) * 1000);

  if (family === 'accessoryInline') {
    widget.addText(state.track ? '♪ ' + state.track.title + ' · ' + state.track.artist : '♪ TurnTable');
    return widget;
  }
  if (family === 'accessoryCircular') {
    widget.addAccessoryWidgetBackground = false;
    const image = widget.addImage(renderRecordOnly(cover, 160));
    image.applyFillingContentMode();
    return widget;
  }
  if (family === 'accessoryRectangular') {
    const row = widget.addStack();
    row.layoutHorizontally();
    row.centerAlignContent();
    row.spacing = 6;
    const disc = row.addImage(renderRecordOnly(cover, 120));
    disc.imageSize = new Size(40, 40);
    const texts = row.addStack();
    texts.layoutVertically();
    const title = texts.addText(state.track ? state.track.title : 'TurnTable');
    title.font = Font.boldSystemFont(13);
    title.lineLimit = 1;
    const sub = texts.addText(state.track ? state.track.artist : (state.error || ''));
    sub.font = Font.systemFont(11);
    sub.lineLimit = 1;
    return widget;
  }
  // 중간은 가로로 긴 배치, 작은·큰(정사각형에 가까움)은 LP 하나
  widget.backgroundImage = family === 'medium' ? renderWide(state, cover) : renderSmall(state, cover);
  return widget;
}

// ---------------------------------------------------------------- 그리기

/** 작은 위젯: LP + 톤암 (글자 없음). */
function renderSmall(state, cover) {
  const W = 360;
  const H = 360;
  const ctx = newContext(W, H);
  drawBackground(ctx, W, H, cover);
  const R = W * 0.36;
  const c = { x: W * 0.43, y: H * 0.52 };
  drawRecord(ctx, c, R, cover);
  const rig = fitRig((W - c.x) / R + 0.1, c.y / R);
  drawArm(ctx, rig, c, R, armAngle(state));
  if (state.error && !state.track) drawCaption(ctx, state.error, new Rect(16, H - 52, W - 32, 40), 26, 'center', true);
  return ctx.getImage();
}

/** 중간 위젯: 앨범 재킷 위로 올라온 LP + 톤암 + 오른쪽 아래 곡 제목 (웹앱 가로 화면과 같은 배치). */
function renderWide(state, cover) {
  const W = 720;
  const H = 338;
  const ctx = newContext(W, H);
  drawBackground(ctx, W, H, cover);
  const margin = 22;
  const avail = H - margin * 2;
  const sleeve = Math.min(avail, W * 0.36);
  const R = sleeve * 0.5;
  const sleeveRect = new Rect(margin + 6, margin + (avail - sleeve) / 2, sleeve, sleeve);
  const c = { x: sleeveRect.x + sleeve + R * 0.42, y: sleeveRect.y + sleeve / 2 };
  drawSleeve(ctx, sleeveRect, cover);
  drawRecord(ctx, c, R, cover);
  const rig = fitRig((W - margin - c.x) / R, c.y / R);
  drawArm(ctx, rig, c, R, armAngle(state));

  const textWidth = W - (c.x + R) - margin - 8;
  const title = state.track ? state.track.title : 'TurnTable';
  const sub = state.track ? state.track.artist + (state.stale ? ' · 오프라인' : '') : (state.error || '');
  drawCaption(ctx, title, new Rect(W - margin - textWidth, H - margin - 74, textWidth, 38), 28, 'right', true);
  drawCaption(ctx, sub, new Rect(W - margin - textWidth, H - margin - 38, textWidth, 34), 22, 'right');
  return ctx.getImage();
}

/** 잠금화면용: 배경 없는 LP 한 장. */
function renderRecordOnly(cover, size) {
  const ctx = newContext(size, size);
  ctx.opaque = false;
  drawRecord(ctx, { x: size / 2, y: size / 2 }, size / 2 - 2, cover);
  return ctx.getImage();
}

function newContext(w, h) {
  const ctx = new DrawContext();
  ctx.size = new Size(w, h);
  ctx.respectScreenScale = false;
  ctx.opaque = true;
  return ctx;
}

function color(hex, alpha) {
  return new Color(hex, alpha === undefined ? 1 : alpha);
}

/** 흐린 커버 배경: 커버를 아주 작게 그렸다가 크게 늘이고 어둡게 덮는다. 커버가 없으면 곡 색 배경. */
function drawBackground(ctx, w, h, cover) {
  ctx.setFillColor(color(COLORS.background));
  ctx.fillRect(new Rect(0, 0, w, h));
  if (cover) {
    const tiny = newContext(8, 8);
    tiny.drawImageInRect(cover, new Rect(0, 0, 8, 8));
    const side = Math.max(w, h) * 1.2;
    ctx.drawImageInRect(tiny.getImage(), new Rect((w - side) / 2, (h - side) / 2, side, side));
    ctx.setFillColor(color('#000000', 0.5));
    ctx.fillRect(new Rect(0, 0, w, h));
  } else {
    ctx.setFillColor(color(PALETTE.tint, 0.9));
    ctx.fillRect(new Rect(0, 0, w, h));
  }
}

function drawSleeve(ctx, rect, cover) {
  ctx.setFillColor(color('#000000', 0.35));
  ctx.fillRect(new Rect(rect.x + 4, rect.y + 8, rect.width, rect.height));
  if (cover) {
    ctx.drawImageInRect(cover, rect);
  } else {
    ctx.setFillColor(color(PALETTE.base));
    ctx.fillRect(rect);
    ctx.setFillColor(color(PALETTE.ink));
    ctx.setFont(Font.boldSystemFont(rect.width * 0.09));
    ctx.setTextColor(color(PALETTE.ink));
    ctx.setTextAlignedLeft();
    ctx.drawTextInRect('TurnTable', new Rect(rect.x + rect.width * 0.08, rect.y + rect.height * 0.08, rect.width * 0.84, rect.width * 0.14));
  }
}

function ellipse(c, r) {
  return new Rect(c.x - r, c.y - r, r * 2, r * 2);
}

/** LP: 판 → 라벨(커버) → 커버 모서리를 가리는 판 색 고리 → 그루브 → 정반사 하이라이트 → 스핀들. */
function drawRecord(ctx, c, R, cover) {
  ctx.setFillColor(color('#000000', 0.45)); // 접지 그림자
  ctx.fillEllipse(ellipse({ x: c.x, y: c.y + R * 0.05 }, R * 1.01));
  ctx.setFillColor(color(COLORS.vinylEdge));
  ctx.fillEllipse(ellipse(c, R));
  ctx.setFillColor(color(COLORS.vinyl));
  ctx.fillEllipse(ellipse(c, R * 0.97));

  const lr = R * ARM.label;
  if (cover) {
    ctx.drawImageInRect(cover, new Rect(c.x - lr, c.y - lr, lr * 2, lr * 2));
    // DrawContext는 원형 자르기가 없어서, 판 색 고리로 정사각형 커버의 모서리를 덮는다.
    const ring = lr * (Math.SQRT2 - 1) + 4;
    ctx.setStrokeColor(color(COLORS.vinyl));
    ctx.setLineWidth(ring);
    ctx.strokeEllipse(ellipse(c, lr + ring / 2));
  } else {
    ctx.setFillColor(color(PALETTE.base));
    ctx.fillEllipse(ellipse(c, lr));
    ctx.setStrokeColor(color(PALETTE.band));
    ctx.setLineWidth(lr * 0.16);
    ctx.strokeEllipse(ellipse(c, lr * 0.7));
  }

  // 그루브
  const inner = ARM.inner - 0.02;
  const outer = ARM.outer + 0.02;
  ctx.setLineWidth(Math.max(1, R / 110));
  let n = 0;
  for (let r = inner; r < outer; r += 0.018) {
    n += 1;
    ctx.setStrokeColor(n % 2 ? color('#ffffff', 0.05) : color('#000000', 0.25));
    ctx.strokeEllipse(ellipse(c, R * r));
  }
  ctx.setLineWidth(Math.max(1.5, R / 45));
  ctx.setStrokeColor(color('#000000', 0.55));
  [0.28, 0.55, 0.8].forEach((f) => ctx.strokeEllipse(ellipse(c, R * (inner + (outer - inner) * f))));

  // 정반사 하이라이트 (화면에 고정된 두 빛줄기, 라벨은 무광이라 제외)
  ctx.setFillColor(color('#ffffff', 0.08));
  ctx.addPath(annularSector(c, lr * 1.05, R * 0.97, -Math.PI / 2 + 0.55 + 0.15, -Math.PI / 2 + 0.55 + 0.65));
  ctx.fillPath();
  ctx.setFillColor(color('#ffffff', 0.05));
  ctx.addPath(annularSector(c, lr * 1.05, R * 0.97, Math.PI / 2 + 0.55 + 0.2, Math.PI / 2 + 0.55 + 0.6));
  ctx.fillPath();

  ctx.setFillColor(color('#d9d4cd'));
  ctx.fillEllipse(ellipse(c, Math.max(2, R * 0.03)));
}

function annularSector(c, r0, r1, a0, a1) {
  const path = new Path();
  const steps = 24;
  const at = (r, a) => new Point(c.x + Math.cos(a) * r, c.y + Math.sin(a) * r);
  path.move(at(r1, a0));
  for (let i = 1; i <= steps; i++) path.addLine(at(r1, a0 + ((a1 - a0) * i) / steps));
  for (let i = steps; i >= 0; i--) path.addLine(at(r0, a0 + ((a1 - a0) * i) / steps));
  path.closeSubpath();
  return path;
}

function armAngle(state) {
  if (!state.track || !state.isPlaying || !(state.track.duration > 0)) return ARM.rest;
  const p = Math.min(Math.max(state.position / state.track.duration, 0), 1);
  return ARM.start + p * (ARM.end - ARM.start);
}

function direction(deg) {
  const r = (deg * Math.PI) / 180;
  return { x: -Math.sin(r), y: Math.cos(r) };
}

/** 웹앱 TonearmRig와 같은 방식으로, 첫 홈·마지막 홈에 맞는 피벗을 찾는다 (단위 ×R). */
function fitRig(maxRight, maxUp) {
  const s = direction(ARM.start);
  const e = direction(ARM.end);
  const rest = direction(ARM.rest);
  let best = { cost: Infinity, x: 1, y: -1 };
  for (let i = 0; i <= 120; i++) {
    const ax = 0.5 + i * 0.01;
    for (let j = 0; j <= 180; j++) {
      const by = -1.5 + j * 0.01;
      const eo = Math.hypot(ax + ARM.length * s.x, by + ARM.length * s.y) - ARM.outer;
      const ei = Math.hypot(ax + ARM.length * e.x, by + ARM.length * e.y) - ARM.inner;
      const restR = Math.hypot(ax + ARM.length * rest.x, by + ARM.length * rest.y);
      const pivotR = Math.hypot(ax, by);
      let pen = 0;
      if (restR < 1.08) pen += (1.08 - restR) * 4;
      if (pivotR < 1.12) pen += (1.12 - pivotR) * 4;
      if (ax + 0.2 > maxRight) pen += (ax + 0.2 - maxRight) * 4;
      if (-by + 0.2 > maxUp) pen += (-by + 0.2 - maxUp) * 4;
      const cost = eo * eo + ei * ei + pen * pen;
      if (cost < best.cost) best = { cost, x: ax, y: by };
    }
  }
  return { pivot: { x: best.x, y: best.y } };
}

function drawArm(ctx, rig, c, R, angle) {
  const P = new Point(c.x + rig.pivot.x * R, c.y + rig.pivot.y * R);
  const d = direction(angle);
  const L = ARM.length * R;
  const N = new Point(P.x + d.x * L, P.y + d.y * L);
  const headLength = R * 0.16;
  const H = new Point(N.x - d.x * headLength, N.y - d.y * headLength);

  ctx.setFillColor(color(COLORS.armBase));
  ctx.fillEllipse(ellipse(P, R * 0.17));

  line(ctx, P, new Point(P.x - d.x * R * 0.22, P.y - d.y * R * 0.22), R * 0.09, COLORS.counterweight); // 카운터웨이트
  line(ctx, new Point(P.x + 3, P.y + 4), new Point(H.x + 3, H.y + 4), Math.max(3, R * 0.032), '#000000', 0.35); // 그림자
  line(ctx, P, H, Math.max(3, R * 0.032), COLORS.armTube); // 튜브
  line(ctx, H, N, R * 0.075, COLORS.headshell); // 헤드셸
  const mark = new Point(H.x + d.x * headLength * 0.6, H.y + d.y * headLength * 0.6);
  line(ctx, mark, new Point(mark.x + d.x * headLength * 0.12, mark.y + d.y * headLength * 0.12), R * 0.075, COLORS.accent);

  ctx.setFillColor(color(COLORS.pivotCap));
  ctx.fillEllipse(ellipse(P, R * 0.06));
}

function line(ctx, a, b, width, hex, alpha) {
  const path = new Path();
  path.move(a);
  path.addLine(b);
  ctx.addPath(path);
  ctx.setStrokeColor(color(hex, alpha));
  ctx.setLineWidth(width);
  ctx.strokePath();
}

function drawCaption(ctx, text, rect, size, align, bold) {
  ctx.setFont(bold ? Font.boldSystemFont(size) : Font.systemFont(size));
  ctx.setTextColor(color(bold ? COLORS.text : COLORS.muted));
  if (align === 'right') ctx.setTextAlignedRight();
  else if (align === 'center') ctx.setTextAlignedCenter();
  else ctx.setTextAlignedLeft();
  ctx.drawTextInRect(text, rect);
}

// ---------------------------------------------------------------- 유틸 (Scriptable에는 Web Crypto가 없다)

function query(fields) {
  return Object.keys(fields).map((k) => encodeURIComponent(k) + '=' + encodeURIComponent(fields[k])).join('&');
}

function asciiBytes(text) {
  const bytes = [];
  for (let i = 0; i < text.length; i++) bytes.push(text.charCodeAt(i) & 0xff);
  return bytes;
}

function base64Url(bytes) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | ((bytes[i + 1] || 0) << 8) | (bytes[i + 2] || 0);
    out += chars[(n >> 18) & 63] + chars[(n >> 12) & 63];
    if (i + 1 < bytes.length) out += chars[(n >> 6) & 63];
    if (i + 2 < bytes.length) out += chars[n & 63];
  }
  return out;
}

/** SHA-256 (FIPS 180-4). 바이트 배열 → 32바이트 배열. */
function sha256(bytes) {
  const K = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ];
  const rotr = (x, n) => (x >>> n) | (x << (32 - n));
  const data = bytes.slice();
  const bitLength = bytes.length * 8;
  data.push(0x80);
  while (data.length % 64 !== 56) data.push(0);
  for (let i = 7; i >= 0; i--) data.push(Math.floor(bitLength / Math.pow(2, 8 * i)) & 0xff);
  let h = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
  const w = new Array(64);
  for (let offset = 0; offset < data.length; offset += 64) {
    for (let t = 0; t < 16; t++) {
      const i = offset + t * 4;
      w[t] = (data[i] << 24) | (data[i + 1] << 16) | (data[i + 2] << 8) | data[i + 3];
    }
    for (let t = 16; t < 64; t++) {
      const s0 = rotr(w[t - 15], 7) ^ rotr(w[t - 15], 18) ^ (w[t - 15] >>> 3);
      const s1 = rotr(w[t - 2], 17) ^ rotr(w[t - 2], 19) ^ (w[t - 2] >>> 10);
      w[t] = (w[t - 16] + s0 + w[t - 7] + s1) | 0;
    }
    let [a, b, c, d, e, f, g, hh] = h;
    for (let t = 0; t < 64; t++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + S1 + ch + K[t] + w[t]) | 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) | 0;
      hh = g;
      g = f;
      f = e;
      e = (d + t1) | 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) | 0;
    }
    h = [(h[0] + a) | 0, (h[1] + b) | 0, (h[2] + c) | 0, (h[3] + d) | 0, (h[4] + e) | 0, (h[5] + f) | 0, (h[6] + g) | 0, (h[7] + hh) | 0];
  }
  const out = [];
  h.forEach((x) => out.push((x >>> 24) & 0xff, (x >>> 16) & 0xff, (x >>> 8) & 0xff, x & 0xff));
  return out;
}
