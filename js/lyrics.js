// 시간이 맞춰진 가사 (설정에서 켤 때만). Spotify Web API에는 가사가 없어서 공개 가사 DB LRCLIB(lrclib.net)에서 받는다.
// 키가 필요 없고 CORS가 열려 있다 (단 서버 장애 때 Cloudflare 502에는 CORS 헤더가 없어 브라우저에선 fetch 실패로 보인다).
// 없거나 실패하면 LyricsPlus(비공식 공개 서버, 키 없음, CORS 허용, 시간 맞춘 가사, 요청이 몰리면 429),
// 그래도 없으면 lyrics.ovh(키 없음, CORS 허용, 시간 정보 없음)를 쓴다.
// 보내는 정보는 곡 제목·가수·앨범·길이뿐.
// LRCLIB에 없는 곡(특히 국내 곡 일부)은 "가사를 찾지 못했어요"로 끝난다.

const LRCLIB = 'https://lrclib.net/api';
const LYRICS_PLUS = 'https://lyricsplus.binimum.org/v2/lyrics/get';
const LYRICS_OVH = 'https://api.lyrics.ovh/v1';
const REQUEST_TIMEOUT_MS = 10000;
const BREAK_MIN_SECONDS = 5; // 이보다 짧은 틈은 간주로 치지 않는다

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
 * 가사 없는 구간(전주·간주·후주)을 { time, text: '', end } 줄로 넣는다. 줄 끝을 모르면 글자 수로 어림한다.
 * LRC의 빈 줄은 앞 줄이 끝난 시각으로만 쓰고, 짧은 틈은 앞 줄을 그대로 둔다.
 */
export function withBreaks(lines, duration) {
  const sung = [];
  for (const line of lines) {
    if (line.text) sung.push({ ...line });
    else if (sung.length) sung[sung.length - 1].end = line.time;
  }
  const result = [];
  let from = 0; // 앞 줄이 끝난 시각
  const addBreak = (until) => {
    if (until - from >= BREAK_MIN_SECONDS) result.push({ time: from, text: '', end: until });
  };
  for (const line of sung) {
    addBreak(line.time);
    result.push(line);
    from = Math.max(from, line.end ?? line.time + estimatedLineSeconds(line.text));
  }
  if (sung.length && duration > 0) addBreak(duration);
  return result;
}

function estimatedLineSeconds(text) {
  return Math.min(8, Math.max(3, text.length * 0.45));
}

/**
 * 결과: { status, lines }
 * - 'synced'       시간 맞춘 가사 (lines)
 * - 'plain'        가사는 있지만 시간이 없음 (lines는 곡 길이에 고르게 나눈 어림 시간. 진행에 따라 흘려 보여 주기만 한다)
 * - 'instrumental' 연주곡
 * - 'none'         찾지 못함
 * - 'error'        네트워크 등 (다음에 다시 시도)
 * retry: true면 LRCLIB가 실패해 예비 가사를 준 것이다. 다음에 시간 맞춘 가사를 다시 찾는다.
 */
export class LyricsService {
  /** alternateNames(track) → { title, artist, album } | null: 처음 이름으로 못 찾을 때 한 번 더 찾아 볼 표기 */
  constructor({ fetchImpl = (...args) => fetch(...args), alternateNames = null } = {}) {
    this.fetchImpl = fetchImpl;
    this.alternateNames = alternateNames;
    this.cache = new Map(); // track id → Promise<결과>
    this.alternates = new Map(); // track id → Promise<표기> (다시 시도할 때 또 묻지 않게)
  }

  load(track) {
    if (!track) return Promise.resolve({ status: 'none', lines: [] });
    if (track.lyrics) return Promise.resolve(toResult(track.lyrics, track.duration)); // 데모 곡
    const cached = this.cache.get(track.id);
    if (cached) return cached;
    const promise = this.fetchFor(track).catch(() => ({ status: 'error', lines: [] }));
    this.cache.set(track.id, promise);
    promise.then((result) => {
      if (result.status === 'error' || result.retry) this.cache.delete(track.id); // 실패는 다음에 다시
    });
    return promise;
  }

  async fetchFor(track) {
    let plain = null;
    let failed = false;
    // 시간 맞춘 가사 찾기: LRCLIB → LyricsPlus. 일시적 실패는 기억했다가 나중에 다시 시도한다.
    const findSynced = async (names) => {
      try {
        const result = await this.fetchLrclib(names);
        if (result.status === 'synced' || result.status === 'instrumental') return result;
        if (result.status === 'plain' && !plain) plain = result;
      } catch {
        failed = true;
      }
      try {
        return await this.fetchLyricsPlus(names);
      } catch {
        failed = true;
        return null;
      }
    };
    const found = await findSynced(track);
    if (found) return found;
    const alternate = await this.alternateFor(track);
    if (alternate) {
      const foundByAlternate = await findSynced({ ...track, ...alternate });
      if (foundByAlternate) return foundByAlternate;
    }
    if (plain) return { ...plain, retry: failed };
    const backup = await this.fetchLyricsOvh(alternate ? { ...track, ...alternate } : track).catch(() => null)
      || (alternate ? await this.fetchLyricsOvh(track).catch(() => null) : null);
    if (backup) return { ...backup, retry: failed };
    if (failed) throw new Error('lyrics unavailable');
    return { status: 'none', lines: [] };
  }

  /** 처음 이름과 다른 표기가 있을 때만 돌려준다. 물어보지 못해도 가사 찾기는 계속한다. */
  alternateFor(track) {
    if (!this.alternateNames) return Promise.resolve(null);
    if (!this.alternates.has(track.id)) {
      const lookup = Promise.resolve()
        .then(() => this.alternateNames(track))
        .then((names) => (names && (names.title !== track.title || firstArtist(names.artist) !== firstArtist(track.artist)) ? names : null))
        .catch(() => null);
      this.alternates.set(track.id, lookup);
    }
    return this.alternates.get(track.id);
  }

  request(url) {
    const options = typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) } : {};
    return this.fetchImpl(url, options);
  }

  async fetchLyricsPlus(track) {
    const params = new URLSearchParams({ title: baseTitle(track.title), artist: firstArtist(track.artist) });
    if (track.album) params.set('album', track.album);
    if (track.duration > 0) params.set('duration', String(Math.round(track.duration)));
    const response = await this.request(`${LYRICS_PLUS}?${params}`);
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`lyricsplus ${response.status}`); // 429(요청 많음) 등은 "없음"이 아니다
    const body = await response.json();
    const lines = (Array.isArray(body.lyrics) ? body.lyrics : [])
      .filter((line) => Number.isFinite(line.time) && line.text)
      .map((line) => ({
        time: line.time / 1000,
        text: String(line.text).trim(),
        ...(line.duration > 0 ? { end: (line.time + line.duration) / 1000 } : {}),
      }))
      .sort((a, b) => a.time - b.time);
    return lines.length ? { status: 'synced', lines: withBreaks(lines, track.duration) } : null;
  }

  async fetchLyricsOvh(track) {
    const url = `${LYRICS_OVH}/${encodeURIComponent(firstArtist(track.artist))}/${encodeURIComponent(baseTitle(track.title))}`;
    const response = await this.request(url);
    if (!response.ok) return null;
    const body = await response.json();
    const result = plainResult(body.lyrics, track.duration);
    return result.status === 'plain' ? result : null;
  }

  async fetchLrclib(track) {
    const artist = firstArtist(track.artist);
    const duration = Math.round(track.duration || 0);
    // 1) 정확히 맞는 곡 (LRCLIB가 길이 ±2초까지 맞춰 준다)
    if (track.album && duration > 0) {
      const params = new URLSearchParams({ track_name: track.title, artist_name: artist, album_name: track.album, duration: String(duration) });
      const response = await this.request(`${LRCLIB}/get?${params}`);
      if (response.ok) {
        const result = toResult(await response.json(), track.duration);
        if (result.status !== 'none') return result;
      } else if (response.status !== 404) {
        throw new Error(`lrclib ${response.status}`);
      }
    }
    // 2) 제목·가수로 찾아서 길이가 가장 가까운 것 (시간 맞춘 가사 우선)
    const params = new URLSearchParams({ track_name: track.title, artist_name: artist });
    const response = await this.request(`${LRCLIB}/search?${params}`);
    if (!response.ok) throw new Error(`lrclib ${response.status}`);
    const items = await response.json();
    return toResult(pickClosest(Array.isArray(items) ? items : [], duration), track.duration);
  }
}

function firstArtist(artist) {
  return String(artist || '').split(', ')[0];
}

/** "곡 (feat. X)"·"곡 - Remastered 2011" → "곡" */
function baseTitle(title) {
  const text = String(title || '');
  return text.replace(/\s*[([].*$/, '').replace(/\s+-\s+.*$/, '').trim() || text;
}

/** 시간 없는 가사 → 곡 길이에 고르게 나눈 줄. 머리말·크레딧·[파트 이름] 줄은 뺀다. */
function plainResult(text, duration) {
  const rows = String(text || '').split(/\r?\n/).map((row) => row.trim());
  const credit = /^(lyrics by|composed by|arranged by|produced by|paroles de la chanson|작사|작곡|편곡)\b|^\[.*\]$/i;
  const kept = rows.filter((row, i) => row && !credit.test(row) && !(i === 0 && / - /.test(row) && rows[1] && credit.test(rows[1])));
  if (!kept.length) return { status: 'none', lines: [] };
  const seconds = duration > 0 ? duration : 0;
  return { status: 'plain', lines: seconds ? kept.map((line, i) => ({ time: (seconds * i) / kept.length, text: line })) : [] };
}

function pickClosest(items, duration) {
  const near = (item) => !duration || !item.duration || Math.abs(item.duration - duration) <= 8;
  const score = (item) => (duration && item.duration ? Math.abs(item.duration - duration) : 0);
  const candidates = items.filter(near).sort((a, b) => score(a) - score(b));
  return candidates.find((item) => item.syncedLyrics) || candidates.find((item) => item.instrumental || item.plainLyrics) || null;
}

function toResult(item, duration) {
  if (!item) return { status: 'none', lines: [] };
  if (item.instrumental) return { status: 'instrumental', lines: [] };
  const lines = parseLrc(item.syncedLyrics);
  if (lines.some((line) => line.text)) return { status: 'synced', lines: withBreaks(lines, duration) };
  if (item.plainLyrics) return plainResult(item.plainLyrics, duration);
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
