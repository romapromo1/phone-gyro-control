export type GameSessionState =
  | 'attract'
  | 'pairing'
  | 'calibrating'
  | 'countdown'
  | 'playing'
  | 'paused'
  | 'result';

export interface SessionTick {
  countdownCompleted: boolean;
  timedOut: boolean;
  remainingMs: number;
  countdownMs: number;
}

export class GameSession {
  state: GameSessionState = 'attract';
  readonly durationMs: number;
  readonly countdownDurationMs: number;
  private deadline = 0;
  private countdownDeadline = 0;
  private pausedFrom: GameSessionState | null = null;
  private pausedRemainingMs = 0;
  private pausedCountdownMs = 0;
  private finalElapsedMs = 0;

  constructor(durationMs: number, countdownDurationMs: number) {
    this.durationMs = durationMs;
    this.countdownDurationMs = countdownDurationMs;
  }

  enterAttract() {
    this.state = 'attract';
    this.clearRuntime();
  }

  enterPairing() {
    this.state = 'pairing';
    this.clearRuntime();
  }

  controllerConnected() {
    if (this.state === 'pairing' || this.state === 'paused') {
      this.state = 'calibrating';
    }
  }

  beginCountdown(now: number) {
    if (this.state !== 'calibrating') return false;
    this.state = 'countdown';
    this.countdownDeadline = now + this.countdownDurationMs;
    return true;
  }

  startPlaying(now: number) {
    if (this.state !== 'countdown' && this.state !== 'calibrating') return false;
    this.state = 'playing';
    this.deadline = now + this.durationMs;
    this.countdownDeadline = 0;
    this.finalElapsedMs = 0;
    return true;
  }

  pause(now: number) {
    if (this.state !== 'playing' && this.state !== 'countdown') return false;
    this.pausedFrom = this.state;
    this.pausedRemainingMs = this.state === 'playing' ? Math.max(0, this.deadline - now) : 0;
    this.pausedCountdownMs = this.state === 'countdown' ? Math.max(0, this.countdownDeadline - now) : 0;
    this.state = 'paused';
    return true;
  }

  resume(now: number) {
    if (this.state !== 'paused' || !this.pausedFrom) return false;
    const targetState = this.pausedFrom;
    this.pausedFrom = null;
    this.state = targetState;
    if (targetState === 'playing') this.deadline = now + this.pausedRemainingMs;
    if (targetState === 'countdown') this.countdownDeadline = now + this.pausedCountdownMs;
    return true;
  }

  finish(now: number) {
    if (this.state === 'playing') {
      this.finalElapsedMs = this.durationMs - Math.max(0, this.deadline - now);
    }
    this.state = 'result';
  }

  tick(now: number): SessionTick {
    const countdownMs = this.state === 'countdown' ? Math.max(0, this.countdownDeadline - now) : 0;
    const remainingMs = this.remainingMs(now);
    return {
      countdownCompleted: this.state === 'countdown' && countdownMs <= 0,
      timedOut: this.state === 'playing' && remainingMs <= 0,
      remainingMs,
      countdownMs,
    };
  }

  remainingMs(now: number) {
    if (this.state === 'playing') return Math.max(0, this.deadline - now);
    if (this.state === 'paused' && this.pausedFrom === 'playing') return this.pausedRemainingMs;
    return this.state === 'result' ? Math.max(0, this.durationMs - this.finalElapsedMs) : this.durationMs;
  }

  elapsedMs(now: number) {
    if (this.state === 'result') return this.finalElapsedMs;
    return this.durationMs - this.remainingMs(now);
  }

  isPlaying() {
    return this.state === 'playing';
  }

  private clearRuntime() {
    this.deadline = 0;
    this.countdownDeadline = 0;
    this.pausedFrom = null;
    this.pausedRemainingMs = 0;
    this.pausedCountdownMs = 0;
    this.finalElapsedMs = 0;
  }
}
