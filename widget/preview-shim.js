// 개발용: Scriptable API를 브라우저로 흉내 내어 TurnTable.js 위젯 스크립트를 실행하고 그림을 보여 준다.
// 실제 Scriptable과 글꼴·보간 등 세부가 다를 수 있다. 배치와 그리기 순서, 로직 확인용.

class Size { constructor(width, height) { this.width = width; this.height = height; } }
class Point { constructor(x, y) { this.x = x; this.y = y; } }
class Rect {
  constructor(x, y, width, height) { Object.assign(this, { x, y, width, height }); }
  get minX() { return this.x; }
  get minY() { return this.y; }
}
class Color {
  constructor(hex, alpha = 1) { this.hex = hex; this.alpha = alpha; }
  get css() {
    const h = this.hex.replace('#', '');
    const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${this.alpha})`;
  }
}
class Font {
  constructor(css) { this.css = css; }
  static boldSystemFont(size) { return new Font(`700 ${size}px -apple-system, system-ui, sans-serif`); }
  static systemFont(size) { return new Font(`400 ${size}px -apple-system, system-ui, sans-serif`); }
}
class ShimImage {
  constructor(source) { this.source = source; this.size = new Size(source.width, source.height); }
}
class Path {
  constructor() { this.p = new Path2D(); }
  move(pt) { this.p.moveTo(pt.x, pt.y); }
  addLine(pt) { this.p.lineTo(pt.x, pt.y); }
  addRect(r) { this.p.rect(r.x, r.y, r.width, r.height); }
  addEllipse(r) { this.p.ellipse(r.x + r.width / 2, r.y + r.height / 2, r.width / 2, r.height / 2, 0, 0, Math.PI * 2); }
  closeSubpath() { this.p.closePath(); }
}
class DrawContext {
  constructor() {
    this.size = new Size(100, 100);
    this.respectScreenScale = true;
    this.opaque = true;
    this.canvas = null;
    this.textAlign = 'left';
    this.font = Font.systemFont(17);
    this.textColor = new Color('#000000');
    this.path = null;
  }
  get ctx() {
    if (!this.canvas) {
      this.canvas = document.createElement('canvas');
      this.canvas.width = this.size.width;
      this.canvas.height = this.size.height;
      this.c = this.canvas.getContext('2d');
    }
    return this.c;
  }
  setFillColor(color) { this.ctx.fillStyle = color.css; }
  setStrokeColor(color) { this.ctx.strokeStyle = color.css; }
  setLineWidth(w) { this.ctx.lineWidth = w; }
  fillRect(r) { this.ctx.fillRect(r.x, r.y, r.width, r.height); }
  fillEllipse(r) { const p = new Path(); p.addEllipse(r); this.ctx.fill(p.p); }
  strokeEllipse(r) { const p = new Path(); p.addEllipse(r); this.ctx.stroke(p.p); }
  drawImageInRect(image, r) { this.ctx.drawImage(image.source, r.x, r.y, r.width, r.height); }
  drawImageAtPoint(image, pt) { this.ctx.drawImage(image.source, pt.x, pt.y); }
  addPath(path) { this.path = path; }
  fillPath() { if (this.path) this.ctx.fill(this.path.p); }
  strokePath() { if (this.path) this.ctx.stroke(this.path.p); }
  setFont(font) { this.font = font; }
  setTextColor(color) { this.textColor = color; }
  setTextAlignedLeft() { this.textAlign = 'left'; }
  setTextAlignedCenter() { this.textAlign = 'center'; }
  setTextAlignedRight() { this.textAlign = 'right'; }
  drawTextInRect(text, r) {
    const c = this.ctx;
    c.save();
    c.font = this.font.css;
    c.fillStyle = this.textColor.css;
    c.textBaseline = 'top';
    c.textAlign = this.textAlign;
    const x = this.textAlign === 'right' ? r.x + r.width : this.textAlign === 'center' ? r.x + r.width / 2 : r.x;
    c.fillText(text, x, r.y, r.width);
    c.restore();
  }
  drawText(text, pt) { this.drawTextInRect(text, new Rect(pt.x, pt.y, 10000, 100)); }
  getImage() { this.ctx; return new ShimImage(this.canvas); }
}

class WidgetElement {
  constructor(kind, value) { this.kind = kind; this.value = value; }
  applyFillingContentMode() {}
}
class WidgetStack {
  constructor() { this.children = []; this.spacing = 0; }
  addText(text) { const el = new WidgetElement('text', text); this.children.push(el); return el; }
  addImage(image) { const el = new WidgetElement('image', image); this.children.push(el); return el; }
  addStack() { const s = new WidgetStack(); this.children.push(s); return s; }
  addSpacer() {}
  layoutHorizontally() {}
  layoutVertically() {}
  centerAlignContent() {}
  setPadding() {}
}
class ListWidget extends WidgetStack {
  async presentSmall() {}
  async presentMedium() {}
}

// ---------- 가짜 Spotify ----------

function sampleCover() {
  const c = document.createElement('canvas');
  c.width = c.height = 640;
  const g = c.getContext('2d');
  const grad = g.createLinearGradient(0, 0, 640, 640);
  grad.addColorStop(0, '#f7a8c4');
  grad.addColorStop(0.5, '#9bd3f7');
  grad.addColorStop(1, '#f9e27a');
  g.fillStyle = grad;
  g.fillRect(0, 0, 640, 640);
  g.fillStyle = '#ffffff';
  g.font = 'italic 900 120px Georgia, serif';
  g.textAlign = 'center';
  g.fillText('Sample', 320, 300);
  g.fillText('Cover', 320, 430);
  return new ShimImage(c);
}

function makeEnvironment({ family, scenario }) {
  const keychain = new Map();
  if (scenario !== 'loggedOut') {
    keychain.set('turntable.widget.tokens', JSON.stringify({ accessToken: 'A', refreshToken: 'R', expiresAt: Date.now() + 3600e3 }));
  }
  const files = new Map();
  const ITEM = {
    type: 'track', id: 't1', name: '새벽 세 시의 라디오', duration_ms: 214000,
    artists: [{ name: '가상의 밴드' }],
    album: { images: scenario === 'noCover' ? [] : [{ url: 'https://i.scdn.co/image/sample', width: 640 }] },
  };
  class Request {
    constructor(url) { this.url = url; this.method = 'GET'; this.headers = {}; this.response = { statusCode: 200 }; }
    async loadString() {
      if (this.url.endsWith('/me/player')) {
        if (scenario === 'idle') { this.response.statusCode = 204; return ''; }
        return JSON.stringify({ is_playing: scenario !== 'paused', progress_ms: 90000, item: ITEM });
      }
      if (this.url.includes('recently-played')) return JSON.stringify({ items: [{ track: ITEM }] });
      this.response.statusCode = 404;
      return '{}';
    }
    async loadJSON() { return JSON.parse(await this.loadString()); }
    async loadImage() { return sampleCover(); }
  }
  let captured = null;
  return {
    config: { runsInWidget: true, widgetFamily: family },
    args: { queryParameters: {} },
    Script: { setWidget(w) { captured = w; }, complete() {}, name() { return 'TurnTable'; } },
    Keychain: { contains: (k) => keychain.has(k), get: (k) => keychain.get(k), set: (k, v) => keychain.set(k, v), remove: (k) => keychain.delete(k) },
    Request,
    FileManager: {
      local: () => ({
        cacheDirectory: () => '/cache',
        joinPath: (a, b) => `${a}/${b}`,
        fileExists: (p) => files.has(p),
        readString: (p) => files.get(p),
        writeString: (p, s) => files.set(p, s),
        readImage: (p) => files.get(p),
        writeImage: (p, img) => files.set(p, img),
      }),
    },
    UUID: { string: () => crypto.randomUUID().toUpperCase() },
    Safari: { open() {} },
    Alert: class { addAction() {} addCancelAction() {} async presentSheet() { return -1; } async presentAlert() { return 0; } },
    get widget() { return captured; },
  };
}

const NAMES = ['config', 'args', 'Script', 'Keychain', 'Request', 'FileManager', 'UUID', 'Safari', 'Alert', 'ListWidget', 'DrawContext', 'Size', 'Point', 'Rect', 'Color', 'Font', 'Path'];
const source = await (await fetch('TurnTable.js', { cache: 'no-store' })).text();
const AsyncFunction = (async () => {}).constructor;
const run = new AsyncFunction(...NAMES, `${source}\n;return { sha256, base64Url, asciiBytes };`);

async function execute(family, scenario) {
  const env = makeEnvironment({ family, scenario });
  const exported = await run(env.config, env.args, env.Script, env.Keychain, env.Request, env.FileManager, env.UUID, env.Safari, env.Alert,
    ListWidget, DrawContext, Size, Point, Rect, Color, Font, Path);
  return { widget: env.widget, exported };
}

// ---------- 검사 ----------

const checks = document.getElementById('checks');
function report(ok, text) {
  const li = document.createElement('li');
  li.className = ok ? 'pass' : 'fail';
  li.textContent = `${ok ? '✓' : '✗'} ${text}`;
  checks.appendChild(li);
}

const { exported } = await execute('small', 'playing');
for (const input of ['', 'abc', 'x'.repeat(55), 'y'.repeat(64), 'A1B2C3D4E5F6'.repeat(8)]) {
  const mine = exported.base64Url(exported.sha256(exported.asciiBytes(input)));
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input)));
  let bin = '';
  digest.forEach((b) => { bin += String.fromCharCode(b); });
  const expected = btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  report(mine === expected, `SHA-256 + base64url 일치 (길이 ${input.length})`);
}

// ---------- 그림 ----------

const out = document.getElementById('out');
function section(title) {
  const h = document.createElement('h2');
  h.textContent = title;
  out.appendChild(h);
  const row = document.createElement('div');
  row.className = 'row';
  out.appendChild(row);
  return row;
}
function tile(row, label, node) {
  const t = document.createElement('div');
  t.className = 'tile';
  t.appendChild(node);
  const s = document.createElement('small');
  s.textContent = label;
  t.appendChild(s);
  row.appendChild(t);
}
function showBackground(widget, w, h) {
  const c = document.createElement('canvas');
  c.className = 'widget';
  c.width = w * 2;
  c.height = h * 2;
  c.style.width = `${w}px`;
  c.style.height = `${h}px`;
  const g = c.getContext('2d');
  if (widget.backgroundImage) g.drawImage(widget.backgroundImage.source, 0, 0, c.width, c.height);
  return c;
}
function firstImage(stack) {
  for (const child of stack.children) {
    if (child.kind === 'image') return child.value;
    if (child.children) { const found = firstImage(child); if (found) return found; }
  }
  return null;
}
function texts(stack, acc = []) {
  for (const child of stack.children) {
    if (child.kind === 'text') acc.push(child.value);
    if (child.children) texts(child, acc);
  }
  return acc;
}

const scenarios = [['playing', '재생 중'], ['paused', '일시정지'], ['idle', '기기 쉼(최근 곡)'], ['noCover', '커버 없음'], ['loggedOut', '연결 전']];
const smallRow = section('홈 화면 · 작은 크기');
const mediumRow = section('홈 화면 · 중간 크기');
const lockRow = section('잠금화면');
for (const [scenario, label] of scenarios) {
  const small = (await execute('small', scenario)).widget;
  tile(smallRow, label, showBackground(small, 170, 170));
  const medium = (await execute('medium', scenario)).widget;
  tile(mediumRow, label, showBackground(medium, 364, 170));
}
for (const [scenario, label] of scenarios.slice(0, 3)) {
  const circular = (await execute('accessoryCircular', scenario)).widget;
  const ci = firstImage(circular);
  const cc = document.createElement('canvas');
  cc.width = cc.height = 76;
  cc.getContext('2d').drawImage(ci.source, 0, 0, 76, 76);
  cc.style.filter = 'grayscale(1) brightness(1.4)';
  tile(lockRow, `원형 · ${label}`, cc);
  const rect = (await execute('accessoryRectangular', scenario)).widget;
  const box = document.createElement('div');
  box.className = 'lock';
  const ri = document.createElement('canvas');
  ri.width = ri.height = 40;
  ri.getContext('2d').drawImage(firstImage(rect).source, 0, 0, 40, 40);
  ri.style.filter = 'grayscale(1) brightness(1.4)';
  box.appendChild(ri);
  const t = texts(rect);
  const textBox = document.createElement('div');
  textBox.innerHTML = `<b></b><span></span>`;
  textBox.querySelector('b').textContent = t[0] || '';
  textBox.querySelector('span').textContent = t[1] || '';
  box.appendChild(textBox);
  tile(lockRow, `가로형 · ${label}`, box);
}
report(true, '모든 크기·상황에서 스크립트가 오류 없이 실행됨');
window.__previewDone = true;
