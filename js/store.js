// TurnTableCore `PlayerStore`(Swift)를 옮긴 상태 머신. 상태 전이는 여기서만 일어나고,
// 화면은 phase와 frame(t)를 그리기만 한다.
//
// 연출(톤암 이동, 디스크 교체)은 한 번에 하나의 시퀀스로 돌고, 새 동작이 오면 이전 시퀀스를 취소한다.
// 시퀀스가 없을 때 서비스 상태가 바뀌면(제어센터, 이어폰, Spotify 앱) 서비스 상태에 맞춘다.

import { Easing, MotionSpec, PlaybackTimeline, SpinRamp, TonearmRig, Tween } from './motion.js?v=202610311722';

export const CANCELLED = Symbol('cancelled');

const PHASES_GRAB = ['playing', 'paused', 'armAtRest', 'idle'];

export class PlayerStore {
  constructor(provider, { now = () => performance.now() / 1000, sleep = (s) => new Promise((r) => setTimeout(r, s * 1000)) } = {}) {
    this.provider = provider;
    this.now = now;
    this.sleep = sleep;

    /** idle | loading | playing | paused | armLifted | armAtRest | trackEnded */
    this.phase = 'armAtRest';
    /** 서비스가 지금 재생 중이라고 알려준 곡 */
    this.track = null;
    /** 디스크에 올라가 있는 곡 (곡 교체 연출 중에는 track보다 늦게 바뀐다) */
    this.displayedTrack = null;
    this.timeline = PlaybackTimeline.zero;
    this.resumePosition = 0;
    this.toastMessage = null;
    this.dragMoveCount = 0;

    this.rig = TonearmRig.standard;
    this.rpm = MotionSpec.rpm33;
    this._reduceMotion = false;
    this.hapticsEnabled = true;
    this.onHaptic = null;
    this.onToast = null;

    this.spin = SpinRamp.stopped();
    this.armTween = Tween.constant(this.rig.geometry.restAngle);
    this.armFollowsPlayback = false;
    this.armLift = Tween.constant(0);
    this.discOffset = Tween.constant(0);
    this.labelOpacity = Tween.constant(1);
    this.dragAngle = null;
    this.dragGrabOffset = 0;
    this.dragStartPhase = 'armAtRest';
    this.dragStartPosition = 0;
    this.sequence = null;
    this.expectingTrackChange = false;
    this.toastTimer = null;

    this.apply(provider.snapshot);
    this.unsubscribe = provider.subscribe((snapshot) => this.apply(snapshot));
  }

  get reduceMotion() { return this._reduceMotion; }
  set reduceMotion(value) {
    this._reduceMotion = value;
    if (this.phase === 'playing') this.setSpin(true);
  }

  setRpm(rpm) {
    this.rpm = rpm;
    if (this.phase === 'playing') this.setSpin(true);
  }

  // ---------- 그리기용 값 ----------

  frame(t) {
    let disc = this.spin.angleAt(t) % 360;
    if (disc < 0) disc += 360;
    return {
      discAngle: disc,
      armAngle: this.armAngleAt(t),
      armLift: this.armLift.valueAt(t),
      discOffset: this.discOffset.valueAt(t),
      labelOpacity: this.labelOpacity.valueAt(t),
    };
  }

  /** 화면에 보일 재생 위치. 톤암을 든 동안에는 바늘 아래 위치(미리보기). */
  displayPosition(t) {
    if (this.dragAngle != null) return this.previewPosition;
    if (this.phase === 'armAtRest' || this.phase === 'idle') return this.resumePosition;
    return this.timeline.positionAt(t);
  }

  get isArmLifted() { return this.dragAngle != null; }

  get previewPosition() {
    if (this.dragAngle == null) return null;
    return this.rig.geometry.positionAtAngle(this.dragAngle, this.timeline.duration);
  }

  get canGrabArm() {
    return PHASES_GRAB.includes(this.phase) && this.timeline.duration > 0;
  }

  // ---------- 사용자 동작 ----------

  /** 라벨 탭: 재생 ↔ 일시정지. 휴식 위치면 기억한 위치부터 재생. */
  tapLabel() {
    switch (this.phase) {
      case 'playing': {
        this.cancelSequence();
        this.haptic('light');
        const t = this.now();
        this.phase = 'paused';
        this.setSpin(false);
        this.timeline = this.timeline.pausedAt(t);
        this.armLift = this.armLift.retargeted(MotionSpec.pausedLift, 0.25, Easing.easeInOut, t); // 홈 위에서 살짝 들린 채 대기
        this.fireAndForget(this.provider.pause());
        break;
      }
      case 'paused':
        this.haptic('light');
        this.run(async (ctx) => {
          await this.setLift(ctx, 0, MotionSpec.armDropDuration, Easing.easeIn);
          await this.call(ctx, this.provider.play());
          this.setSpin(true);
          this.phase = 'playing';
        });
        break;
      case 'armAtRest':
      case 'idle':
        this.haptic('light');
        this.playFromRest(this.resumePosition);
        break;
      default:
        break;
    }
  }

  playFromRest(position) {
    if (!(this.timeline.duration > 0)) {
      this.showToast(this.track ? '곡 길이를 알 수 없어 톤암을 내릴 수 없어요.' : 'Spotify 앱에서 음악을 재생하면 여기에 나타나요.');
      return;
    }
    this.run((ctx) => this.dropFromRest(ctx, position));
  }

  /** 톤암 머리를 눌렀을 때. 잡을 수 없으면 false. */
  armPressBegan(fingerAngle) {
    if (!this.canGrabArm) {
      if (!(this.timeline.duration > 0)) this.showToast('곡 길이를 알 수 없어 톤암을 움직일 수 없어요.');
      return false;
    }
    const t = this.now();
    this.dragStartPhase = this.phase;
    this.dragStartPosition = this.timeline.positionAt(t);
    this.dragGrabOffset = fingerAngle - this.armAngleAt(t);
    this.dragMoveCount = 0;
    return true;
  }

  /** 드래그 중. seek은 부르지 않고 미리보기만 바뀐다. */
  armDragChanged(fingerAngle) {
    if (this.dragAngle == null) this.beginLift();
    this.dragMoveCount += 1;
    const g = this.rig.geometry;
    this.dragAngle = Math.min(Math.max(fingerAngle - this.dragGrabOffset, g.restAngle - 3), g.endAngle + 6);
  }

  /** 손을 뗐을 때. 홈 위면 그 위치로 seek 1회 후 재생, 홈 밖이면 휴식 위치로. */
  armPressEnded() {
    const fromRest = this.dragStartPhase === 'armAtRest' || this.dragStartPhase === 'idle';
    const angle = this.dragAngle;
    if (angle == null) {
      // 움직이지 않은 탭: 휴식 위치의 암이면 이어서 재생
      if (fromRest) {
        this.haptic('light');
        this.playFromRest(this.resumePosition);
      }
      return;
    }
    this.dragAngle = null;
    this.armTween = Tween.constant(angle);
    const position = this.rig.geometry.positionAtAngle(angle, this.timeline.duration);
    if (position != null) {
      const previous = this.dragStartPosition;
      this.run(async (ctx) => {
        this.phase = 'loading';
        await this.dropAndPlay(ctx, position, fromRest ? { kind: 'rest' } : { kind: 'previous', position: previous });
      });
    } else {
      if (!fromRest) this.resumePosition = this.dragStartPosition;
      this.run(async (ctx) => {
        this.phase = 'armAtRest';
        await this.moveArm(ctx, this.rig.geometry.restAngle, MotionSpec.armRestReturnDuration);
        await this.setLift(ctx, 0, 0.15);
        this.haptic('soft');
      });
    }
  }

  /** 스크린 리더 대체 조작: 재생 위치를 초 단위로 옮긴다. */
  adjustPosition(delta) {
    if (!(this.phase === 'playing' || this.phase === 'paused') || !(this.timeline.duration > 0)) return;
    const t = this.now();
    const target = Math.min(Math.max(this.timeline.positionAt(t) + delta, 0), this.timeline.duration);
    const wasPlaying = this.phase === 'playing';
    // 화면 위치를 먼저 옮겨 둔다: 연달아 누르면(키보드 →→→) 앞선 이동 위에 쌓인다.
    this.timeline = new PlaybackTimeline(target, t, wasPlaying, this.timeline.duration);
    this.run(async (ctx) => {
      await this.call(ctx, this.provider.seek(target));
    });
  }

  /** 다음/이전 곡. 음악은 바로 넘어가고, 톤암·디스크 교체는 화면에서만 따라간다 (끊김 없음). */
  skip(offset) {
    this.run(async (ctx) => {
      this.phase = 'loading';
      this.expectingTrackChange = true;
      const skipping = Promise.resolve(this.provider.skip(offset));
      skipping.catch(() => {}); // 아래에서 기다릴 때 처리한다
      await this.liftToRest(ctx);
      await this.slideDisc(ctx, -2.6, MotionSpec.recordSwapDuration / 2, Easing.easeIn);
      await this.call(ctx, skipping);
      this.adoptProviderTrack();
      await this.swapIn(ctx);
      this.resumePosition = 0;
      if (!this.timeline.isPlaying) await this.call(ctx, this.provider.play());
      await this.dropOntoPlayback(ctx);
    });
  }

  showToast(message) {
    this.toastMessage = message;
    if (this.onToast) this.onToast(message);
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => {
      this.toastMessage = null;
      if (this.onToast) this.onToast(null);
    }, 2400);
  }

  // ---------- 서비스 상태 반영 ----------

  apply(snapshot) {
    const previousId = this.track ? this.track.id : null;
    const incoming = snapshot.timeline;
    const nextId = snapshot.track ? snapshot.track.id : null;
    if (nextId !== previousId && this.armFollowsPlayback) {
      // 곡이 바뀌면 톤암이 새 곡 위치로 순간이동하지 않도록 지금 자리에 고정한다 (연출이 옮긴다).
      const t = this.now();
      this.armTween = Tween.constant(this.armAngleAt(t));
      this.armFollowsPlayback = false;
    }
    this.timeline = incoming;
    if (nextId !== previousId) {
      this.track = snapshot.track;
      if (previousId == null) {
        this.displayedTrack = this.track;
        this.fadeInLabel();
      } else if (this.expectingTrackChange) {
        this.expectingTrackChange = false;
      } else if (['playing', 'paused', 'loading', 'trackEnded'].includes(this.phase) && nextId != null) {
        this.runTrackAdvance();
      } else {
        this.displayedTrack = this.track;
        this.fadeInLabel();
      }
      return;
    }
    // 연출 중에는 연출이 상태를 정한다.
    if (this.sequence) return;
    if (this.phase === 'playing' && !incoming.isPlaying) {
      if (incoming.duration > 0 && incoming.position >= incoming.duration - 0.5) this.runQueueFinished();
      else this.syncExternalPause();
    } else if (this.phase === 'paused' && incoming.isPlaying) {
      this.syncExternalResume();
    } else if ((this.phase === 'armAtRest' || this.phase === 'idle') && incoming.isPlaying && incoming.duration > 0) {
      this.runExternalPlayFromRest();
    }
  }

  syncExternalPause() {
    const t = this.now();
    this.phase = 'paused';
    this.setSpin(false);
    this.armLift = this.armLift.retargeted(MotionSpec.pausedLift, 0.25, Easing.easeInOut, t);
  }

  syncExternalResume() {
    const t = this.now();
    this.armLift = this.armLift.retargeted(0, MotionSpec.armDropDuration, Easing.easeIn, t);
    this.setSpin(true);
    this.phase = 'playing';
  }

  runExternalPlayFromRest() {
    this.run(async (ctx) => {
      this.phase = 'loading';
      await this.setLift(ctx, 1, 0.15);
      const angle = this.rig.geometry.angleAtPosition(this.timeline.positionAt(this.now()), this.timeline.duration);
      await this.moveArm(ctx, angle, MotionSpec.armTravelDuration);
      await this.setLift(ctx, 0, MotionSpec.armDropDuration, Easing.easeIn);
      this.setSpin(true);
      this.armFollowsPlayback = true;
      this.phase = 'playing';
    });
  }

  /**
   * 서비스가 다음 곡으로 넘어갔을 때: 바늘을 들어 휴식 위치로 → 디스크 교체 → 지금 재생 위치에 바늘을 내린다.
   * 음악은 멈추지 않는다 (연출만 화면에서 따라간다).
   */
  runTrackAdvance() {
    this.run(async (ctx) => {
      this.phase = 'trackEnded';
      await this.setLift(ctx, 1, 0.2);
      await this.moveArm(ctx, this.rig.geometry.restAngle, MotionSpec.armReturnDuration);
      await this.slideDisc(ctx, -2.6, MotionSpec.recordSwapDuration / 2, Easing.easeIn);
      this.adoptProviderTrack();
      await this.swapIn(ctx);
      this.resumePosition = 0;
      await this.dropOntoPlayback(ctx);
    });
  }

  /** 음악이 이미 나오고 있을 때: 바늘을 (이동 시간 뒤의) 재생 위치로 옮겨 내려놓고 따라가게 한다. seek 없음. */
  async dropOntoPlayback(ctx) {
    if (!(this.timeline.duration > 0)) {
      await this.setLift(ctx, 0, 0.15);
      this.phase = this.timeline.isPlaying ? 'playing' : 'armAtRest';
      return;
    }
    await this.setLift(ctx, 1, 0.15);
    const t = this.now();
    const target = this.timeline.positionAt(t + MotionSpec.armTravelDuration + MotionSpec.armDropDuration);
    await this.moveArm(ctx, this.rig.geometry.angleAtPosition(target, this.timeline.duration), MotionSpec.armTravelDuration);
    await this.setLift(ctx, 0, MotionSpec.armDropDuration, Easing.easeIn);
    this.haptic('medium');
    if (this.timeline.isPlaying) {
      this.startPlayingVisuals();
    } else {
      this.armFollowsPlayback = true;
      this.setSpin(false);
      this.armLift = this.armLift.retargeted(MotionSpec.pausedLift, 0.25, Easing.easeInOut, this.now());
      this.phase = 'paused';
    }
  }

  runQueueFinished() {
    this.run(async (ctx) => {
      this.phase = 'trackEnded';
      this.setSpin(false);
      await this.setLift(ctx, 1, 0.2);
      await this.moveArm(ctx, this.rig.geometry.restAngle, MotionSpec.armReturnDuration);
      await this.setLift(ctx, 0, 0.15);
      this.resumePosition = 0;
      this.phase = 'idle';
      this.showToast('대기열의 마지막 곡이 끝났어요.');
    });
  }

  // ---------- 연출 단계 ----------

  async dropFromRest(ctx, position) {
    if (!(this.timeline.duration > 0)) {
      this.phase = 'armAtRest';
      return;
    }
    this.phase = 'loading';
    await this.setLift(ctx, 1, 0.15);
    await this.moveArm(ctx, this.rig.geometry.angleAtPosition(position, this.timeline.duration), MotionSpec.armTravelDuration);
    await this.dropAndPlay(ctx, position, { kind: 'rest' });
  }

  /** 바늘을 내려놓고 seek 1회 후 재생. 실패하면 이전 위치(또는 휴식 위치)로 되돌린다. */
  async dropAndPlay(ctx, position, fallback) {
    await this.setLift(ctx, 0, MotionSpec.armDropDuration, Easing.easeIn);
    this.haptic('medium');
    try {
      await this.call(ctx, this.provider.seek(position));
      await this.call(ctx, this.provider.play());
    } catch (error) {
      if (error === CANCELLED) throw error;
      this.showToast((error && error.userMessage) || '위치를 옮기지 못했어요. 이전 위치로 돌아갑니다.');
      await this.setLift(ctx, 1, MotionSpec.armLiftDuration);
      if (fallback.kind === 'rest') {
        await this.moveArm(ctx, this.rig.geometry.restAngle, MotionSpec.armRestReturnDuration);
        await this.setLift(ctx, 0, 0.15);
        this.phase = 'armAtRest';
      } else {
        await this.moveArm(ctx, this.rig.geometry.angleAtPosition(fallback.position, this.timeline.duration), 0.35);
        await this.setLift(ctx, 0, MotionSpec.armDropDuration, Easing.easeIn);
        await this.call(ctx, this.provider.play());
        this.timeline = new PlaybackTimeline(fallback.position, this.now(), true, this.timeline.duration);
        this.startPlayingVisuals();
      }
      return;
    }
    // seek이 성공했으니 다음 스냅샷을 기다리지 않고 위치를 맞춘다 (톤암이 잠깐 뒤로 튀지 않게).
    this.timeline = new PlaybackTimeline(position, this.now(), true, this.timeline.duration);
    this.startPlayingVisuals();
  }

  startPlayingVisuals() {
    this.setSpin(true);
    this.armFollowsPlayback = true;
    this.phase = 'playing';
  }

  async liftToRest(ctx) {
    const t = this.now();
    if (Math.abs(this.armAngleAt(t) - this.rig.geometry.restAngle) <= 0.5 && this.armLift.valueAt(t) <= 0.01) return;
    await this.setLift(ctx, 1, 0.15);
    await this.moveArm(ctx, this.rig.geometry.restAngle, 0.5);
    await this.setLift(ctx, 0, 0.12);
  }

  async swapIn(ctx) {
    this.discOffset = Tween.constant(2.6);
    await this.slideDisc(ctx, 0, MotionSpec.recordSwapDuration / 2, Easing.easeOut);
  }

  adoptProviderTrack() {
    const snapshot = this.provider.snapshot;
    this.track = snapshot.track;
    this.timeline = snapshot.timeline;
    this.displayedTrack = snapshot.track;
    this.expectingTrackChange = false;
    this.fadeInLabel();
  }

  beginLift() {
    this.cancelSequence();
    const t = this.now();
    const current = this.armAngleAt(t);
    this.armTween = Tween.constant(current);
    this.armFollowsPlayback = false;
    this.dragAngle = current;
    const wasPlaying = this.timeline.isPlaying;
    if (wasPlaying) this.timeline = this.timeline.pausedAt(t);
    this.setSpin(false);
    this.phase = 'armLifted';
    this.armLift = this.armLift.retargeted(1, MotionSpec.armLiftDuration, Easing.easeInOut, t);
    this.haptic('light');
    if (wasPlaying) this.fireAndForget(this.provider.pause());
  }

  // ---------- 저수준 ----------

  armAngleAt(t) {
    if (this.dragAngle != null) return this.dragAngle;
    if (this.armFollowsPlayback) return this.rig.geometry.angleAtPosition(this.timeline.positionAt(t), this.timeline.duration);
    return this.armTween.valueAt(t);
  }

  get degreesPerSecond() {
    return MotionSpec.degreesPerSecond(this.rpm) * (this._reduceMotion ? MotionSpec.reducedMotionSpeedFactor : 1);
  }

  setSpin(on) {
    this.spin = this.spin.ramp(
      on ? this.degreesPerSecond : 0,
      on ? MotionSpec.spinUpDuration : MotionSpec.spinDownDuration,
      on ? Easing.easeIn : Easing.easeOut,
      this.now(),
    );
  }

  async moveArm(ctx, angle, duration, easing = Easing.easeInOut) {
    const t = this.now();
    this.armTween = new Tween(this.armAngleAt(t), angle, t, duration, easing);
    this.armFollowsPlayback = false;
    await this.wait(ctx, duration);
  }

  async setLift(ctx, value, duration, easing = Easing.easeInOut) {
    this.armLift = this.armLift.retargeted(value, duration, easing, this.now());
    await this.wait(ctx, duration);
  }

  async slideDisc(ctx, offset, duration, easing) {
    this.discOffset = this.discOffset.retargeted(offset, duration, easing, this.now());
    await this.wait(ctx, duration);
  }

  fadeInLabel() {
    this.labelOpacity = new Tween(0, 1, this.now(), MotionSpec.labelFadeDuration);
  }

  haptic(kind) {
    if (this.hapticsEnabled && this.onHaptic) this.onHaptic(kind);
  }

  fireAndForget(promise) {
    Promise.resolve(promise).catch(() => {});
  }

  run(body) {
    this.cancelSequence();
    const ctx = { cancelled: false, promise: null };
    this.sequence = ctx;
    ctx.promise = (async () => {
      try {
        await body(ctx);
      } catch (error) {
        if (error !== CANCELLED) {
          console.warn(error);
          this.showToast((error && error.userMessage) || '재생을 제어하지 못했어요. 다시 시도해 주세요.');
          if (!ctx.cancelled) this.recoverAfterFailure();
        }
      } finally {
        if (this.sequence === ctx) this.sequence = null;
      }
    })();
  }

  /** 시퀀스가 실패로 끝났을 때 화면이 어정쩡한 상태(loading 등)에 남지 않게 한다. */
  recoverAfterFailure() {
    this.expectingTrackChange = false;
    if (this.phase === 'loading' || this.phase === 'trackEnded') {
      const t = this.now();
      this.displayedTrack = this.track;
      this.discOffset = Tween.constant(0);
      this.armTween = new Tween(this.armAngleAt(t), this.rig.geometry.restAngle, t, MotionSpec.armRestReturnDuration);
      this.armFollowsPlayback = false;
      this.armLift = this.armLift.retargeted(0, 0.15, Easing.easeInOut, t);
      this.setSpin(false);
      this.phase = 'armAtRest';
    }
  }

  cancelSequence() {
    if (this.sequence) this.sequence.cancelled = true;
    this.sequence = null;
  }

  check(ctx) {
    if (ctx.cancelled) throw CANCELLED;
  }

  async wait(ctx, seconds) {
    await this.sleep(seconds);
    this.check(ctx);
  }

  async call(ctx, promise) {
    const result = await promise;
    this.check(ctx);
    return result;
  }

  /** 테스트용: 진행 중인 연출이 끝날 때까지 기다린다. */
  async waitForSequence() {
    while (this.sequence) await this.sequence.promise;
  }
}
