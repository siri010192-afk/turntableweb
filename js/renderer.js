// 턴테이블 캔버스 렌더러. 캔버스가 화면 전체를 채우고, 상태는 PlayerStore.frame(t)에서 읽어 그리기만 한다.
// 레이어(아래→위): 배경(흐린 커버/그라데이션 + 노이즈) → 디스크 그림자 → 디스크·그루브·먼지(회전)
// → 라벨(회전) → 정반사 하이라이트(고정) → 스핀들 → 톤암 → 미리보기 시간. 가로에서는 앨범 재킷을 디스크보다 먼저 그려 LP가 위로 겹친다.

import { TimeText, TonearmRig, VinylGrooves } from './motion.js';

/**
 * 화면 크기에 맞춘 배치. 글자·버튼(HUD)은 HTML로 위에 겹치므로 그만큼 비워 둔다.
 * - 세로: LP가 폭을 거의 채운다 (왼쪽이 화면 밖으로 살짝 나감). 톤암 받침은 오른쪽 끝에 걸쳐도 된다.
 * - 가로: 왼쪽에 앨범 재킷, LP가 재킷 오른쪽 위로 올라와 겹친다.
 * - 작은 창(compact, PiP): 어떤 비율이든 아래쪽에 제목·가수 두 줄 자리를 비운다. 가로로 길면 재킷 + LP,
 *   아니면 LP만. 재생 버튼은 글자 위에 떠서 나타나므로 자리를 차지하지 않는다.
 * 반환 단위는 CSS 픽셀. maxRight/maxUp은 톤암 피벗 맞춤용 (×R).
 */
export const COMPACT_TEXT_AREA = 58; // 작은 창 아래쪽 제목·가수 자리 (styles.css의 .app.pip .hud와 맞춘다)

export function computeLayout(width, height, insets = { top: 0, bottom: 0, left: 0, right: 0 }, { compact = false } = {}) {
  if (compact) return computeCompactLayout(width, height);
  if (width > height) {
    // 제목·버튼은 오른쪽 아래(톤암 밑)에 두므로 재킷과 LP는 높이를 거의 다 쓴다.
    const top = insets.top + 14;
    const bottom = insets.bottom + 14;
    const avail = Math.max(1, height - top - bottom);
    const left = Math.max(16, insets.left) + 8;
    const sleeveSize = Math.min(avail, width * 0.36);
    const radius = sleeveSize * 0.5;
    const center = { x: left + sleeveSize + radius * 0.42, y: top + avail / 2 };
    return {
      mode: 'landscape',
      radius,
      center,
      sleeve: { x: left, y: center.y - sleeveSize / 2, size: sleeveSize },
      maxRight: (width - Math.max(16, insets.right) - center.x) / radius,
      maxUp: center.y / radius,
    };
  }
  const top = insets.top + 60; // 설정 버튼 줄
  const bottom = insets.bottom + 120; // 아래쪽 제목·버튼
  const avail = Math.max(1, height - top - bottom);
  const radius = Math.min(width * 0.44, avail * 0.48);
  const center = { x: width * 0.42, y: top + avail / 2 };
  return {
    mode: 'portrait',
    radius,
    center,
    sleeve: null,
    maxRight: (width - center.x) / radius + 0.15, // 톤암 받침이 오른쪽 끝에 살짝 걸쳐도 된다
    maxUp: (center.y - insets.top) / radius,
  };
}

function computeCompactLayout(width, height) {
  const top = 10;
  const gap = 8; // LP·재킷 아래 끝과 제목 사이
  const avail = Math.max(1, height - top - COMPACT_TEXT_AREA - gap);
  if (width > height * 1.25) {
    // 가로로 긴 작은 창: 재킷 + 그 위로 올라온 LP를 한 줄로, 글자는 아래
    const left = 12;
    const sleeveSize = Math.min(avail, width * 0.4);
    const radius = sleeveSize * 0.5;
    const center = { x: left + sleeveSize + radius * 0.42, y: top + avail / 2 };
    return {
      mode: 'landscape',
      radius,
      center,
      sleeve: { x: left, y: center.y - sleeveSize / 2, size: sleeveSize },
      maxRight: (width - 8 - center.x) / radius,
      maxUp: center.y / radius,
    };
  }
  // 세로·정사각형 작은 창: LP만 크게
  const radius = Math.min(width * 0.44, avail * 0.48);
  const center = { x: width * 0.42, y: top + avail / 2 };
  return {
    mode: 'portrait',
    radius,
    center,
    sleeve: null,
    maxRight: (width - center.x) / radius + 0.15,
    maxUp: center.y / radius,
  };
}

const TAU = Math.PI * 2;
const DEG = Math.PI / 180;
const COVER_FADE = 0.35;

export const RenderTokens = {
  backgroundEdge: '#0b0a09',
  vinylCenter: '#1c1b1a',
  vinylEdge: '#0b0b0b',
  labelSkeleton: '80,74,66',
  armBase: '#211f1c',
  armCounterweight: '#8e8880',
  armTubeLight: '#d8d4ce',
  armTubeDark: '#8f8a83',
  headshell: '#2b2825',
  accent: '#e0703f',
  pivotCap: '#b9b3ab',
  highlightStrength: 0.8,
};

function circle(ctx, x, y, r) {
  ctx.beginPath();
  ctx.arc(x, y, r, 0, TAU);
}

function mulberry(seed) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class TurntableRenderer {
  constructor(canvas, store, { now = () => performance.now() / 1000 } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.store = store;
    this.now = now;
    this.useCoverBackground = true;
    this.width = 0;
    this.height = 0;
    this.dpr = 1;
    this.radius = 0;
    this.center = { x: 0, y: 0 };
    this.mode = 'portrait';
    this.sleeve = null;
    /** 이 화면 배치에 맞춘 톤암 (각도↔시간 대응은 store.rig.geometry와 같다) */
    this.rig = store.rig;
    this.rigKey = '';
    this.grooveCanvas = document.createElement('canvas');
    this.noisePattern = null;
    this.covers = new Map(); // artworkURL → { img, loadedAt, label, background, failed }
    this.placeholders = new Map(); // track id → label canvas
  }

  // ---------- 배치 ----------

  /** 크기가 바뀌었을 때 호출. 아직 크기가 없으면 false. */
  layout() {
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    if (!w || !h) return false;
    this.dpr = Math.min(window.devicePixelRatio || 1, 3);
    this.canvas.width = Math.round(w * this.dpr);
    this.canvas.height = Math.round(h * this.dpr);
    this.width = w;
    this.height = h;
    // PiP 창(다른 문서)으로 옮겨진 경우: 설정 버튼이 없으니 위아래 여백을 줄여 LP를 키운다
    const compact = this.canvas.ownerDocument !== document;
    const layout = computeLayout(w, h, compact ? { top: 0, bottom: 0, left: 0, right: 0 } : readSafeAreaInsets(), { compact });
    this.mode = layout.mode;
    this.radius = layout.radius;
    this.center = layout.center;
    this.sleeve = layout.sleeve;
    // 피벗 맞춤은 계산이 조금 들어서 비율이 바뀔 때만 다시 한다
    const key = `${layout.maxRight.toFixed(2)}/${layout.maxUp.toFixed(2)}`;
    if (key !== this.rigKey) {
      const base = this.store.rig;
      this.rig = new TonearmRig({
        geometry: base.geometry,
        armLength: base.armLength,
        outerGroove: base.outerGroove,
        innerGroove: base.innerGroove,
        labelRadius: base.labelRadius,
        maxRight: layout.maxRight,
        maxUp: layout.maxUp,
      });
      this.rigKey = key;
    }
    this.buildNoise();
    this.buildGrooves();
    // 크기에 따라 다시 만들어야 하는 캐시
    for (const entry of this.covers.values()) {
      entry.label = null;
      entry.background = null;
    }
    this.placeholders.clear();
    return true;
  }

  point(v) {
    return { x: this.center.x + v.x * this.radius, y: this.center.y + v.y * this.radius };
  }

  vector(p) {
    return { x: (p.x - this.center.x) / this.radius, y: (p.y - this.center.y) / this.radius };
  }

  // ---------- 히트 테스트 ----------

  /** 바늘 쪽 머리 근처만 잡힌다 (최소 44pt 터치 영역). */
  hitsArm(p, armAngle) {
    const rig = this.rig;
    const needle = this.point(rig.needleAt(armAngle));
    const pivot = this.point(rig.pivot);
    const middle = { x: (pivot.x + needle.x) / 2, y: (pivot.y + needle.y) / 2 };
    const headRadius = Math.max(28, this.radius * 0.14);
    return Math.hypot(p.x - needle.x, p.y - needle.y) < headRadius || distanceToSegment(p, middle, needle) < 18;
  }

  hitsLabel(p) {
    return Math.hypot(p.x - this.center.x, p.y - this.center.y) < this.radius * this.store.rig.labelRadius;
  }

  fingerAngle(p) {
    return this.rig.angleTowards(this.vector(p));
  }

  // ---------- 커버 이미지 ----------

  coverEntry(track) {
    if (!track || !track.artworkURL) return null;
    let entry = this.covers.get(track.artworkURL);
    if (!entry) {
      entry = { img: null, loadedAt: null, label: null, background: null, failed: false };
      this.covers.set(track.artworkURL, entry);
      this.loadCover(track.artworkURL, entry, true);
      // 메모리를 위해 최근 몇 장만 둔다
      if (this.covers.size > 6) this.covers.delete(this.covers.keys().next().value);
    }
    return entry;
  }

  loadCover(url, entry, withCORS) {
    const img = new Image();
    if (withCORS) img.crossOrigin = 'anonymous';
    img.decoding = 'async';
    img.onload = () => {
      entry.img = img;
      entry.loadedAt = this.now();
    };
    img.onerror = () => {
      // CORS 헤더가 없는 경우 CORS 없이 다시 (캔버스에 그리기만 하고 픽셀은 읽지 않으므로 괜찮다)
      if (withCORS) this.loadCover(url, entry, false);
      else entry.failed = true;
    };
    img.src = url;
  }

  coverLabel(entry, labelRadius) {
    if (!entry.label) {
      const size = Math.max(1, Math.ceil(2 * labelRadius * this.dpr));
      const c = document.createElement('canvas');
      c.width = c.height = size;
      const g = c.getContext('2d');
      const img = entry.img;
      const s = Math.min(img.naturalWidth, img.naturalHeight);
      g.beginPath();
      g.arc(size / 2, size / 2, size / 2, 0, TAU);
      g.clip();
      g.drawImage(img, (img.naturalWidth - s) / 2, (img.naturalHeight - s) / 2, s, s, 0, 0, size, size);
      g.strokeStyle = 'rgba(0,0,0,0.35)';
      g.lineWidth = this.dpr;
      g.beginPath();
      g.arc(size / 2, size / 2, size / 2 - this.dpr / 2, 0, TAU);
      g.stroke();
      entry.label = c;
    }
    return entry.label;
  }

  /** 커버를 아주 작게 줄였다가 키워 흐리게 만들고, 디스크가 돋보이도록 어둡게 덮는다. */
  coverBackground(entry) {
    if (!entry.background) {
      const tiny = document.createElement('canvas');
      tiny.width = tiny.height = 16;
      const img = entry.img;
      const s = Math.min(img.naturalWidth, img.naturalHeight);
      tiny.getContext('2d').drawImage(img, (img.naturalWidth - s) / 2, (img.naturalHeight - s) / 2, s, s, 0, 0, 16, 16);
      const c = document.createElement('canvas');
      c.width = this.canvas.width;
      c.height = this.canvas.height;
      const g = c.getContext('2d');
      g.imageSmoothingEnabled = true;
      g.imageSmoothingQuality = 'high';
      const side = Math.max(c.width, c.height) * 1.2;
      g.drawImage(tiny, (c.width - side) / 2, (c.height - side) / 2, side, side);
      const cx = this.center.x * this.dpr;
      const cy = this.center.y * this.dpr;
      const shade = g.createRadialGradient(cx, cy, 0, cx, cy, side * 0.6);
      shade.addColorStop(0, 'rgba(0,0,0,0.3)');
      shade.addColorStop(1, 'rgba(0,0,0,0.72)');
      g.fillStyle = shade;
      g.fillRect(0, 0, c.width, c.height);
      entry.background = c;
    }
    return entry.background;
  }

  placeholderLabel(track, labelRadius) {
    const key = track ? track.id : '_none';
    let c = this.placeholders.get(key);
    if (c) return c;
    const palette = (track && track.palette) || { base: '#D9643A', band: '#F3D9B1', ink: '#2A140B' };
    const size = Math.max(1, Math.ceil(2 * labelRadius * this.dpr));
    c = document.createElement('canvas');
    c.width = c.height = size;
    const g = c.getContext('2d');
    const lr = size / 2;
    g.fillStyle = palette.base;
    g.beginPath(); g.arc(lr, lr, lr, 0, TAU); g.fill();
    // 비대칭 띠: 회전이 읽히게 한다
    g.fillStyle = palette.band;
    g.beginPath();
    g.arc(lr, lr, lr * 0.8, -0.9, 0.9 + Math.PI * 0.35);
    g.arc(lr, lr, lr * 0.62, 0.9 + Math.PI * 0.35, -0.9, true);
    g.closePath(); g.fill();
    g.strokeStyle = 'rgba(0,0,0,0.25)';
    g.lineWidth = this.dpr;
    g.beginPath(); g.arc(lr, lr, lr * 0.95, 0, TAU); g.stroke();
    g.fillStyle = palette.ink;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.font = `700 ${lr * 0.2}px -apple-system, system-ui, sans-serif`;
    g.fillText('TurnTable', lr, lr - lr * 0.4);
    g.font = `500 ${lr * 0.12}px -apple-system, system-ui, sans-serif`;
    if (track) g.fillText(track.title, lr, lr + lr * 0.42, lr * 1.3);
    g.fillText('33⅓', lr, lr + lr * 0.66);
    this.placeholders.set(key, c);
    return c;
  }

  // ---------- 정적 레이어 ----------

  buildNoise() {
    const n = document.createElement('canvas');
    n.width = n.height = 96;
    const g = n.getContext('2d');
    const img = g.createImageData(96, 96);
    const rand = mulberry(42);
    for (let i = 0; i < img.data.length; i += 4) {
      const v = rand() * 255;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
      img.data[i + 3] = 255;
    }
    g.putImageData(img, 0, 0);
    this.noisePattern = this.ctx.createPattern(n, 'repeat');
  }

  buildGrooves() {
    const R = this.radius;
    const size = Math.max(1, Math.ceil(2 * R * this.dpr));
    const c = this.grooveCanvas;
    c.width = c.height = size;
    const g = c.getContext('2d');
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    const base = g.createRadialGradient(R, R, 0, R, R, R);
    base.addColorStop(0, RenderTokens.vinylCenter);
    base.addColorStop(1, RenderTokens.vinylEdge);
    g.fillStyle = base;
    g.beginPath(); g.arc(R, R, R, 0, TAU); g.fill();
    const grooves = VinylGrooves.standard;
    g.lineWidth = 0.6;
    for (const ring of grooves.rings) {
      g.strokeStyle = ring.isLight ? `rgba(255,255,255,${ring.opacity})` : `rgba(0,0,0,${ring.opacity})`;
      g.beginPath(); g.arc(R, R, ring.radius * R, 0, TAU); g.stroke();
    }
    g.lineWidth = 2.4;
    g.strokeStyle = 'rgba(0,0,0,0.6)';
    for (const gap of grooves.gaps) {
      g.beginPath(); g.arc(R, R, gap * R, 0, TAU); g.stroke();
    }
    g.lineWidth = 1.5;
    g.strokeStyle = 'rgba(255,255,255,0.08)';
    g.beginPath(); g.arc(R, R, R - 1.5, 0, TAU); g.stroke();
    // 먼지: 회전이 눈에 보이게 하는 비대칭 단서
    for (const speck of grooves.specks) {
      g.fillStyle = `rgba(255,255,255,${speck.opacity})`;
      g.fillRect(R + Math.cos(speck.angle) * speck.radius * R, R + Math.sin(speck.angle) * speck.radius * R, 1.2, 1.2);
    }
  }

  // ---------- 그리기 ----------

  draw(t) {
    if (!this.width) return;
    const { ctx, store } = this;
    const R = this.radius;
    const track = store.displayedTrack;
    const frame = store.frame(t);
    const entry = this.coverEntry(track);
    const coverReady = Boolean(entry && entry.img);
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.width, this.height);

    // 1. 배경
    if (coverReady && this.useCoverBackground) {
      ctx.drawImage(this.coverBackground(entry), 0, 0, this.width, this.height);
    } else {
      const tint = (track && track.palette && track.palette.backgroundTint) || '#2b1a12';
      const bg = ctx.createRadialGradient(this.center.x, this.center.y - R * 0.4, R * 0.2, this.center.x, this.center.y, Math.max(this.width, this.height));
      bg.addColorStop(0, tint);
      bg.addColorStop(1, RenderTokens.backgroundEdge);
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, this.width, this.height);
    }
    if (this.noisePattern) {
      ctx.save();
      ctx.globalAlpha = 0.045;
      ctx.fillStyle = this.noisePattern;
      ctx.fillRect(0, 0, this.width, this.height);
      ctx.restore();
    }

    // (가로) 앨범 재킷: LP가 재킷 위로 올라와 겹친다. 디스크 교체 때 판이 재킷 위를 지나간다.
    if (this.sleeve) this.drawSleeve(track, entry, coverReady, t);

    // 2. 디스크 접지 그림자 (디스크와 함께 움직이고, 가로에서는 재킷 위에 드리운다)
    const cx = this.center.x + frame.discOffset * R;
    const cy = this.center.y;
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.55)';
    ctx.shadowBlur = R * 0.16;
    ctx.shadowOffsetY = R * 0.06;
    ctx.fillStyle = RenderTokens.vinylEdge;
    circle(ctx, cx, cy, R * 0.995);
    ctx.fill();
    ctx.restore();

    // 3~6. 디스크(그루브·먼지) + 라벨: 함께 회전
    const lr = store.rig.labelRadius * R;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(frame.discAngle * DEG);
    ctx.drawImage(this.grooveCanvas, -R, -R, 2 * R, 2 * R);
    ctx.fillStyle = `rgba(${RenderTokens.labelSkeleton},${0.6 + 0.2 * Math.sin(t * 4)})`;
    circle(ctx, 0, 0, lr);
    ctx.fill();
    if (frame.labelOpacity > 0) {
      ctx.globalAlpha = frame.labelOpacity;
      if (!coverReady) ctx.drawImage(this.placeholderLabel(track, lr), -lr, -lr, 2 * lr, 2 * lr);
      if (coverReady) {
        const fade = Math.min(1, (t - entry.loadedAt) / COVER_FADE);
        if (fade < 1) ctx.drawImage(this.placeholderLabel(track, lr), -lr, -lr, 2 * lr, 2 * lr);
        ctx.globalAlpha = frame.labelOpacity * Math.max(0, fade);
        ctx.drawImage(this.coverLabel(entry, lr), -lr, -lr, 2 * lr, 2 * lr);
      }
      ctx.globalAlpha = 1;
    }
    ctx.restore();

    // 5. 정반사 하이라이트: 화면에 고정 (회전하지 않음). 라벨(무광)은 제외.
    if (ctx.createConicGradient) {
      const k = RenderTokens.highlightStrength;
      ctx.save();
      ctx.beginPath();
      ctx.arc(cx, cy, R, 0, TAU);
      ctx.arc(cx, cy, lr, 0, TAU, true);
      ctx.clip('evenodd');
      const cg = ctx.createConicGradient(-Math.PI / 2 + 0.55, cx, cy);
      cg.addColorStop(0, 'rgba(255,255,255,0)');
      cg.addColorStop(0.06, `rgba(255,255,255,${0.17 * k})`);
      cg.addColorStop(0.13, 'rgba(255,255,255,0)');
      cg.addColorStop(0.5, 'rgba(255,255,255,0)');
      cg.addColorStop(0.56, `rgba(255,255,255,${0.11 * k})`);
      cg.addColorStop(0.63, 'rgba(255,255,255,0)');
      cg.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.globalCompositeOperation = 'screen';
      ctx.fillStyle = cg;
      ctx.fillRect(cx - R, cy - R, 2 * R, 2 * R);
      const rg = ctx.createRadialGradient(cx, cy, lr, cx, cy, R);
      rg.addColorStop(0, 'rgba(0,0,0,0.35)');
      rg.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.globalCompositeOperation = 'multiply';
      ctx.fillStyle = rg;
      ctx.fillRect(cx - R, cy - R, 2 * R, 2 * R);
      ctx.restore();
    }

    // 7. 스핀들
    const sp = ctx.createRadialGradient(cx - 1.5, cy - 1.5, 0, cx, cy, R * 0.03);
    sp.addColorStop(0, '#f4f1ec');
    sp.addColorStop(1, '#8a857e');
    ctx.fillStyle = sp;
    circle(ctx, cx, cy, R * 0.028);
    ctx.fill();

    // 8. 톤암
    this.drawArm(frame.armAngle, frame.armLift);

    // 드래그 중 미리보기 시간
    if (store.isArmLifted) this.drawPreview(frame.armAngle);
  }

  /** 앨범 재킷(정사각형 커버). 커버가 없으면 곡 색으로 만든 임시 재킷. */
  drawSleeve(track, entry, coverReady, t) {
    const { ctx } = this;
    const { x, y, size } = this.sleeve;
    const radius = Math.max(4, size * 0.02);
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.5)';
    ctx.shadowBlur = size * 0.08;
    ctx.shadowOffsetY = size * 0.03;
    ctx.fillStyle = (track && track.palette && track.palette.base) || '#d9643a';
    roundedRect(ctx, x, y, size, size, radius);
    ctx.fill();
    ctx.restore();

    ctx.save();
    roundedRect(ctx, x, y, size, size, radius);
    ctx.clip();
    if (!coverReady) this.drawSleevePlaceholder(track, x, y, size);
    if (coverReady) {
      const fade = Math.min(1, (t - entry.loadedAt) / COVER_FADE);
      if (fade < 1) this.drawSleevePlaceholder(track, x, y, size);
      ctx.globalAlpha = Math.max(0, fade);
      const img = entry.img;
      const s = Math.min(img.naturalWidth, img.naturalHeight);
      ctx.drawImage(img, (img.naturalWidth - s) / 2, (img.naturalHeight - s) / 2, s, s, x, y, size, size);
      ctx.globalAlpha = 1;
    }
    // 종이 재킷의 가장자리 느낌
    const edge = ctx.createLinearGradient(x, y, x + size, y + size);
    edge.addColorStop(0, 'rgba(255,255,255,0.10)');
    edge.addColorStop(0.5, 'rgba(255,255,255,0)');
    edge.addColorStop(1, 'rgba(0,0,0,0.12)');
    ctx.fillStyle = edge;
    ctx.fillRect(x, y, size, size);
    ctx.restore();
    ctx.strokeStyle = 'rgba(255,255,255,0.12)';
    ctx.lineWidth = 1;
    roundedRect(ctx, x + 0.5, y + 0.5, size - 1, size - 1, radius);
    ctx.stroke();
  }

  drawSleevePlaceholder(track, x, y, size) {
    const { ctx } = this;
    const palette = (track && track.palette) || { base: '#D9643A', band: '#F3D9B1', ink: '#2A140B' };
    ctx.fillStyle = palette.base;
    ctx.fillRect(x, y, size, size);
    ctx.strokeStyle = palette.band;
    ctx.lineWidth = size * 0.06;
    ctx.beginPath();
    ctx.arc(x + size * 0.62, y + size * 0.62, size * 0.42, Math.PI * 0.95, Math.PI * 1.75);
    ctx.stroke();
    ctx.fillStyle = palette.ink;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.font = `700 ${size * 0.075}px -apple-system, system-ui, sans-serif`;
    ctx.fillText('TurnTable', x + size * 0.08, y + size * 0.16, size * 0.84);
    if (track) {
      ctx.font = `500 ${size * 0.055}px -apple-system, system-ui, sans-serif`;
      ctx.fillText(track.title, x + size * 0.08, y + size * 0.9, size * 0.84);
    }
  }

  drawArm(angle, lift) {
    const { ctx } = this;
    const R = this.radius;
    const rig = this.rig;
    const P = this.point(rig.pivot);
    const d = { x: -Math.sin(angle * DEG), y: Math.cos(angle * DEG) };
    const L = rig.armLength * R;
    const N = { x: P.x + d.x * L, y: P.y + d.y * L };
    const headLen = 0.16 * R;
    const H = { x: N.x - d.x * headLen, y: N.y - d.y * headLen };

    ctx.fillStyle = RenderTokens.armBase;
    circle(ctx, P.x, P.y, R * 0.17);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.06)';
    ctx.lineWidth = 1;
    ctx.stroke();

    ctx.save();
    // 들림: 약간 커지고 그림자가 멀어지며 흐려진다
    const sc = 1 + 0.035 * lift;
    ctx.translate(P.x, P.y);
    ctx.scale(sc, sc);
    ctx.translate(-P.x, -P.y);
    ctx.shadowColor = `rgba(0,0,0,${0.55 - 0.2 * lift})`;
    ctx.shadowBlur = 4 + 16 * lift;
    ctx.shadowOffsetX = 2 + 9 * lift;
    ctx.shadowOffsetY = 3 + 13 * lift;
    ctx.lineCap = 'round';

    ctx.strokeStyle = RenderTokens.armCounterweight;
    ctx.lineWidth = R * 0.09;
    ctx.beginPath();
    ctx.moveTo(P.x, P.y);
    ctx.lineTo(P.x - d.x * R * 0.22, P.y - d.y * R * 0.22);
    ctx.stroke();

    const tube = ctx.createLinearGradient(P.x - d.y * 4, P.y + d.x * 4, P.x + d.y * 4, P.y - d.x * 4);
    tube.addColorStop(0, RenderTokens.armTubeLight);
    tube.addColorStop(1, RenderTokens.armTubeDark);
    ctx.strokeStyle = tube;
    ctx.lineWidth = Math.max(3, R * 0.032);
    ctx.beginPath();
    ctx.moveTo(P.x, P.y);
    ctx.lineTo(H.x, H.y);
    ctx.stroke();

    ctx.save();
    ctx.translate(H.x, H.y);
    ctx.rotate(Math.atan2(d.y, d.x));
    const hw = R * 0.075;
    ctx.fillStyle = RenderTokens.headshell;
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(-2, -hw / 2, headLen + 2, hw, 3);
    else ctx.rect(-2, -hw / 2, headLen + 2, hw);
    ctx.fill();
    ctx.fillStyle = RenderTokens.accent;
    ctx.fillRect(headLen * 0.55, -hw / 2, headLen * 0.12, hw);
    ctx.restore();
    ctx.restore();

    ctx.fillStyle = RenderTokens.pivotCap;
    circle(ctx, P.x, P.y, R * 0.06);
    ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.7)';
    circle(ctx, N.x, N.y, 1.6);
    ctx.fill();
  }

  drawPreview(angle) {
    const { ctx } = this;
    const pos = this.store.previewPosition;
    const n = this.point(this.rig.needleAt(angle));
    const text = pos == null ? '홈 밖' : TimeText.mmss(pos);
    ctx.font = '600 13px -apple-system, system-ui, sans-serif';
    const tw = ctx.measureText(text).width + 16;
    const bx = Math.min(Math.max(n.x - tw / 2, 4), this.width - tw - 4);
    const by = n.y - 44;
    ctx.fillStyle = 'rgba(15,13,12,0.85)';
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(bx, by, tw, 24, 12);
    else ctx.rect(bx, by, tw, 24);
    ctx.fill();
    ctx.fillStyle = pos == null ? '#a39b90' : '#f2ede6';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, bx + tw / 2, by + 12);
  }
}

/** CSS 변수(--sat 등)에 넣어 둔 safe-area 여백(노치·홈 인디케이터)을 읽는다. */
function readSafeAreaInsets() {
  const style = getComputedStyle(document.documentElement);
  const read = (name) => parseFloat(style.getPropertyValue(name)) || 0;
  return { top: read('--sat'), bottom: read('--sab'), left: read('--sal'), right: read('--sar') };
}

function roundedRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(x, y, w, h, r);
  else ctx.rect(x, y, w, h);
}

function distanceToSegment(p, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const t = Math.min(Math.max(((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy || 1), 0), 1);
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}
