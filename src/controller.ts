import { io } from 'socket.io-client';
import { EVENTS, normalizeStationId } from '../shared/protocol.js';

interface ControllerCredentials {
  stationId: string;
  sessionId: string;
  controllerKey: string;
}

interface ClaimResponse {
  ok: boolean;
  reason?: string;
  resumed?: boolean;
  stationId?: string;
  sessionId?: string;
  controllerKey?: string;
  state?: string;
}

const SOCKET_CONNECT_TIMEOUT_MS = 12_000;
const CLAIM_ACK_TIMEOUT_MS = 8_000;
const MAX_RESUME_CLAIM_RETRIES = 8;
// A pairing QR is refreshed after about a minute. Keep retrying for nearly
// that entire window so a Render cold start or a brief desktop reconnect does
// not strand the guest on a manual "retry" screen.
const MAX_STATION_CLAIM_RETRIES = 40;
const DEFAULT_PERMISSION_DESCRIPTION = 'Положите смартфон горизонтально на ладонь экраном вверх и подключите управление.';

const socket = io(window.location.origin, {
  autoConnect: false,
  // Start with HTTP polling and upgrade to WebSocket when the network allows
  // it. Some QR in-app browsers and venue Wi-Fi gateways block direct WS.
  transports: ['polling', 'websocket'],
  upgrade: true,
  reconnection: true,
  reconnectionDelay: 500,
  reconnectionDelayMax: 2_000,
  timeout: 8_000,
});
const query = new URLSearchParams(window.location.search);
const stationId = normalizeStationId(query.get('station'));
const pairingToken = query.get('token') || '';
const resumeStorageKey = `gyro-controller:${stationId}`;

const permissionScreen = requireElement<HTMLElement>('permission-screen');
const permissionDescription = requireElement<HTMLElement>('permission-description');
const dashboardScreen = requireElement<HTMLElement>('dashboard-screen');
const sessionEndedScreen = requireElement<HTMLElement>('session-ended-screen');
const sessionEndedMessage = requireElement<HTMLElement>('session-ended-message');
const btnRequestPermission = requireElement<HTMLButtonElement>('btn-request-permission');
const btnCalibrateMobile = requireElement<HTMLButtonElement>('btn-calibrate-mobile');
const controllerStatusText = requireElement<HTMLElement>('controller-status-text');
const statusBadge = controllerStatusText.closest('.status-badge') as HTMLElement;
const valPitch = requireElement<HTMLElement>('val-pitch');
const valRoll = requireElement<HTMLElement>('val-roll');
const levelBubble = requireElement<HTMLElement>('level-bubble');

const btnDpadUp = requireElement<HTMLButtonElement>('btn-dpad-up');
const btnDpadDown = requireElement<HTMLButtonElement>('btn-dpad-down');
const btnDpadLeft = requireElement<HTMLButtonElement>('btn-dpad-left');
const btnDpadRight = requireElement<HTMLButtonElement>('btn-dpad-right');

let offsetBeta = 0;
let offsetGamma = 0;
let offsetAlpha = 0;
let isCalibrated = false;
let sensorBeta = 0;
let sensorGamma = 0;
let sensorAlpha = 0;
let hasSensor = false;
let trackingStarted = false;
let sessionActive = false;
let claimInFlight = false;
let telemetrySequence = 0;
let telemetryTimer: number | null = null;
let lastTelemetryUpdate = performance.now();
let credentials = readStoredCredentials();
let claimRetryTimer: number | null = null;
let claimRetryCount = 0;
let lastSocketError = '';
let sessionFinished = false;

const activeDirections = { up: false, down: false, left: false, right: false };
let manualBeta = 0;
let manualGamma = 0;
let wakeLock: WakeLockSentinel | null = null;

socket.on('connect', () => {
  lastSocketError = '';
  if (trackingStarted) void claimController().catch(handleClaimFailure);
});

socket.on('disconnect', (reason) => {
  if (!trackingStarted || !credentials) return;
  sessionActive = false;
  claimRetryCount = 0;
  setConnectionStatus('ВОССТАНАВЛИВАЕМ СВЯЗЬ', true);
  if (reason === 'io server disconnect') {
    window.setTimeout(() => socket.connect(), 500);
  }
});

socket.on('connect_error', (error) => {
  lastSocketError = error.message;
  if (!trackingStarted || sessionActive) return;
  showReconnectProgress(connectionWaitMessage());
});

socket.on(EVENTS.CALIBRATE_REQUEST, () => {
  isCalibrated = false;
});

socket.on(EVENTS.SESSION_STATE, (payload: { state?: string; stationOnline?: boolean }) => {
  if (payload.stationOnline === false) {
    setConnectionStatus('ЭКРАН ПЕРЕПОДКЛЮЧАЕТСЯ', true);
    sessionActive = false;
    return;
  }
  if (payload.state === 'calibrating' || payload.state === 'countdown' || payload.state === 'playing') {
    sessionActive = true;
  }
  if (payload.state === 'playing') setConnectionStatus('УПРАВЛЕНИЕ АКТИВНО');
  if (payload.state === 'paused') setConnectionStatus('ВОССТАНАВЛИВАЕМ СВЯЗЬ', true);
});

socket.on(EVENTS.SESSION_ENDED, (payload: { reason?: string }) => {
  endControllerSession(payload.reason);
});

btnRequestPermission.addEventListener('click', async () => {
  clearClaimRetry();
  claimRetryCount = 0;
  btnRequestPermission.disabled = true;
  permissionDescription.classList.remove('error');
  try {
    showConnectingState('Разрешите доступ к датчикам движения…', 'Ожидаем разрешение…');
    await requestOrientationPermission();
    startOrientationTracking();
    showConnectingState('Подключаем смартфон к игровому экрану…');
    await claimController();
  } catch (error) {
    handleClaimFailure(error);
  } finally {
    if (!sessionActive && claimRetryTimer === null) btnRequestPermission.disabled = false;
  }
});

btnCalibrateMobile.addEventListener('click', () => {
  isCalibrated = false;
  if (sessionActive) socket.emit(EVENTS.CALIBRATE);
});

bindDpad(btnDpadUp, 'up');
bindDpad(btnDpadDown, 'down');
bindDpad(btnDpadLeft, 'left');
bindDpad(btnDpadRight, 'right');

window.addEventListener('blur', clearManualDirections);
document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState === 'visible' && sessionActive) await requestWakeLock();
});

async function requestOrientationPermission() {
  if (typeof DeviceOrientationEvent === 'undefined') return;
  const orientationEvent = DeviceOrientationEvent as typeof DeviceOrientationEvent & {
    requestPermission?: () => Promise<'granted' | 'denied'>;
  };
  if (typeof orientationEvent.requestPermission !== 'function') return;
  const state = await orientationEvent.requestPermission();
  if (state !== 'granted') {
    throw new Error('Доступ к датчикам отклонён. Можно повторить или использовать экранные стрелки.');
  }
}

function startOrientationTracking() {
  if (trackingStarted) return;
  trackingStarted = true;
  window.addEventListener('deviceorientation', handleOrientation);
  telemetryTimer = window.setInterval(updateTelemetry, 33);
  void requestWakeLock();
}

async function claimController() {
  if (claimInFlight || sessionActive || !trackingStarted) return;
  if (!pairingToken && !credentials) {
    throw new Error('В QR-коде нет данных сессии. Отсканируйте новый QR на игровом экране.');
  }
  claimInFlight = true;
  try {
    if (!socket.connected) await waitForSocketConnection(SOCKET_CONNECT_TIMEOUT_MS);
    const attemptingResume = Boolean(credentials);
    const response = await emitWithAck<ClaimResponse>(EVENTS.CLAIM_CONTROLLER, {
      stationId,
      token: pairingToken || undefined,
      sessionId: credentials?.sessionId,
      controllerKey: credentials?.controllerKey,
    }, CLAIM_ACK_TIMEOUT_MS);
    if (!response.ok || !response.sessionId || !response.controllerKey) {
      const retryable = response.reason === 'station-offline'
        || (response.reason === 'session-busy' && attemptingResume);
      if (retryable && scheduleClaimRetry(response.reason)) return;
      if (response.reason === 'token-expired-or-used') {
        clearStoredCredentials();
      }
      throw new Error(claimErrorMessage(response.reason));
    }

    clearClaimRetry();
    claimRetryCount = 0;
    credentials = {
      stationId: response.stationId || stationId,
      sessionId: response.sessionId,
      controllerKey: response.controllerKey,
    };
    storeCredentials(credentials);
    sessionActive = true;
    isCalibrated = false;
    telemetrySequence = 0;
    permissionScreen.classList.add('hidden');
    permissionScreen.setAttribute('aria-busy', 'false');
    sessionEndedScreen.classList.add('hidden');
    dashboardScreen.classList.remove('hidden');
    btnRequestPermission.disabled = false;
    setConnectionStatus(response.resumed ? 'СВЯЗЬ ВОССТАНОВЛЕНА' : 'СВЯЗЬ АКТИВНА');
  } finally {
    claimInFlight = false;
  }
}

function scheduleClaimRetry(reason?: string) {
  const maxRetries = reason === 'station-offline'
    ? MAX_STATION_CLAIM_RETRIES
    : MAX_RESUME_CLAIM_RETRIES;
  if (claimRetryTimer !== null || claimRetryCount >= maxRetries) return false;
  const delayMs = Math.min(500 + claimRetryCount * 350, 2_000);
  claimRetryCount += 1;
  sessionActive = false;
  if (dashboardScreen.classList.contains('hidden')) {
    showConnectingState(reason === 'station-offline'
      ? 'Ждём готовности игрового экрана. Подключение продолжится автоматически…'
      : 'Восстанавливаем предыдущую сессию…');
  } else {
    setConnectionStatus('ВОССТАНАВЛИВАЕМ СВЯЗЬ', true);
  }
  claimRetryTimer = window.setTimeout(() => {
    claimRetryTimer = null;
    void claimController().catch(handleClaimFailure);
  }, delayMs);
  return true;
}

function clearClaimRetry() {
  if (claimRetryTimer !== null) window.clearTimeout(claimRetryTimer);
  claimRetryTimer = null;
}

function handleClaimFailure(error: unknown) {
  clearClaimRetry();
  const message = error instanceof Error ? error.message : 'Не удалось подключить управление.';
  showClaimError(message);
}

function handleOrientation(event: DeviceOrientationEvent) {
  if (event.beta === null || event.gamma === null) return;
  const orientationAngle = screen.orientation?.angle ?? (window as unknown as { orientation?: number }).orientation ?? 0;
  const normalizedAngle = ((orientationAngle % 360) + 360) % 360;
  hasSensor = true;
  if (event.alpha !== null) sensorAlpha = event.alpha;

  if (normalizedAngle === 90) {
    sensorBeta = -event.gamma;
    sensorGamma = event.beta;
  } else if (normalizedAngle === 270) {
    sensorBeta = event.gamma;
    sensorGamma = -event.beta;
  } else if (normalizedAngle === 180) {
    sensorBeta = -event.beta;
    sensorGamma = -event.gamma;
  } else {
    sensorBeta = event.beta;
    sensorGamma = event.gamma;
  }
}

function updateTelemetry() {
  const now = performance.now();
  const dt = Math.min((now - lastTelemetryUpdate) / 1000, 0.1);
  lastTelemetryUpdate = now;
  updateManualTilt(dt);

  let relBeta = 0;
  let relGamma = 0;
  let relAlpha = 0;
  if (hasSensor) {
    if (!isCalibrated) {
      offsetBeta = sensorBeta;
      offsetGamma = sensorGamma;
      offsetAlpha = sensorAlpha;
      isCalibrated = true;
    }
    relBeta = wrapAngle(sensorBeta - offsetBeta, 180);
    relGamma = wrapAngle(sensorGamma - offsetGamma, 90);
    relAlpha = wrapAngle(sensorAlpha - offsetAlpha, 180);
  }

  const maxTilt = 35;
  const clampedBeta = clamp(relBeta + manualBeta, -maxTilt, maxTilt);
  const clampedGamma = clamp(relGamma + manualGamma, -maxTilt, maxTilt);
  updateTelemetryUi(clampedBeta, clampedGamma, maxTilt);

  if (!sessionActive || !socket.connected || !credentials) return;
  socket.volatile.emit(EVENTS.GYRO_DATA, {
    beta: clampedBeta / maxTilt,
    gamma: clampedGamma / maxTilt,
    alpha: relAlpha,
    sequence: telemetrySequence++,
    sentAt: Date.now(),
  });
}

function updateManualTilt(dt: number) {
  const tiltRate = 66;
  const returnRate = 84;
  manualBeta = updateAxis(manualBeta, activeDirections.up, activeDirections.down, tiltRate, returnRate, dt);
  manualGamma = updateAxis(manualGamma, activeDirections.right, activeDirections.left, tiltRate, returnRate, dt);
}

function updateAxis(value: number, positive: boolean, negative: boolean, rate: number, returnRate: number, dt: number) {
  if (positive) return Math.min(30, value + rate * dt);
  if (negative) return Math.max(-30, value - rate * dt);
  if (value > 0) return Math.max(0, value - returnRate * dt);
  if (value < 0) return Math.min(0, value + returnRate * dt);
  return value;
}

function updateTelemetryUi(beta: number, gamma: number, maxTilt: number) {
  valPitch.textContent = `${beta.toFixed(1)}°`;
  valRoll.textContent = `${gamma.toFixed(1)}°`;
  const maxDisplacement = 78;
  let x = (gamma / maxTilt) * maxDisplacement;
  let y = (beta / maxTilt) * maxDisplacement;
  const distance = Math.hypot(x, y);
  if (distance > maxDisplacement) {
    x = (x / distance) * maxDisplacement;
    y = (y / distance) * maxDisplacement;
  }
  levelBubble.style.transform = `translate(${x}px, ${y}px)`;
}

function bindDpad(button: HTMLElement, direction: keyof typeof activeDirections) {
  button.addEventListener('pointerdown', (event) => {
    activeDirections[direction] = true;
    button.setPointerCapture?.(event.pointerId);
    event.preventDefault();
  });
  const release = (event: PointerEvent) => {
    activeDirections[direction] = false;
    event.preventDefault();
  };
  button.addEventListener('pointerup', release);
  button.addEventListener('pointercancel', release);
  button.addEventListener('lostpointercapture', release);
}

async function requestWakeLock() {
  if (
    !('wakeLock' in navigator)
    || document.visibilityState !== 'visible'
    || (wakeLock && !wakeLock.released)
  ) return;
  try {
    wakeLock = await navigator.wakeLock.request('screen');
  } catch {
    wakeLock = null;
  }
}

function endControllerSession(reason?: string) {
  sessionActive = false;
  sessionFinished = true;
  clearClaimRetry();
  clearStoredCredentials();
  clearManualDirections();
  stopOrientationTracking();
  dashboardScreen.classList.add('hidden');
  permissionScreen.classList.add('hidden');
  sessionEndedScreen.classList.remove('hidden');
  sessionEndedMessage.textContent = reason === 'disconnect-timeout'
    ? 'Связь не восстановилась вовремя. Отсканируйте новый QR-код на игровом экране.'
    : 'Сессия завершена. Передайте очередь следующему гостю — ему понадобится новый QR-код на экране.';
  void wakeLock?.release().catch(() => {});
  wakeLock = null;
  socket.disconnect();
}

function showClaimError(message: string) {
  sessionActive = false;
  dashboardScreen.classList.add('hidden');
  sessionEndedScreen.classList.add('hidden');
  permissionScreen.classList.remove('hidden');
  permissionScreen.setAttribute('aria-busy', 'false');
  permissionDescription.textContent = message;
  permissionDescription.classList.remove('connecting');
  permissionDescription.classList.add('error');
  btnRequestPermission.textContent = 'Повторить подключение';
  btnRequestPermission.disabled = false;
}

function showConnectingState(message: string, buttonText = 'Подключаем…') {
  dashboardScreen.classList.add('hidden');
  sessionEndedScreen.classList.add('hidden');
  permissionScreen.classList.remove('hidden');
  permissionScreen.setAttribute('aria-busy', 'true');
  permissionDescription.textContent = message;
  permissionDescription.classList.remove('error');
  permissionDescription.classList.add('connecting');
  btnRequestPermission.textContent = buttonText;
  btnRequestPermission.disabled = true;
}

function showReconnectProgress(message: string) {
  if (dashboardScreen.classList.contains('hidden')) showConnectingState(message);
  else setConnectionStatus('ВОССТАНАВЛИВАЕМ СВЯЗЬ', true);
}

function setConnectionStatus(text: string, reconnecting = false) {
  controllerStatusText.textContent = text;
  statusBadge.classList.toggle('reconnecting', reconnecting);
}

function clearManualDirections() {
  Object.keys(activeDirections).forEach((key) => {
    activeDirections[key as keyof typeof activeDirections] = false;
  });
  manualBeta = 0;
  manualGamma = 0;
}

function stopOrientationTracking() {
  if (!trackingStarted) return;
  trackingStarted = false;
  window.removeEventListener('deviceorientation', handleOrientation);
  if (telemetryTimer !== null) window.clearInterval(telemetryTimer);
  telemetryTimer = null;
}

function readStoredCredentials(): ControllerCredentials | null {
  try {
    const parsed = JSON.parse(sessionStorage.getItem(resumeStorageKey) || 'null') as ControllerCredentials | null;
    return parsed?.stationId === stationId && parsed.sessionId && parsed.controllerKey ? parsed : null;
  } catch {
    return null;
  }
}

function storeCredentials(value: ControllerCredentials) {
  try {
    sessionStorage.setItem(resumeStorageKey, JSON.stringify(value));
  } catch {
    // Some embedded/private mobile browsers block storage. The in-memory
    // credentials still keep the current controller session functional.
  }
}

function clearStoredCredentials() {
  credentials = null;
  try {
    sessionStorage.removeItem(resumeStorageKey);
  } catch {
    // Storage can be unavailable in private/embedded browser modes.
  }
}

function claimErrorMessage(reason?: string) {
  if (reason === 'station-offline') return 'Игровой экран ещё не готов. Подождите несколько секунд и повторите.';
  if (reason === 'session-busy') return 'К игре уже подключён другой смартфон. Дождитесь нового QR-кода.';
  if (reason === 'token-expired-or-used') return 'Этот QR-код уже использован или устарел. Отсканируйте новый QR-код.';
  return 'Не удалось подключить смартфон. Повторите попытку.';
}

function emitWithAck<T>(event: string, payload: unknown, timeoutMs = 5_000): Promise<T> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = window.setTimeout(() => {
      settled = true;
      reject(new Error('Сервер не ответил вовремя. Повторите подключение.'));
    }, timeoutMs);
    socket.emit(event, payload, (response: T) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      resolve(response);
    });
  });
}

function waitForSocketConnection(timeoutMs: number) {
  if (socket.connected) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      window.clearTimeout(timer);
      socket.off('connect', handleConnect);
      socket.off('connect_error', handleConnectError);
    };
    const handleConnect = () => {
      cleanup();
      resolve();
    };
    const handleConnectError = (error: Error) => {
      lastSocketError = error.message;
      showReconnectProgress(connectionWaitMessage());
    };
    const timer = window.setTimeout(() => {
      cleanup();
      reject(new Error(connectionWaitMessage(true)));
    }, timeoutMs);
    socket.on('connect', handleConnect);
    socket.on('connect_error', handleConnectError);
    socket.connect();
  });
}

function connectionWaitMessage(timedOut = false) {
  if (!navigator.onLine) return 'На смартфоне нет подключения к интернету. Проверьте Wi‑Fi и повторите.';
  if (timedOut) return 'Игровой сервер не ответил. Проверьте сеть и повторите подключение.';
  return lastSocketError
    ? 'Не удаётся связаться с игровым сервером. Повторяем подключение…'
    : 'Подключаем смартфон к игровому экрану…';
}

function wrapAngle(value: number, halfRange: number) {
  const fullRange = halfRange * 2;
  while (value > halfRange) value -= fullRange;
  while (value < -halfRange) value += fullRange;
  return value;
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function requireElement<T extends HTMLElement>(id: string) {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Required element #${id} is missing`);
  return element as T;
}

window.addEventListener('offline', () => {
  if (trackingStarted && !sessionActive) showReconnectProgress(connectionWaitMessage());
  if (sessionActive) setConnectionStatus('НЕТ СЕТИ', true);
});

window.addEventListener('online', () => {
  if (sessionFinished) return;
  lastSocketError = '';
  if (!socket.connected) socket.connect();
  if (trackingStarted && !sessionActive) {
    showReconnectProgress('Сеть восстановлена. Подключаемся…');
  } else if (!trackingStarted) {
    permissionDescription.textContent = DEFAULT_PERMISSION_DESCRIPTION;
    permissionDescription.classList.remove('error', 'connecting');
  }
});

window.addEventListener('pageshow', () => {
  if (!sessionFinished && (pairingToken || credentials) && !socket.connected) socket.connect();
});

if (!pairingToken && !credentials) {
  showClaimError('Откройте контроллер через QR-код на игровом экране.');
} else {
  // Warm up the same-origin Render WebSocket only after all handlers exist.
  socket.connect();
}

window.addEventListener('beforeunload', () => {
  clearClaimRetry();
  stopOrientationTracking();
  void wakeLock?.release().catch(() => {});
});
