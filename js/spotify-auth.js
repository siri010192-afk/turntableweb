// Spotify 로그인: Authorization Code + PKCE (클라이언트 시크릿 없이 브라우저에서 안전하게).
// 토큰은 이 기기 브라우저 저장소(localStorage)에만 둔다.

import { ProviderError } from './mock-provider.js?v=202610311722';

const AUTHORIZE_URL = 'https://accounts.spotify.com/authorize';
const TOKEN_URL = 'https://accounts.spotify.com/api/token';
const TOKENS_KEY = 'tt.spotify.tokens';
const PKCE_KEY = 'tt.spotify.pkce';

export const SPOTIFY_SCOPES = [
  'user-read-playback-state',
  'user-modify-playback-state',
  'user-read-currently-playing',
  'user-read-recently-played',
  'playlist-read-private',
];

/** localStorage가 막혀 있어도(사생활 보호 모드 등) 앱이 죽지 않게 감싼다. */
export function safeStorage(backing = globalThis.localStorage) {
  const memory = new Map();
  return {
    getItem(key) {
      try { return backing ? backing.getItem(key) : memory.get(key) ?? null; } catch { return memory.get(key) ?? null; }
    },
    setItem(key, value) {
      memory.set(key, value);
      try { if (backing) backing.setItem(key, value); } catch { /* 메모리에만 둔다 */ }
    },
    removeItem(key) {
      memory.delete(key);
      try { if (backing) backing.removeItem(key); } catch { /* 무시 */ }
    },
  };
}

function base64Url(bytes) {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function randomString(byteCount) {
  const bytes = new Uint8Array(byteCount);
  crypto.getRandomValues(bytes);
  return base64Url(bytes);
}

async function sha256Base64Url(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return base64Url(new Uint8Array(digest));
}

export class SpotifyAuth {
  constructor({ clientId, redirectUri, storage = safeStorage(), fetchFn = (...a) => fetch(...a), now = () => Date.now() }) {
    this.clientId = clientId;
    this.redirectUri = redirectUri;
    this.storage = storage;
    this.fetchFn = fetchFn;
    this.now = now;
    this.refreshing = null;
    this.tokens = this.readJSON(TOKENS_KEY);
  }

  get isConfigured() { return Boolean(this.clientId); }
  get isLoggedIn() { return Boolean(this.tokens && this.tokens.refreshToken); }

  /** 로그인 페이지 주소를 만든다. 호출한 쪽이 그 주소로 이동한다. */
  async loginURL(scopes = SPOTIFY_SCOPES) {
    const verifier = randomString(64);
    const state = randomString(16);
    this.storage.setItem(PKCE_KEY, JSON.stringify({ verifier, state }));
    const url = new URL(AUTHORIZE_URL);
    url.search = new URLSearchParams({
      response_type: 'code',
      client_id: this.clientId,
      scope: scopes.join(' '),
      redirect_uri: this.redirectUri,
      state,
      code_challenge_method: 'S256',
      code_challenge: await sha256Base64Url(verifier),
    }).toString();
    return url.toString();
  }

  /** 로그인 후 돌아온 주소를 처리한다. 처리할 것이 없으면 false. */
  async completeLogin(currentURL) {
    const params = new URL(currentURL).searchParams;
    const error = params.get('error');
    const code = params.get('code');
    if (!error && !code) return false;
    const pkce = this.readJSON(PKCE_KEY);
    this.storage.removeItem(PKCE_KEY);
    if (error) {
      throw new ProviderError('auth', error === 'access_denied' ? 'Spotify 연결을 취소했어요.' : 'Spotify 로그인에 실패했어요. 다시 시도해 주세요.', error);
    }
    if (!pkce || pkce.state !== params.get('state')) {
      throw new ProviderError('auth', 'Spotify 로그인 확인에 실패했어요. 다시 연결해 주세요.', 'state mismatch');
    }
    const body = await this.tokenRequest({
      grant_type: 'authorization_code',
      code,
      redirect_uri: this.redirectUri,
      client_id: this.clientId,
      code_verifier: pkce.verifier,
    });
    this.saveTokens(body);
    return true;
  }

  /** 만료 1분 전이면 미리 갱신한 뒤 토큰을 준다. */
  async accessToken() {
    if (!this.isLoggedIn) throw new ProviderError('auth', 'Spotify에 연결해 주세요.');
    if (this.now() > this.tokens.expiresAt - 60_000) await this.refresh();
    return this.tokens.accessToken;
  }

  async refresh() {
    if (!this.isLoggedIn) throw new ProviderError('auth', 'Spotify에 연결해 주세요.');
    if (!this.refreshing) {
      this.refreshing = this.tokenRequest({
        grant_type: 'refresh_token',
        refresh_token: this.tokens.refreshToken,
        client_id: this.clientId,
      })
        .then((body) => this.saveTokens(body))
        .finally(() => { this.refreshing = null; });
    }
    return this.refreshing;
  }

  logout() {
    this.tokens = null;
    this.storage.removeItem(TOKENS_KEY);
  }

  async tokenRequest(fields) {
    let response;
    try {
      response = await this.fetchFn(TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(fields).toString(),
      });
    } catch (error) {
      throw new ProviderError('network', '인터넷 연결을 확인해 주세요.', String(error));
    }
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      if (body.error === 'invalid_grant') {
        this.logout();
        throw new ProviderError('auth', 'Spotify 연결이 만료됐어요. 다시 연결해 주세요.', body.error);
      }
      throw new ProviderError('auth', 'Spotify 로그인에 실패했어요. 다시 시도해 주세요.', body.error || response.status);
    }
    return body;
  }

  saveTokens(body) {
    this.tokens = {
      accessToken: body.access_token,
      // 갱신 응답에 새 refresh_token이 없으면 기존 것을 계속 쓴다.
      refreshToken: body.refresh_token || (this.tokens && this.tokens.refreshToken),
      expiresAt: this.now() + (Number(body.expires_in) || 3600) * 1000,
    };
    this.storage.setItem(TOKENS_KEY, JSON.stringify(this.tokens));
  }

  readJSON(key) {
    try { return JSON.parse(this.storage.getItem(key) || 'null'); } catch { return null; }
  }
}
