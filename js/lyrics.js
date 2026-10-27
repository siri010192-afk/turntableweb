// 시간이 맞춰진 가사 (설정에서 켤 때만). Spotify Web API에는 가사가 없어서 공개 가사 DB LRCLIB(lrclib.net)에서 받는다.
// 키가 필요 없고 CORS가 열려 있다. 보내는 정보는 곡 제목·가수·앨범·길이뿐.
// LRCLIB에 없는 곡(특히 국내 곡 일부)은 "가사를 찾지 못했어요"로 끝난다.

const LRCLIB = 'https://lrclib.net/api';

/**
 * LRC 본문 → [{ time(초), text }] (시간순). 한 줄에 시간표가 여러 개면 각각 한 줄로 펼친다.
 * 빈 가사 줄(간주)은 text가 ''이다.
 */
export function parseLrc(source) {
  const lines = [];
  for (const raw of String(source || '').split(/\r?\n/)) {
    const stamps = [...raw.matchAll(/\[(\d+):(\d+(?:\.\d+)?)\]/g)];
    if (!stamps.length) continue;
    const text = raw.replace(/\[[^\]]*\]/g, '').trim();
    for (const m of stamps) lines.push({ time: Number(m[1]) * 60 + Number(m[2]), text });
  }
  lines.sort((a, b) => a.time - b.time);
  // 연달아 오는 빈 줄은 하나로
  return lines.filter((line, i) => line.text || i === 0 || lines[i - 1].text);
}

/** 재생 위치에서 지금 부르는 줄 (첫 줄 전이면 -1). */
export function lineIndexAt(lines, position) {
  if (!lines.length || position == null || position < lines[0].time) return -1;
  let lo = 0;
  let hi = lines.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (lines[mid].time <= position) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/**
 * 결과: { status, lines }
 * - 'synced'       시간 맞춘 가사 (lines)
 * - 'plain'        가사는 있지만 시간이 없음
 * - 'instrumental' 연주곡
 * - 'none'         찾지 못함
 * - 'error'        네트워크 등 (다음에 다시 시도)
 */
export class LyricsService {
  constructor({ fetchImpl = (...args) => fetch(...args) } = {}) {
    this.fetchImpl = fetchImpl;
    this.cache = new Map(); // track id → Promise<결과>
  }

  load(track) {
    if (!track) return Promise.resolve({ status: 'none', lines: [] });
    if (track.lyrics) return Promise.resolve(toResult(track.lyrics)); // 데모 곡
    const cached = this.cache.get(track.id);
    if (cached) return cached;
    const promise = this.fetchFor(track).catch(() => ({ status: 'error', lines: [] }));
    this.cache.set(track.id, promise);
    promise.then((result) => {
      if (result.status === 'error') this.cache.delete(track.id); // 실패는 다음에 다시
    });
    return promise;
  }

  async fetchFor(track) {
    const artist = firstArtist(track.artist);
    const duration = Math.round(track.duration || 0);
    // 1) 정확히 맞는 곡 (LRCLIB가 길이 ±2초까지 맞춰 준다)
    if (track.album && duration > 0) {
      const params = new URLSearchParams({ track_name: track.title, artist_name: artist, album_name: track.album, duration: String(duration) });
      const response = await this.fetchImpl(`${LRCLIB}/get?${params}`);
      if (response.ok) {
        const result = toResult(await response.json());
        if (result.status !== 'none') return result;
      } else if (response.status !== 404) {
        throw new Error(`lrclib ${response.status}`);
      }
    }
    // 2) 제목·가수로 찾아서 길이가 가장 가까운 것 (시간 맞춘 가사 우선)
    const params = new URLSearchParams({ track_name: track.title, artist_name: artist });
    const response = await this.fetchImpl(`${LRCLIB}/search?${params}`);
    if (!response.ok) throw new Error(`lrclib ${response.status}`);
    const items = await response.json();
    return toResult(pickClosest(Array.isArray(items) ? items : [], duration));
  }
}

function firstArtist(artist) {
  return String(artist || '').split(', ')[0];
}

function pickClosest(items, duration) {
  const near = (item) => !duration || !item.duration || Math.abs(item.duration - duration) <= 8;
  const score = (item) => (duration && item.duration ? Math.abs(item.duration - duration) : 0);
  const candidates = items.filter(near).sort((a, b) => score(a) - score(b));
  return candidates.find((item) => item.syncedLyrics) || candidates.find((item) => item.instrumental || item.plainLyrics) || null;
}

function toResult(item) {
  if (!item) return { status: 'none', lines: [] };
  if (item.instrumental) return { status: 'instrumental', lines: [] };
  const lines = parseLrc(item.syncedLyrics);
  if (lines.some((line) => line.text)) return { status: 'synced', lines };
  if (item.plainLyrics) return { status: 'plain', lines: [] };
  return { status: 'none', lines: [] };
}

/** 데모 곡용 가사 (직접 지은 문장). 곡 길이 동안 줄을 고르게 돌린다. */
export function demoLyrics(duration, seed = 0) {
  const verses = [
    '아무도 없는 새벽 주파수에',
    '낡은 노래 한 곡이 흘러나와',
    '바늘이 지나간 자리마다',
    '작은 별들이 반짝거려',
    '',
    '천천히 돌아, 천천히 돌아',
    '오늘의 끝을 한 바퀴 더',
    '창밖의 불빛이 하나둘 꺼지면',
    '우리 이야기는 B면으로 넘어가',
    '',
    '먼지 앉은 재킷을 열면',
    '그때의 계절이 쏟아져 나와',
    '같은 홈을 몇 번이고 지나도',
    '처음처럼 설레는 이 소리',
  ];
  const step = 7;
  const lines = [];
  for (let t = 6, i = seed; t < duration - 4; t += step, i += 1) {
    lines.push(`[${String(Math.floor(t / 60)).padStart(2, '0')}:${(t % 60).toFixed(2).padStart(5, '0')}]${verses[i % verses.length]}`);
  }
  return { syncedLyrics: lines.join('\n') };
}
