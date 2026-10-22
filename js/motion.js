// TurnTableCore(Swift)의 모션 모델을 옮긴 것. 수치와 공식은 Swift 쪽과 같게 유지한다.
// 시간 단위는 초, 각도는 도. 시간은 단조 시계(performance.now() / 1000)를 쓴다.

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export const MotionSpec = Object.freeze({
  rpm33: 100 / 3,
  rpm45: 45,
  spinUpDuration: 0.8,
  spinDownDuration: 1.2,
  recordSwapDuration: 0.6,
  armDropDuration: 0.15,
  armReturnDuration: 1.0,
  armTravelDuration: 0.7,
  armLiftDuration: 0.12,
  armRestReturnDuration: 0.45,
  pausedLift: 0.35,
  labelFadeDuration: 0.35,
  reducedMotionSpeedFactor: 0.25,
  degreesPerSecond: (rpm) => (rpm * 360) / 60,
});

const cube = (x) => x * x * x;

// value(p): 곡선 값, integral(p): 0부터 p까지의 넓이 (속도 곡선 적분용)
export const Easing = Object.freeze({
  linear: { value: (p) => clamp(p, 0, 1), integral: (p) => { p = clamp(p, 0, 1); return (p * p) / 2; } },
  easeIn: { value: (p) => { p = clamp(p, 0, 1); return p * p; }, integral: (p) => cube(clamp(p, 0, 1)) / 3 },
  easeOut: {
    value: (p) => { p = clamp(p, 0, 1); return 1 - (1 - p) * (1 - p); },
    integral: (p) => { p = clamp(p, 0, 1); return p - (1 - cube(1 - p)) / 3; },
  },
  easeInOut: {
    value: (p) => { p = clamp(p, 0, 1); return p < 0.5 ? 2 * p * p : 1 - 2 * (1 - p) * (1 - p); },
    integral: (p) => {
      p = clamp(p, 0, 1);
      if (p < 0.5) return (2 * cube(p)) / 3;
      return 1 / 12 + (p - 0.5) - (2 / 3) * (0.125 - cube(1 - p));
    },
  },
});

/** 시간의 함수로 표현한 값 전환. 그리는 쪽이 valueAt(t)로 읽는다. */
export class Tween {
  constructor(from, to, startTime, duration, easing = Easing.easeInOut) {
    Object.assign(this, { from, to, startTime, duration, easing });
    Object.freeze(this);
  }

  static constant(value) {
    return new Tween(value, value, 0, 0, Easing.linear);
  }

  valueAt(t) {
    if (!(this.duration > 0)) return t < this.startTime ? this.from : this.to;
    return this.from + (this.to - this.from) * this.easing.value((t - this.startTime) / this.duration);
  }

  isFinishedAt(t) {
    return t >= this.startTime + this.duration;
  }

  /** 지금 값에서 시작해 새 목표로. 진행 중이던 전환을 끊김 없이 이어받는다. */
  retargeted(to, duration, easing = Easing.easeInOut, t) {
    return new Tween(this.valueAt(t), to, t, duration, easing);
  }
}

/** 디스크 회전: 각속도가 곡선을 따라 바뀌는 한 구간. 각도는 속도를 적분해 누적한다. */
export class SpinRamp {
  constructor(startAngle, startTime, fromVelocity, toVelocity, duration, easing) {
    Object.assign(this, { startAngle, startTime, fromVelocity, toVelocity, duration, easing });
    Object.freeze(this);
  }

  static stopped(angle = 0, t = 0) {
    return new SpinRamp(angle, t, 0, 0, 0, Easing.linear);
  }

  velocityAt(t) {
    if (!(this.duration > 0)) return this.toVelocity;
    return this.fromVelocity + (this.toVelocity - this.fromVelocity) * this.easing.value((t - this.startTime) / this.duration);
  }

  angleAt(t) {
    const elapsed = Math.max(0, t - this.startTime);
    if (!(this.duration > 0)) return this.startAngle + this.toVelocity * elapsed;
    const dv = this.toVelocity - this.fromVelocity;
    if (elapsed < this.duration) {
      return this.startAngle + this.fromVelocity * elapsed + dv * this.duration * this.easing.integral(elapsed / this.duration);
    }
    const rampAngle = this.fromVelocity * this.duration + dv * this.duration * this.easing.integral(1);
    return this.startAngle + rampAngle + this.toVelocity * (elapsed - this.duration);
  }

  ramp(toVelocity, duration, easing, t) {
    return new SpinRamp(this.angleAt(t) % 360, t, this.velocityAt(t), toVelocity, duration, easing);
  }
}

/** 서비스가 마지막으로 알려준 재생 위치. 표시 위치 = 수신 위치 + (지금 - 수신 시각). */
export class PlaybackTimeline {
  constructor(position, receivedAt, isPlaying, duration) {
    Object.assign(this, { position, receivedAt, isPlaying, duration });
    Object.freeze(this);
  }

  positionAt(t) {
    const raw = this.position + (this.isPlaying ? Math.max(0, t - this.receivedAt) : 0);
    return this.duration > 0 ? clamp(raw, 0, this.duration) : Math.max(raw, 0);
  }

  pausedAt(t) {
    return new PlaybackTimeline(this.positionAt(t), t, false, this.duration);
  }
}
PlaybackTimeline.zero = new PlaybackTimeline(0, 0, false, 0);

export const TimeText = {
  mmss(seconds) {
    if (seconds == null || !Number.isFinite(seconds)) return '--:--';
    const total = Math.floor(Math.max(0, seconds));
    return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
  },
};

/** 톤암 각도(휴식 위치에서 시계방향 증가)와 재생 위치의 선형 대응. */
export class ToneArmGeometry {
  constructor(restAngle = 0, startAngle = 18, endAngle = 48) {
    if (!(restAngle < startAngle && startAngle < endAngle)) throw new Error('restAngle < startAngle < endAngle');
    Object.assign(this, { restAngle, startAngle, endAngle });
    Object.freeze(this);
  }

  isOverGrooves(angle) {
    return angle >= this.startAngle && angle <= this.endAngle;
  }

  /** 홈 범위 밖이거나 곡 길이를 모르면 null. */
  positionAtAngle(angle, duration) {
    if (!(duration > 0) || !this.isOverGrooves(angle)) return null;
    return ((angle - this.startAngle) / (this.endAngle - this.startAngle)) * duration;
  }

  angleAtPosition(position, duration) {
    if (!(duration > 0)) return this.startAngle;
    return this.startAngle + clamp(position / duration, 0, 1) * (this.endAngle - this.startAngle);
  }
}

/** 화면 배치 비율. 폭 W 기준. */
export const TurntableLayout = Object.freeze({ aspect: 1.05, radius: 0.37, centerX: 0.42, centerY: 0.56 });

/** 톤암 배치 (단위 ×R, 원점 디스크 중심, y는 아래가 +). 첫/마지막 홈에 맞는 피벗을 찾는다. */
export class TonearmRig {
  constructor({
    geometry = new ToneArmGeometry(),
    armLength = 1.1,
    outerGroove = 0.94,
    innerGroove = 0.42,
    labelRadius = 0.34,
    maxRight = (1 - TurntableLayout.centerX) / TurntableLayout.radius,
    maxUp = (TurntableLayout.centerY * TurntableLayout.aspect) / TurntableLayout.radius,
  } = {}) {
    Object.assign(this, { geometry, armLength, outerGroove, innerGroove, labelRadius });
    const start = TonearmRig.direction(geometry.startAngle);
    const end = TonearmRig.direction(geometry.endAngle);
    const rest = TonearmRig.direction(geometry.restAngle);
    let best = { cost: Infinity, pivot: { x: 1, y: -1 }, error: Infinity };
    for (let i = 0; i <= 120; i++) {
      const ax = 0.5 + i * 0.01;
      for (let j = 0; j <= 180; j++) {
        const by = -1.5 + j * 0.01;
        const outerError = Math.hypot(ax + armLength * start.x, by + armLength * start.y) - outerGroove;
        const innerError = Math.hypot(ax + armLength * end.x, by + armLength * end.y) - innerGroove;
        const restRadius = Math.hypot(ax + armLength * rest.x, by + armLength * rest.y);
        const pivotRadius = Math.hypot(ax, by);
        let penalty = 0;
        if (restRadius < 1.08) penalty += (1.08 - restRadius) * 4; // 휴식 위치는 디스크 밖
        if (pivotRadius < 1.12) penalty += (1.12 - pivotRadius) * 4; // 피벗은 디스크 밖
        if (ax + 0.2 > maxRight) penalty += (ax + 0.2 - maxRight) * 4; // 화면 안
        if (-by + 0.2 > maxUp) penalty += (-by + 0.2 - maxUp) * 4;
        const cost = outerError * outerError + innerError * innerError + penalty * penalty;
        if (cost < best.cost) best = { cost, pivot: { x: ax, y: by }, error: Math.max(Math.abs(outerError), Math.abs(innerError)) };
      }
    }
    this.pivot = best.pivot;
    this.fitError = best.error;
    Object.freeze(this);
  }

  /** 0° = 피벗에서 화면 아래쪽, 시계방향으로 증가. */
  static direction(degrees) {
    const r = (degrees * Math.PI) / 180;
    return { x: -Math.sin(r), y: Math.cos(r) };
  }

  needleAt(angle) {
    const d = TonearmRig.direction(angle);
    return { x: this.pivot.x + this.armLength * d.x, y: this.pivot.y + this.armLength * d.y };
  }

  angleTowards(point) {
    return (Math.atan2(-(point.x - this.pivot.x), point.y - this.pivot.y) * 180) / Math.PI;
  }
}
TonearmRig.standard = new TonearmRig();

/** SplitMix64. 같은 시드에서 같은 수열 (Swift `SeededRandom`과 같은 값). */
export class SeededRandom {
  constructor(seed) {
    this.state = BigInt.asUintN(64, BigInt(seed));
  }

  next() {
    this.state = BigInt.asUintN(64, this.state + 0x9e3779b97f4a7c15n);
    let z = this.state;
    z = BigInt.asUintN(64, (z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n);
    z = BigInt.asUintN(64, (z ^ (z >> 27n)) * 0x94d049bb133111ebn);
    return z ^ (z >> 31n);
  }

  /** 0..<1 */
  unit() {
    return Number(this.next() >> 11n) * 2 ** -53;
  }
}

/** 그루브 질감 레시피 (×R). */
export class VinylGrooves {
  constructor(seed, inner, outer) {
    const random = new SeededRandom(seed);
    this.rings = [];
    for (let r = inner; r < outer; r += 0.0078) {
      const opacity = 0.02 + random.unit() * 0.05;
      const isLight = random.unit() < 0.5;
      this.rings.push({ radius: r, opacity: isLight ? opacity : opacity * 2.5, isLight });
    }
    this.gaps = [0.28, 0.55, 0.8].map((f) => inner + (outer - inner) * f);
    this.specks = Array.from({ length: 90 }, () => ({
      angle: random.unit() * 2 * Math.PI,
      radius: inner + random.unit() * (outer - inner),
      opacity: 0.1 + random.unit() * 0.25,
    }));
  }
}
VinylGrooves.standard = new VinylGrooves(7, TonearmRig.standard.innerGroove - 0.02, TonearmRig.standard.outerGroove + 0.02);
