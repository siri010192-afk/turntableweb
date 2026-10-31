// Spotify Web API로 iPhone의 Spotify 앱(Connect 기기)을 조종하는 프로바이더.
// 상태는 화면이 보일 때만 주기적으로 읽고(기본 1.5초), 그 사이 위치는 로컬 시계로 보간한다.
// 재생 조종은 Premium이 필요하다.

import { PlaybackTimeline } from './motion.js?v=202610311717';
import { ProviderError } from './mock-provider.js?v=202610311717';

const API = 'https://api.spotify.com/v1';
const DEFAULT_PALETTE = { base: '#D9643A', band: '#F3D9B1', ink: '#2A140B', backgroundTint: '#2B1A12' };

export function mapTrack(item) {
  const images = [...((item.album && item.album.images) || [])].sort((a, b) => (b.width || 0) - (a.width || 0));
  const art = images.find((img) => (img.width || 0) <= 640) || images[0];
  return {
    id: item.id || item.uri,
    title: item.name || '',
    artist: (item.artists || []).map((a) => a.name).join(', '),
    album: (item.album && item.album.name) || '',
    duration: (item.duration_ms || 0) / 1000,
    artworkURL: art ? art.url : null,
    palette: DEFAULT_PALETTE,
  };
}

function errorFromResponse(status, body) {
  const reason = body && body.error && body.error.reason;
  const message = (body && body.error && body.error.message) || '';
  if (status === 404 || reason === 'NO_ACTIVE_DEVICE') {
    return new ProviderError('noDevice', 'Spotify 앱에서 먼저 음악을 재생해 주세요.', reason || message);
  }
  if (status === 403 && reason === 'PREMIUM_REQUIRED') {
    return new ProviderError('premium', '재생 조종에는 Spotify Premium이 필요해요.', reason);
  }
  if (status === 403) return new ProviderError('restricted', '지금은 이 조작을 할 수 없어요.', reason || message);
  if (status === 401) return new ProviderError('auth', 'Spotify에 다시 연결해 주세요.', message);
  if (status === 429) return new ProviderError('rateLimited', '요청이 많아요. 잠시 후 다시 시도해 주세요.', message);
  return new ProviderError('unknown', 'Spotify와 통신하지 못했어요. 잠시 후 다시 시도해 주세요.', `${status} ${message}`);
}

export class SpotifyProvider {
  constructor(auth, {
    fetchFn = (...a) => fetch(...a),
    now = () => performance.now() / 1000,
    sleep = (s) => new Promise((r) => setTimeout(r, s * 1000)),
    pollInterval = 1.5,
    preferredDeviceType = 'Smartphone', // 쉬는 기기를 깨울 때 우선할 종류 (PC에서는 'Computer')
    setTimer = (fn, ms) => setTimeout(fn, ms),
    clearTimer = (id) => clearTimeout(id),
  } = {}) {
    this.kind = 'spotify';
    this.auth = auth;
    this.fetchFn = fetchFn;
    this.now = now;
    this.sleep = sleep;
    this.pollInterval = pollInterval;
    this.preferredDeviceType = preferredDeviceType;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.snapshot = { track: null, timeline: PlaybackTimeline.zero };
    /** 'connecting' | 'ok' | 'noDevice' | 'error' */
    this.status = 'connecting';
    this.lastError = null;
    this.listeners = new Set();
    this.statusListeners = new Set();
    this.commandCounter = 0;
    this.pollTimer = null;
    this.running = false;
  }

  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  onStatus(fn) {
    this.statusListeners.add(fn);
    return () => this.statusListeners.delete(fn);
  }

  // ---------- 상태 읽기 ----------

  start() {
    this.running = true;
    this.schedulePoll(0);
  }

  stop() {
    this.running = false;
    this.clearTimer(this.pollTimer);
    this.pollTimer = null;
  }

  schedulePoll(delaySeconds) {
    this.clearTimer(this.pollTimer);
    if (!this.running) return;
    this.pollTimer = this.setTimer(() => this.poll(), delaySeconds * 1000);
  }

  async poll() {
    let next = this.pollInterval;
    try {
      await this.refresh();
    } catch (error) {
      this.setStatus('error', error);
      if (error && error.code === 'rateLimited') next = Math.max(next, Number(error.detail) || 5);
      if (error && error.code === 'auth') next = 10;
    }
    this.schedulePoll(next);
  }

  /** 현재 재생 상태를 한 번 읽어 반영한다. */
  async refresh() {
    const counter = this.commandCounter;
    const sentAt = this.now();
    const response = await this.request('GET', '/me/player');
    const receivedAt = this.now();
    // 읽는 사이에 조종 명령이 나갔으면 명령 전 상태일 수 있으므로 버린다.
    if (counter !== this.commandCounter) return;
    const data = response.body;
    if (response.status === 204 || !data) {
      // 활성 기기가 없다 (Spotify 앱이 한동안 쉬면 이렇게 된다). 마지막으로 들은 곡을 대신 보여 준다.
      this.setStatus('noDevice');
      const last = await this.loadLastPlayed().catch(() => null);
      if (counter !== this.commandCounter) return;
      const position = this.pendingPosition || 0;
      this.setSnapshot(
        last ? last.track : null,
        last ? new PlaybackTimeline(position, this.now(), false, last.track.duration) : PlaybackTimeline.zero,
      );
      return;
    }
    this.setStatus('ok');
    this.pendingPosition = null;
    this.lastPlayedTried = false;
    const item = data.item;
    if (!item || (item.type && item.type !== 'track')) {
      this.setSnapshot(null, new PlaybackTimeline(0, receivedAt, Boolean(data.is_playing), 0));
      return;
    }
    const track = mapTrack(item);
    this.lastPlayed = { track, uri: item.uri, contextUri: (data.context && data.context.uri) || null };
    // 응답이 오는 데 걸린 시간의 절반만큼 재생 위치가 앞서 있다고 본다.
    const latency = Math.max(0, (receivedAt - sentAt) / 2);
    const position = (data.progress_ms || 0) / 1000 + (data.is_playing ? latency : 0);
    this.setSnapshot(track, new PlaybackTimeline(position, receivedAt, Boolean(data.is_playing), track.duration));
  }

  // ---------- 조종 ----------

  async play() {
    if (this.status === 'noDevice') {
      await this.startOnDevice();
      return;
    }
    await this.command('PUT', '/me/player/play', null, (tl, t) => new PlaybackTimeline(tl.positionAt(t), t, true, tl.duration));
  }

  /**
   * 활성 기기가 없을 때 재생 시작: 쓸 수 있는 기기(iPhone의 Spotify 앱 등)를 골라
   * 마지막으로 듣던 곡을 (앨범·플레이리스트 순서 그대로) 기억한 위치부터 튼다.
   */
  async startOnDevice() {
    const device = await this.pickDevice();
    const last = this.lastPlayed;
    const positionMs = Math.round((this.pendingPosition || 0) * 1000);
    const bodies = [];
    if (last && last.contextUri) bodies.push({ context_uri: last.contextUri, offset: { uri: last.uri }, position_ms: positionMs });
    if (last) bodies.push({ uris: [last.uri], position_ms: positionMs });
    if (!bodies.length) bodies.push(undefined); // 기억한 곡이 없으면 그 기기의 마지막 상태로 재개
    this.commandCounter += 1;
    let lastError = null;
    for (const body of bodies) {
      try {
        await this.request('PUT', '/me/player/play', { query: { device_id: device.id }, body });
        lastError = null;
        break;
      } catch (error) {
        // 재생 목록(예: 좋아요 표시한 곡)을 문맥으로 못 쓰면 곡만으로 다시 시도한다.
        lastError = error;
      }
    }
    this.commandCounter += 1;
    if (lastError) throw lastError;
    this.setStatus('ok');
    const t = this.now();
    const tl = this.snapshot.timeline;
    this.setSnapshot(this.snapshot.track, new PlaybackTimeline(positionMs / 1000, t, true, tl.duration));
    this.pendingPosition = null;
    this.schedulePoll(1.0);
  }

  async pickDevice() {
    const response = await this.request('GET', '/me/player/devices');
    const devices = ((response.body && response.body.devices) || []).filter((d) => !d.is_restricted);
    const device = devices.find((d) => d.is_active) || devices.find((d) => d.type === this.preferredDeviceType) || devices[0];
    if (!device) {
      const where = this.preferredDeviceType === 'Computer' ? 'PC에서' : 'iPhone에서';
      throw new ProviderError('noDevice', `${where} Spotify 앱을 열어 주세요. 앱이 켜져 있어야 조종할 수 있어요.`, 'no devices');
    }
    return device;
  }

  /** 최근 재생한 곡 1개 (활성 기기가 없을 때 판에 올려 둘 곡). 한 번만 읽는다. */
  async loadLastPlayed() {
    if (this.lastPlayed) return this.lastPlayed;
    if (this.lastPlayedTried) return null;
    this.lastPlayedTried = true;
    const response = await this.request('GET', '/me/player/recently-played', { query: { limit: '1' } });
    const entry = response.body && response.body.items && response.body.items[0];
    if (!entry || !entry.track) return null;
    this.lastPlayed = { track: mapTrack(entry.track), uri: entry.track.uri, contextUri: (entry.context && entry.context.uri) || null };
    return this.lastPlayed;
  }

  async pause() {
    await this.command('PUT', '/me/player/pause', null, (tl, t) => tl.pausedAt(t));
  }

  async seek(seconds) {
    const ms = Math.max(0, Math.round(seconds * 1000));
    if (this.status === 'noDevice') {
      // 아직 재생 중인 기기가 없다: 위치만 기억했다가 play()에서 그 위치부터 시작한다.
      this.pendingPosition = ms / 1000;
      const tl = this.snapshot.timeline;
      this.setSnapshot(this.snapshot.track, new PlaybackTimeline(ms / 1000, this.now(), false, tl.duration));
      return;
    }
    await this.command('PUT', '/me/player/seek', { position_ms: String(ms) }, (tl, t) => new PlaybackTimeline(ms / 1000, t, tl.isPlaying, tl.duration));
  }

  /** 다음/이전 곡으로 넘기고, 새 곡 정보가 들어올 때까지(최대 약 3초) 기다린다. */
  async skip(offset) {
    const oldId = this.snapshot.track ? this.snapshot.track.id : null;
    const path = offset > 0 ? '/me/player/next' : '/me/player/previous';
    for (let i = 0; i < Math.max(1, Math.abs(offset)); i++) await this.command('POST', path, null, null);
    for (let attempt = 0; attempt < 8; attempt++) {
      await this.sleep(0.4);
      await this.refresh();
      const current = this.snapshot.track ? this.snapshot.track.id : null;
      if (current !== oldId) return;
      // '이전 곡'은 곡 앞부분이 아니면 같은 곡을 처음부터 다시 튼다.
      if (offset < 0 && this.snapshot.timeline.position < 1.5) return;
    }
  }

  async command(method, path, query, optimistic) {
    this.commandCounter += 1;
    await this.request(method, path, { query });
    this.commandCounter += 1;
    if (optimistic) {
      const t = this.now();
      this.setSnapshot(this.snapshot.track, optimistic(this.snapshot.timeline, t));
    }
    // 명령이 반영된 상태를 조금 뒤에 다시 읽는다.
    this.schedulePoll(0.8);
  }

  // ---------- 저수준 ----------

  async request(method, path, { query, body } = {}, retried = false) {
    const token = await this.auth.accessToken();
    const url = new URL(API + path);
    if (query) url.search = new URLSearchParams(query).toString();
    const init = { method, headers: { Authorization: `Bearer ${token}` } };
    if (body !== undefined) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    let response;
    try {
      response = await this.fetchFn(url.toString(), init);
    } catch (error) {
      throw new ProviderError('network', '인터넷 연결을 확인해 주세요.', String(error));
    }
    if (response.status === 401 && !retried) {
      await this.auth.refresh();
      return this.request(method, path, { query, body }, true);
    }
    const text = response.status === 204 ? '' : await response.text().catch(() => '');
    let parsed = null;
    if (text) {
      try { parsed = JSON.parse(text); } catch { parsed = null; }
    }
    if (!response.ok) {
      const error = errorFromResponse(response.status, parsed);
      if (response.status === 429) error.detail = Number(response.headers && response.headers.get && response.headers.get('Retry-After')) || 5;
      throw error;
    }
    return { status: response.status, body: parsed };
  }

  setSnapshot(track, timeline) {
    this.snapshot = { track, timeline };
    for (const fn of this.listeners) fn(this.snapshot);
  }

  setStatus(status, error = null) {
    const changed = status !== this.status || error !== this.lastError;
    this.status = status;
    this.lastError = error;
    if (changed) for (const fn of this.statusListeners) fn(status, error);
  }
}
