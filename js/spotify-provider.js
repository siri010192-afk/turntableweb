// Spotify Web API로 iPhone의 Spotify 앱(Connect 기기)을 조종하는 프로바이더.
// 상태는 화면이 보일 때만 주기적으로 읽고(기본 1.5초), 그 사이 위치는 로컬 시계로 보간한다.
// 재생 조종은 Premium이 필요하다.

import { PlaybackTimeline } from './motion.js';
import { ProviderError } from './mock-provider.js';

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
    setTimer = (fn, ms) => setTimeout(fn, ms),
    clearTimer = (id) => clearTimeout(id),
  } = {}) {
    this.kind = 'spotify';
    this.auth = auth;
    this.fetchFn = fetchFn;
    this.now = now;
    this.sleep = sleep;
    this.pollInterval = pollInterval;
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
      this.setStatus('noDevice');
      this.setSnapshot(null, PlaybackTimeline.zero);
      return;
    }
    this.setStatus('ok');
    const item = data.item;
    if (!item || (item.type && item.type !== 'track')) {
      this.setSnapshot(null, new PlaybackTimeline(0, receivedAt, Boolean(data.is_playing), 0));
      return;
    }
    const track = mapTrack(item);
    // 응답이 오는 데 걸린 시간의 절반만큼 재생 위치가 앞서 있다고 본다.
    const latency = Math.max(0, (receivedAt - sentAt) / 2);
    const position = (data.progress_ms || 0) / 1000 + (data.is_playing ? latency : 0);
    this.setSnapshot(track, new PlaybackTimeline(position, receivedAt, Boolean(data.is_playing), track.duration));
  }

  // ---------- 조종 ----------

  async play() {
    await this.command('PUT', '/me/player/play', null, (tl, t) => new PlaybackTimeline(tl.positionAt(t), t, true, tl.duration));
  }

  async pause() {
    await this.command('PUT', '/me/player/pause', null, (tl, t) => tl.pausedAt(t));
  }

  async seek(seconds) {
    const ms = Math.max(0, Math.round(seconds * 1000));
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
    await this.request(method, path, query);
    this.commandCounter += 1;
    if (optimistic) {
      const t = this.now();
      this.setSnapshot(this.snapshot.track, optimistic(this.snapshot.timeline, t));
    }
    // 명령이 반영된 상태를 조금 뒤에 다시 읽는다.
    this.schedulePoll(0.8);
  }

  // ---------- 저수준 ----------

  async request(method, path, query, retried = false) {
    const token = await this.auth.accessToken();
    const url = new URL(API + path);
    if (query) url.search = new URLSearchParams(query).toString();
    let response;
    try {
      response = await this.fetchFn(url.toString(), { method, headers: { Authorization: `Bearer ${token}` } });
    } catch (error) {
      throw new ProviderError('network', '인터넷 연결을 확인해 주세요.', String(error));
    }
    if (response.status === 401 && !retried) {
      await this.auth.refresh();
      return this.request(method, path, query, true);
    }
    const text = response.status === 204 ? '' : await response.text().catch(() => '');
    let body = null;
    if (text) {
      try { body = JSON.parse(text); } catch { body = null; }
    }
    if (!response.ok) {
      const error = errorFromResponse(response.status, body);
      if (response.status === 429) error.detail = Number(response.headers && response.headers.get && response.headers.get('Retry-After')) || 5;
      throw error;
    }
    return { status: response.status, body };
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
