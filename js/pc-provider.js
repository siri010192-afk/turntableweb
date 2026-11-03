// PC 도우미(pc-helper/turntable_helper.py)를 통해 Windows에서 재생 중인 음악 앱을 조종하는 프로바이더.
// 브라우저의 YouTube Music, Spotify 데스크톱 등 Windows 미디어 컨트롤에 나오는 앱이면 된다. iPhone에서는 쓸 수 없다.
// 도우미는 이 PC의 http://127.0.0.1:39517 에서만 받는다. 상태는 1초마다 읽고 그 사이 위치는 로컬 시계로 보간한다.

import { PlaybackTimeline } from './motion.js?v=202611040059';
import { ProviderError } from './mock-provider.js?v=202611040059';

export const PC_HELPER_URL = 'http://127.0.0.1:39517';
const PALETTE = { base: '#C0392B', band: '#F5D7D2', ink: '#2A0E0B', backgroundTint: '#2A1414' };
const REQUEST_TIMEOUT_MS = 3000;
const JITTER_SECONDS = 0.4; // 이보다 작은 위치 차이는 무시한다 (앱이 알려 주는 위치가 조금씩 흔들려서)

export function mapSession(session, base = PC_HELPER_URL) {
  if (!session || !(session.title || session.artist)) return null;
  return {
    id: `pc:${session.id}`,
    title: session.title || '',
    artist: session.artist || '',
    album: session.album || '',
    duration: session.duration > 0 ? session.duration : 0,
    artworkURL: session.artId ? `${base}/art?id=${encodeURIComponent(session.artId)}` : null,
    palette: PALETTE,
  };
}

export class PcProvider {
  constructor({
    base = PC_HELPER_URL,
    fetchFn = (...a) => fetch(...a),
    now = () => performance.now() / 1000,
    sleep = (s) => new Promise((r) => setTimeout(r, s * 1000)),
    pollInterval = 1,
    setTimer = (fn, ms) => setTimeout(fn, ms),
    clearTimer = (id) => clearTimeout(id),
  } = {}) {
    this.kind = 'pc';
    this.base = base;
    this.fetchFn = fetchFn;
    this.now = now;
    this.sleep = sleep;
    this.pollInterval = pollInterval;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.snapshot = { track: null, timeline: PlaybackTimeline.zero };
    /** 'connecting' | 'ok' | 'noSession' | 'offline' | 'error' */
    this.status = 'connecting';
    this.lastError = null;
    this.appName = '';
    this.session = null;
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
    try {
      await this.refresh();
    } catch (error) {
      if (error && error.code === 'offline') {
        this.session = null;
        this.setSnapshot(null, PlaybackTimeline.zero);
        this.setStatus('offline', error);
      } else {
        this.setStatus('error', error);
      }
    }
    this.schedulePoll(this.status === 'offline' ? 3 : this.pollInterval);
  }

  async refresh() {
    const counter = this.commandCounter;
    const sentAt = this.now();
    const body = await this.request('GET', '/state');
    const receivedAt = this.now();
    if (counter !== this.commandCounter) return; // 명령 전에 읽은 상태는 버린다
    const session = body && body.session;
    this.session = session || null;
    this.appName = session ? session.appName || '' : '';
    const track = mapSession(session, this.base);
    if (!track) {
      this.setStatus('noSession');
      this.setSnapshot(null, PlaybackTimeline.zero);
      return;
    }
    this.setStatus('ok');
    const playing = session.status === 'playing';
    const latency = Math.max(0, (receivedAt - sentAt) / 2);
    let timeline = new PlaybackTimeline(session.position + (playing ? latency : 0), receivedAt, playing, track.duration);
    const old = this.snapshot;
    // 같은 곡·같은 상태에서 조금 흔들린 위치는 예전 시간표를 그대로 쓴다 (알림은 매번 보낸다: 스토어가 상태를 따라잡는 데 쓴다)
    if (old.track && old.track.id === track.id && old.timeline.isPlaying === playing && old.timeline.duration === timeline.duration
      && Math.abs(old.timeline.positionAt(receivedAt) - timeline.position) < JITTER_SECONDS) timeline = old.timeline;
    this.setSnapshot(track, timeline);
  }

  // ---------- 조종 ----------

  async play() {
    await this.command('play', null, (tl, t) => new PlaybackTimeline(tl.positionAt(t), t, true, tl.duration));
  }

  async pause() {
    await this.command('pause', null, (tl, t) => tl.pausedAt(t));
  }

  async seek(seconds) {
    if (this.session && this.session.canSeek === false) {
      throw new ProviderError('seekFailed', '지금 재생 중인 앱은 위치 옮기기를 받지 않아요.', 'canSeek false');
    }
    const target = Math.max(0, seconds);
    await this.command('seek', { position: target.toFixed(3) }, (tl, t) => new PlaybackTimeline(target, t, tl.isPlaying, tl.duration));
  }

  /** 다음/이전 곡으로 넘기고, 새 곡 정보가 들어올 때까지(최대 약 3초) 기다린다. */
  async skip(offset) {
    const oldId = this.snapshot.track ? this.snapshot.track.id : null;
    const action = offset > 0 ? 'next' : 'previous';
    for (let i = 0; i < Math.max(1, Math.abs(offset)); i++) await this.command(action, null, null);
    for (let attempt = 0; attempt < 8; attempt++) {
      await this.sleep(0.4);
      await this.refresh().catch(() => {});
      const current = this.snapshot.track ? this.snapshot.track.id : null;
      if (current !== oldId) return;
      if (offset < 0 && this.snapshot.timeline.position < 1.5) return; // 같은 곡을 처음부터 다시 트는 경우
    }
  }

  async command(action, query, optimistic) {
    this.commandCounter += 1;
    const body = await this.request('POST', `/${action}`, query);
    this.commandCounter += 1;
    if (!body || !body.ok) {
      throw new ProviderError(action === 'seek' ? 'seekFailed' : 'restricted', '재생 중인 앱이 이 조작을 받지 않았어요.', action);
    }
    if (optimistic) this.setSnapshot(this.snapshot.track, optimistic(this.snapshot.timeline, this.now()));
    this.schedulePoll(0.6);
  }

  // ---------- 저수준 ----------

  async request(method, path, query) {
    const url = new URL(path, this.base);
    if (query) for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
    const options = { method, cache: 'no-store' };
    if (method === 'POST') options.headers = { 'X-TurnTable': '1' }; // 도우미가 다른 사이트의 요청을 걸러 내는 표시
    if (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) options.signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    let response;
    try {
      response = await this.fetchFn(url.toString(), options);
    } catch (error) {
      throw new ProviderError('offline', 'PC 도우미가 꺼져 있어요. pc-helper 폴더의 start.cmd를 실행해 주세요.', String(error));
    }
    let body = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    if (!response.ok) throw new ProviderError('unknown', 'PC 도우미와 통신하지 못했어요.', `${response.status} ${(body && body.error) || ''}`);
    return body;
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
