export const EVENTS = Object.freeze({
  REGISTER_DESKTOP: 'register-desktop',
  CLAIM_CONTROLLER: 'claim-controller',
  CONTROLLER_STATUS: 'controller-status',
  GYRO_DATA: 'gyro-data',
  GYRO_UPDATE: 'gyro-update',
  CALIBRATE: 'calibrate',
  CALIBRATE_REQUEST: 'calibrate-request',
  SESSION_COMMAND: 'session-command',
  SESSION_STATE: 'session-state',
  SESSION_ENDED: 'session-ended',
});

export const SESSION_STATES = Object.freeze({
  ATTRACT: 'attract',
  PAIRING: 'pairing',
  CALIBRATING: 'calibrating',
  COUNTDOWN: 'countdown',
  PLAYING: 'playing',
  PAUSED: 'paused',
  RESULT: 'result',
  RESETTING: 'resetting',
});

export const SESSION_COMMANDS = Object.freeze({
  PAIR: 'pair',
  PLAYING: 'playing',
  FINISH: 'finish',
});

const STATION_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/i;
const TOKEN_PATTERN = /^[a-zA-Z0-9_-]{16,256}$/;

export function normalizeStationId(value, fallback = 'main') {
  return typeof value === 'string' && STATION_ID_PATTERN.test(value) ? value : fallback;
}

export function normalizeDesktopRegistration(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const instanceId = typeof payload.instanceId === 'string' && TOKEN_PATTERN.test(payload.instanceId)
    ? payload.instanceId
    : null;
  return { stationId: normalizeStationId(payload.stationId), instanceId };
}

export function normalizeControllerClaim(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const stationId = normalizeStationId(payload.stationId);
  const token = typeof payload.token === 'string' && TOKEN_PATTERN.test(payload.token)
    ? payload.token
    : null;
  const sessionId = typeof payload.sessionId === 'string' && TOKEN_PATTERN.test(payload.sessionId)
    ? payload.sessionId
    : null;
  const controllerKey = typeof payload.controllerKey === 'string' && TOKEN_PATTERN.test(payload.controllerKey)
    ? payload.controllerKey
    : null;

  if (!token && !(sessionId && controllerKey)) return null;
  return { stationId, token, sessionId, controllerKey };
}

export function normalizeGyroPayload(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const beta = payload.beta;
  const gamma = payload.gamma;
  const alpha = payload.alpha === undefined ? 0 : payload.alpha;
  const sequence = payload.sequence;
  const sentAt = payload.sentAt;

  if (![beta, gamma, alpha, sequence, sentAt].every((value) => typeof value === 'number' && Number.isFinite(value))) return null;
  if (!Number.isSafeInteger(sequence) || sequence < 0) return null;

  return {
    beta: clamp(beta, -1, 1),
    gamma: clamp(gamma, -1, 1),
    alpha: clamp(alpha, -180, 180),
    sequence,
    sentAt,
  };
}

export function normalizeSessionCommand(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const stationId = normalizeStationId(payload.stationId);
  const action = payload.action;
  if (!Object.values(SESSION_COMMANDS).includes(action)) return null;

  const result = payload.result && typeof payload.result === 'object'
    ? {
        isWin: Boolean(payload.result.isWin),
        savesCollected: clampInteger(payload.result.savesCollected, 0, 100),
        elapsedMs: clampInteger(payload.result.elapsedMs, 0, 60 * 60 * 1000),
      }
    : undefined;

  return { stationId, action, result };
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function clampInteger(value, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return min;
  return Math.max(min, Math.min(max, Math.round(number)));
}
