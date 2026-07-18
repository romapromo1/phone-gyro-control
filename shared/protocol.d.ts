export const EVENTS: Readonly<{
  REGISTER_DESKTOP: 'register-desktop';
  CLAIM_CONTROLLER: 'claim-controller';
  CONTROLLER_STATUS: 'controller-status';
  GYRO_DATA: 'gyro-data';
  GYRO_UPDATE: 'gyro-update';
  CALIBRATE: 'calibrate';
  CALIBRATE_REQUEST: 'calibrate-request';
  SESSION_COMMAND: 'session-command';
  SESSION_STATE: 'session-state';
  SESSION_ENDED: 'session-ended';
}>;

export const SESSION_STATES: Readonly<Record<'ATTRACT' | 'PAIRING' | 'CALIBRATING' | 'COUNTDOWN' | 'PLAYING' | 'PAUSED' | 'RESULT' | 'RESETTING', string>>;
export const SESSION_COMMANDS: Readonly<Record<'PAIR' | 'PLAYING' | 'FINISH', string>>;

export interface GyroPayload {
  beta: number;
  gamma: number;
  alpha: number;
  sequence: number;
  sentAt: number;
}

export function normalizeStationId(value: unknown, fallback?: string): string;
export function normalizeDesktopRegistration(payload: unknown): { stationId: string; instanceId: string | null } | null;
export function normalizeControllerClaim(payload: unknown): {
  stationId: string;
  token: string | null;
  sessionId: string | null;
  controllerKey: string | null;
} | null;
export function normalizeGyroPayload(payload: unknown): GyroPayload | null;
export function normalizeSessionCommand(payload: unknown): {
  stationId: string;
  action: string;
  result?: { isWin: boolean; savesCollected: number; elapsedMs: number };
} | null;
