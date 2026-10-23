// 실제 서비스 없이 재생을 흉내 내는 프로바이더 (데모 모드, 테스트). Swift `MockMusicProvider`와 같은 동작.
// 프로바이더 공통 형태: snapshot { track, timeline }, subscribe(fn) → 해제 함수, play/pause/seek/skip (Promise).

import { PlaybackTimeline } from './motion.js?v=202610231146';

export class ProviderError extends Error {
  constructor(code, userMessage, detail) {
    super(`${code}: ${userMessage}`);
    this.code = code;
    this.userMessage = userMessage;
    this.detail = detail;
  }
}

export const SAMPLE_TRACKS = [
  { id: 'mock-1', title: '새벽 세 시의 라디오', artist: '가상의 밴드', album: 'Side A', duration: 214, artworkURL: null,
    palette: { base: '#D9643A', band: '#F3D9B1', ink: '#2A140B', backgroundTint: '#2B1A12' } },
  { id: 'mock-2', title: 'Slow Orbit', artist: 'Mock Ensemble', album: 'Demo Pressing', duration: 187, artworkURL: null,
    palette: { base: '#3A6FD9', band: '#D6E4F5', ink: '#0D1A33', backgroundTint: '#141C2C' } },
  { id: 'mock-3', title: 'Linen Waltz', artist: 'Placeholder Trio', album: 'Test Lacquer', duration: 245, artworkURL: null,
    palette: { base: '#4F9A66', band: '#E6EFD2', ink: '#0F2416', backgroundTint: '#13221A' } },
];

export class MockProvider {
  constructor({ tracks = SAMPLE_TRACKS, now = () => performance.now() / 1000, seekLatency = 0.15 } = {}) {
    this.kind = 'mock';
    this.tracks = tracks;
    this.now = now;
    this.seekLatency = seekLatency;
    this.failSeeks = false;
    this.seekCallCount = 0;
    this.index = 0;
    this.listeners = new Set();
    this.endTimer = null;
    const first = tracks[0] || null;
    this.snapshot = { track: first, timeline: new PlaybackTimeline(0, now(), false, first ? first.duration : 0) };
  }

  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  async play() {
    if (this.snapshot.timeline.isPlaying) return;
    const t = this.now();
    const tl = this.snapshot.timeline;
    this.setTimeline(new PlaybackTimeline(tl.positionAt(t), t, true, tl.duration));
    this.startEndWatcher();
  }

  async pause() {
    this.pauseCallCount = (this.pauseCallCount || 0) + 1;
    if (!this.snapshot.timeline.isPlaying) return;
    this.stopEndWatcher();
    this.setTimeline(this.snapshot.timeline.pausedAt(this.now()));
  }

  async seek(seconds) {
    this.seekCallCount += 1;
    if (this.seekLatency > 0) await new Promise((r) => setTimeout(r, this.seekLatency * 1000));
    if (this.failSeeks) throw new ProviderError('seekFailed', '위치를 옮기지 못했어요. 이전 위치로 돌아갑니다.');
    const tl = this.snapshot.timeline;
    const target = tl.duration > 0 ? Math.min(Math.max(seconds, 0), tl.duration) : Math.max(seconds, 0);
    this.setTimeline(new PlaybackTimeline(target, this.now(), tl.isPlaying, tl.duration));
  }

  /** Spotify처럼 넘기면 바로 새 곡을 재생한다. */
  async skip(offset) {
    if (!this.tracks.length) return;
    const n = this.tracks.length;
    this.index = (((this.index + offset) % n) + n) % n;
    this.load(this.index, true);
    this.startEndWatcher();
  }

  /** 곡 끝을 지났으면 실제 서비스처럼 다음 곡으로. 마지막 곡이면 끝에서 멈춘다. */
  checkForTrackEnd() {
    const tl = this.snapshot.timeline;
    if (!tl.isPlaying || !(tl.duration > 0) || tl.positionAt(this.now()) < tl.duration) return;
    if (this.index < this.tracks.length - 1) {
      this.index += 1;
      this.load(this.index, true);
    } else {
      this.stopEndWatcher();
      this.setTimeline(new PlaybackTimeline(tl.duration, this.now(), false, tl.duration));
    }
  }

  load(index, playing) {
    const track = this.tracks[index];
    this.snapshot = { track, timeline: new PlaybackTimeline(0, this.now(), playing, track.duration) };
    this.publish();
  }

  setTimeline(timeline) {
    this.snapshot = { track: this.snapshot.track, timeline };
    this.publish();
  }

  publish() {
    for (const fn of this.listeners) fn(this.snapshot);
  }

  startEndWatcher() {
    this.stopEndWatcher();
    this.endTimer = setInterval(() => this.checkForTrackEnd(), 250);
  }

  stopEndWatcher() {
    clearInterval(this.endTimer);
    this.endTimer = null;
  }
}
