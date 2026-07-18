import * as THREE from 'three';
import type RAPIER_TYPES from '@dimforge/rapier3d-compat';
import { io } from 'socket.io-client';
import { EVENTS, SESSION_COMMANDS } from '../shared/protocol.js';
import { AssetManager } from './game/AssetManager';
import { GameSession } from './game/GameSession';
import {
  COUNTDOWN_DURATION_MS,
  GAME_DURATION_MS,
  LEVELS,
  RESULT_DISPLAY_MS,
  STATION_ID,
} from './game/config';
import { disposeObject, removeNamedChildren } from './game/dispose';
import {
  TEAMS,
  TeamSelection3D,
  type TeamCameraView,
  type TeamDefinition,
} from './experience/TeamSelection3D';
import { StartSaveDecorations } from './experience/StartSaveDecorations';
import { submitTeamGeneration } from './experience/teamGenerationService';
import {
  SCENE_EDITOR_STORAGE_KEY,
  SceneEditorPanel,
  type EditorField,
  type EditorTarget,
} from './editor/SceneEditorPanel';

const KIOSK_TOKEN_STORAGE_KEY = 'gyro-kiosk-token';
const KIOSK_TOKEN_PATTERN = /^[\x21-\x7e]{16,512}$/;
const kioskToken = readKioskToken();
const desktopInstanceId = crypto.randomUUID();

// Connect only after the one-time kiosk activation fragment has been read.
// This prevents the first Socket.IO registration from racing token storage.
const socket = io({
  // Use polling for the initial handshake and upgrade to WebSocket. This
  // keeps the kiosk registered on venue networks that block direct WS.
  transports: ['polling', 'websocket'],
  upgrade: true,
  reconnection: true,
  reconnectionDelayMax: 2_000,
});

// Logging helper to relay browser logs to the Node.js server terminal
function debugLog(msg: string) {
  if (import.meta.env.DEV) console.debug(msg);
}

function getBrowserStorage(name: 'localStorage' | 'sessionStorage') {
  try {
    return window[name];
  } catch {
    return null;
  }
}

function readStorageToken(storage: Storage | null) {
  if (!storage) return '';
  try {
    const value = storage.getItem(KIOSK_TOKEN_STORAGE_KEY) || '';
    return KIOSK_TOKEN_PATTERN.test(value) ? value : '';
  } catch {
    return '';
  }
}

function persistKioskToken(value: string) {
  // The installation runs in a dedicated kiosk browser profile. localStorage
  // keeps the activation across tab/browser restarts; sessionStorage remains a
  // fallback for privacy modes that reject persistent storage.
  for (const storage of [getBrowserStorage('localStorage'), getBrowserStorage('sessionStorage')]) {
    if (!storage) continue;
    try {
      storage.setItem(KIOSK_TOKEN_STORAGE_KEY, value);
    } catch {
      // Continue with the other storage backend.
    }
  }
}

function readKioskToken() {
  const supplied = readKioskActivationFragment(window.location.hash);
  if (supplied) {
    history.replaceState(null, '', `${window.location.pathname}${window.location.search}`);
    if (KIOSK_TOKEN_PATTERN.test(supplied)) {
      persistKioskToken(supplied);
      return supplied;
    }
    console.error('Kiosk activation token has an invalid format.');
  }

  const persistentToken = readStorageToken(getBrowserStorage('localStorage'));
  if (persistentToken) return persistentToken;

  const sessionToken = readStorageToken(getBrowserStorage('sessionStorage'));
  if (sessionToken) persistKioskToken(sessionToken);
  return sessionToken;
}

function readKioskActivationFragment(hash: string) {
  const match = hash.replace(/^#/, '').match(/(?:^|&)kiosk=([^&]*)/);
  if (!match) return '';
  try {
    // URLSearchParams turns a literal "+" into a space, which corrupts
    // base64-style Render secrets copied directly into the fragment.
    return decodeURIComponent(match[1]);
  } catch {
    console.error('Kiosk activation token is not URL encoded correctly.');
    return '';
  }
}

// UI Elements
const pairingOverlay = document.getElementById('pairing-overlay') as HTMLElement;
const hudOverlay = document.getElementById('hud-overlay') as HTMLElement;
const qrCodeImg = document.getElementById('qr-code') as HTMLImageElement;
const controllerUrlCode = document.getElementById('controller-url') as HTMLElement;
const gameLoadingOverlay = document.getElementById('game-loading-overlay') as HTMLElement;
const gameLoadingSpinner = document.getElementById('game-loading-spinner') as HTMLElement;
const gameLoadingError = document.getElementById('game-loading-error') as HTMLElement;
const btnRetryGameLoad = document.getElementById('btn-retry-game-load') as HTMLButtonElement;
const btnResetAfterLoadError = document.getElementById('btn-reset-after-load-error') as HTMLButtonElement;
const gameInstructionOverlay = document.getElementById('game-instruction-overlay') as HTMLElement;
const btnStartLabyrinth = document.getElementById('btn-start-labyrinth') as HTMLButtonElement;
const saveProgressOverlay = document.getElementById('save-progress-overlay') as HTMLElement;
const saveProgressMessage = document.getElementById('save-progress-message') as HTMLElement;
const btnViewGeneratedImage = document.getElementById('btn-view-generated-image') as HTMLButtonElement;
const generatedImageOverlay = document.getElementById('generated-image-overlay') as HTMLElement;
const generatedTeamImage = document.getElementById('generated-team-image') as HTMLImageElement;
const btnCloseGeneratedImage = document.getElementById('btn-close-generated-image') as HTMLButtonElement;
const btnDownloadGeneratedImage = document.getElementById('btn-download-generated-image') as HTMLButtonElement;
const currentLevelSpan = document.getElementById('current-level') as HTMLElement;
const btnCalibrate = document.getElementById('btn-calibrate-desktop') as HTMLButtonElement;
const btnRestart = document.getElementById('btn-restart') as HTMLButtonElement;
const victoryOverlay = document.getElementById('victory-overlay') as HTMLElement;
const btnPrevLevel = document.getElementById('btn-prev-level') as HTMLButtonElement;
const btnNextLevel = document.getElementById('btn-next-level') as HTMLButtonElement;
const connectionIndicator = document.getElementById('connection-indicator') as HTMLElement;
const connectionStatusText = document.getElementById('connection-status-text') as HTMLElement;
const settingsTrigger = document.getElementById('settings-trigger') as HTMLButtonElement;
const settingsPanel = document.getElementById('settings-panel') as HTMLElement;
const settingsClose = document.getElementById('settings-close') as HTMLButtonElement;

// New HUD elements Binds
const timerSpan = document.getElementById('game-timer') as HTMLElement;

const btnHudRestart = document.getElementById('btn-hud-restart') as HTMLButtonElement;
const modalTitle = document.getElementById('modal-title') as HTMLElement;
const modalSubtitle = document.getElementById('modal-subtitle') as HTMLElement;

// Start Screen elements
const startOverlay = document.getElementById('start-overlay') as HTMLElement;
const btnStartGame = document.getElementById('btn-start-game') as HTMLButtonElement;
const teamSelectionOverlay = document.getElementById('team-selection-overlay') as HTMLElement;
const btnOpenCamera = document.getElementById('btn-open-camera') as HTMLButtonElement;
const photoOverlay = document.getElementById('photo-overlay') as HTMLElement;
const cameraVideo = document.getElementById('camera-video') as HTMLVideoElement;
const cameraPreview = document.getElementById('camera-preview') as HTMLImageElement;
const cameraCapture = document.getElementById('camera-capture') as HTMLCanvasElement;
const cameraStatus = document.getElementById('camera-status') as HTMLElement;
const cameraFlash = document.getElementById('camera-flash') as HTMLElement;
const cameraCountdown = document.getElementById('camera-countdown') as HTMLElement;
const btnCapturePhoto = document.getElementById('btn-capture-photo') as HTMLButtonElement;
const btnRetakePhoto = document.getElementById('btn-retake-photo') as HTMLButtonElement;
const btnConfirmPhoto = document.getElementById('btn-confirm-photo') as HTMLButtonElement;



const assetManager = new AssetManager(LEVELS);
const gameSession = new GameSession(GAME_DURATION_MS, COUNTDOWN_DURATION_MS);
let RAPIER: typeof RAPIER_TYPES;
let gameRuntimePromise: Promise<void> | null = null;
let currentMazeIndex = 0;
let isAnimating = false; // prevent calling animate() multiple times

// Game mode state variables
let savesCollected = 0;
const totalSavesGoal = 4;
let gameTimeLeft = 60.0;
let isGameActive = false;
let currentControllerSessionId: string | null = null;
let sessionPreparationInFlight = false;
let resultResetTimer: number | null = null;
let pairingRefreshTimer: number | null = null;
let pairingRequestAbortController: AbortController | null = null;
let pairingSyncPromise: Promise<void> | null = null;
let pairingSyncQueued = false;
let pairingServerResetPending = false;
let desktopSocketRegistered = false;
let desktopRegistrationFailure: string | null = null;
let lifecycleVersion = 0;
type ExperienceScreen = 'start' | 'transition' | 'team' | 'photo' | 'labyrinth';
let experienceScreen: ExperienceScreen = 'start';
let teamSelection: TeamSelection3D | null = null;
let startSaveDecorations: StartSaveDecorations | null = null;
let selectedTeam: TeamDefinition | null = null;
let cameraStream: MediaStream | null = null;
let capturedPhotoDataUrl = '';
let photoCaptureInFlight = false;
let generationAbortController: AbortController | null = null;
let cameraStatusTimer: number | null = null;
let photoCountdownVersion = 0;
let gameReadyForManualStart = false;
let saveCelebrationActive = false;
let saveCelebrationTimer: number | null = null;
let pendingPostSaveAction: number | 'finish' | null = null;
let generatedImageRequestVersion = 0;
let generatedTeamImageUrl = '';
let generatedImageViewerOpen = false;
let generatedImageViewerPausedGame = false;

// Transition and save object state
let saveMesh: THREE.Group | null = null;
let saveEditorRoot: THREE.Group | null = null;
const customSaveCoordinates: { [key: number]: { x: number, z: number } } = {};

// Football and Gates Templates & State
let isSaveCollected = false;


// Start Screen State
let isStartScreenActive = false;

let isTransitioning = false;
let transitionTime = 0.0;
let transitionDir = 1; // 1: fading out, -1: fading in
let nextMazeIndexToLoad = -1;

let mazeMaterial: THREE.MeshPhysicalMaterial;
let floorMaterial: THREE.MeshStandardMaterial;

// Sound Manager using Web Audio API (Synthesized sounds)
const GAME_AUDIO_ENABLED = false;

class SoundManager {
  private ctx: AudioContext | null = null;
  private rollOsc: OscillatorNode | null = null;
  private rollGain: GainNode | null = null;
  private filter: BiquadFilterNode | null = null;
  private isInitialized = false;

  init() {
    if (!GAME_AUDIO_ENABLED) return;
    if (this.isInitialized) {
      // If already initialized but suspended (due to browser autoplay policies), resume it
      if (this.ctx && this.ctx.state === 'suspended') {
        this.ctx.resume().then(() => {
          debugLog('AudioContext resumed successfully via user interaction.');
        });
      }
      return;
    }
    try {
      const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
      this.ctx = new AudioContextClass();

      // Setup rolling rumble oscillator
      this.rollGain = this.ctx.createGain();
      this.rollGain.gain.setValueAtTime(0, this.ctx.currentTime);

      this.filter = this.ctx.createBiquadFilter();
      this.filter.type = 'lowpass';
      this.filter.frequency.setValueAtTime(120, this.ctx.currentTime);

      this.rollOsc = this.ctx.createOscillator();
      this.rollOsc.type = 'triangle';
      this.rollOsc.frequency.setValueAtTime(45, this.ctx.currentTime);

      // Connect
      this.rollOsc.connect(this.filter);
      this.filter.connect(this.rollGain);
      this.rollGain.connect(this.ctx.destination);

      this.rollOsc.start();
      this.isInitialized = true;
      debugLog('Audio initialized successfully.');

      // Auto-resume if already inside a user gesture callback
      if (this.ctx.state === 'suspended') {
        this.ctx.resume();
      }
    } catch (e) {
      console.warn('Failed to initialize AudioContext:', e);
    }
  }

  updateRolling(speed: number) {
    if (!this.isInitialized || !this.ctx || !this.rollGain || !this.rollOsc || !this.filter) return;
    if (this.ctx.state === 'suspended') {
      this.ctx.resume();
    }

    // Map speed to frequency and gain (updated for meter-scale speeds)
    const maxSpeed = 5.0;
    const normSpeed = Math.min(speed / maxSpeed, 1.0);

    const targetVolume = normSpeed * 0.18; // soft rumble
    const targetFreq = 40 + normSpeed * 70; // 40Hz to 110Hz rumble
    const targetFilterFreq = 100 + normSpeed * 180; // shift cutoff higher as it speeds up

    this.rollGain.gain.setTargetAtTime(targetVolume, this.ctx.currentTime, 0.05);
    this.rollOsc.frequency.setTargetAtTime(targetFreq, this.ctx.currentTime, 0.05);
    this.filter.frequency.setTargetAtTime(targetFilterFreq, this.ctx.currentTime, 0.05);
  }

  playImpact(force: number) {
    if (!this.isInitialized || !this.ctx) return;
    if (this.ctx.state === 'suspended') {
      this.ctx.resume();
    }

    const vol = Math.min(force * 0.15, 0.6);
    if (vol < 0.02) return;

    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    const lowpass = this.ctx.createBiquadFilter();

    osc.type = 'sine';
    osc.frequency.setValueAtTime(100 - vol * 20, this.ctx.currentTime); // low thud

    lowpass.type = 'lowpass';
    lowpass.frequency.setValueAtTime(180, this.ctx.currentTime);

    gain.gain.setValueAtTime(vol, this.ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, this.ctx.currentTime + 0.25);

    osc.connect(lowpass);
    lowpass.connect(gain);
    gain.connect(this.ctx.destination);

    osc.start();
    osc.stop(this.ctx.currentTime + 0.3);
  }

  playVictory() {
    const ctx = this.ctx;
    if (!this.isInitialized || !ctx) return;
    if (ctx.state === 'suspended') {
      ctx.resume();
    }

    const now = ctx.currentTime;
    const notes = [261.63, 329.63, 392.00, 523.25, 659.25]; // C4, E4, G4, C5, E5 arpeggio

    notes.forEach((freq, index) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(freq, now + index * 0.12);
      
      gain.gain.setValueAtTime(0, now + index * 0.12);
      gain.gain.linearRampToValueAtTime(0.2, now + index * 0.12 + 0.03);
      gain.gain.exponentialRampToValueAtTime(0.001, now + index * 0.12 + 0.3);
      
      osc.connect(gain);
      gain.connect(ctx.destination);
      
      osc.start(now + index * 0.12);
      osc.stop(now + index * 0.12 + 0.4);
    });
  }
}

const sounds = new SoundManager();

// Resume/initialize AudioContext on any user gesture to satisfy browser autoplay policies
function handleUserGesture() {
  sounds.init();
}
if (GAME_AUDIO_ENABLED) {
  window.addEventListener('click', handleUserGesture);
  window.addEventListener('keydown', handleUserGesture);
  window.addEventListener('touchstart', handleUserGesture);
}

// Game State variables
let scene: THREE.Scene;
let camera: THREE.PerspectiveCamera;
let renderer: THREE.WebGLRenderer;
let lastFrameAt = 0;
let environmentReady = false;

let physicsWorld: RAPIER_TYPES.World;
let ballBody: RAPIER_TYPES.RigidBody | null = null;
let ballMesh: THREE.Object3D | null = null;
let ballEditorRoot: THREE.Group | null = null;
let ballRadius = 0.25; 
let gameSceneEditorRoot: THREE.Group;
let mazeContainer: THREE.Group; // Outer group centered at (0, 0, 0) which we rotate
let mazeEditorRoot: THREE.Group | null = null;
let mazeGroup: THREE.Group | null = null;   // Inner group containing FBX mesh shifted by -center
let mazeBody: RAPIER_TYPES.RigidBody | null = null;

// Telemetry & Tilting
let targetPitch = 0; // Pitch (from beta): -1.0 to 1.0
let targetRoll = 0;  // Roll (from gamma): -1.0 to 1.0
let currentPitch = 0;
let currentRoll = 0;
const maxTiltAngle = 14 * Math.PI / 180; // 14 degrees max visual tilt
let phonePitch = 0;
let phoneRoll = 0;
let manualPitch = 0;
let manualRoll = 0;

// Camera angle setting (adjustable via Keyboard ArrowUp/ArrowDown)
let cameraAngleDeg = 0.0; // starts at 0 degrees horizontal front look (straight at screen)
let mazeYOffset = 0.0;
let cameraHeight = 0.0; // will be dynamically set based on maze size
let sceneYShift = 0.0;  // moves the entire scene up/down visually
let gameCameraX = 0.0;
let gameCameraDistanceMultiplier = 1.9;
let gameCameraTargetY = 1.0;
let gameCameraFov = 45;
let phoneYaw = 0;       // target yaw angle from phone orientation
let currentYaw = 0;     // current interpolated yaw angle
let isLevelLoading = false; // blocks visual rotation during level loading

// Game Logic
let startPos = new THREE.Vector3();
let finishPos = new THREE.Vector3();
let finishRadius = 0.5;
let isControllerConnected = false;
let mazeBoundingBox = new THREE.Box3();
let mazeSize = new THREE.Vector3();
let floorTopY = 0.0;
let physicsAccumulator = 0.0;
const PHYSICS_TIMESTEP = 1 / 60; // 60 Hz physics step
const MAX_PHYSICS_STEPS_PER_FRAME = 3;

const startCameraView = {
  position: new THREE.Vector3(0, 0.5, 10),
  target: new THREE.Vector3(0, 0.5, 0),
  fov: 45,
};
const teamCameraView: TeamCameraView = {
  position: { x: 0, y: 0.35, z: 12 },
  target: { x: 0, y: -0.35, z: 0 },
  fov: 45,
};
const shadowSettings = {
  opacity: 0.22,
  distanceBehindFocus: 3.5,
  screenDistanceBehindFocus: 1.2,
  size: 60,
  lightOffsetX: -5,
  lightOffsetY: 7,
  lightIntensity: 0.42,
};
let shadowReceiver: THREE.Mesh<THREE.PlaneGeometry, THREE.ShadowMaterial> | null = null;
let shadowKeyLight: THREE.DirectionalLight | null = null;
let nextShadowMapUpdateAt = 0;
let lastShadowExtent = 0;
let sceneEditorPanel: SceneEditorPanel | null = null;

// DOM overlays remain native-resolution, while the WebGL layer is capped at
// 1440p. Rendering the 3D scene at native 4K more than doubles fragment work
// with little visible benefit on the softly lit exhibition content.
const MAX_RENDER_PIXELS = 2_560 * 1_440;
const MIN_RENDER_PIXEL_RATIO = 2 / 3;

function getTargetPixelRatio() {
  const deviceRatio = Math.max(1, window.devicePixelRatio || 1);
  const qualityCap = experienceScreen === 'labyrinth'
    ? 1.5
    : experienceScreen === 'team' ? 1.25 : 1;
  const nativePixels = Math.max(1, window.innerWidth * window.innerHeight);
  const budgetRatio = Math.sqrt(MAX_RENDER_PIXELS / nativePixels);
  return Math.max(
    MIN_RENDER_PIXEL_RATIO,
    Math.min(deviceRatio, qualityCap, budgetRatio),
  );
}

function updateRendererQuality() {
  if (!renderer) return;
  renderer.setPixelRatio(getTargetPixelRatio());
}

// Self-healing reset logic
let resetCount = 0;
let aliveTime = 0;

// For collision impact detection
let lastVelocity = new THREE.Vector3();
const frameVelocity = new THREE.Vector3();
const frameAcceleration = new THREE.Vector3();
const frameBallXZ = new THREE.Vector2();
const frameSaveXZ = new THREE.Vector2();
const frameMazeRotation = new THREE.Quaternion();
const frameMazeEuler = new THREE.Euler(0, 0, 0, 'YXZ');

const PAIRING_RETRY_DELAY_MS = 3_000;
const PAIRING_REQUEST_TIMEOUT_MS = 8_000;

class PairingRequestError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'PairingRequestError';
  }
}

function clearPairingRefreshTimer() {
  if (pairingRefreshTimer !== null) window.clearTimeout(pairingRefreshTimer);
  pairingRefreshTimer = null;
}

function abortPairingRequest() {
  pairingRequestAbortController?.abort();
  pairingRequestAbortController = null;
}

function schedulePairingRefresh(delay = PAIRING_RETRY_DELAY_MS) {
  clearPairingRefreshTimer();
  if (gameSession.state !== 'pairing') return;
  pairingRefreshTimer = window.setTimeout(() => {
    pairingRefreshTimer = null;
    void refreshPairingSession();
  }, delay);
}

function localBackendHint() {
  const isLocalhost = ['localhost', '127.0.0.1', '::1'].includes(window.location.hostname);
  return isLocalhost
    ? 'Запустите приложение командой npm run dev, а не Vite отдельно.'
    : 'Проверьте, что Render-сервис запущен и доступен.';
}

function pairingErrorMessage(error: unknown, timedOut: boolean) {
  if (timedOut) return 'Сервер не ответил вовремя. Повторяем подключение…';
  if (!navigator.onLine) return 'Нет подключения к сети. QR появится после восстановления связи.';
  if (error instanceof PairingRequestError) {
    if (error.status === 401 || error.status === 403) {
      return 'Экран не авторизован. Откройте адрес заново с #kiosk=<KIOSK_TOKEN>.';
    }
    if (error.status === 404) {
      return `API сопряжения не найден. ${localBackendHint()}`;
    }
    if (error.status === 409) return `${error.message}. Повторяем…`;
    if (error.status >= 500) return 'Сервер не смог создать QR-код. Повторяем…';
    return `${error.message} Повторяем…`;
  }
  return `Нет связи с сервером. ${localBackendHint()}`;
}

// Fetch server pairing information. All retries are routed through the single
// pairing scheduler below so a temporary outage cannot create parallel loops.
async function fetchServerInfo(expectedLifecycle: number) {
  const requestController = new AbortController();
  pairingRequestAbortController = requestController;
  let timedOut = false;
  const timeout = window.setTimeout(() => {
    timedOut = true;
    requestController.abort();
  }, PAIRING_REQUEST_TIMEOUT_MS);

  try {
    const res = await fetch(`/api/server-info?station=${encodeURIComponent(STATION_ID)}`, {
      cache: 'no-store',
      headers: kioskToken ? { Authorization: `Bearer ${kioskToken}` } : {},
      signal: requestController.signal,
    });
    let data: Record<string, unknown> = {};
    try {
      data = await res.json() as Record<string, unknown>;
    } catch {
      if (res.ok) throw new PairingRequestError('Сервер вернул некорректный ответ.', 502);
    }
    if (!res.ok) {
      const state = typeof data.state === 'string' ? data.state : '';
      const message = state ? `Станция занята: ${state}` : 'QR временно недоступен.';
      throw new PairingRequestError(message, res.status);
    }
    if (typeof data.qrDataUrl !== 'string' || typeof data.mobileUrl !== 'string') {
      throw new PairingRequestError('Сервер не вернул QR-код.', 502);
    }
    if (expectedLifecycle !== lifecycleVersion || gameSession.state !== 'pairing') return;

    qrCodeImg.src = data.qrDataUrl;
    controllerUrlCode.textContent = data.mobileUrl;
    updateConnectionStatus('ОЖИДАНИЕ СМАРТФОНА', true);
    // This is normally already warm from the start screen. Keep a fallback
    // here so a transient startup preload failure gets another attempt.
    preloadGameRuntimeInBackground();
    const expiresAt = Number(data.expiresAt);
    const refreshDelay = Number.isFinite(expiresAt)
      ? Math.max(10_000, Math.min(60_000, expiresAt - Date.now() - 15_000))
      : 30_000;
    schedulePairingRefresh(refreshDelay);
  } catch (error) {
    if (
      expectedLifecycle !== lifecycleVersion ||
      gameSession.state !== 'pairing' ||
      (requestController.signal.aborted && !timedOut)
    ) return;
    if (timedOut) console.warn('Pairing QR request timed out; retrying.');
    else console.error('Failed to load pairing QR:', error);
    qrCodeImg.removeAttribute('src');
    controllerUrlCode.textContent = pairingErrorMessage(error, timedOut);
    updateConnectionStatus('QR-КОД НЕДОСТУПЕН', true);
    schedulePairingRefresh();
  } finally {
    window.clearTimeout(timeout);
    if (pairingRequestAbortController === requestController) {
      pairingRequestAbortController = null;
    }
  }
}

function preloadGameRuntimeInBackground() {
  void ensureGameRuntime().catch((error) => {
    console.error('Game runtime preload failed:', error);
    if (experienceScreen === 'labyrinth' && gameSession.state === 'pairing') {
      updateConnectionStatus('ОШИБКА ЗАГРУЗКИ ИГРЫ', true);
    }
  });
}

async function runPairingSynchronization() {
  const expectedLifecycle = lifecycleVersion;
  if (gameSession.state !== 'pairing') return;

  if (!socket.connected || !desktopSocketRegistered) {
    qrCodeImg.removeAttribute('src');
    if (desktopRegistrationFailure) {
      controllerUrlCode.textContent = desktopRegistrationFailure;
      updateConnectionStatus('ИГРОВОЙ ЭКРАН НЕ ЗАРЕГИСТРИРОВАН', true);
      return;
    }
    controllerUrlCode.textContent = 'Подключаемся к серверу сеансов…';
    updateConnectionStatus('ВОССТАНАВЛИВАЕМ СВЯЗЬ С СЕРВЕРОМ', true);
    schedulePairingRefresh();
    return;
  }

  if (pairingServerResetPending) {
    try {
      await sendSessionCommand(SESSION_COMMANDS.PAIR);
      if (expectedLifecycle !== lifecycleVersion || gameSession.state !== 'pairing') return;
      pairingServerResetPending = false;
    } catch (error) {
      if (expectedLifecycle !== lifecycleVersion || gameSession.state !== 'pairing') return;
      console.error('Failed to reset pairing session:', error);
      controllerUrlCode.textContent = socket.connected
        ? 'Сервер ещё не готов к сопряжению. Повторяем…'
        : 'Связь с сервером потеряна. Ждём переподключения…';
      updateConnectionStatus('QR-КОД НЕДОСТУПЕН', true);
      schedulePairingRefresh();
      return;
    }
  }

  await fetchServerInfo(expectedLifecycle);
}

function refreshPairingSession() {
  clearPairingRefreshTimer();
  if (pairingSyncPromise) {
    pairingSyncQueued = true;
    return pairingSyncPromise;
  }

  const syncPromise = runPairingSynchronization()
    .catch((error) => {
      console.error('Unexpected pairing synchronization error:', error);
      if (gameSession.state === 'pairing') schedulePairingRefresh();
    })
    .finally(() => {
      if (pairingSyncPromise !== syncPromise) return;
      pairingSyncPromise = null;
      const runAgain = pairingSyncQueued;
      pairingSyncQueued = false;
      if (runAgain && gameSession.state === 'pairing') void refreshPairingSession();
    });
  pairingSyncPromise = syncPromise;
  return syncPromise;
}

// Set up websockets
socket.on('connect', () => {
  desktopSocketRegistered = false;
  desktopRegistrationFailure = null;
  debugLog(`Connected to session server as station ${STATION_ID}.`);
  socket.emit(
    EVENTS.REGISTER_DESKTOP,
    { stationId: STATION_ID, kioskToken, instanceId: desktopInstanceId },
    (response?: { ok?: boolean; reason?: string }) => {
      if (response?.ok === true) {
        desktopSocketRegistered = true;
        if (gameSession.state === 'pairing') void refreshPairingSession();
        return;
      }
      desktopRegistrationFailure = response?.reason === 'kiosk-unauthorized'
        ? 'Откройте Render URL с фрагментом #kiosk=<KIOSK_TOKEN>.'
        : 'Не удалось зарегистрировать игровой экран.';
      updateConnectionStatus('HOLOBOX НЕ АВТОРИЗОВАН', true);
      controllerUrlCode.textContent = desktopRegistrationFailure;
    },
  );
});

socket.on('disconnect', () => {
  desktopSocketRegistered = false;
  desktopRegistrationFailure = null;
  isControllerConnected = false;
  syncGeneratedImageButtonVisibility();
  phonePitch = 0;
  phoneRoll = 0;
  phoneYaw = 0;
  gameSession.pause(performance.now());
  isGameActive = false;
  updateConnectionStatus('ВОССТАНАВЛИВАЕМ СВЯЗЬ С СЕРВЕРОМ', true);
  if (gameSession.state === 'pairing') {
    clearPairingRefreshTimer();
    abortPairingRequest();
    qrCodeImg.removeAttribute('src');
    controllerUrlCode.textContent = 'Связь с сервером потеряна. Ждём переподключения…';
  }
});

socket.on('connect_error', () => {
  if (gameSession.state !== 'pairing') return;
  qrCodeImg.removeAttribute('src');
  controllerUrlCode.textContent = `Сервер сеансов недоступен. ${localBackendHint()}`;
  updateConnectionStatus('СЕРВЕР НЕДОСТУПЕН', true);
});

socket.on(EVENTS.CONTROLLER_STATUS, (status: {
  connected: boolean;
  recoverable?: boolean;
  sessionId?: string | null;
  state?: string;
}) => {
  if (status.connected) {
    const wasPairing = gameSession.state === 'pairing';
    isControllerConnected = true;
    currentControllerSessionId = status.sessionId || currentControllerSessionId;
    syncGeneratedImageButtonVisibility();
    pairingOverlay.classList.add('hidden');
    updateConnectionStatus('СМАРТФОН АКТИВЕН');
    calibrate();
    if (wasPairing) {
      gameSession.controllerConnected();
      showGameLoadingState();
      void prepareControllerGame();
    } else if (gameSession.state === 'paused') {
      if (saveCelebrationActive || generatedImageViewerOpen) return;
      if (pendingPostSaveAction !== null) {
        continueAfterSaveCelebration();
        return;
      }
      gameSession.resume(performance.now());
      isGameActive = gameSession.isPlaying();
      hudOverlay.classList.remove('hidden');
    } else if (gameSession.state === 'calibrating') {
      if (gameReadyForManualStart) showGameInstruction();
      else {
        showGameLoadingState();
        void prepareControllerGame();
      }
    }
    return;
  }

  isControllerConnected = false;
  syncGeneratedImageButtonVisibility();
  phonePitch = 0;
  phoneRoll = 0;
  phoneYaw = 0;
  if (status.recoverable) {
    gameSession.pause(performance.now());
    isGameActive = false;
    updateConnectionStatus('ВОССТАНАВЛИВАЕМ СВЯЗЬ', true);
  } else if (gameSession.state !== 'result') {
    updateConnectionStatus('СМАРТФОН НЕ ПОДКЛЮЧЁН', true);
    if (gameSession.state !== 'attract' && gameSession.state !== 'pairing') {
      void openPairing(false);
    }
  }
});

socket.on(EVENTS.GYRO_UPDATE, (data: {
  beta: number;
  gamma: number;
  alpha?: number;
  sessionId?: string;
}) => {
  if (!isControllerConnected || (data.sessionId && data.sessionId !== currentControllerSessionId)) return;

  phonePitch = data.beta;
  phoneRoll = data.gamma;
  if (data.alpha !== undefined) {
    phoneYaw = data.alpha * Math.PI / 180;
  }
  if (
    gameSession.state === 'calibrating'
    && !sessionPreparationInFlight
    && !gameReadyForManualStart
  ) {
    void prepareControllerGame();
  }
});

socket.on(EVENTS.CALIBRATE_REQUEST, () => {
  debugLog('Calibration request received.');
  calibrate();
});

socket.on(EVENTS.SESSION_ENDED, (payload: { reason?: string }) => {
  debugLog(`Session ended by server: ${payload.reason || 'unknown'}`);
  if (gameSession.state !== 'result') void openPairing(false);
});

async function prepareControllerGame() {
  if (
    sessionPreparationInFlight
    || gameReadyForManualStart
    || gameSession.state !== 'calibrating'
  ) return;
  sessionPreparationInFlight = true;
  const expectedLifecycle = lifecycleVersion;
  updateConnectionStatus('ГОТОВИМ ИГРУ…');
  showGameLoadingState();
  try {
    // Let the opaque loading state paint before synchronous FBX processing.
    await waitForNextPaint();
    await prepareNewGame();
    if (
      expectedLifecycle !== lifecycleVersion ||
      !isControllerConnected ||
      gameSession.state !== 'calibrating'
    ) return;
    gameReadyForManualStart = true;
    updateConnectionStatus('ИГРА ГОТОВА');
    showGameInstruction();
  } catch (error) {
    if (
      expectedLifecycle !== lifecycleVersion
      || !isControllerConnected
      || gameSession.state !== 'calibrating'
    ) return;
    console.error('Failed to prepare game session:', error);
    isLevelLoading = false;
    gameLoadingOverlay.classList.remove('hidden');
    gameLoadingSpinner.classList.add('hidden');
    gameLoadingError.classList.remove('hidden');
    controllerUrlCode.textContent = 'Ошибка загрузки игры. Нажмите «Начать заново».';
    updateConnectionStatus('ОШИБКА ПОДГОТОВКИ', true);
    syncGeneratedImageButtonVisibility();
  } finally {
    sessionPreparationInFlight = false;
  }
}

function waitForNextPaint() {
  return new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  });
}

function showGameLoadingState() {
  closeSettingsDrawer();
  pairingOverlay.classList.add('hidden');
  hudOverlay.classList.add('hidden');
  gameInstructionOverlay.classList.add('hidden');
  gameInstructionOverlay.setAttribute('aria-hidden', 'true');
  gameLoadingSpinner.classList.remove('hidden');
  gameLoadingError.classList.add('hidden');
  gameLoadingOverlay.classList.remove('hidden');
  settingsTrigger.classList.add('experience-hidden');
  setShadowPresentationVisible(false);
  syncGeneratedImageButtonVisibility();
}

function showGameInstruction() {
  closeSettingsDrawer();
  gameLoadingOverlay.classList.add('hidden');
  hudOverlay.classList.add('hidden');
  gameInstructionOverlay.classList.remove('hidden');
  gameInstructionOverlay.setAttribute('aria-hidden', 'false');
  settingsTrigger.classList.add('experience-hidden');
  mazeContainer.visible = true;
  setShadowPresentationVisible(true);
  markShadowMapDirty();
  renderSceneOnce();
  startRenderLoop();
  syncGeneratedImageButtonVisibility();
}

function startPreparedGame() {
  if (
    !gameReadyForManualStart
    || !isControllerConnected
    || gameSession.state !== 'calibrating'
  ) return;

  gameReadyForManualStart = false;
  gameInstructionOverlay.classList.add('hidden');
  gameInstructionOverlay.setAttribute('aria-hidden', 'true');
  hudOverlay.classList.remove('hidden');
  settingsTrigger.classList.remove('experience-hidden');
  calibrate();
  setShadowPresentationVisible(true);
  if (gameSession.beginCountdown(performance.now())) {
    setTextIfChanged(timerSpan, String(Math.ceil(COUNTDOWN_DURATION_MS / 1_000)));
    updateConnectionStatus(`СТАРТ ЧЕРЕЗ ${Math.ceil(COUNTDOWN_DURATION_MS / 1_000)}`);
    markShadowMapDirty();
    startRenderLoop();
    syncGeneratedImageButtonVisibility();
  }
}

btnStartLabyrinth.addEventListener('click', startPreparedGame);
btnRetryGameLoad.addEventListener('click', () => {
  showGameLoadingState();
  void prepareControllerGame();
});
btnResetAfterLoadError.addEventListener('click', () => void resetExperience(true));

async function openPairing(resetServer: boolean) {
  closeSettingsDrawer();
  lifecycleVersion += 1;
  if (resultResetTimer !== null) window.clearTimeout(resultResetTimer);
  resultResetTimer = null;
  if (saveCelebrationTimer !== null) window.clearTimeout(saveCelebrationTimer);
  saveCelebrationTimer = null;
  saveCelebrationActive = false;
  pendingPostSaveAction = null;
  renderer.domElement.classList.remove('game-paused-blurred');
  saveProgressOverlay.classList.add('hidden');
  saveProgressOverlay.setAttribute('aria-hidden', 'true');
  generatedImageOverlay.classList.add('hidden');
  generatedImageOverlay.setAttribute('aria-hidden', 'true');
  generatedImageViewerOpen = false;
  generatedImageViewerPausedGame = false;
  clearPairingRefreshTimer();
  abortPairingRequest();
  pairingServerResetPending ||= resetServer;
  gameSession.enterPairing();
  gameReadyForManualStart = false;
  isGameActive = false;
  isControllerConnected = false;
  currentControllerSessionId = null;
  calibrate();
  if (ballBody) {
    ballBody.setLinvel({ x: 0, y: 0, z: 0 }, true);
    ballBody.setAngvel({ x: 0, y: 0, z: 0 }, true);
  }
  if (physicsWorld) physicsWorld.gravity = { x: 0, y: -35, z: 0 };
  victoryOverlay.classList.add('hidden');
  hudOverlay.classList.add('hidden');
  gameLoadingOverlay.classList.add('hidden');
  gameInstructionOverlay.classList.add('hidden');
  gameInstructionOverlay.setAttribute('aria-hidden', 'true');
  saveProgressOverlay.classList.add('hidden');
  settingsTrigger.classList.add('experience-hidden');
  setShadowPresentationVisible(false);
  pairingOverlay.classList.remove('hidden');
  syncGeneratedImageButtonVisibility();
  qrCodeImg.removeAttribute('src');
  controllerUrlCode.textContent = desktopSocketRegistered
    ? 'Создаём QR-код…'
    : 'Подключаемся к серверу сеансов…';
  updateConnectionStatus(
    desktopSocketRegistered ? 'СОЗДАЁМ QR-КОД' : 'ВОССТАНАВЛИВАЕМ СВЯЗЬ С СЕРВЕРОМ',
    true,
  );

  await refreshPairingSession();
}

function updateConnectionStatus(text: string, disconnected = false) {
  if (connectionStatusText.textContent !== text) connectionStatusText.textContent = text;
  if (connectionIndicator.classList.contains('disconnected') !== disconnected) {
    connectionIndicator.classList.toggle('disconnected', disconnected);
  }
}

function setTextIfChanged(element: HTMLElement, text: string) {
  if (element.textContent !== text) element.textContent = text;
}

function closeSettingsDrawer() {
  settingsPanel.classList.add('hidden');
}

function syncGeneratedImageButtonVisibility() {
  const sessionCanShow = gameSession.state === 'calibrating'
    || gameSession.state === 'countdown'
    || gameSession.state === 'playing'
    || gameSession.state === 'paused';
  const shouldShow = Boolean(generatedTeamImageUrl)
    && experienceScreen === 'labyrinth'
    && isControllerConnected
    && sessionCanShow
    && gameLoadingOverlay.classList.contains('hidden')
    && pairingOverlay.classList.contains('hidden')
    && !saveCelebrationActive
    && !generatedImageViewerOpen
    && !isTransitioning
    && !isLevelLoading;
  btnViewGeneratedImage.classList.toggle('hidden', !shouldShow);
}

function syncSettingsTriggerVisibility() {
  const shouldHide = !pairingOverlay.classList.contains('hidden')
    || !gameLoadingOverlay.classList.contains('hidden')
    || !gameInstructionOverlay.classList.contains('hidden')
    || !saveProgressOverlay.classList.contains('hidden')
    || generatedImageViewerOpen;
  settingsTrigger.classList.toggle('experience-hidden', shouldHide);
  if (shouldHide) closeSettingsDrawer();
}

function sendSessionCommand(action: string, result?: { isWin: boolean; savesCollected: number; elapsedMs: number }) {
  return new Promise<Record<string, unknown>>((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error(`Session command timed out: ${action}`)), 5_000);
    socket.emit(EVENTS.SESSION_COMMAND, { stationId: STATION_ID, action, result }, (response: { ok?: boolean; reason?: string }) => {
      window.clearTimeout(timer);
      if (!response?.ok) reject(new Error(response?.reason || `Session command failed: ${action}`));
      else resolve(response as Record<string, unknown>);
    });
  });
}

// Setup calibration
function calibrate() {
  phonePitch = 0;
  phoneRoll = 0;
  phoneYaw = 0;
  manualPitch = 0;
  manualRoll = 0;
  targetPitch = 0;
  targetRoll = 0;
  currentPitch = 0;
  currentRoll = 0;
  currentYaw = 0;
  if (mazeContainer) {
    const q = new THREE.Quaternion();
    mazeContainer.quaternion.copy(q);
  }
}

btnCalibrate.addEventListener('click', () => {
  calibrate();
  socket.emit(EVENTS.CALIBRATE);
  sounds.init(); // Initialize sound on button press just in case
});

btnRestart.addEventListener('click', () => {
  void resetExperience(true);
});

btnHudRestart?.addEventListener('click', () => {
  void resetExperience(true);
});

btnPrevLevel?.addEventListener('click', () => {
  switchMaze((currentMazeIndex - 1 + LEVELS.length) % LEVELS.length);
});

btnNextLevel?.addEventListener('click', () => {
  switchMaze((currentMazeIndex + 1) % LEVELS.length);
});

function switchMaze(newIndex: number) {
  if (newIndex === currentMazeIndex) return;
  cleanupCurrentLevel();
  currentMazeIndex = newIndex;
  currentLevelSpan.textContent = String(currentMazeIndex + 1).padStart(2, '0');
  debugLog(`Switching to maze ${currentMazeIndex + 1}: ${LEVELS[currentMazeIndex].asset}`);
  resetCount = 0;
  aliveTime = 0;
  victoryOverlay.classList.add('hidden');
  loadMazeAsset();
}

function cleanupCurrentLevel() {
  if (ballBody && physicsWorld) physicsWorld.removeRigidBody(ballBody);
  if (mazeBody && physicsWorld) physicsWorld.removeRigidBody(mazeBody);
  ballBody = null;
  mazeBody = null;
  disposeObject(ballMesh, true);
  disposeObject(saveMesh, true);
  disposeObject(mazeGroup, false);
  ballEditorRoot?.removeFromParent();
  saveEditorRoot?.removeFromParent();
  mazeEditorRoot?.removeFromParent();
  ballMesh = null;
  ballEditorRoot = null;
  saveMesh = null;
  saveEditorRoot = null;
  mazeGroup = null;
  mazeEditorRoot = null;
  removeNamedChildren(mazeContainer, [
    'finish-marker',
    'finish-light',
    'start-light',
    'save-item',
    'floor-mesh',
    'football-gates',
    'save-highlight-front',
    'save-highlight-back',
    'save-highlight-top',
  ]);
  lastVelocity.set(0, 0, 0);
  physicsAccumulator = 0;
}

function endGame(isWin: boolean) {
  if (gameSession.state === 'result') return;
  closeSettingsDrawer();
  if (saveCelebrationTimer !== null) window.clearTimeout(saveCelebrationTimer);
  saveCelebrationTimer = null;
  saveCelebrationActive = false;
  pendingPostSaveAction = null;
  saveProgressOverlay.classList.add('hidden');
  saveProgressOverlay.setAttribute('aria-hidden', 'true');
  renderer.domElement.classList.remove('game-paused-blurred');
  settingsTrigger.classList.remove('experience-hidden');
  const now = performance.now();
  gameSession.finish(now);
  syncGeneratedImageButtonVisibility();
  const elapsedMs = Math.round(gameSession.elapsedMs(now));
  isGameActive = false;
  gameTimeLeft = Math.max(0, (GAME_DURATION_MS - elapsedMs) / 1000);
  physicsWorld.gravity = { x: 0, y: -35, z: 0 };
  if (ballBody) {
    ballBody.setLinvel({ x: 0, y: 0, z: 0 }, true);
    ballBody.setAngvel({ x: 0, y: 0, z: 0 }, true);
  }
  calibrate();
  updateConnectionStatus('СЕССИЯ ЗАВЕРШЕНА');
  
  victoryOverlay.classList.remove('hidden');
  
  if (isWin) {
    if (modalTitle) {
      modalTitle.textContent = 'ПОБЕДА!';
      modalTitle.style.background = 'linear-gradient(45deg, #00ff66, var(--accent-cyan))';
      modalTitle.style.webkitBackgroundClip = 'text';
      modalTitle.style.webkitTextFillColor = 'transparent';
    }
    if (modalSubtitle) {
      modalSubtitle.textContent = `Вы собрали все ${totalSavesGoal} сейва за ${Math.round(elapsedMs / 1000)} секунд!`;
    }
  } else {
    if (modalTitle) {
      modalTitle.textContent = 'ВРЕМЯ ВЫШЛО!';
      modalTitle.style.background = 'linear-gradient(45deg, var(--accent-magenta), #ffcc00)';
      modalTitle.style.webkitBackgroundClip = 'text';
      modalTitle.style.webkitTextFillColor = 'transparent';
    }
    if (modalSubtitle) {
      modalSubtitle.textContent = `Вы успели собрать ${savesCollected} из ${totalSavesGoal} сейвов.`;
    }
  }

  void sendSessionCommand(SESSION_COMMANDS.FINISH, { isWin, savesCollected, elapsedMs })
    .catch((error) => console.error('Failed to close server session:', error));
  if (resultResetTimer !== null) window.clearTimeout(resultResetTimer);
  resultResetTimer = window.setTimeout(() => void resetExperience(true), RESULT_DISPLAY_MS);
}

async function prepareNewGame() {
  isGameActive = false;
  await ensureGameRuntime();
  savesCollected = 0;
  currentMazeIndex = 0;
  cleanupCurrentLevel();
  updateSavesHUD();
  victoryOverlay.classList.add('hidden');
  isSaveCollected = false;
  resetCount = 0;
  aliveTime = 0;
  gameTimeLeft = GAME_DURATION_MS / 1000;
  timerSpan.textContent = String(Math.ceil(gameTimeLeft));
  currentLevelSpan.textContent = String(currentMazeIndex + 1).padStart(2, '0');
  loadMazeAsset();
}

function updateSavesHUD() {
  const container = document.getElementById('saves-icons');
  if (!container) return;

  container.replaceChildren();
  for (let i = 0; i < savesCollected; i++) {
    const slot = document.createElement('div');
    slot.className = 'save-icon-slot collected';
    const icon = document.createElement('img');
    icon.className = 'save-icon-svg';
    icon.src = '/source/save.svg';
    icon.alt = '';
    slot.append(icon);
    container.append(slot);
  }
}

function collectSave() {
  if (isTransitioning || !isGameActive || isSaveCollected || !saveMesh) return;

  isSaveCollected = true;
  savesCollected++;
  updateSavesHUD();
  beginSaveCelebration();
}

function beginSaveCelebration() {
  closeSettingsDrawer();
  saveCelebrationActive = true;
  gameSession.pause(performance.now());
  isGameActive = false;
  if (ballBody) {
    ballBody.setLinvel({ x: 0, y: 0, z: 0 }, true);
    ballBody.setAngvel({ x: 0, y: 0, z: 0 }, true);
  }

  const remaining = Math.max(0, totalSavesGoal - savesCollected);
  const collectedWord = savesCollected === 1 ? 'СЕЙВ' : 'СЕЙВА';
  saveProgressMessage.textContent = remaining > 0
    ? `ТЫ СОБРАЛ ${savesCollected} ${collectedWord}, ${remaining === 1 ? 'ОСТАЛСЯ' : 'ОСТАЛОСЬ'} ${remaining}`
    : `ТЫ СОБРАЛ ${savesCollected} ${collectedWord}!`;
  renderer.domElement.classList.add('game-paused-blurred');
  saveProgressOverlay.classList.remove('hidden');
  saveProgressOverlay.setAttribute('aria-hidden', 'false');
  settingsTrigger.classList.add('experience-hidden');
  syncGeneratedImageButtonVisibility();
  renderSceneOnce();

  if (saveCelebrationTimer !== null) window.clearTimeout(saveCelebrationTimer);
  saveCelebrationTimer = window.setTimeout(finishSaveCelebration, 2_000);
}

function finishSaveCelebration() {
  saveCelebrationTimer = null;
  saveCelebrationActive = false;
  saveProgressOverlay.classList.add('hidden');
  saveProgressOverlay.setAttribute('aria-hidden', 'true');
  renderer.domElement.classList.remove('game-paused-blurred');
  settingsTrigger.classList.remove('experience-hidden');
  pendingPostSaveAction = savesCollected >= totalSavesGoal
    ? 'finish'
    : (currentMazeIndex + 1) % LEVELS.length;
  syncGeneratedImageButtonVisibility();
  continueAfterSaveCelebration();
}

function continueAfterSaveCelebration() {
  if (
    pendingPostSaveAction === null
    || !isControllerConnected
    || gameSession.state !== 'paused'
  ) return;

  const action = pendingPostSaveAction;
  pendingPostSaveAction = null;
  gameSession.resume(performance.now());
  isGameActive = gameSession.isPlaying();
  if (action === 'finish') endGame(true);
  else startTransitionToLevel(action);
}

function startTransitionToLevel(nextIndex: number) {
  isTransitioning = true;
  transitionTime = 0.0;
  transitionDir = 1; // Fade out
  nextMazeIndexToLoad = nextIndex;
  syncGeneratedImageButtonVisibility();
}

function resetGame() {
  if (!isGameActive || gameSession.state !== 'playing') return;
  victoryOverlay.classList.add('hidden');
  aliveTime = 0;
  resetCount++;
  
  let spawnX = startPos.x;
  let spawnZ = startPos.z;
  
  // Fallback: spawn at center of the maze if falling repeatedly
  if (resetCount > 3) {
    debugLog('⚠️ Fallback: spawning ball at the center of the maze.');
    spawnX = 0;
    spawnZ = 0;
  }

  if (ballBody) {
    // Reset ball physics
    ballBody.setTranslation({ x: spawnX, y: startPos.y, z: spawnZ }, true);
    ballBody.setLinvel({ x: 0, y: 0, z: 0 }, true);
    ballBody.setAngvel({ x: 0, y: 0, z: 0 }, true);
  }
  
  calibrate();
}

function getGeometryBoundingBox(object: THREE.Object3D | null): THREE.Box3 {
  const box = new THREE.Box3();
  if (!object) return box;
  let hasMesh = false;
  object.traverse((child) => {
    if (child instanceof THREE.Mesh) {
      const geometry = child.geometry;
      if (geometry) {
        if (!geometry.boundingBox) {
          geometry.computeBoundingBox();
        }
        child.updateMatrixWorld(true);
        const tempBox = geometry.boundingBox!.clone();
        const meshBox = tempBox.applyMatrix4(child.matrixWorld);
        if (!hasMesh) {
          box.copy(meshBox);
          hasMesh = true;
        } else {
          box.union(meshBox);
        }
      }
    }
  });
  return box;
}

async function transitionToTeamSelection() {
  if (experienceScreen !== 'start' || !teamSelection) return;
  closeSettingsDrawer();
  experienceScreen = 'transition';
  btnStartGame.disabled = true;
  sounds.init();
  const teamAssetsReady = teamSelection.preload();
  startSaveDecorations?.beginExit(760);
  startOverlay.classList.add('is-leaving');

  await delay(1_080);
  if (experienceScreen !== 'transition') return;
  startSaveDecorations?.hide();
  startOverlay.classList.add('hidden');
  startOverlay.setAttribute('aria-hidden', 'true');
  teamSelectionOverlay.classList.remove('hidden', 'is-team-selected', 'is-selection-ready');
  teamSelectionOverlay.setAttribute('aria-hidden', 'false');
  requestAnimationFrame(() => teamSelectionOverlay.classList.add('is-visible'));
  experienceScreen = 'team';
  ensureSceneEnvironment();
  await teamAssetsReady;
  await teamSelection.show(1_200);
  startRenderLoop();
}

function handleTeamSelected(team: TeamDefinition) {
  if (experienceScreen !== 'team') return;
  selectedTeam = team;
  teamSelectionOverlay.classList.add('is-team-selected');
  teamSelectionOverlay.querySelectorAll<HTMLButtonElement>('[data-team]').forEach((button) => {
    button.classList.toggle('selected', button.dataset.team === team.id);
    button.disabled = true;
  });
}

function handleTeamSelectionReady(team: TeamDefinition) {
  if (experienceScreen !== 'team' || selectedTeam?.id !== team.id) return;
  renderer.domElement.classList.add('team-ball-blurred');
  btnOpenCamera.disabled = false;
  teamSelectionOverlay.classList.add('is-selection-ready');
}

async function openPhotoScreen() {
  if (experienceScreen !== 'team' || !selectedTeam) return;
  closeSettingsDrawer();
  experienceScreen = 'photo';
  btnOpenCamera.disabled = true;
  teamSelectionOverlay.classList.add('hidden');
  teamSelectionOverlay.classList.remove('is-visible');
  teamSelectionOverlay.setAttribute('aria-hidden', 'true');
  teamSelection?.hide();
  renderer.domElement.classList.remove('team-ball-blurred');
  markShadowMapDirty();
  renderSceneOnce();
  updateRendererQuality();
  resetCameraPreview();
  photoOverlay.classList.remove('hidden');
  photoOverlay.setAttribute('aria-hidden', 'false');
  await startCamera();
}

async function startCamera() {
  stopCamera();
  btnCapturePhoto.disabled = true;
  btnCapturePhoto.textContent = 'СДЕЛАТЬ ФОТО';
  setCameraStatus('Разрешите доступ к камере в окне браузера', 'loading');
  try {
    if (!window.isSecureContext) throw new Error('Камера требует HTTPS-адрес Render.');
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('Камера недоступна в этом браузере.');
    cameraStream = await requestCameraStream();
    cameraVideo.srcObject = cameraStream;
    cameraVideo.muted = true;
    await cameraVideo.play();
    await waitForVideoFrame(cameraVideo, 5_000);
    btnCapturePhoto.disabled = false;
    setCameraStatus('Нажми «Сделать фото»', 'hint', 2_600);
  } catch (error) {
    stopCamera();
    const message = error instanceof DOMException && error.name === 'NotAllowedError'
      ? 'Разрешите доступ к камере в настройках браузера и обновите страницу.'
      : error instanceof DOMException && error.name === 'NotFoundError'
        ? 'Камера не найдена. Проверьте подключение камеры.'
        : error instanceof DOMException && error.name === 'NotReadableError'
          ? 'Камера занята другим приложением. Закройте его и попробуйте снова.'
      : error instanceof Error ? error.message : 'Не удалось включить камеру.';
    setCameraStatus(message, 'error');
    btnCapturePhoto.textContent = 'ПОВТОРИТЬ КАМЕРУ';
    btnCapturePhoto.disabled = false;
  }
}

function handleCaptureButton() {
  if (cameraStream) capturePhoto();
  else void startCamera();
}

function capturePhoto() {
  if (
    photoCaptureInFlight
    || capturedPhotoDataUrl
    || !cameraStream
    || cameraVideo.videoWidth <= 0
    || cameraVideo.videoHeight <= 0
  ) return;
  const countdownVersion = ++photoCountdownVersion;
  photoCaptureInFlight = true;
  btnCapturePhoto.disabled = true;
  setCameraStatus('', 'hidden');
  void runPhotoCountdown(countdownVersion)
    .then((completed) => {
      if (!completed) return;
      return capturePhotoAsync();
    })
    .catch((error) => {
      console.error('Photo capture failed:', error);
      setCameraStatus('Не удалось обработать фото. Попробуйте ещё раз.', 'error');
    })
    .finally(() => {
      if (countdownVersion === photoCountdownVersion) hidePhotoCountdown();
      photoCaptureInFlight = false;
      if (!capturedPhotoDataUrl && cameraStream) btnCapturePhoto.disabled = false;
    });
}

async function runPhotoCountdown(version: number) {
  for (let value = 3; value >= 1; value -= 1) {
    if (
      version !== photoCountdownVersion
      || experienceScreen !== 'photo'
      || !cameraStream
      || capturedPhotoDataUrl
    ) return false;

    cameraCountdown.textContent = String(value);
    cameraCountdown.setAttribute('aria-hidden', 'false');
    cameraCountdown.classList.remove('is-ticking');
    void cameraCountdown.offsetWidth;
    cameraCountdown.classList.add('is-visible', 'is-ticking');
    await delay(1_000);
  }

  hidePhotoCountdown();
  return version === photoCountdownVersion
    && experienceScreen === 'photo'
    && Boolean(cameraStream)
    && !capturedPhotoDataUrl;
}

function hidePhotoCountdown() {
  cameraCountdown.classList.remove('is-visible', 'is-ticking');
  cameraCountdown.setAttribute('aria-hidden', 'true');
  cameraCountdown.textContent = '';
}

function cancelPhotoCountdown() {
  photoCountdownVersion += 1;
  hidePhotoCountdown();
}

async function capturePhotoAsync() {
  btnCapturePhoto.disabled = true;
  const sourceWidth = cameraVideo.videoWidth;
  const sourceHeight = cameraVideo.videoHeight;
  const targetAspect = 16 / 9;
  let cropWidth = sourceWidth;
  let cropHeight = sourceHeight;
  let sourceX = 0;
  let sourceY = 0;

  if (sourceWidth / sourceHeight > targetAspect) {
    cropWidth = sourceHeight * targetAspect;
    sourceX = (sourceWidth - cropWidth) / 2;
  } else {
    cropHeight = sourceWidth / targetAspect;
    sourceY = (sourceHeight - cropHeight) / 2;
  }

  // The generator creates the 4K result; a native 1080p reference preserves
  // facial detail without blocking the UI on a 2560px synchronous JPEG encode.
  const outputWidth = Math.min(1_920, Math.round(cropWidth));
  const outputHeight = Math.round(outputWidth / targetAspect);
  cameraCapture.width = outputWidth;
  cameraCapture.height = outputHeight;
  const context = cameraCapture.getContext('2d');
  if (!context) return;
  context.save();
  context.translate(outputWidth, 0);
  context.scale(-1, 1);
  context.drawImage(
    cameraVideo,
    sourceX,
    sourceY,
    cropWidth,
    cropHeight,
    0,
    0,
    outputWidth,
    outputHeight,
  );
  context.restore();
  capturedPhotoDataUrl = await encodeCanvasAsDataUrl(cameraCapture, 0.9);
  if (experienceScreen !== 'photo') return;
  cameraFlash.classList.remove('is-active');
  void cameraFlash.offsetWidth;
  cameraFlash.classList.add('is-active');
  cameraPreview.src = capturedPhotoDataUrl;
  cameraPreview.classList.remove('hidden');
  cameraVideo.classList.add('hidden');
  photoOverlay.classList.add('has-photo');
  btnCapturePhoto.classList.add('hidden');
  btnRetakePhoto.classList.remove('hidden');
  btnConfirmPhoto.classList.remove('hidden');
  setCameraStatus('', 'hidden');
}

function encodeCanvasAsDataUrl(canvas: HTMLCanvasElement, quality: number) {
  return new Promise<string>((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) {
        reject(new Error('Browser failed to encode the camera frame.'));
        return;
      }
      const reader = new FileReader();
      reader.addEventListener('load', () => resolve(String(reader.result)));
      reader.addEventListener('error', () => reject(reader.error || new Error('Failed to read encoded photo.')));
      reader.readAsDataURL(blob);
    }, 'image/jpeg', quality);
  });
}

function resetCameraPreview() {
  cancelPhotoCountdown();
  capturedPhotoDataUrl = '';
  cameraPreview.removeAttribute('src');
  cameraPreview.classList.add('hidden');
  cameraVideo.classList.remove('hidden');
  photoOverlay.classList.remove('has-photo');
  btnCapturePhoto.classList.remove('hidden');
  btnRetakePhoto.classList.add('hidden');
  btnConfirmPhoto.classList.add('hidden');
  btnConfirmPhoto.disabled = false;
  btnCapturePhoto.disabled = !cameraStream;
  btnCapturePhoto.textContent = cameraStream ? 'СДЕЛАТЬ ФОТО' : 'ПОВТОРИТЬ КАМЕРУ';
}

function retakePhoto() {
  resetCameraPreview();
  btnCapturePhoto.disabled = !cameraStream;
  if (cameraStream) {
    setCameraStatus('Нажми «Сделать фото»', 'hint', 2_600);
  }
}

function downloadImage(dataUrl: string, filename: string) {
  const link = document.createElement('a');
  link.href = dataUrl;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}

function confirmPhoto() {
  if (!capturedPhotoDataUrl || !selectedTeam || experienceScreen !== 'photo') return;
  btnConfirmPhoto.disabled = true;
  setCameraStatus('Фото принято', 'hint');
  stopCamera();

  const photo = capturedPhotoDataUrl;
  const team = selectedTeam;
  const abortController = new AbortController();
  const requestVersion = ++generatedImageRequestVersion;
  generationAbortController = abortController;
  void submitTeamGeneration(photo, team, kioskToken, abortController.signal)
    .then((result) => {
      if (requestVersion !== generatedImageRequestVersion) return;
      const imageSource = result.imageDataUrl || result.imageUrl || '';
      if (imageSource) {
        generatedTeamImageUrl = imageSource;
        generatedTeamImage.src = imageSource;
        syncGeneratedImageButtonVisibility();
        try {
          downloadImage(imageSource, `my-team-character-${team}.png`);
        } catch (err) {
          console.error('Auto-download failed:', err);
        }
      }
      window.dispatchEvent(new CustomEvent('team-image-ready', { detail: { ...result, team } }));
    })
    .catch((error) => {
      if (!(error instanceof DOMException && error.name === 'AbortError')) {
        console.error('Team image generation failed:', error);
      }
    })
    .finally(() => {
      if (generationAbortController === abortController) generationAbortController = null;
    });

  void enterLabyrinthFlow();
}

function openGeneratedImage() {
  if (
    !generatedTeamImageUrl
    || !isControllerConnected
    || saveCelebrationActive
    || isTransitioning
    || isLevelLoading
  ) return;
  closeSettingsDrawer();
  generatedTeamImage.src = generatedTeamImageUrl;
  generatedImageViewerOpen = true;
  generatedImageViewerPausedGame = gameSession.state === 'playing' || gameSession.state === 'countdown';
  if (generatedImageViewerPausedGame) {
    gameSession.pause(performance.now());
    isGameActive = false;
  }
  generatedImageOverlay.classList.remove('hidden');
  generatedImageOverlay.setAttribute('aria-hidden', 'false');
  settingsTrigger.classList.add('experience-hidden');
  syncGeneratedImageButtonVisibility();
}

function closeGeneratedImage() {
  generatedImageOverlay.classList.add('hidden');
  generatedImageOverlay.setAttribute('aria-hidden', 'true');
  generatedImageViewerOpen = false;
  syncSettingsTriggerVisibility();
  if (
    generatedImageViewerPausedGame
    && isControllerConnected
    && gameSession.state === 'paused'
    && pendingPostSaveAction === null
  ) {
    gameSession.resume(performance.now());
    isGameActive = gameSession.isPlaying();
    startRenderLoop();
  }
  generatedImageViewerPausedGame = false;
  syncGeneratedImageButtonVisibility();
}

function resetGeneratedImageState() {
  generatedImageRequestVersion += 1;
  generatedTeamImageUrl = '';
  generatedTeamImage.removeAttribute('src');
  btnViewGeneratedImage.classList.add('hidden');
  generatedImageOverlay.classList.add('hidden');
  generatedImageOverlay.setAttribute('aria-hidden', 'true');
  generatedImageViewerOpen = false;
  generatedImageViewerPausedGame = false;
}

btnViewGeneratedImage.addEventListener('click', openGeneratedImage);
btnCloseGeneratedImage.addEventListener('click', closeGeneratedImage);
btnDownloadGeneratedImage.addEventListener('click', () => {
  if (generatedTeamImageUrl) {
    downloadImage(generatedTeamImageUrl, `my-team-character-${selectedTeam || 'avatar'}.png`);
  }
});

async function enterLabyrinthFlow() {
  closeSettingsDrawer();
  experienceScreen = 'labyrinth';
  photoOverlay.classList.add('hidden');
  photoOverlay.setAttribute('aria-hidden', 'true');
  settingsTrigger.classList.remove('experience-hidden');
  hideStartScreen();
  // The cached shadow map may still contain the selected team ball. Hide the
  // receiver throughout pairing and rebuild it only after the maze is ready.
  setShadowPresentationVisible(false);
  markShadowMapDirty();
  renderSceneOnce();
  // Rapier/WASM and the FBX assets have been warming since the start screen,
  // so pairing should only need to clone the already parsed first maze.
  await openPairing(true);
}

async function resetExperience(resetServer: boolean) {
  closeSettingsDrawer();
  lifecycleVersion += 1;
  generationAbortController?.abort();
  generationAbortController = null;
  resetGeneratedImageState();
  stopCamera();
  if (resultResetTimer !== null) window.clearTimeout(resultResetTimer);
  resultResetTimer = null;
  clearPairingRefreshTimer();
  abortPairingRequest();
  if (saveCelebrationTimer !== null) window.clearTimeout(saveCelebrationTimer);
  saveCelebrationTimer = null;
  saveCelebrationActive = false;
  pendingPostSaveAction = null;
  gameReadyForManualStart = false;
  pairingSyncQueued = false;
  pairingServerResetPending = false;
  experienceScreen = 'start';
  selectedTeam = null;
  capturedPhotoDataUrl = '';
  isGameActive = false;
  isControllerConnected = false;
  currentControllerSessionId = null;
  gameSession.enterAttract();
  teamSelection?.reset();
  renderer.domElement.classList.remove('team-ball-blurred', 'game-paused-blurred');
  teamSelectionOverlay.classList.add('hidden');
  teamSelectionOverlay.classList.remove('is-visible', 'is-team-selected', 'is-selection-ready');
  teamSelectionOverlay.setAttribute('aria-hidden', 'true');
  photoOverlay.classList.add('hidden');
  photoOverlay.setAttribute('aria-hidden', 'true');
  resetCameraPreview();
  teamSelectionOverlay.querySelectorAll<HTMLButtonElement>('[data-team]').forEach((button) => {
    button.disabled = false;
    button.classList.remove('selected');
  });
  btnOpenCamera.disabled = true;
  settingsTrigger.classList.remove('experience-hidden');
  pairingOverlay.classList.add('hidden');
  gameLoadingOverlay.classList.add('hidden');
  gameInstructionOverlay.classList.add('hidden');
  gameInstructionOverlay.setAttribute('aria-hidden', 'true');
  saveProgressOverlay.classList.add('hidden');
  saveProgressOverlay.setAttribute('aria-hidden', 'true');
  hudOverlay.classList.add('hidden');
  victoryOverlay.classList.add('hidden');
  startOverlay.classList.remove('hidden', 'is-leaving');
  startOverlay.setAttribute('aria-hidden', 'false');
  btnStartGame.disabled = false;
  setShadowPresentationVisible(true);
  showStartScreen();
  if (resetServer && socket.connected) {
    await sendSessionCommand(SESSION_COMMANDS.PAIR).catch((error) => {
      console.error('Failed to reset server for the next guest:', error);
    });
  }
}

function stopCamera() {
  cancelPhotoCountdown();
  cameraStream?.getTracks().forEach((track) => track.stop());
  cameraStream = null;
  cameraVideo.srcObject = null;
  if (cameraStatusTimer !== null) window.clearTimeout(cameraStatusTimer);
  cameraStatusTimer = null;
}

async function requestCameraStream() {
  const preferred: MediaStreamConstraints = {
    audio: false,
    video: {
      facingMode: { ideal: 'user' },
      width: { ideal: 1_280 },
      height: { ideal: 720 },
      aspectRatio: { ideal: 16 / 9 },
    },
  };
  try {
    return await getUserMediaWithTimeout(preferred, 20_000);
  } catch (error) {
    if (error instanceof CameraRequestTimeoutError) throw error;
    if (
      error instanceof DOMException
      && ['NotAllowedError', 'NotFoundError', 'NotReadableError', 'SecurityError'].includes(error.name)
    ) throw error;
    return getUserMediaWithTimeout({ audio: false, video: true }, 20_000);
  }
}

class CameraRequestTimeoutError extends Error {
  constructor() {
    super('Браузер не получил разрешение. Разрешите камеру и нажмите «Повторить камеру».');
    this.name = 'CameraRequestTimeoutError';
  }
}

function getUserMediaWithTimeout(constraints: MediaStreamConstraints, timeoutMs: number) {
  const request = navigator.mediaDevices.getUserMedia(constraints);
  return new Promise<MediaStream>((resolve, reject) => {
    let expired = false;
    const timeout = window.setTimeout(() => {
      expired = true;
      reject(new CameraRequestTimeoutError());
    }, timeoutMs);

    request.then((stream) => {
      window.clearTimeout(timeout);
      if (expired) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      resolve(stream);
    }, (error) => {
      window.clearTimeout(timeout);
      if (!expired) reject(error);
    });
  });
}

function waitForVideoFrame(video: HTMLVideoElement, timeoutMs: number) {
  if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && video.videoWidth > 0) {
    return Promise.resolve();
  }
  return new Promise<void>((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      cleanup();
      reject(new Error('Камера подключена, но не передаёт изображение.'));
    }, timeoutMs);
    const handleReady = () => {
      if (video.videoWidth <= 0) return;
      cleanup();
      resolve();
    };
    const cleanup = () => {
      window.clearTimeout(timeout);
      video.removeEventListener('loadeddata', handleReady);
      video.removeEventListener('playing', handleReady);
      video.removeEventListener('resize', handleReady);
    };
    video.addEventListener('loadeddata', handleReady);
    video.addEventListener('playing', handleReady);
    video.addEventListener('resize', handleReady);
  });
}

function setCameraStatus(
  message: string,
  mode: 'loading' | 'hint' | 'error' | 'hidden',
  autoHideMs = 0,
) {
  if (cameraStatusTimer !== null) window.clearTimeout(cameraStatusTimer);
  cameraStatusTimer = null;
  cameraStatus.textContent = message;
  cameraStatus.classList.toggle('is-visible', mode !== 'hidden');
  cameraStatus.classList.toggle('is-error', mode === 'error');
  if (autoHideMs > 0) {
    cameraStatusTimer = window.setTimeout(() => {
      cameraStatus.classList.remove('is-visible', 'is-error');
      cameraStatusTimer = null;
    }, autoHideMs);
  }
}

function delay(durationMs: number) {
  return new Promise((resolve) => window.setTimeout(resolve, durationMs));
}

function applyCameraView(view: { position: THREE.Vector3; target: THREE.Vector3; fov: number }) {
  camera.position.copy(view.position);
  camera.fov = view.fov;
  camera.up.set(0, 1, 0);
  camera.lookAt(view.target);
  camera.updateProjectionMatrix();
}

const shadowFocus = new THREE.Vector3();
const shadowViewDirection = new THREE.Vector3();
const shadowCameraRight = new THREE.Vector3();
const shadowCameraUp = new THREE.Vector3();

function updateShadowSystem(now: number, forceShadowMap = false) {
  if (!shadowReceiver || !shadowKeyLight || !camera) return;

  if (experienceScreen === 'labyrinth' && gameSceneEditorRoot?.visible) {
    gameSceneEditorRoot.getWorldPosition(shadowFocus);
  } else {
    shadowFocus.set(0, -0.15, 0);
  }

  camera.getWorldDirection(shadowViewDirection).normalize();
  const contentRadius = experienceScreen === 'labyrinth'
    ? Math.max(0, Math.max(mazeSize.x, mazeSize.z) * 0.55)
    : 1.8;
  const receiverDistance = experienceScreen === 'labyrinth'
    ? shadowSettings.distanceBehindFocus + contentRadius
    : shadowSettings.screenDistanceBehindFocus;
  shadowReceiver.position.copy(shadowFocus).addScaledVector(shadowViewDirection, receiverDistance);
  shadowReceiver.quaternion.copy(camera.quaternion);
  shadowReceiver.scale.setScalar(shadowSettings.size);
  shadowReceiver.material.opacity = shadowSettings.opacity;

  shadowCameraRight.set(1, 0, 0).applyQuaternion(camera.quaternion).normalize();
  shadowCameraUp.set(0, 1, 0).applyQuaternion(camera.quaternion).normalize();
  shadowKeyLight.position.copy(camera.position)
    .addScaledVector(shadowCameraRight, shadowSettings.lightOffsetX)
    .addScaledVector(shadowCameraUp, shadowSettings.lightOffsetY);
  shadowKeyLight.intensity = shadowSettings.lightIntensity;
  shadowKeyLight.target.position.copy(shadowFocus);
  shadowKeyLight.target.updateMatrixWorld();

  // Fit the VSM map tightly around the visible content. This preserves usable
  // texel density and a clean soft edge on the two-metre 4K display.
  const shadowExtent = experienceScreen === 'labyrinth'
    ? Math.max(8, contentRadius * 1.35)
    : 3.4;
  if (Math.abs(shadowExtent - lastShadowExtent) > 0.05) {
    const shadowCamera = shadowKeyLight.shadow.camera;
    shadowCamera.left = -shadowExtent;
    shadowCamera.right = shadowExtent;
    shadowCamera.top = shadowExtent;
    shadowCamera.bottom = -shadowExtent;
    shadowCamera.updateProjectionMatrix();
    lastShadowExtent = shadowExtent;
    forceShadowMap = true;
  }

  // Match the shadow pass to the scene render. The map is deliberately small
  // and only the rear plane receives it, so this stays cheaper than rendering
  // self-shadows while avoiding the visible cadence mismatch on moving meshes.
  const shadowInterval = 0;
  if (forceShadowMap || now >= nextShadowMapUpdateAt) {
    renderer.shadowMap.needsUpdate = true;
    nextShadowMapUpdateAt = now + shadowInterval;
  }
}

function markShadowMapDirty() {
  nextShadowMapUpdateAt = 0;
}

function setShadowPresentationVisible(visible: boolean) {
  if (shadowReceiver) shadowReceiver.visible = visible;
  if (shadowKeyLight) shadowKeyLight.visible = visible;
  if (visible) markShadowMapDirty();
}

function enableAutomaticMeshShadows() {
  scene.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    if (object === shadowReceiver || object.userData.ignoreShadow) {
      object.castShadow = false;
      return;
    }
    if (object.userData.manualShadowControl) {
      object.receiveShadow = false;
      return;
    }
    const materials = (Array.isArray(object.material) ? object.material : [object.material])
      .filter(Boolean);
    const invisible = materials.length > 0 && materials.every((material) => (
      !material.visible
      || material.colorWrite === false
      || (material.transparent && material.opacity <= 0.001)
    ));
    object.castShadow = !invisible;
    // The experience uses one camera-facing rear plane as its shadow surface.
    // Letting every FBX mesh receive the same VSM adds a shadow lookup to all
    // materials and causes self-shadow shimmer while the maze rotates.
    object.receiveShadow = false;
  });
}

function showStartScreen() {
  isStartScreenActive = true;
  mazeContainer.visible = false;
  
  if (scene) {
    scene.background = new THREE.Color(0xC5DFFC);
  }
  
  const mainLight = scene.getObjectByName('main-light');
  if (mainLight) mainLight.visible = false;
  
  applyCameraView(startCameraView);
  updateRendererQuality();
  renderSceneOnce(false);
  void startSaveDecorations?.show()
    .then(() => {
      markShadowMapDirty();
      startRenderLoop();
    })
    .catch((error) => console.error('Start save decorations failed to load:', error));
}

function hideStartScreen() {
  isStartScreenActive = false;
  startSaveDecorations?.hide();
  mazeContainer.visible = true;
  
  if (scene) {
    scene.background = new THREE.Color(0xffffff);
  }
  
  const mainLight = scene.getObjectByName('main-light');
  if (mainLight) mainLight.visible = true;
  if (mazeGroup) updateCameraPosition();
}

async function ensureGameRuntime() {
  if (gameRuntimePromise) return gameRuntimePromise;
  const runtimeLoad = (async () => {
    const rapierReady = import('@dimforge/rapier3d-compat').then(async (module) => {
      RAPIER = module.default;
      await RAPIER.init();
    });
    await Promise.all([rapierReady, assetManager.preload()]);
    physicsWorld = new RAPIER.World({ x: 0, y: -35, z: 0 });
    debugLog(`Game runtime ready: ${LEVELS.length} mazes, props and Rapier.`);
  })();
  gameRuntimePromise = runtimeLoad.catch((error) => {
    // A rejected cached promise would make the visible Retry button fail
    // forever. Clear it so a transient asset/network error can recover.
    gameRuntimePromise = null;
    throw error;
  });
  return gameRuntimePromise;
}

function ensureSceneEnvironment() {
  if (environmentReady) return;
  environmentReady = true;
  const pmremGenerator = new THREE.PMREMGenerator(renderer);
  pmremGenerator.compileEquirectangularShader();
  const envScene = new THREE.Scene();
  const panelGeo = new THREE.BoxGeometry(100, 100, 1);
  const panelMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
  const panelPositions = [
    [-300, 150, 0],
    [300, 150, 0],
    [0, 400, -200],
    [0, 150, 300],
  ] as const;
  for (const [x, y, z] of panelPositions) {
    const panel = new THREE.Mesh(panelGeo, panelMat);
    panel.position.set(x, y, z);
    panel.lookAt(0, 0, 0);
    envScene.add(panel);
  }
  const envTarget = pmremGenerator.fromScene(envScene);
  scene.environment = envTarget.texture;
  pmremGenerator.dispose();
  panelGeo.dispose();
  panelMat.dispose();
}



// Initialize Graphics & Physics
async function init() {
  // Set up the light start/team runtime first. The game runtime starts warming
  // after the first paint so an event station is ready before a guest reaches
  // the QR screen.
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0xffffff); // White background

  // A stable editor root keeps layout adjustments separate from gyro animation.
  gameSceneEditorRoot = new THREE.Group();
  gameSceneEditorRoot.name = 'game-scene-editor-root';
  gameSceneEditorRoot.userData.editorId = 'game-scene';
  gameSceneEditorRoot.userData.editorLabel = 'Вся игровая 3D-сцена';
  scene.add(gameSceneEditorRoot);

  // Create visual container group centered at (0, 0, 0)
  mazeContainer = new THREE.Group();
  mazeContainer.name = 'maze-tilt-container';
  mazeContainer.userData.ignoreEditor = true;
  gameSceneEditorRoot.add(mazeContainer);

  // Camera setup optimized for 9:16 layout
  camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.1, 1000);
  
  const viewportPixels = window.innerWidth * window.innerHeight;
  renderer = new THREE.WebGLRenderer({
    canvas: document.getElementById('game-canvas') as HTMLCanvasElement,
    // Native 4K already has enough pixel density for clean geometry edges.
    // Avoiding an additional multisample buffer there saves a large GPU pass.
    antialias: viewportPixels < 6_000_000,
    alpha: false,
    powerPreference: "high-performance"
  });
  renderer.setSize(window.innerWidth, window.innerHeight);
  updateRendererQuality();
  renderer.shadowMap.enabled = true;
  // VSM uses regular floating-point samplers. Besides producing the soft
  // exhibition shadow we want, it avoids PCF depth-comparison sampler failures
  // seen on some Windows/ANGLE driver combinations.
  renderer.shadowMap.type = THREE.VSMShadowMap;
  renderer.shadowMap.autoUpdate = false;

  // 2. Add Studio Lights (increased intensities so everything is well-lit from all sides)
  // Ambient fill light for base brightness
  const ambientLight = new THREE.AmbientLight(0xffffff, 0.8);
  scene.add(ambientLight);

  // Key Light (main light casting shadows with optimized frustum bounds)
  const mainLight = new THREE.DirectionalLight(0xffffff, 1.8);
  mainLight.position.set(20, 50, 10);
  mainLight.name = 'main-light';
  scene.add(mainLight);

  // A camera-facing rear plane catches shadows in every scene, including top-down game views.
  const shadowMaterial = new THREE.ShadowMaterial({
    color: 0x080245,
    opacity: shadowSettings.opacity,
    transparent: true,
    depthWrite: false,
  });
  shadowReceiver = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), shadowMaterial);
  shadowReceiver.name = 'back-shadow-plane';
  shadowReceiver.receiveShadow = true;
  shadowReceiver.castShadow = false;
  shadowReceiver.frustumCulled = false;
  shadowReceiver.renderOrder = -20;
  shadowReceiver.userData.ignoreShadow = true;
  scene.add(shadowReceiver);

  // This light follows the active camera, so shadows always travel toward the rear plane.
  shadowKeyLight = new THREE.DirectionalLight(0xffffff, shadowSettings.lightIntensity);
  shadowKeyLight.name = 'shadow-key-light';
  shadowKeyLight.castShadow = true;
  shadowKeyLight.shadow.mapSize.set(1024, 1024);
  shadowKeyLight.shadow.radius = 3;
  shadowKeyLight.shadow.blurSamples = 4;
  shadowKeyLight.shadow.bias = -0.00035;
  shadowKeyLight.shadow.normalBias = 0.035;
  shadowKeyLight.shadow.camera.left = -24;
  shadowKeyLight.shadow.camera.right = 24;
  shadowKeyLight.shadow.camera.top = 24;
  shadowKeyLight.shadow.camera.bottom = -24;
  shadowKeyLight.shadow.camera.near = 0.5;
  shadowKeyLight.shadow.camera.far = 160;
  shadowKeyLight.target.name = 'shadow-key-target';
  shadowKeyLight.target.userData.ignoreEditor = true;
  scene.add(shadowKeyLight, shadowKeyLight.target);

  // Fill Light (soft light from the opposite side to brighten shadows)
  const fillLight = new THREE.DirectionalLight(0xffffff, 1.2);
  fillLight.position.set(-20, 30, 10);
  fillLight.name = 'fill-light';
  scene.add(fillLight);

  // Rim Light (backlight highlighting edges of walls and floor)
  const rimLight = new THREE.DirectionalLight(0xffffff, 1.0);
  rimLight.position.set(0, 30, -20);
  rimLight.name = 'rim-light';
  scene.add(rimLight);

  // Front Light (direct light from the camera/front side)
  const frontLight = new THREE.DirectionalLight(0xffffff, 1.2);
  frontLight.position.set(0, 30, 40);
  frontLight.name = 'front-light';
  scene.add(frontLight);

  startSaveDecorations = new StartSaveDecorations({
    scene,
    onReady: () => {
      sceneEditorPanel?.applyStoredValues();
      markShadowMapDirty();
    },
  });

  teamSelection = new TeamSelection3D({
    scene,
    camera,
    canvas: renderer.domElement,
    onSelect: handleTeamSelected,
    onSelectionReady: handleTeamSelectionReady,
  });
  teamSelection.setCameraView(teamCameraView);

  btnStartGame.addEventListener('click', () => void transitionToTeamSelection());
  teamSelectionOverlay.querySelectorAll<HTMLButtonElement>('[data-team]').forEach((button) => {
    const teamId = button.dataset.team || '';
    button.addEventListener('click', () => teamSelection?.select(teamId));
    button.addEventListener('pointerenter', () => teamSelection?.hover(teamId));
    button.addEventListener('pointerleave', () => teamSelection?.hover(null));
    button.addEventListener('focus', () => teamSelection?.hover(teamId));
    button.addEventListener('blur', () => teamSelection?.hover(null));
  });
  btnOpenCamera.addEventListener('click', () => void openPhotoScreen());
  btnCapturePhoto.addEventListener('click', handleCaptureButton);
  btnRetakePhoto.addEventListener('click', retakePhoto);
  btnConfirmPhoto.addEventListener('click', confirmPhoto);
  window.addEventListener('beforeunload', () => {
    stopCamera();
    generationAbortController?.abort();
  });

  currentLevelSpan.textContent = String(currentMazeIndex + 1).padStart(2, '0');
  showStartScreen();
  window.addEventListener('resize', onWindowResize);

  // Start all non-visible downloads after the first paint. In particular,
  // Rapier and the mazes must not begin only after the guest scans the QR.
  const preloadTeamAssets = () => {
    ensureSceneEnvironment();
    preloadGameRuntimeInBackground();
    void teamSelection?.preload()
      .then(() => {
        enableAutomaticMeshShadows();
        sceneEditorPanel?.applyStoredValues();
        debugLog(`Preloaded ${TEAMS.length} team balls.`);
      })
      .catch((error) => console.error('Team ball preload failed:', error));
  };
  window.requestIdleCallback(preloadTeamAssets, { timeout: 600 });
}

function loadMazeAsset() {
  isLevelLoading = true;
  mazeContainer.quaternion.set(0, 0, 0, 1);
  const normalMap = assetManager.getNormalMap();

  mazeMaterial = new THREE.MeshPhysicalMaterial({
    color: 0x716cff, // #716cff (requested color)
    transmission: 0.0, // Set to 0.0 to avoid WebGL transmission pass sorting conflicts
    opacity: 0.6,
    transparent: true,
    depthWrite: true, // Restored depth writing to prevent floor clipping/overlap
    roughness: 0.2, // Lower roughness for a glossy glass/plexiglass finish
    metalness: 0.1,
    ior: 1.5,
    thickness: 1.5,
    clearcoat: 1.0,
    clearcoatRoughness: 0.1,
    normalMap: normalMap,
    normalScale: new THREE.Vector2(0.2, 0.2),
    side: THREE.DoubleSide
  });

  floorMaterial = new THREE.MeshStandardMaterial({
    color: 0xddff68, // #ddff68 (requested color)
    roughness: 0.3,  // requested: 0.3
    metalness: 0.7,  // requested: 0.7
    emissive: 0xddff68, // #ddff68 (same color emission)
    emissiveIntensity: 0.15, // subtle glow
    side: THREE.DoubleSide, // Render both sides in case normals are inverted in the model
    transparent: true,
    opacity: 1.0
  });

  mazeGroup = assetManager.cloneMaze(currentMazeIndex);
  mazeEditorRoot = new THREE.Group();
  mazeEditorRoot.name = 'maze-editor-root';
  mazeEditorRoot.userData.editorId = 'game-maze';
  mazeEditorRoot.userData.editorLabel = 'Лабиринт';
  mazeEditorRoot.add(mazeGroup);
  mazeContainer.add(mazeEditorRoot);
  mazeGroup.traverse((child) => {
      const nameLower = child.name.toLowerCase();
      if (nameLower === 'start' || nameLower === 'finish') {
        child.visible = false;
        if (child instanceof THREE.Mesh) {
          child.material = new THREE.MeshBasicMaterial({ visible: false, transparent: true, opacity: 0 });
        }
        return;
      }

      if (child instanceof THREE.Mesh) {
        if (!child.geometry.boundingBox) child.geometry.computeBoundingBox();
        child.visible = true;
        const isFloor = nameLower.includes('floor') || 
                        nameLower.includes('ground') || 
                        nameLower.includes('plane') || 
                        nameLower.includes('cube.001') ||
                        nameLower.includes('floor2');
        const activeMaterial = isFloor ? floorMaterial : mazeMaterial;

        child.material = activeMaterial;
        child.castShadow = true;
        child.receiveShadow = false;
      }
  });

  if (isTransitioning) {
    mazeMaterial.opacity = 0.0;
    floorMaterial.opacity = 0.0;
  } else {
    mazeMaterial.opacity = 0.6;
    floorMaterial.opacity = 1.0;
  }

  mazeBoundingBox = getGeometryBoundingBox(mazeGroup);
  mazeBoundingBox.getSize(mazeSize);
  const maxDim = Math.max(mazeSize.x, mazeSize.z);
  if (!Number.isFinite(maxDim) || maxDim <= 0) throw new Error(`Invalid maze bounds for level ${currentMazeIndex}`);
  const scaleFactor = 12.0 / maxDim;
  mazeGroup.scale.set(scaleFactor, scaleFactor, scaleFactor);
  mazeGroup.updateMatrix();
  mazeGroup.updateMatrixWorld(true);

  debugLog(`Prepared maze ${LEVELS[currentMazeIndex].id}; scale=${scaleFactor.toFixed(5)}.`);
  positionCamera();
  buildPhysicsMaze();
  spawnGameElements();

  if (isTransitioning) {
    transitionDir = -1;
    transitionTime = 0.3;
  }
  enableAutomaticMeshShadows();
  markShadowMapDirty();
  startRenderLoop();
}

// Recalculates camera coordinates based on cameraAngleDeg
function updateCameraPosition() {
  if (!mazeGroup) return;
  const distance = Math.max(mazeSize.x, mazeSize.z);
  const angleRad = cameraAngleDeg * Math.PI / 180;
  
  // Adjust distance for vertical screens (aspect < 1.0) so maze fits horizontally
  let camDistance = distance * gameCameraDistanceMultiplier;
  if (camera.aspect < 1.0) {
    camDistance = camDistance / camera.aspect;
  }
  
  const targetZ = camDistance * Math.cos(angleRad);
  const targetY = camDistance * Math.sin(angleRad);
  
  // Initialize camera height if not set
  if (cameraHeight === 0.0) {
    cameraHeight = distance * 0.40;
  }
  
  // Raise camera Y coordinate and apply sceneYShift for vertical screen position
  camera.position.set(gameCameraX, cameraHeight + targetY - sceneYShift, targetZ);
  camera.fov = gameCameraFov;
  
  // Look slightly above the maze center - sceneYShift
  const targetLookAt = new THREE.Vector3(0, mazeYOffset + gameCameraTargetY - sceneYShift, 0);
  
  camera.lookAt(targetLookAt);
  
  // Adjust up vector if looking straight down (gimbal lock avoidance)
  if (Math.abs(cameraAngleDeg - 90.0) < 1.0) {
    camera.up.set(0, 0, -1);
  } else {
    camera.up.set(0, 1, 0);
  }
  
  camera.updateProjectionMatrix();
}

function positionCamera() {
  const center = new THREE.Vector3();
  // Get bounds of the scaled maze group (relative to container)
  mazeBoundingBox = getGeometryBoundingBox(mazeGroup!);
  mazeBoundingBox.getCenter(center);

  // Center the visual maze model group inside the container, but lower it slightly
  mazeYOffset = 0.0;
  if (mazeGroup) {
    mazeGroup.position.set(-center.x, -center.y + mazeYOffset, -center.z);
    mazeGroup.updateMatrix();
    mazeGroup.updateMatrixWorld(true);
  }
  
  // Re-evaluate bounding box at center (now centered around container origin (0,0,0))
  mazeBoundingBox = getGeometryBoundingBox(mazeGroup!);
  mazeBoundingBox.getSize(mazeSize);
  
  const distance = Math.max(mazeSize.x, mazeSize.z);
  
  camera.far = Math.max(1000, distance * 10.0);
  
  // Automatically choose a height only until the operator stores a manual value.
  if (cameraHeight === 0.0) cameraHeight = distance * 0.40;
  
  // Position camera based on our adjustable settings
  updateCameraPosition();

  debugLog(`Camera positioned. Size: Width=${mazeSize.x.toFixed(2)}, Depth=${mazeSize.z.toFixed(2)}. Camera Pos=(0, ${camera.position.y.toFixed(2)}, ${camera.position.z.toFixed(2)}), Angle=${cameraAngleDeg}°`);
}

function buildPhysicsMaze() {
  if (!mazeGroup) return;

  // Create STATIC fixed body for stable mesh collisions.
  const mazeBodyDesc = RAPIER.RigidBodyDesc.fixed();
  mazeBody = physicsWorld.createRigidBody(mazeBodyDesc);

  // Find visual floor mesh to get its exact top surface height in world coordinates
  floorTopY = mazeBoundingBox.min.y;
  mazeGroup.traverse((child) => {
    if (child instanceof THREE.Mesh) {
      const nameLower = child.name.toLowerCase();
      const isFloor = nameLower.includes('floor') || 
                      nameLower.includes('ground') || 
                      nameLower.includes('plane') || 
                      nameLower.includes('cube.001') ||
                      nameLower.includes('floor2');
      if (isFloor) {
        const floorBox = getGeometryBoundingBox(child);
        floorTopY = floorBox.max.y;
      }
    }
  });

  // Accumulate all mesh vertices and indices to build Rapier trimesh colliders
  mazeGroup.traverse((child) => {
    if (child instanceof THREE.Mesh) {
      const nameLower = child.name.toLowerCase();
      // Skip start and finish markers from generating physical obstacles
      if (nameLower === 'start' || nameLower === 'finish') return;

      // Skip floor meshes so the ball rolls on the smooth cuboid collider
      // instead of hitting seams or internal edges between modular floor tiles
      const isFloor = nameLower.includes('floor') || 
                      nameLower.includes('ground') || 
                      nameLower.includes('plane') || 
                      nameLower.includes('cube.001') ||
                      nameLower.includes('floor2');
      if (isFloor) return;

      const geometry = child.geometry;
      if (!geometry) return;

      const posAttr = geometry.attributes.position;
      if (!posAttr) return;

      const originalVertices = posAttr.array;
      const vertices = new Float32Array(posAttr.count * 3);

      child.updateMatrixWorld(true);
      const tempMatrix = child.matrixWorld.clone();
      const transformedVertex = new THREE.Vector3();

      for (let i = 0; i < posAttr.count; i++) {
        const vx = originalVertices[i * 3];
        const vy = originalVertices[i * 3 + 1];
        const vz = originalVertices[i * 3 + 2];

        transformedVertex.set(vx, vy, vz).applyMatrix4(tempMatrix);
        vertices[i * 3] = transformedVertex.x;
        vertices[i * 3 + 1] = transformedVertex.y;
        vertices[i * 3 + 2] = transformedVertex.z;
      }

      let indices: Uint32Array;
      if (geometry.index) {
        indices = new Uint32Array(geometry.index.array);
      } else {
        indices = new Uint32Array(posAttr.count);
        for (let i = 0; i < posAttr.count; i++) {
          indices[i] = i;
        }
      }

      try {
        const flags = RAPIER.TriMeshFlags.FIX_INTERNAL_EDGES | 
                      RAPIER.TriMeshFlags.DELETE_DEGENERATE_TRIANGLES | 
                      RAPIER.TriMeshFlags.DELETE_DUPLICATE_TRIANGLES;
        const colliderDesc = RAPIER.ColliderDesc.trimesh(vertices, indices, flags)
          .setFriction(0.1) // Low friction for walls to prevent sticking when sliding along them
          .setRestitution(0.0);
        physicsWorld.createCollider(colliderDesc, mazeBody ?? undefined);
      } catch (err) {
        console.error('Failed to create collider for child mesh:', err);
      }
    }
  });

  // Create a mathematically perfect smooth solid physical floor collider slightly elevated by 0.03m to lift the ball above the bottom faces of the walls
  const floorThickness = 0.2;
  const physicsFloorY = floorTopY + 0.03;
  const floorColliderDesc = RAPIER.ColliderDesc.cuboid(
    mazeSize.x * 0.5 + 1.0,
    floorThickness * 0.5,
    mazeSize.z * 0.5 + 1.0
  )
  .setTranslation(0, physicsFloorY - floorThickness * 0.5, 0)
  .setFriction(0.4)
  .setRestitution(0.2);

  physicsWorld.createCollider(floorColliderDesc, mazeBody);
  debugLog(`Solid physical floor collider added to maze body at Y = ${physicsFloorY.toFixed(3)}.`);

  debugLog('Physics maze colliders built successfully.');
}

function spawnGameElements() {
  isSaveCollected = false;
  const maxDim = Math.max(mazeSize.x, mazeSize.z);
  // Doubled ball radius multiplier to 0.024 for the fixed maps
  ballRadius = maxDim * 0.024; 
  finishRadius = ballRadius * 2.0;

  // Spawn ball exactly on the smooth elevated floor in the middle of the corridor at top-left
  startPos.set(
    mazeBoundingBox.min.x + 1.0,
    floorTopY + 0.03 + ballRadius + 0.05,
    mazeBoundingBox.min.z + 1.0
  );

  // Position finish Golden Save template using the custom default coordinates
  const finishCoord = LEVELS[currentMazeIndex]?.save;
  if (finishCoord) {
    finishPos.set(finishCoord.x, floorTopY + 0.03 + 0.1, finishCoord.z);
  } else {
    // Fallback: Position finish Golden Save template at the opposite end of the labyrinth from start (on the smooth floor)
    finishPos.set(
      mazeBoundingBox.max.x - mazeSize.x * 0.12,
      floorTopY + 0.03 + 0.1,
      mazeBoundingBox.max.z - mazeSize.z * 0.12
    );
  }

  // 1. Visual representation of the Ball (Cloned GLB Football model or holographic sphere fallback)
  const footballClone = assetManager.cloneFootball();
  if (footballClone) {
    ballMesh = footballClone;
    
    // Normalize football size to fit the physics ballRadius * 2
    const ballBox = getGeometryBoundingBox(ballMesh);
    const sizeVec = new THREE.Vector3();
    ballBox.getSize(sizeVec);
    const maxDim = Math.max(sizeVec.x, sizeVec.y, sizeVec.z);
    const scale = (maxDim > 0.0001) ? ((ballRadius * 2.0) / maxDim) : 1.0;
    ballMesh.scale.set(scale, scale, scale);
    
    ballMesh.traverse((child) => {
      if (child instanceof THREE.Mesh) {
        child.castShadow = true;
        child.receiveShadow = false;
        if (child.material) {
          if (Array.isArray(child.material)) {
            child.material.forEach((material) => {
              material.transparent = true;
              material.opacity = isTransitioning ? 0.0 : 1.0;
            });
          } else {
            child.material.transparent = true;
            child.material.opacity = isTransitioning ? 0.0 : 1.0;
          }
        }
      }
    });
  } else {
    const ballGeo = new THREE.SphereGeometry(ballRadius, 32, 32);
    const ballMat = new THREE.MeshStandardMaterial({
      color: 0x00f0ff,
      emissive: 0x003366,
      roughness: 0.15,
      metalness: 0.95,
      transparent: true,
      opacity: isTransitioning ? 0.0 : 1.0
    });
    ballMesh = new THREE.Mesh(ballGeo, ballMat);
    ballMesh.castShadow = true;
    ballMesh.receiveShadow = false;
  }
  ballEditorRoot = new THREE.Group();
  ballEditorRoot.name = 'game-ball-editor-root';
  ballEditorRoot.userData.editorId = 'game-ball';
  ballEditorRoot.userData.editorLabel = 'Игровой мяч';
  ballEditorRoot.add(ballMesh);
  mazeContainer.add(ballEditorRoot);

  // 2. Physics representation of the Ball (Dynamic sphere)
  const ballBodyDesc = RAPIER.RigidBodyDesc.dynamic()
    .setTranslation(startPos.x, startPos.y, startPos.z)
    .setLinearDamping(0.3)
    .setAngularDamping(0.3)
    .setCanSleep(false);
  ballBody = physicsWorld.createRigidBody(ballBodyDesc);
  ballBody.enableCcd(true);

  const ballColliderDesc = RAPIER.ColliderDesc.ball(ballRadius)
    .setRestitution(0.05)
    .setFriction(0.6);
  physicsWorld.createCollider(ballColliderDesc, ballBody);

  // 3. Spawn Save Item directly at finishPos
  const saveClone = assetManager.cloneSave();
  if (saveClone) {
    saveMesh = saveClone;
    saveMesh.name = 'save-item';
    if (customSaveCoordinates[currentMazeIndex]) {
      saveMesh.position.set(
        customSaveCoordinates[currentMazeIndex].x,
        finishPos.y,
        customSaveCoordinates[currentMazeIndex].z
      );
    } else {
      saveMesh.position.copy(finishPos);
    }

    // Scale saveMesh
    const saveBox = getGeometryBoundingBox(saveMesh);
    const saveSizeVec = new THREE.Vector3();
    saveBox.getSize(saveSizeVec);
    const maxDim = Math.max(saveSizeVec.x, saveSizeVec.y, saveSizeVec.z);
    const targetSize = ballRadius * 1.6;
    const finalScale = (maxDim > 0.0001) ? (targetSize / maxDim) : targetSize;
    saveMesh.scale.set(finalScale, finalScale, finalScale);
    saveMesh.position.y += targetSize * 0.6; // lift to rest on floor

    saveMesh.traverse((child) => {
      if (child instanceof THREE.Mesh) {
        child.visible = true;
        child.castShadow = true;
        child.receiveShadow = false;
        if (child.material) {
          if (Array.isArray(child.material)) {
            child.material.forEach((material) => {
              material.transparent = true;
              material.opacity = isTransitioning ? 0.0 : 1.0;
            });
          } else {
            child.material.transparent = true;
            child.material.opacity = isTransitioning ? 0.0 : 1.0;
          }
        }
      }
    });

    saveEditorRoot = new THREE.Group();
    saveEditorRoot.name = 'save-editor-root';
    saveEditorRoot.userData.editorId = 'game-save';
    saveEditorRoot.userData.editorLabel = 'Сейв';
    saveEditorRoot.add(saveMesh);
    mazeContainer.add(saveEditorRoot);
  }

  // Glowing pulse light at finish
  const finishLight = new THREE.PointLight(0xff00ff, 4, finishRadius * 8);
  finishLight.position.set(finishPos.x, finishPos.y + 0.4, finishPos.z);
  finishLight.name = 'finish-light';
  mazeContainer.add(finishLight); 

  // Front highlight light directly facing the save disk's front emblem
  const saveHighlightFront = new THREE.PointLight(0xffffff, 15, ballRadius * 25);
  saveHighlightFront.position.set(finishPos.x, finishPos.y + 0.3, finishPos.z + 1.2);
  saveHighlightFront.name = 'save-highlight-front';
  mazeContainer.add(saveHighlightFront);

  // Back highlight light to eliminate shadows on the reverse side
  const saveHighlightBack = new THREE.PointLight(0xffffff, 8, ballRadius * 20);
  saveHighlightBack.position.set(finishPos.x, finishPos.y + 0.3, finishPos.z - 1.2);
  saveHighlightBack.name = 'save-highlight-back';
  mazeContainer.add(saveHighlightBack);

  // Top highlight light shining down from above
  const saveHighlightTop = new THREE.PointLight(0xffffff, 8, ballRadius * 20);
  saveHighlightTop.position.set(finishPos.x, finishPos.y + 1.0, finishPos.z);
  saveHighlightTop.name = 'save-highlight-top';
  mazeContainer.add(saveHighlightTop);

  // Ambient neon light at start
  const startLight = new THREE.PointLight(0x00f0ff, 2, ballRadius * 8);
  startLight.position.set(startPos.x, startPos.y + 0.4, startPos.z);
  startLight.name = 'start-light';
  mazeContainer.add(startLight); 

  debugLog(`Ball spawned at: x=${startPos.x.toFixed(2)}, y=${startPos.y.toFixed(2)}, z=${startPos.z.toFixed(2)}`);
  debugLog(`Finish spawned at: x=${finishPos.x.toFixed(2)}, y=${finishPos.y.toFixed(2)}, z=${finishPos.z.toFixed(2)}`);

  isLevelLoading = false;
  syncGeneratedImageButtonVisibility();



  if (import.meta.env.DEV) {
    Object.assign(window, { physicsWorld, ballBody, ballMesh, mazeGroup, startPos, finishPos });
  }

  sceneEditorPanel?.applyStoredValues();
}

function onWindowResize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  updateRendererQuality();
  renderer.setSize(window.innerWidth, window.innerHeight);
  if (experienceScreen === 'team') {
    teamSelection?.resize();
    markShadowMapDirty();
    startRenderLoop();
  } else if (isStartScreenActive) {
    applyCameraView(startCameraView);
    renderSceneOnce();
    startRenderLoop();
  } else {
    positionCamera();
    markShadowMapDirty();
    startRenderLoop();
  }
}

function shouldRenderWebGl() {
  return experienceScreen === 'team'
    || experienceScreen === 'labyrinth'
    || Boolean(startSaveDecorations?.needsContinuousRender());
}

function startRenderLoop() {
  if (isAnimating || !shouldRenderWebGl()) return;
  updateRendererQuality();
  lastFrameAt = performance.now();
  isAnimating = true;
  requestAnimationFrame(animate);
}

function renderSceneOnce(updateShadows = true) {
  if (!renderer || !scene || !camera) return;
  if (updateShadows) updateShadowSystem(performance.now(), true);
  renderer.render(scene, camera);
}

// Game loop
function animate(now: number) {
  if (!shouldRenderWebGl()) {
    isAnimating = false;
    return;
  }

  // Presentation/selection scenes run at a stable 30 FPS. Active maze play
  // remains at display rate so smartphone tilt input stays responsive.
  const useThirtyFps = experienceScreen === 'start'
    || experienceScreen === 'transition'
    || experienceScreen === 'team'
    || (experienceScreen === 'labyrinth' && !isGameActive);
  if (useThirtyFps && now - lastFrameAt < 33) {
    requestAnimationFrame(animate);
    return;
  }

  const dt = Math.min(0.05, Math.max(0, (now - lastFrameAt) / 1_000));
  lastFrameAt = now;
  startSaveDecorations?.update(now);

  if (experienceScreen === 'start' || experienceScreen === 'transition') {
    updateShadowSystem(now);
    renderer.render(scene, camera);
    if (shouldRenderWebGl()) {
      requestAnimationFrame(animate);
    } else {
      isAnimating = false;
    }
    return;
  }

  teamSelection?.update(now);
  const sessionTick = gameSession.tick(now);
  if (gameSession.state === 'countdown') {
    const countdown = Math.max(1, Math.ceil(sessionTick.countdownMs / 1000));
    setTextIfChanged(timerSpan, String(countdown));
    updateConnectionStatus(`СТАРТ ЧЕРЕЗ ${countdown}`);
    if (sessionTick.countdownCompleted && gameSession.startPlaying(now)) {
      isGameActive = true;
      gameTimeLeft = GAME_DURATION_MS / 1000;
      setTextIfChanged(timerSpan, String(Math.ceil(gameTimeLeft)));
      updateConnectionStatus('СМАРТФОН АКТИВЕН');
      void sendSessionCommand(SESSION_COMMANDS.PLAYING).catch((error) => {
        console.error('Server rejected game start:', error);
        void openPairing(true);
      });
    }
  } else if (gameSession.state === 'playing') {
    gameTimeLeft = sessionTick.remainingMs / 1000;
    setTextIfChanged(timerSpan, String(Math.ceil(gameTimeLeft)));
    if (sessionTick.timedOut) endGame(false);
  } else if (gameSession.state === 'paused') {
    setTextIfChanged(timerSpan, String(Math.ceil(sessionTick.remainingMs / 1000)));
  }
  // 3. Normal active Save Mesh Hover rotation in the level
  if (saveMesh && !saveCelebrationActive) {
    saveMesh.rotation.y += 2.99 * dt;
    const bobOffset = Math.sin(Date.now() * 0.003) * 0.04;
    saveMesh.position.y = (floorTopY + 0.03 + (ballRadius * 1.6) * 0.6) + bobOffset;
  }

  // 4. Fade Transition Animation for level switching
  if (isTransitioning) {
    if (transitionDir === 1) {
      // Fading out
      transitionTime = Math.min(0.3, transitionTime + dt);
      const progress = transitionTime / 0.3;
      const opacity = 1.0 - progress;
      
      if (mazeMaterial) {
        mazeMaterial.opacity = 0.6 * opacity;
      }
      if (floorMaterial) {
        floorMaterial.opacity = opacity;
      }
      if (ballMesh) {
        ballMesh.traverse((child) => {
          if (child instanceof THREE.Mesh && child.material) {
            if (Array.isArray(child.material)) {
              child.material.forEach((mat) => {
                mat.transparent = true;
                mat.opacity = opacity;
              });
            } else {
              child.material.transparent = true;
              child.material.opacity = opacity;
            }
          }
        });
      }
      const gates = mazeContainer.getObjectByName('football-gates');
      if (gates) {
        gates.traverse((child) => {
          if (child instanceof THREE.Mesh && child.material) {
            if (Array.isArray(child.material)) {
              child.material.forEach((mat) => {
                mat.transparent = true;
                mat.opacity = opacity;
              });
            } else {
              child.material.transparent = true;
              child.material.opacity = opacity;
            }
          }
        });
      }
      if (saveMesh) {
        saveMesh.traverse((child) => {
          if (child instanceof THREE.Mesh && child.material) {
            if (Array.isArray(child.material)) {
              child.material.forEach((mat) => mat.opacity = opacity);
            } else {
              child.material.opacity = opacity;
            }
          }
        });
      }
      
      // Fade out lights
      const finishLight = mazeContainer.getObjectByName('finish-light') as THREE.PointLight;
      if (finishLight) finishLight.intensity = 4.0 * opacity;
      const startLight = mazeContainer.getObjectByName('start-light') as THREE.PointLight;
      if (startLight) startLight.intensity = 2.0 * opacity;
      const saveFront = mazeContainer.getObjectByName('save-highlight-front') as THREE.PointLight;
      if (saveFront) saveFront.intensity = 15.0 * opacity;
      const saveBack = mazeContainer.getObjectByName('save-highlight-back') as THREE.PointLight;
      if (saveBack) saveBack.intensity = 8.0 * opacity;
      const saveTop = mazeContainer.getObjectByName('save-highlight-top') as THREE.PointLight;
      if (saveTop) saveTop.intensity = 8.0 * opacity;
      
      if (transitionTime >= 0.3) {
        // Fade out complete, switch level
        switchMaze(nextMazeIndexToLoad);
      }
    } else {
      // Fading in
      transitionTime = Math.max(0.0, transitionTime - dt);
      const progress = transitionTime / 0.3; // 1 down to 0
      const opacity = 1.0 - progress; // 0 up to 1
      
      if (mazeMaterial) {
        mazeMaterial.opacity = 0.6 * opacity;
      }
      if (floorMaterial) {
        floorMaterial.opacity = opacity;
      }
      if (ballMesh) {
        ballMesh.traverse((child) => {
          if (child instanceof THREE.Mesh && child.material) {
            if (Array.isArray(child.material)) {
              child.material.forEach((mat) => {
                mat.transparent = true;
                mat.opacity = opacity;
              });
            } else {
              child.material.transparent = true;
              child.material.opacity = opacity;
            }
          }
        });
      }
      const gates = mazeContainer.getObjectByName('football-gates');
      if (gates) {
        gates.traverse((child) => {
          if (child instanceof THREE.Mesh && child.material) {
            if (Array.isArray(child.material)) {
              child.material.forEach((mat) => {
                mat.transparent = true;
                mat.opacity = opacity;
              });
            } else {
              child.material.transparent = true;
              child.material.opacity = opacity;
            }
          }
        });
      }
      if (saveMesh) {
        saveMesh.traverse((child) => {
          if (child instanceof THREE.Mesh && child.material) {
            if (Array.isArray(child.material)) {
              child.material.forEach((mat) => mat.opacity = opacity);
            } else {
              child.material.opacity = opacity;
            }
          }
        });
      }
      
      // Fade in lights
      const finishLight = mazeContainer.getObjectByName('finish-light') as THREE.PointLight;
      if (finishLight) finishLight.intensity = 4.0 * opacity;
      const startLight = mazeContainer.getObjectByName('start-light') as THREE.PointLight;
      if (startLight) startLight.intensity = 2.0 * opacity;
      const saveFront = mazeContainer.getObjectByName('save-highlight-front') as THREE.PointLight;
      if (saveFront) saveFront.intensity = 15.0 * opacity;
      const saveBack = mazeContainer.getObjectByName('save-highlight-back') as THREE.PointLight;
      if (saveBack) saveBack.intensity = 8.0 * opacity;
      const saveTop = mazeContainer.getObjectByName('save-highlight-top') as THREE.PointLight;
      if (saveTop) saveTop.intensity = 8.0 * opacity;
      
      if (transitionTime <= 0.0) {
        isTransitioning = false;
        syncGeneratedImageButtonVisibility();
      }
    }
  }

  if (physicsWorld && ballBody && ballMesh) {
    const simulationActive = isGameActive && gameSession.state === 'playing' && !isLevelLoading && !isStartScreenActive;
    if (!simulationActive) {
      if (!saveCelebrationActive && !generatedImageViewerOpen) {
        // Keep everything flat and unrotated during level build. During the
        // two-second save pause and fullscreen image view the current tilt is
        // deliberately preserved.
        currentPitch = 0;
        currentRoll = 0;
        currentYaw = 0;
        if (mazeContainer) {
          mazeContainer.quaternion.set(0, 0, 0, 1);
        }
        physicsWorld.gravity = { x: 0, y: -35.0, z: 0 };
      }
    } else {
      // Update manual offsets from keyboard visual button presses (WASD keys)
      const tiltRate = 2.2 * dt; 
      const centerRate = 2.8 * dt; 

      if (activeControls.up) {
        manualPitch = Math.min(1.0, manualPitch + tiltRate);
      } else if (activeControls.down) {
        manualPitch = Math.max(-1.0, manualPitch - tiltRate);
      } else {
        // Return manualPitch back to flat
        if (manualPitch > 0) manualPitch = Math.max(0, manualPitch - centerRate);
        if (manualPitch < 0) manualPitch = Math.min(0, manualPitch + centerRate);
      }

      if (activeControls.right) {
        manualRoll = Math.min(1.0, manualRoll + tiltRate);
      } else if (activeControls.left) {
        manualRoll = Math.max(-1.0, manualRoll - tiltRate);
      } else {
        // Return manualRoll back to flat
        if (manualRoll > 0) manualRoll = Math.max(0, manualRoll - centerRate);
        if (manualRoll < 0) manualRoll = Math.min(0, manualRoll + centerRate);
      }

      // Combine mobile phone tilt and manual/keyboard controls, clamped to range
      targetPitch = Math.max(-1.0, Math.min(1.0, phonePitch + manualPitch));
      targetRoll = Math.max(-1.0, Math.min(1.0, phoneRoll + manualRoll));

      // 1. Smoothly interpolate maze rotation (taking the shortest path for yaw, frame-rate independent)
      const smoothingFactor = 1.0 - Math.exp(-6.0 * dt);
      currentPitch += (targetPitch - currentPitch) * smoothingFactor;
      currentRoll += (targetRoll - currentRoll) * smoothingFactor;
      
      let yawDiff = phoneYaw - currentYaw;
      while (yawDiff < -Math.PI) yawDiff += Math.PI * 2;
      while (yawDiff > Math.PI) yawDiff -= Math.PI * 2;
      currentYaw += yawDiff * smoothingFactor;

      // 2. Physics world gravity slant in local coordinates
      // Both the visual tilt and physical gravity rotate together with the maze,
      // so they are calculated directly in local space.
      const gravityStrength = 31.0;
      physicsWorld.gravity = {
        x: currentRoll * gravityStrength,
        y: -35.0,
        z: currentPitch * gravityStrength
      };

      // 3. Visual maze rotation matching gravity tilt and phone yaw
      // Using YXZ Euler order applies Y rotation (yaw) first, which rotates the tilt axis with the maze.
      const visualPitch = currentPitch * maxTiltAngle;
      const visualRoll = -currentRoll * maxTiltAngle;
      const visualYaw = currentYaw; 
      frameMazeEuler.set(visualPitch, visualYaw, visualRoll, 'YXZ');
      frameMazeRotation.setFromEuler(frameMazeEuler);

      if (mazeContainer) {
        mazeContainer.quaternion.copy(frameMazeRotation);
      }
    }

    // 4. Step physics only while a validated controller owns an active session.
    if (simulationActive) {
      physicsAccumulator = Math.min(physicsAccumulator + dt, PHYSICS_TIMESTEP * MAX_PHYSICS_STEPS_PER_FRAME);
      while (physicsAccumulator >= PHYSICS_TIMESTEP) {
        physicsWorld.step();
        physicsAccumulator -= PHYSICS_TIMESTEP;
      }
    } else {
      physicsAccumulator = 0;
      ballBody.setLinvel({ x: 0, y: 0, z: 0 }, true);
      ballBody.setAngvel({ x: 0, y: 0, z: 0 }, true);
    }

    // 5. Sync Ball graphics
    const ballPos = ballBody.translation();
    const ballRot = ballBody.rotation();
    
    ballMesh.position.set(ballPos.x, ballPos.y, ballPos.z);
    ballMesh.quaternion.set(ballRot.x, ballRot.y, ballRot.z, ballRot.w);

    // 6. Update audio based on velocity
    const linVel = ballBody.linvel();
    frameVelocity.set(linVel.x, linVel.y, linVel.z);
    const speed = simulationActive ? frameVelocity.length() : 0;

    sounds.updateRolling(speed);

    if (simulationActive && speed > 0.1) {
      aliveTime += dt;
      if (aliveTime > 3.0) {
        resetCount = 0;
      }
    } else {
      aliveTime = 0;
    }

    if (simulationActive) {
      frameAcceleration.copy(lastVelocity).sub(frameVelocity);
      const deltaV = frameAcceleration.length();
      if (deltaV > 1.2) sounds.playImpact(deltaV * 2.0);
      lastVelocity.copy(frameVelocity);

      const dropLimit = mazeBoundingBox.min.y - Math.max(2.0, mazeSize.y * 1.5);
      if (ballPos.y < dropLimit) {
        debugLog(`Ball fell below threshold (${ballPos.y.toFixed(2)} < ${dropLimit.toFixed(2)}). Resetting...`);
        resetGame();
      }

      if (!isSaveCollected && saveMesh) {
        frameBallXZ.set(ballPos.x, ballPos.z);
        frameSaveXZ.set(saveMesh.position.x, saveMesh.position.z);
        const distToSave = frameBallXZ.distanceTo(frameSaveXZ);
        if (distToSave < (ballRadius + (ballRadius * 1.6) * 0.8) && !isTransitioning) {
          collectSave();
        }
      }
    } else {
      lastVelocity.set(0, 0, 0);
    }
  }

  updateShadowSystem(now);

  // Render Scene
  renderer.render(scene, camera);

  const keepRendering = shouldRenderWebGl()
    && (experienceScreen !== 'team' || Boolean(teamSelection?.needsContinuousRender()));
  if (keepRendering) {
    requestAnimationFrame(animate);
  } else {
    isAnimating = false;
  }
}

// Initialize the kiosk; pairing starts only after the attract-screen button.
void init().catch((error) => {
  console.error('Fatal kiosk initialization error:', error);
  startOverlay.classList.remove('hidden');
  btnStartGame.disabled = true;
  btnStartGame.textContent = 'ОШИБКА ЗАГРУЗКИ';
});

// Active states of keyboard directional controls (WASD keys for developer tilting)
const activeControls = {
  up: false,
  down: false,
  left: false,
  right: false
};

// Bind keyboard events
window.addEventListener('keydown', (e) => {
  // Camera Angle adjustments (Up/Down arrow keys raise/lower camera angle)
  if (e.key === 'ArrowUp') {
    cameraAngleDeg = Math.min(85.0, cameraAngleDeg + 2.0);
    updateCameraPosition();
    e.preventDefault();
  }
  if (e.key === 'ArrowDown') {
    cameraAngleDeg = Math.max(5.0, cameraAngleDeg - 2.0);
    updateCameraPosition();
    e.preventDefault();
  }

  // Keyboard tilting (WASD keys tilt the maze)
  if (e.key === 'w' || e.key === 'W') { activeControls.up = true; e.preventDefault(); }
  if (e.key === 's' || e.key === 'S') { activeControls.down = true; e.preventDefault(); }
  if (e.key === 'a' || e.key === 'A') { activeControls.left = true; e.preventDefault(); }
  if (e.key === 'd' || e.key === 'D') { activeControls.right = true; e.preventDefault(); }
  
  if (e.key === 'c' || e.key === 'C') {
    calibrate();
    socket.emit(EVENTS.CALIBRATE);
  }
  if (e.key === 'r' || e.key === 'R') {
    resetGame();
  }
  // Switch maze levels with number keys.
  if (e.key >= '1' && e.key <= String(LEVELS.length)) {
    switchMaze(parseInt(e.key) - 1);
  }
});

window.addEventListener('keyup', (e) => {
  if (e.key === 'w' || e.key === 'W') { activeControls.up = false; }
  if (e.key === 's' || e.key === 'S') { activeControls.down = false; }
  if (e.key === 'a' || e.key === 'A') { activeControls.left = false; }
  if (e.key === 'd' || e.key === 'D') { activeControls.right = false; }
});

// Extensible operator layout/scene editor.
const settingsGroupSelect = document.getElementById('settings-group-select') as HTMLSelectElement;
const settingsTargetSelect = document.getElementById('settings-target-select') as HTMLSelectElement;
const settingsDynamicControls = document.getElementById('settings-dynamic-controls') as HTMLElement;
const settingsResetTarget = document.getElementById('settings-reset-target') as HTMLButtonElement;
const settingsResetAll = document.getElementById('settings-reset-all') as HTMLButtonElement;

restoreStartAndTeamCameraDefaultsOnce();
restoreTeamBallGroupRotationOnce();

sceneEditorPanel = new SceneEditorPanel({
  trigger: settingsTrigger,
  panel: settingsPanel,
  close: settingsClose,
  groupSelect: settingsGroupSelect,
  targetSelect: settingsTargetSelect,
  controls: settingsDynamicControls,
  resetTarget: settingsResetTarget,
  resetAll: settingsResetAll,
  targetProvider: buildEditorTargets,
});

function restoreStartAndTeamCameraDefaultsOnce() {
  migrateSceneEditorStateOnce('holobox-camera-defaults-restored-v1', (values) => {
    delete values['camera:start'];
    delete values['camera:team'];
  });
}

function restoreTeamBallGroupRotationOnce() {
  migrateSceneEditorStateOnce('holobox-team-ball-group-rotation-restored-v1', (values) => {
    const teamBallGroup = values['three:team-scene-v2'];
    if (!teamBallGroup) return;
    teamBallGroup.rotationX = 0;
    teamBallGroup.rotationY = 0;
    teamBallGroup.rotationZ = 0;
  });
}

function migrateSceneEditorStateOnce(
  migrationKey: string,
  update: (values: Record<string, Record<string, number>>) => void,
) {
  try {
    if (localStorage.getItem(migrationKey) === '1') return;
    const rawState = localStorage.getItem(SCENE_EDITOR_STORAGE_KEY);
    if (rawState) {
      const state = JSON.parse(rawState) as {
        version?: unknown;
        values?: Record<string, Record<string, number>>;
      };
      if (state.version === 1 && state.values && typeof state.values === 'object') {
        update(state.values);
        localStorage.setItem(SCENE_EDITOR_STORAGE_KEY, JSON.stringify(state));
      }
    }
    localStorage.setItem(migrationKey, '1');
  } catch {
    // Storage may be unavailable in private mode; in that case camera values
    // already fall back to the defaults declared below.
  }
}

function buildEditorTargets(): EditorTarget[] {
  return [
    ...buildDomEditorTargets(),
    ...buildCameraEditorTargets(),
    ...buildThreeEditorTargets(),
    buildShadowEditorTarget(),
  ];
}

interface DomEditorState {
  x: number;
  y: number;
  scaleX: number;
  scaleY: number;
  rotationX: number;
  rotationY: number;
  rotationZ: number;
}

function buildDomEditorTargets(): EditorTarget[] {
  const elements = [...document.querySelectorAll('#app *')]
    .filter((element): element is HTMLElement => (
      element instanceof HTMLElement
      && element.id !== 'game-canvas'
      && !element.closest('#settings-panel')
    ));

  return elements.map((element) => {
    const state: DomEditorState = {
      x: readEditorDataNumber(element, 'editorX', 0),
      y: readEditorDataNumber(element, 'editorY', 0),
      scaleX: readEditorDataNumber(element, 'editorScaleX', 1),
      scaleY: readEditorDataNumber(element, 'editorScaleY', 1),
      rotationX: readEditorDataNumber(element, 'editorRotationX', 0),
      rotationY: readEditorDataNumber(element, 'editorRotationY', 0),
      rotationZ: readEditorDataNumber(element, 'editorRotationZ', 0),
    };
    const apply = () => applyDomEditorState(element, state);
    apply();
    return {
      id: `dom:${getStableDomKey(element)}`,
      label: getDomEditorLabel(element),
      group: getDomEditorGroup(element),
      fields: [
        createField('x', 'Позиция X', -1_500, 1_500, 1, state.x, () => state.x, (value) => { state.x = value; apply(); }, ' px'),
        createField('y', 'Позиция Y', -1_500, 1_500, 1, state.y, () => state.y, (value) => { state.y = value; apply(); }, ' px'),
        createField('scaleX', 'Масштаб X', 0.1, 4, 0.01, state.scaleX, () => state.scaleX, (value) => { state.scaleX = value; apply(); }),
        createField('scaleY', 'Масштаб Y', 0.1, 4, 0.01, state.scaleY, () => state.scaleY, (value) => { state.scaleY = value; apply(); }),
        createField('rotationX', 'Наклон X', -180, 180, 1, state.rotationX, () => state.rotationX, (value) => { state.rotationX = value; apply(); }, '°'),
        createField('rotationY', 'Наклон Y', -180, 180, 1, state.rotationY, () => state.rotationY, (value) => { state.rotationY = value; apply(); }, '°'),
        createField('rotationZ', 'Поворот Z', -180, 180, 1, state.rotationZ, () => state.rotationZ, (value) => { state.rotationZ = value; apply(); }, '°'),
      ],
    };
  });
}

function readEditorDataNumber(element: HTMLElement, key: keyof DOMStringMap, fallback: number) {
  const value = Number(element.dataset[key]);
  return Number.isFinite(value) ? value : fallback;
}

function applyDomEditorState(element: HTMLElement, state: DomEditorState) {
  element.style.translate = `${state.x}px ${state.y}px`;
  element.style.scale = `${state.scaleX} ${state.scaleY}`;
  element.style.rotate = eulerDegreesToCssAxisAngle(
    state.rotationX,
    state.rotationY,
    state.rotationZ,
  );
}

function eulerDegreesToCssAxisAngle(xDeg: number, yDeg: number, zDeg: number) {
  const x = THREE.MathUtils.degToRad(xDeg) * 0.5;
  const y = THREE.MathUtils.degToRad(yDeg) * 0.5;
  const z = THREE.MathUtils.degToRad(zDeg) * 0.5;
  const cx = Math.cos(x); const sx = Math.sin(x);
  const cy = Math.cos(y); const sy = Math.sin(y);
  const cz = Math.cos(z); const sz = Math.sin(z);
  const qx = sx * cy * cz + cx * sy * sz;
  const qy = cx * sy * cz - sx * cy * sz;
  const qz = cx * cy * sz + sx * sy * cz;
  const qw = cx * cy * cz - sx * sy * sz;
  const angle = 2 * Math.acos(Math.max(-1, Math.min(1, qw)));
  const denominator = Math.sqrt(Math.max(0, 1 - qw * qw));
  if (angle < 0.000001 || denominator < 0.000001) return 'none';
  return `${qx / denominator} ${qy / denominator} ${qz / denominator} ${angle}rad`;
}

function getStableDomKey(element: HTMLElement) {
  if (element.id) return element.id;
  const segments: string[] = [];
  let current: HTMLElement | null = element;
  while (current && current.id !== 'app') {
    const siblings = current.parentElement
      ? [...current.parentElement.children].filter((sibling) => sibling.tagName === current!.tagName)
      : [];
    segments.unshift(`${current.tagName.toLowerCase()}:${Math.max(0, siblings.indexOf(current))}`);
    if (current.parentElement?.id) {
      segments.unshift(current.parentElement.id);
      break;
    }
    current = current.parentElement;
  }
  return segments.join('/');
}

function getDomEditorLabel(element: HTMLElement) {
  const explicit = element.dataset.editorLabel;
  if (explicit) return explicit;
  if (element.id) return `#${element.id}`;
  const imageAlt = element instanceof HTMLImageElement ? element.alt.trim() : '';
  const text = (element.getAttribute('aria-label') || imageAlt || element.textContent || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 42);
  const className = typeof element.className === 'string'
    ? element.className.split(/\s+/).filter(Boolean)[0]
    : '';
  return text || (className ? `.${className}` : element.tagName.toLowerCase());
}

function getDomEditorGroup(element: HTMLElement) {
  if (element.closest('#start-overlay')) return 'DOM — стартовый экран';
  if (element.closest('#team-selection-overlay')) return 'DOM — выбор команды';
  if (element.closest('#photo-overlay')) return 'DOM — фото';
  if (element.closest('#pairing-overlay')) return 'DOM — QR и сопряжение';
  if (element.closest('#hud-overlay')) return 'DOM — игровой HUD';
  if (element.closest('#victory-overlay')) return 'DOM — результат';
  return 'DOM — общие элементы';
}

function buildCameraEditorTargets(): EditorTarget[] {
  const startTarget: EditorTarget = {
    id: 'camera:start',
    label: 'Камера стартового экрана',
    group: 'Камеры',
    fields: createCameraViewFields(startCameraView.position, startCameraView.target, () => startCameraView.fov, (value) => { startCameraView.fov = value; }, {
      position: { x: 0, y: 0.5, z: 10 },
      target: { x: 0, y: 0.5, z: 0 },
      fov: 45,
    }),
    afterApply: () => {
      if (isStartScreenActive) applyCameraView(startCameraView);
    },
  };

  const teamPosition = teamCameraView.position;
  const teamTarget = teamCameraView.target;
  const teamEditorTarget: EditorTarget = {
    id: 'camera:team',
    label: 'Камера выбора команды',
    group: 'Камеры',
    fields: createPlainCameraViewFields(teamPosition, teamTarget, () => teamCameraView.fov, (value) => { teamCameraView.fov = value; }, {
      position: { x: 0, y: 0.35, z: 12 },
      target: { x: 0, y: -0.35, z: 0 },
      fov: 45,
    }),
    afterApply: () => {
      teamSelection?.setCameraView(teamCameraView);
      markShadowMapDirty();
      renderSceneOnce();
    },
  };

  const gameTarget: EditorTarget = {
    id: 'camera:game',
    label: 'Камера лабиринта',
    group: 'Камеры',
    fields: [
      createField('x', 'Позиция X', -20, 20, 0.1, 0, () => gameCameraX, (value) => { gameCameraX = value; }, ' м'),
      createField('height', 'Высота камеры', -10, 40, 0.1, 4.8, () => cameraHeight, (value) => { cameraHeight = value; }, ' м'),
      createField('angle', 'Угол сверху', 0, 89, 1, 0, () => cameraAngleDeg, (value) => { cameraAngleDeg = value; }, '°'),
      createField('distance', 'Дистанция', 0.5, 4, 0.05, 1.9, () => gameCameraDistanceMultiplier, (value) => { gameCameraDistanceMultiplier = value; }, '×'),
      createField('targetY', 'Высота точки взгляда', -10, 15, 0.1, 1, () => gameCameraTargetY, (value) => { gameCameraTargetY = value; }, ' м'),
      createField('sceneY', 'Сдвиг сцены по высоте', -10, 10, 0.1, 0, () => sceneYShift, (value) => { sceneYShift = value; }, ' м'),
      createField('fov', 'Поле зрения', 15, 100, 1, 45, () => gameCameraFov, (value) => { gameCameraFov = value; }, '°'),
    ],
    afterApply: () => {
      if (experienceScreen === 'labyrinth') {
        updateCameraPosition();
        markShadowMapDirty();
        renderSceneOnce();
      }
    },
  };
  return [startTarget, teamEditorTarget, gameTarget];
}

function createCameraViewFields(
  position: THREE.Vector3,
  target: THREE.Vector3,
  getFov: () => number,
  setFov: (value: number) => void,
  defaults: { position: { x: number; y: number; z: number }; target: { x: number; y: number; z: number }; fov: number },
) {
  return createPlainCameraViewFields(position, target, getFov, setFov, defaults);
}

function createPlainCameraViewFields(
  position: { x: number; y: number; z: number },
  target: { x: number; y: number; z: number },
  getFov: () => number,
  setFov: (value: number) => void,
  defaults: { position: { x: number; y: number; z: number }; target: { x: number; y: number; z: number }; fov: number },
): EditorField[] {
  return [
    createField('x', 'Камера X', -50, 50, 0.1, defaults.position.x, () => position.x, (value) => { position.x = value; }, ' м'),
    createField('y', 'Высота камеры', -20, 50, 0.1, defaults.position.y, () => position.y, (value) => { position.y = value; }, ' м'),
    createField('z', 'Камера Z', -50, 50, 0.1, defaults.position.z, () => position.z, (value) => { position.z = value; }, ' м'),
    createField('targetX', 'Точка взгляда X', -20, 20, 0.1, defaults.target.x, () => target.x, (value) => { target.x = value; }, ' м'),
    createField('targetY', 'Точка взгляда Y', -20, 20, 0.1, defaults.target.y, () => target.y, (value) => { target.y = value; }, ' м'),
    createField('targetZ', 'Точка взгляда Z', -20, 20, 0.1, defaults.target.z, () => target.z, (value) => { target.z = value; }, ' м'),
    createField('fov', 'Поле зрения', 15, 100, 1, defaults.fov, getFov, setFov, '°'),
  ];
}

function buildThreeEditorTargets(): EditorTarget[] {
  if (!scene) return [];
  const objects = new Map<string, { id: string; label: string; group: string; object: THREE.Object3D }>();
  const add = (id: string, label: string, group: string, object: THREE.Object3D | null | undefined) => {
    if (!object || objects.has(id)) return;
    objects.set(id, { id, label, group, object });
  };

  add('game-scene', 'Вся игровая 3D-сцена', '3D — лабиринт', gameSceneEditorRoot);
  add('game-maze', 'Лабиринт', '3D — лабиринт', mazeEditorRoot);
  add('game-ball', 'Игровой мяч', '3D — лабиринт', ballEditorRoot);
  add('game-save', 'Сейв', '3D — лабиринт', saveEditorRoot);
  for (const target of startSaveDecorations?.getEditorObjects() || []) {
    add(target.id, target.label, '3D — стартовый экран', target.object);
  }
  for (const target of teamSelection?.getEditorObjects() || []) {
    add(target.id, target.label, '3D — выбор команды', target.object);
  }

  scene.traverse((object) => {
    if (
      object instanceof THREE.Light
      || object instanceof THREE.Camera
      || object === shadowReceiver
      || object.userData.ignoreEditor
    ) return;
    const explicitId = typeof object.userData.editorId === 'string' ? object.userData.editorId : '';
    const isNamedRuntimeRoot = Boolean(object.name) && (
      object.parent === scene
      || object.parent === mazeContainer
      || object.parent === gameSceneEditorRoot
    );
    if (!explicitId && !isNamedRuntimeRoot) return;
    const id = explicitId || `runtime-${slugifyEditorId(object.parent?.name || 'scene')}-${slugifyEditorId(object.name)}`;
    const label = String(object.userData.editorLabel || object.name || object.type);
    const group = object === gameSceneEditorRoot || object.parent === mazeContainer || object.parent === gameSceneEditorRoot
      ? '3D — лабиринт'
      : object.name.includes('team') ? '3D — выбор команды' : '3D — прочее';
    add(id, label, group, object);
  });

  return [...objects.values()].map(({ id, label, group, object }) => createThreeObjectTarget(id, label, group, object));
}

function createThreeObjectTarget(id: string, label: string, group: string, object: THREE.Object3D): EditorTarget {
  const defaults = object.userData.sceneEditorDefaults || {
    position: object.position.toArray(),
    rotation: [object.rotation.x, object.rotation.y, object.rotation.z],
    scale: object.scale.toArray(),
  };
  object.userData.sceneEditorDefaults = defaults;
  const rotation = (axis: 'x' | 'y' | 'z') => THREE.MathUtils.radToDeg(object.rotation[axis]);
  const setUniformScale = (value: number) => object.scale.setScalar(value);
  return {
    id: `three:${id}`,
    label,
    group,
    fields: [
      createField('x', 'Позиция X', -30, 30, 0.05, defaults.position[0], () => object.position.x, (value) => { object.position.x = value; }, ' м'),
      createField('y', 'Позиция Y', -30, 30, 0.05, defaults.position[1], () => object.position.y, (value) => { object.position.y = value; }, ' м'),
      createField('z', 'Позиция Z', -30, 30, 0.05, defaults.position[2], () => object.position.z, (value) => { object.position.z = value; }, ' м'),
      createField('scaleX', 'Масштаб X', 0.05, 8, 0.01, defaults.scale[0], () => object.scale.x, setUniformScale),
      createField('scaleY', 'Масштаб Y', 0.05, 8, 0.01, defaults.scale[0], () => object.scale.y, setUniformScale),
      createField('scaleZ', 'Масштаб Z', 0.05, 8, 0.01, defaults.scale[0], () => object.scale.z, setUniformScale),
      createField('rotationX', 'Наклон X', -180, 180, 1, THREE.MathUtils.radToDeg(defaults.rotation[0]), () => rotation('x'), (value) => { object.rotation.x = THREE.MathUtils.degToRad(value); }, '°'),
      createField('rotationY', 'Поворот Y', -180, 180, 1, THREE.MathUtils.radToDeg(defaults.rotation[1]), () => rotation('y'), (value) => { object.rotation.y = THREE.MathUtils.degToRad(value); }, '°'),
      createField('rotationZ', 'Наклон Z', -180, 180, 1, THREE.MathUtils.radToDeg(defaults.rotation[2]), () => rotation('z'), (value) => { object.rotation.z = THREE.MathUtils.degToRad(value); }, '°'),
    ],
    afterApply: () => {
      object.updateMatrixWorld(true);
      markShadowMapDirty();
      if (shouldRenderWebGl()) renderSceneOnce();
    },
  };
}

function buildShadowEditorTarget(): EditorTarget {
  return {
    id: 'shadows:rear-plane',
    label: 'Тень и задняя плоскость',
    group: 'Свет и тени',
    fields: [
      createField('opacity', 'Плотность тени', 0, 0.8, 0.01, 0.22, () => shadowSettings.opacity, (value) => { shadowSettings.opacity = value; }),
      createField('distance', 'Отступ плоскости — лабиринт', 0.5, 30, 0.1, 3.5, () => shadowSettings.distanceBehindFocus, (value) => { shadowSettings.distanceBehindFocus = value; }, ' м'),
      createField('screenDistance', 'Отступ плоскости — экраны', 0.3, 10, 0.1, 1.2, () => shadowSettings.screenDistanceBehindFocus, (value) => { shadowSettings.screenDistanceBehindFocus = value; }, ' м'),
      createField('size', 'Размер плоскости', 10, 160, 1, 60, () => shadowSettings.size, (value) => { shadowSettings.size = value; }, ' м'),
      createField('lightX', 'Свет: смещение X', -30, 30, 0.1, -5, () => shadowSettings.lightOffsetX, (value) => { shadowSettings.lightOffsetX = value; }, ' м'),
      createField('lightY', 'Свет: высота', -10, 40, 0.1, 7, () => shadowSettings.lightOffsetY, (value) => { shadowSettings.lightOffsetY = value; }, ' м'),
      createField('intensity', 'Сила теневого света', 0, 3, 0.01, 0.42, () => shadowSettings.lightIntensity, (value) => { shadowSettings.lightIntensity = value; }),
    ],
    afterApply: () => {
      markShadowMapDirty();
      if (shouldRenderWebGl()) renderSceneOnce();
    },
  };
}

function createField(
  id: string,
  label: string,
  min: number,
  max: number,
  step: number,
  defaultValue: number,
  get: () => number,
  set: (value: number) => void,
  unit = '',
): EditorField {
  return { id, label, min, max, step, defaultValue, get, set, unit };
}

function slugifyEditorId(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9а-яё_-]+/gi, '-').replace(/^-+|-+$/g, '') || 'object';
}
