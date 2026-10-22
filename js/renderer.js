// 턴테이블 캔버스 렌더러. 상태는 PlayerStore.frame(t)에서 읽고 그리기만 한다.
// 레이어(아래→위): 배경(흐린 커버/그라데이션 + 노이즈) → 플래터 그림자 → 디스크·그루브·먼지(회전)
// → 라벨(회전) → 정반사 하이라이트(고정) → 스핀들 → 톤암 → 미리보기 시간.

import { TimeText, TurntableLayout, VinylGrooves } from './motion.js';

const TAU = Math.PI * 2;
const DEG = Math.PI / 180;
const COVER_FADE = 0.35;

export const RenderTokens = {
  backgroundEdge: '#0b0a09',
  platter: '#121110',
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
    this.grooveCanvas = document.createElement('canvas');
    this.noisePattern = null;
    this.covers = new Map(); // artworkURL → { img, loadedAt, label, background, failed }
    this.placeholders = new Map(); // track id → label canvas
  }

  // ---------- 배치 ----------

  /** 크기가 바뀌었을 때 호출. 아직 크기가 없으면 false. */
  layout() {
    const w = this.canvas.clientWidth;
    if (!w) return false;
    const h = Math.round(w * TurntableLayout.aspect);
    this.canvas.style.height = `${h}px`;
    this.dpr = Math.min(window.devicePixelRatio || 1, 3);
    this.canvas.width = Math.round(w * this.dpr);
    this.canvas.height = Math.round(h * this.dpr);
    this.width = w;
    this.height = h;
    this.radius = w * TurntableLayout.radius;
    this.center = { x: w * TurntableLayout.centerX, y: h * TurntableLayout.centerY };
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
    const rig = this.store.rig;
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
    return this.store.rig.angleTowards(this.vector(p));
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

    // 2. 플래터 그림자
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.65)';
    ctx.shadowBlur = 28;
    ctx.shadowOffsetY = 12;
    ctx.fillStyle = RenderTokens.platter;
    circle(ctx, this.center.x, this.center.y, R * 1.03);
    ctx.fill();
    ctx.restore();

    // 3~6. 디스크(그루브·먼지) + 라벨: 함께 회전
    const cx = this.center.x + frame.discOffset * R;
    const cy = this.center.y;
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

  drawArm(angle, lift) {
    const { ctx } = this;
    const R = this.radius;
    const rig = this.store.rig;
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
    const n = this.point(this.store.rig.needleAt(angle));
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

function distanceToSegment(p, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const t = Math.min(Math.max(((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy || 1), 0), 1);
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}
