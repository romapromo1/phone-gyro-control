import * as THREE from 'three';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import RAPIER from '@dimforge/rapier3d-compat';
import { io } from 'socket.io-client';

// Connect to the socket server
const socket = io();

// Logging helper to relay browser logs to the Node.js server terminal
function debugLog(msg: string) {
  console.log(msg);
  socket.emit('log', msg);
}

window.addEventListener('error', (event) => {
  debugLog(`CRITICAL ERROR: ${event.message} at ${event.filename}:${event.lineno}:${event.colno}`);
});
window.addEventListener('unhandledrejection', (event) => {
  debugLog(`CRITICAL PROMISE REJECTION: ${event.reason}`);
});

// UI Elements
const pairingOverlay = document.getElementById('pairing-overlay') as HTMLElement;
const hudOverlay = document.getElementById('hud-overlay') as HTMLElement;
const qrCodeImg = document.getElementById('qr-code') as HTMLImageElement;
const controllerUrlCode = document.getElementById('controller-url') as HTMLElement;
const currentLevelSpan = document.getElementById('current-level') as HTMLElement;
const btnCalibrate = document.getElementById('btn-calibrate-desktop') as HTMLButtonElement;
const btnRestart = document.getElementById('btn-restart') as HTMLButtonElement;
const victoryOverlay = document.getElementById('victory-overlay') as HTMLElement;
const btnPrevLevel = document.getElementById('btn-prev-level') as HTMLButtonElement;
const btnNextLevel = document.getElementById('btn-next-level') as HTMLButtonElement;

// New HUD elements Binds
const timerSpan = document.getElementById('game-timer') as HTMLElement;
const savesSpan = document.getElementById('saves-count') as HTMLElement;
const btnHudRestart = document.getElementById('btn-hud-restart') as HTMLButtonElement;
const modalTitle = document.getElementById('modal-title') as HTMLElement;
const modalSubtitle = document.getElementById('modal-subtitle') as HTMLElement;
const connectionIndicator = document.querySelector('.connection-indicator') as HTMLElement;

// Maze level management (Level 2 to Level 7 from /new/)
const MAZE_FILES = [
  '/source/new/labirint2.fbx',
  '/source/new/labirint3.fbx',
  '/source/new/labirint4.fbx',
  '/source/new/labirint5.fbx',
  '/source/new/labirint6.fbx',
  '/source/new/labirint7.fbx'
];
const BLENDER_FINISH_COORDS = [
  { x: -8.809,   y: 1.8372,   z: 0.0 }, // Labyrinth 2 (index 0)
  { x: 16.063,   y: 1.8372,   z: 0.0 }, // Labyrinth 3 (index 1)
  { x: -12.483,  y: -12.53,   z: 0.0 }, // Labyrinth 4 (index 2)
  { x: 8.856,    y: 1.7429,   z: 0.0 }, // Labyrinth 5 (index 3)
  { x: 1.67227,  y: 1.82146,  z: 0.0 }, // Labyrinth 6 (index 4)
  { x: -12.53,   y: -12.436,  z: 0.0 }  // Labyrinth 7 (index 5)
];
const BLENDER_METERS_TO_FBX_UNITS = 100;
let currentMazeIndex = 0;
let isAnimating = false; // prevent calling animate() multiple times

// Game mode state variables
let savesCollected = 0;
const totalSavesGoal = 6;
let gameTimeLeft = 60.0;
let isGameActive = false;
let isControllerConnected = false;
let gameTimerInterval: any = null;

// Transition and save object state
let saveTemplate: THREE.Group | null = null;
let saveMesh: THREE.Group | null = null;
let startObject: THREE.Object3D | null = null;
let finishObject: THREE.Object3D | null = null;

let isTransitioning = false;
let transitionTime = 0.0;
let transitionDir = 1; // 1: fading out, -1: fading in
let nextMazeIndexToLoad = -1;

let mazeMaterial: THREE.MeshPhysicalMaterial | null = null;
let floorMaterial: THREE.MeshStandardMaterial | null = null;
let mazeNormalMap: THREE.Texture | null = null;
let activeLoadId = 0;
let scaleFactor = 1.0;

let isBallStopping = false;
let ballStopTimer = 0.0;
const ballStartLinVel = new THREE.Vector3();
const ballStartAngVel = new THREE.Vector3();

interface FlyingSave {
  mesh: THREE.Group;
  origPos: THREE.Vector3;
  targetPos: THREE.Vector3;
  progress: number;
}
const activeFlyingSaves: FlyingSave[] = [];
const mazeCenter = new THREE.Vector3();

// Sound Manager using Web Audio API (Synthesized sounds)
class SoundManager {
  private ctx: AudioContext | null = null;
  private rollOsc: OscillatorNode | null = null;
  private rollGain: GainNode | null = null;
  private filter: BiquadFilterNode | null = null;
  private isInitialized = false;

  init() {
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
    if (!this.isInitialized || !this.ctx) return;
    if (this.ctx.state === 'suspended') {
      this.ctx.resume();
    }

    const ctx = this.ctx;
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
  const promptEl = document.getElementById('audio-prompt');
  if (promptEl) {
    promptEl.classList.add('hidden');
  }
}
window.addEventListener('click', handleUserGesture);
window.addEventListener('keydown', handleUserGesture);
window.addEventListener('touchstart', handleUserGesture);

// Game State variables
let scene: THREE.Scene;
let camera: THREE.PerspectiveCamera;
let renderer: THREE.WebGLRenderer;
let clock: THREE.Clock;

let physicsWorld: RAPIER.World;
let ballBody: RAPIER.RigidBody | null = null;
let ballMesh: THREE.Mesh | null = null;
let ballRadius = 0.25; 
let mazeContainer: THREE.Group; // Outer group centered at (0, 0, 0) which we rotate
let mazeGroup: THREE.Group | null = null;   // Inner group containing FBX mesh shifted by -center
let mazeBody: RAPIER.RigidBody | null = null;

// Telemetry & Tilting
let targetPitch = 0; // Pitch (from beta): -1.0 to 1.0
let targetRoll = 0;  // Roll (from gamma): -1.0 to 1.0
let currentPitch = 0;
let currentRoll = 0;
const maxTiltAngle = 14 * Math.PI / 180; // 14 degrees max visual tilt
const lerpFactor = 0.09; // smoothing input speed

let phonePitch = 0;
let phoneRoll = 0;
let phoneYaw = 0;
let currentYaw = 0;
let manualPitch = 0;
let manualRoll = 0;

// Camera angle setting (adjustable via Keyboard ArrowUp/ArrowDown)
let cameraAngleDeg = 0.0; // starts at 0 degrees horizontal front look (straight at screen)
let mazeYOffset = 0.0;
let cameraHeight = 0.0; // will be dynamically set based on maze size
let sceneYShift = 0.0;  // moves the entire scene up/down visually
let isLevelLoading = false; // blocks visual rotation during level loading

// Game Logic
let startPos = new THREE.Vector3();
let finishPos = new THREE.Vector3();
let finishRadius = 0.5;
let isFirstTelemetry = true;
let mazeBoundingBox = new THREE.Box3();
let mazeSize = new THREE.Vector3();

// Self-healing reset logic
let resetCount = 0;
let aliveTime = 0;

// For collision impact detection
let lastVelocity = new THREE.Vector3();

const PHYSICS_TIMESTEP = 1 / 60;
const MAX_PHYSICS_STEPS_PER_FRAME = 4;
let physicsAccumulator = 0;

function disposeMaterials(object: THREE.Object3D) {
  const materials = new Set<THREE.Material>();
  object.traverse((child) => {
    if (!(child instanceof THREE.Mesh) || !child.material) return;
    const childMaterials = Array.isArray(child.material) ? child.material : [child.material];
    childMaterials.forEach(material => materials.add(material));
  });
  materials.forEach(material => material.dispose());
}

function disposeGeometries(object: THREE.Object3D) {
  const geometries = new Set<THREE.BufferGeometry>();
  object.traverse((child) => {
    if (child instanceof THREE.Mesh && child.geometry) {
      geometries.add(child.geometry);
    }
  });
  geometries.forEach(geometry => geometry.dispose());
}

function disposeBallMesh() {
  if (!ballMesh) return;
  mazeContainer.remove(ballMesh);
  ballMesh.geometry.dispose();
  const materials = Array.isArray(ballMesh.material) ? ballMesh.material : [ballMesh.material];
  materials.forEach(material => material.dispose());
  ballMesh = null;
}

function disposeMazeGroup() {
  if (!mazeGroup) return;
  mazeContainer.remove(mazeGroup);
  disposeGeometries(mazeGroup);
  mazeGroup = null;

  mazeMaterial?.dispose();
  floorMaterial?.dispose();
  mazeMaterial = null;
  floorMaterial = null;
}

function removeNamedObject(name: string, shouldDisposeMaterials = false) {
  const object = mazeContainer.getObjectByName(name);
  if (!object) return;
  mazeContainer.remove(object);
  if (shouldDisposeMaterials) disposeMaterials(object);
}

// Fetch server pairing information
async function fetchServerInfo() {
  try {
    const res = await fetch('/api/server-info');
    const data = await res.json();
    qrCodeImg.src = data.qrDataUrl;
    controllerUrlCode.textContent = data.mobileUrl;
  } catch (err) {
    console.error('Error fetching server info:', err);
    controllerUrlCode.textContent = 'Ошибка загрузки адреса';
  }
}

// Set up websockets
socket.on('connect', () => {
  debugLog('Connected to websocket server, registering as desktop...');
  socket.emit('register', 'desktop');
});

socket.on('gyro-update', (data: { beta: number; gamma: number; alpha?: number }) => {
  isControllerConnected = true;
  updateControllerStatus();

  if (isFirstTelemetry) {
    pairingOverlay.classList.add('hidden');
    hudOverlay.classList.remove('hidden');
    isFirstTelemetry = false;
    // Initialize audio context
    sounds.init();
    // Start game mode
    startNewGame();
  }

  // Save raw normalized sensor telemetry (-1.0 to 1.0)
  phonePitch = Number.isFinite(data.beta) ? THREE.MathUtils.clamp(data.beta, -1, 1) : 0;
  phoneRoll = Number.isFinite(data.gamma) ? THREE.MathUtils.clamp(data.gamma, -1, 1) : 0;
  if (data.alpha !== undefined) {
    phoneYaw = data.alpha * Math.PI / 180; // convert calibrated yaw from degrees to radians
  }
});

socket.on('controller-status', ({ connected }: { connected: boolean }) => {
  isControllerConnected = connected;
  updateControllerStatus();
});

function updateControllerStatus() {
  if (!connectionIndicator) return;
  connectionIndicator.classList.toggle('disconnected', !isControllerConnected);
  connectionIndicator.lastChild!.textContent = isControllerConnected
    ? ' СМАРТФОН АКТИВЕН'
    : ' СВЯЗЬ ПОТЕРЯНА — ТАЙМЕР НА ПАУЗЕ';
}

socket.on('calibrate-request', () => {
  debugLog('Calibration request received.');
  calibrate();
});

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
  socket.emit('calibrate'); // Tell mobile to calibrate offset
  sounds.init(); // Initialize sound on button press just in case
});

btnRestart.addEventListener('click', () => {
  startNewGame();
});

btnHudRestart?.addEventListener('click', () => {
  startNewGame();
});

btnPrevLevel?.addEventListener('click', () => {
  switchMaze((currentMazeIndex - 1 + MAZE_FILES.length) % MAZE_FILES.length);
});

btnNextLevel?.addEventListener('click', () => {
  switchMaze((currentMazeIndex + 1) % MAZE_FILES.length);
});

function switchMaze(newIndex: number) {
  if (newIndex === currentMazeIndex) return;
  currentMazeIndex = newIndex;
  currentLevelSpan.textContent = String(currentMazeIndex + 2).padStart(2, '0');
  debugLog(`Switching to maze ${currentMazeIndex + 1}: ${MAZE_FILES[currentMazeIndex]}`);

  // 1. Remove old ball body and mesh
  if (ballBody) {
    physicsWorld.removeRigidBody(ballBody);
    ballBody = null;
  }
  disposeBallMesh();

  // 2. Remove old maze body
  if (mazeBody) {
    physicsWorld.removeRigidBody(mazeBody);
    mazeBody = null;
  }

  // 3. Remove old visual maze
  disposeMazeGroup();

  // 4. Remove markers and lights
  removeNamedObject('finish-marker');
  removeNamedObject('finish-light');
  removeNamedObject('start-light');
  removeNamedObject('save-item', true);
  removeNamedObject('floor-mesh', true);

  // 5. Reset level state
  resetCount = 0;
  aliveTime = 0;
  isBallStopping = false;
  ballStopTimer = 0.0;
  victoryOverlay.classList.add('hidden');

  // 6. Load new maze
  loadMazeAsset();
}

function startTimer() {
  if (gameTimerInterval) clearInterval(gameTimerInterval);
  
  gameTimeLeft = 60.0;
  if (timerSpan) timerSpan.textContent = String(Math.ceil(gameTimeLeft));
  
  gameTimerInterval = setInterval(() => {
    if (!isGameActive || !isControllerConnected) return;
    
    gameTimeLeft -= 1.0;
    if (gameTimeLeft <= 0.0) {
      gameTimeLeft = 0.0;
      if (timerSpan) timerSpan.textContent = '0';
      clearInterval(gameTimerInterval);
      endGame(false); // Time ran out!
    } else {
      if (timerSpan) timerSpan.textContent = String(Math.ceil(gameTimeLeft));
    }
  }, 1000);
}

function endGame(isWin: boolean) {
  isGameActive = false;
  if (gameTimerInterval) clearInterval(gameTimerInterval);
  
  // Stop physics
  if (ballBody) {
    ballBody.setLinvel({ x: 0, y: 0, z: 0 }, true);
    ballBody.setAngvel({ x: 0, y: 0, z: 0 }, true);
  }
  
  // Show modal pop-up
  if (victoryOverlay) {
    victoryOverlay.classList.remove('hidden');
  }
  
  if (isWin) {
    if (modalTitle) {
      modalTitle.textContent = 'ПОБЕДА!';
      modalTitle.style.background = 'linear-gradient(45deg, #00ff66, var(--accent-cyan))';
      modalTitle.style.webkitBackgroundClip = 'text';
      modalTitle.style.webkitTextFillColor = 'transparent';
    }
    if (modalSubtitle) {
      modalSubtitle.textContent = `Вы собрали все 6 сейвов за ${Math.round(60.0 - gameTimeLeft)} секунд!`;
    }
  } else {
    if (modalTitle) {
      modalTitle.textContent = 'ВРЕМЯ ВЫШЛО!';
      modalTitle.style.background = 'linear-gradient(45deg, var(--accent-magenta), #ffcc00)';
      modalTitle.style.webkitBackgroundClip = 'text';
      modalTitle.style.webkitTextFillColor = 'transparent';
    }
    if (modalSubtitle) {
      modalSubtitle.textContent = `Вы успели собрать ${savesCollected} из 6 сейвов.`;
    }
  }
}

function startNewGame() {
  savesCollected = 0;
  currentMazeIndex = 0;

  // Clean up any existing ball, physics, and old level assets first!
  if (ballBody && physicsWorld) {
    physicsWorld.removeRigidBody(ballBody);
    ballBody = null;
  }
  disposeBallMesh();
  if (mazeBody && physicsWorld) {
    physicsWorld.removeRigidBody(mazeBody);
    mazeBody = null;
  }
  disposeMazeGroup();
  
  // Remove old markers, lights, save meshes, etc.
  removeNamedObject('finish-marker');
  removeNamedObject('finish-light');
  removeNamedObject('start-light');
  removeNamedObject('save-item', true);
  removeNamedObject('floor-mesh', true);

  if (savesSpan) {
    savesSpan.textContent = `0 / ${totalSavesGoal}`;
  }
  isGameActive = true;
  if (victoryOverlay) {
    victoryOverlay.classList.add('hidden');
  }
  
  // Clear any static saves from the scene
  activeFlyingSaves.forEach(item => {
    scene.remove(item.mesh);
    disposeMaterials(item.mesh);
  });
  activeFlyingSaves.length = 0;
  isBallStopping = false;
  ballStopTimer = 0.0;

  const savesToRemove: THREE.Object3D[] = [];
  scene.traverse((child) => {
    if (child.name === 'save-item' && child.parent === scene) {
      savesToRemove.push(child);
    }
  });
  savesToRemove.forEach(s => scene.remove(s));
  
  currentLevelSpan.textContent = String(currentMazeIndex + 2).padStart(2, '0');
  loadMazeAsset();
  
  startTimer();
}

function collectSave() {
  if (isTransitioning || !isGameActive) return;
  
  savesCollected++;
  if (savesSpan) {
    savesSpan.textContent = `${savesCollected} / ${totalSavesGoal}`;
  }
  sounds.playVictory();
  
  // Smooth deceleration stopping logic
  if (ballBody) {
    isBallStopping = true;
    ballStopTimer = 0.0;
    const lv = ballBody.linvel();
    const av = ballBody.angvel();
    ballStartLinVel.set(lv.x, lv.y, lv.z);
    ballStartAngVel.set(av.x, av.y, av.z);
  }

  // Trigger save flight animation
  if (saveMesh) {
    // Reparent saveMesh to scene so it stays static
    saveMesh.updateMatrixWorld(true);
    const worldPos = new THREE.Vector3();
    const worldQuat = new THREE.Quaternion();
    const worldScale = new THREE.Vector3();
    saveMesh.matrixWorld.decompose(worldPos, worldQuat, worldScale);
    
    mazeContainer.remove(saveMesh);
    scene.add(saveMesh);
    
    saveMesh.position.copy(worldPos);
    saveMesh.quaternion.copy(worldQuat);
    saveMesh.scale.copy(worldScale);
    
    // Calculate target position in the sky aligned under saves counter
    const targetX = -1.25 + (savesCollected - 1) * 0.5;
    const targetPos = new THREE.Vector3(targetX, 4.8, -3.5);
    
    activeFlyingSaves.push({
      mesh: saveMesh,
      origPos: worldPos.clone(),
      targetPos: targetPos,
      progress: 0.0
    });
    
    saveMesh = null; // Unreference
  }
  
  // Check if we collected all 6 saves!
  if (savesCollected >= totalSavesGoal) {
    endGame(true); // Game Won!
    return;
  }
  
  // Otherwise transition to next level!
  const nextLevelIndex = (currentMazeIndex + 1) % MAZE_FILES.length;
  startTransitionToLevel(nextLevelIndex);
}

function startTransitionToLevel(nextIndex: number) {
  isTransitioning = true;
  transitionTime = 0.0;
  transitionDir = 1; // Fade out
  nextMazeIndexToLoad = nextIndex;
}

function resetGame() {
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

// Custom function to compute bounding box from THREE.Mesh objects ONLY
function getGeometryBoundingBox(object: THREE.Object3D): THREE.Box3 {
  const box = new THREE.Box3();
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

// Initialize Graphics & Physics
async function init() {
  // 1. Initialize Rapier Physics WASM
  await RAPIER.init();
  physicsWorld = new RAPIER.World({ x: 0.0, y: -35.0, z: 0.0 });
  physicsWorld.timestep = PHYSICS_TIMESTEP;
  physicsWorld.integrationParameters.numSolverIterations = 12;
  physicsWorld.integrationParameters.normalizedAllowedLinearError = 0.0001;

  // 2. Set up Three.js Scene
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0xffffff); // White background

  clock = new THREE.Clock();

  // Create visual container group centered at (0, 0, 0)
  mazeContainer = new THREE.Group();
  scene.add(mazeContainer);

  // Camera setup optimized for 9:16 layout
  camera = new THREE.PerspectiveCamera(65, window.innerWidth / window.innerHeight, 0.1, 1000);
  
  renderer = new THREE.WebGLRenderer({
    canvas: document.getElementById('game-canvas') as HTMLCanvasElement,
    antialias: true,
    alpha: false,
    powerPreference: "high-performance"
  });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2)); // Limit to 2x for performance in 4K
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  // Shared by every level to avoid repeated downloads and GPU uploads during
  // a long event session.
  mazeNormalMap = new THREE.TextureLoader().load('/textures/DefaultMaterial_Normal_OpenGL.png');
  mazeNormalMap.wrapS = THREE.RepeatWrapping;
  mazeNormalMap.wrapT = THREE.RepeatWrapping;

  // 1. Procedural HDRI Environment Map for reflections only
  const pmremGenerator = new THREE.PMREMGenerator(renderer);
  pmremGenerator.compileEquirectangularShader();

  const envScene = new THREE.Scene();
  const panelGeo = new THREE.BoxGeometry(100, 100, 1);
  const panelMat = new THREE.MeshBasicMaterial({ color: 0xffffff });

  // Add bright light softbox panels for premium glossy metallic reflections
  const panel1 = new THREE.Mesh(panelGeo, panelMat);
  panel1.position.set(-300, 150, 0);
  panel1.lookAt(0, 0, 0);
  envScene.add(panel1);

  const panel2 = new THREE.Mesh(panelGeo, panelMat);
  panel2.position.set(300, 150, 0);
  panel2.lookAt(0, 0, 0);
  envScene.add(panel2);

  const panel3 = new THREE.Mesh(panelGeo, panelMat);
  panel3.position.set(0, 400, -200);
  panel3.lookAt(0, 0, 0);
  envScene.add(panel3);

  const panel4 = new THREE.Mesh(panelGeo, panelMat);
  panel4.position.set(0, 150, 300);
  panel4.lookAt(0, 0, 0);
  envScene.add(panel4);

  const envTarget = pmremGenerator.fromScene(envScene);
  scene.environment = envTarget.texture;
  pmremGenerator.dispose();

  // 2. Add Studio Lights (brightened so the entire scene is fully illuminated from all sides)
  // Ambient fill light for base brightness
  const ambientLight = new THREE.AmbientLight(0xffffff, 0.85);
  scene.add(ambientLight);

  // Key Light (main light casting shadows)
  const mainLight = new THREE.DirectionalLight(0xffffff, 1.5);
  mainLight.position.set(20, 50, 10);
  mainLight.castShadow = true;
  mainLight.shadow.mapSize.width = 2048;
  mainLight.shadow.mapSize.height = 2048;
  mainLight.shadow.bias = -0.0005;
  scene.add(mainLight);

  // Fill Light (soft light from the opposite side to brighten shadows)
  const fillLight = new THREE.DirectionalLight(0xffffff, 0.8);
  fillLight.position.set(-20, 30, 10);
  scene.add(fillLight);

  // Rim Light (backlight highlighting edges of walls and floor)
  const rimLight = new THREE.DirectionalLight(0xffffff, 0.6);
  rimLight.position.set(0, 30, -20);
  scene.add(rimLight);

  // Load Save 3D asset template
  const fbxLoader = new FBXLoader();
  fbxLoader.load('/source/save.fbx', (fbx) => {
    saveTemplate = fbx;
    saveTemplate.traverse((child) => {
      if (child instanceof THREE.Mesh) {
        child.castShadow = true;
        child.receiveShadow = true;
        
        // Define premium custom materials for the 2 slots (Case and Slider Shutter)
        // This resolves the missing texture issue in the FBX file.
        const caseMat = new THREE.MeshStandardMaterial({
          color: 0x252526, // Dark graphite gray plastic case
          roughness: 0.4,
          metalness: 0.15,
          transparent: true
        });
        
        const sliderMat = new THREE.MeshStandardMaterial({
          color: 0xcccccc, // Polished silver metal slider
          roughness: 0.12,
          metalness: 0.95,
          transparent: true
        });
        
        child.material = [caseMat, sliderMat];
      }
    });
    debugLog('Loaded save.fbx template successfully.');
  }, undefined, (err) => {
    console.error('Error loading save.fbx template:', err);
  });

  // Load the Maze asset
  currentLevelSpan.textContent = String(currentMazeIndex + 2).padStart(2, '0');
  loadMazeAsset();

  // Window Resize
  window.addEventListener('resize', onWindowResize);
}

function loadMazeAsset() {
  isLevelLoading = true;
  activeLoadId++;
  const thisLoadId = activeLoadId;
  if (mazeContainer) {
    mazeContainer.quaternion.set(0, 0, 0, 1);
  }
  const loader = new FBXLoader();
  const mazeFile = MAZE_FILES[currentMazeIndex];

  const loadedMazeMaterial = new THREE.MeshPhysicalMaterial({
    color: 0x716cff, // #716cff (requested color)
    transmission: 0.9,
    opacity: 0.6,
    transparent: true,
    roughness: 0.4, // Increased roughness for frosted glass look
    metalness: 0.1,
    ior: 1.5,
    thickness: 1.5,
    clearcoat: 1.0,
    clearcoatRoughness: 0.1,
    normalMap: mazeNormalMap,
    normalScale: new THREE.Vector2(0.2, 0.2),
    side: THREE.DoubleSide
  });

  const loadedFloorMaterial = new THREE.MeshStandardMaterial({
    color: 0xddff68, // #ddff68 (requested color)
    roughness: 0.3,  // requested: 0.3
    metalness: 0.7,  // requested: 0.7
    emissive: 0xddff68, // #ddff68 (same color emission)
    emissiveIntensity: 0.15, // subtle glow
    side: THREE.DoubleSide, // Render both sides in case normals are inverted in the model
    transparent: true,
    opacity: 1.0
  });

  mazeMaterial = loadedMazeMaterial;
  floorMaterial = loadedFloorMaterial;

  // Stable URLs let the browser cache level files between players.
  loader.load(mazeFile, (fbx) => {
    if (thisLoadId !== activeLoadId) {
      debugLog('Ignoring superseded maze load callback.');
      disposeGeometries(fbx);
      disposeMaterials(fbx);
      loadedMazeMaterial.dispose();
      loadedFloorMaterial.dispose();
      return;
    }
    mazeGroup = fbx;
    mazeContainer.add(mazeGroup);

    debugLog('Loaded labyrinth FBX successfully.');

    startObject = null;
    finishObject = null;

    // Apply PBR material to all meshes (FBX has no embedded textures)
    mazeGroup.traverse((child) => {
      const nameLower = child.name.toLowerCase();
      if (nameLower === 'start') {
        startObject = child;
        child.visible = false;
        if (child instanceof THREE.Mesh) {
          child.material = new THREE.MeshBasicMaterial({ visible: false, transparent: true, opacity: 0 });
        }
        return;
      }
      if (nameLower === 'finish') {
        finishObject = child;
        child.visible = false;
        if (child instanceof THREE.Mesh) {
          child.material = new THREE.MeshBasicMaterial({ visible: false, transparent: true, opacity: 0 });
        }
        return;
      }

      if (child instanceof THREE.Mesh) {
        if (!child.geometry.boundingBox) {
          child.geometry.computeBoundingBox();
        }
        const size = new THREE.Vector3();
        child.geometry.boundingBox.getSize(size);
        debugLog(`Mesh "${child.name}": visible=${child.visible} scale=(${child.scale.x},${child.scale.y},${child.scale.z}) pos=(${child.position.x},${child.position.y},${child.position.z}) size=(${size.x.toFixed(2)},${size.y.toFixed(2)},${size.z.toFixed(2)})`);

        // Force visibility to true in case it was exported as hidden from Blender
        child.visible = true;

        const isFloor = nameLower.includes('floor') || 
                        nameLower.includes('ground') || 
                        nameLower.includes('plane') || 
                        nameLower.includes('cube.001') ||
                        nameLower.includes('floor2');
        const activeMaterial = isFloor ? loadedFloorMaterial : loadedMazeMaterial;

        child.material = activeMaterial;
        child.castShadow = true;
        child.receiveShadow = true;
      }
    });

    // If we are transitioning, start level fully transparent
    if (isTransitioning) {
      loadedMazeMaterial.opacity = 0.0;
      loadedFloorMaterial.opacity = 0.0;
    } else {
      loadedMazeMaterial.opacity = 0.6;
      loadedFloorMaterial.opacity = 1.0;
    }

    // 1. Get original size of the mesh
    mazeBoundingBox = getGeometryBoundingBox(mazeGroup);
    mazeBoundingBox.getSize(mazeSize);
    
    // Scale maze to a realistic size (12.0 meters wide/deep)
    const targetWidth = 12.0;
    const maxDim = Math.max(mazeSize.x, mazeSize.z);
    scaleFactor = targetWidth / maxDim;
    
    mazeGroup.scale.set(scaleFactor, scaleFactor, scaleFactor);
    // Force matrix update immediately after scaling to ensure getGeometryBoundingBox computes scaled sizes!
    mazeGroup.updateMatrix();
    mazeGroup.updateMatrixWorld(true);

    debugLog(`Original size: ${maxDim.toFixed(1)}, Scaling factor: ${scaleFactor.toFixed(5)}`);

    // Center the model group and position camera
    positionCamera();

    // Create Physics representation (Static fixed body for stable collisions)
    buildPhysicsMaze();

    // Spawn Ball and Start/Finish points
    spawnGameElements();

    if (isTransitioning) {
      transitionDir = -1; // Fade in
      transitionTime = 0.3;
    }

    // Start animation loop (only once)
    if (!isAnimating) {
      isAnimating = true;
      animate();
    }
  }, (xhr) => {
    if (xhr.total > 0) {
      console.log((xhr.loaded / xhr.total * 100) + '% loaded');
    }
  }, (error) => {
    loadedMazeMaterial.dispose();
    loadedFloorMaterial.dispose();
    if (mazeMaterial === loadedMazeMaterial) mazeMaterial = null;
    if (floorMaterial === loadedFloorMaterial) floorMaterial = null;
    console.error('An error happened loading the FBX model:', error);
    debugLog('Error loading FBX model: ' + (error instanceof Error ? error.message : String(error)));
  });
}

// Recalculates camera coordinates based on cameraAngleDeg
function updateCameraPosition() {
  if (!mazeGroup) return;
  const distance = Math.max(mazeSize.x, mazeSize.z);
  const angleRad = cameraAngleDeg * Math.PI / 180;
  
  // Keep the distance from camera to center constant
  const camDistance = distance * 1.15;
  const targetZ = camDistance * Math.cos(angleRad);
  const targetY = camDistance * Math.sin(angleRad);
  
  // Initialize camera height if not set
  if (cameraHeight === 0.0) {
    cameraHeight = distance * 0.32;
  }
  
  // Raise camera Y coordinate and apply sceneYShift for vertical screen position
  camera.position.set(0, cameraHeight + targetY - sceneYShift, targetZ);
  
  // Look slightly above the maze center - sceneYShift
  const targetLookAt = new THREE.Vector3(0, mazeYOffset + 1.0 - sceneYShift, 0);
  
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
  mazeCenter.copy(center); // Store global reference for coordinate mapping

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
  
  // Automatically adjust cameraHeight to match new level geometry size
  cameraHeight = distance * 0.32;
  
  // Sync HTML inputs with new geometry settings
  updateSlidersUI();
  
  // Position camera based on our adjustable settings
  updateCameraPosition();

  debugLog(`Camera positioned. Size: Width=${mazeSize.x.toFixed(2)}, Depth=${mazeSize.z.toFixed(2)}. Camera Pos=(0, ${camera.position.y.toFixed(2)}, ${camera.position.z.toFixed(2)}), Angle=${cameraAngleDeg}°`);
}

function buildPhysicsMaze() {
  // Create STATIC fixed body for stable mesh collisions.
  const mazeBodyDesc = RAPIER.RigidBodyDesc.fixed();
  mazeBody = physicsWorld.createRigidBody(mazeBodyDesc);
  let floorTop = mazeBoundingBox.min.y;

  // Build trimesh colliders for walls only. The exported floor mesh contains
  // triangulation seams; using it as a collider allowed the ball to sink at a
  // local seam and become wedged against the wall.
  mazeGroup!.traverse((child) => {
    if (child instanceof THREE.Mesh) {
      const nameLower = child.name.toLowerCase();
      if (nameLower === 'start' || nameLower === 'finish') return;

      const isFloor = nameLower.includes('floor') ||
                      nameLower.includes('ground') ||
                      nameLower.includes('plane') ||
                      nameLower.includes('cube.001') ||
                      nameLower.includes('floor2');
      if (isFloor) {
        child.updateMatrixWorld(true);
        const floorBox = new THREE.Box3().setFromObject(child, true);
        floorTop = Math.max(floorTop, floorBox.max.y);
        return;
      }

      const geometry = child.geometry;
      if (!geometry) return;

      const posAttr = geometry.attributes.position;
      if (!posAttr) return;

      const originalVertices = posAttr.array;
      const vertices = new Float32Array(posAttr.count * 3);

      child.updateMatrixWorld(true);
      const tempMatrix = child.matrixWorld.clone();

      for (let i = 0; i < posAttr.count; i++) {
        const vx = originalVertices[i * 3];
        const vy = originalVertices[i * 3 + 1];
        const vz = originalVertices[i * 3 + 2];

        const v = new THREE.Vector3(vx, vy, vz).applyMatrix4(tempMatrix);
        vertices[i * 3] = v.x;
        vertices[i * 3 + 1] = v.y;
        vertices[i * 3 + 2] = v.z;
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
        const trimeshFlags = RAPIER.TriMeshFlags.FIX_INTERNAL_EDGES |
                             RAPIER.TriMeshFlags.MERGE_DUPLICATE_VERTICES |
                             RAPIER.TriMeshFlags.DELETE_DEGENERATE_TRIANGLES |
                             RAPIER.TriMeshFlags.DELETE_BAD_TOPOLOGY_TRIANGLES;
        const colliderDesc = RAPIER.ColliderDesc.trimesh(
          vertices,
          indices,
          trimeshFlags
        ).setFriction(0.0)
         .setContactSkin(0.015);
        physicsWorld.createCollider(colliderDesc, mazeBody!);
      } catch (err) {
        console.error('Failed to create collider for child mesh:', err);
      }
    }
  });
  // One continuous collider sits exactly at the visible floor surface. It has
  // no triangle edges or holes, so the ball cannot partially fall through.
  const floorThickness = Math.max(0.2, ballRadius * 1.5);
  const floorColliderDesc = RAPIER.ColliderDesc.cuboid(
    mazeSize.x * 0.5,
    floorThickness * 0.5,
    mazeSize.z * 0.5
  )
  .setTranslation(0, (floorTop + 0.03) - floorThickness * 0.5, 0)
  .setFriction(0.35)
  .setRestitution(0.05)
  .setContactSkin(0.005);

  physicsWorld.createCollider(floorColliderDesc, mazeBody);
debugLog(`Continuous floor collider added at y=${(floorTop + 0.03).toFixed(3)}.`);

  debugLog('Physics maze colliders built successfully.');
}

function spawnGameElements() {
  // Defensive reset
  isBallStopping = false;
  ballStopTimer = 0.0;

  const maxDim = Math.max(mazeSize.x, mazeSize.z);
  ballRadius = maxDim * 0.022; 
  finishRadius = ballRadius * 2.0;

  // Use Start node position if found
  if (startObject) {
    startObject.updateMatrixWorld(true);
    startObject.getWorldPosition(startPos);
    startPos.y += ballRadius + 0.3; // slightly above wall top for drop animation
  } else {
    // Fallback: spawn exactly in the center of the top-left cell (0.06 offset)
    startPos.set(
      mazeBoundingBox.min.x + mazeSize.x * 0.06,
      mazeBoundingBox.max.y + ballRadius + 0.4,
      mazeBoundingBox.min.z + mazeSize.z * 0.06
    );
  }

  // The supplied Blender coordinates are authoritative for all six levels.
  const finishCoords = BLENDER_FINISH_COORDS[currentMazeIndex];
  if (finishCoords) {
    // Build the point in the FBX coordinate system, then pass it through the
    // actual maze matrix. This preserves FBX axis conversion, centering and
    // per-level scale without relying on an approximate manual offset.
    mazeGroup!.updateWorldMatrix(true, true);
    const finishWorld = new THREE.Vector3(
      finishCoords.x * BLENDER_METERS_TO_FBX_UNITS,
      finishCoords.z * BLENDER_METERS_TO_FBX_UNITS,
      -finishCoords.y * BLENDER_METERS_TO_FBX_UNITS
    ).applyMatrix4(mazeGroup!.matrixWorld);

    finishPos.copy(mazeContainer.worldToLocal(finishWorld));
    debugLog(
      `Finish Blender coords: (${finishCoords.x}, ${finishCoords.y}, ${finishCoords.z}) ` +
      `-> maze coords: (${finishPos.x.toFixed(3)}, ${finishPos.y.toFixed(3)}, ${finishPos.z.toFixed(3)})`
    );
  } else if (finishObject) {
    finishObject.updateMatrixWorld(true);
    finishObject.getWorldPosition(finishPos);
  } else {
    finishPos.set(
      mazeBoundingBox.max.x - mazeSize.x * 0.12,
      mazeBoundingBox.min.y + 0.1,
      mazeBoundingBox.max.z - mazeSize.z * 0.12
    );
  }

  // 1. Visual representation of the Ball (Glowing holographic sphere)
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
  ballMesh.receiveShadow = true;
  mazeContainer.add(ballMesh); 

  // 2. Physics representation of the Ball (Dynamic sphere)
  const ballBodyDesc = RAPIER.RigidBodyDesc.dynamic()
    .setTranslation(startPos.x, startPos.y, startPos.z)
    .setLinearDamping(1.2)
    .setAngularDamping(1.2)
    .setCanSleep(false);
  ballBody = physicsWorld.createRigidBody(ballBodyDesc);
  ballBody.enableCcd(true);
  physicsAccumulator = 0;

  const ballColliderDesc = RAPIER.ColliderDesc.ball(ballRadius)
    .setRestitution(0.15)
    .setFriction(0.35)
    .setContactSkin(0.005);
  physicsWorld.createCollider(ballColliderDesc, ballBody);

  // 3. Visual representation of the Finish Zone: Save item (save.fbx)
  if (saveMesh) {
    mazeContainer.remove(saveMesh);
    saveMesh = null;
  }
  if (saveTemplate) {
    saveMesh = saveTemplate.clone();
    saveMesh.name = 'save-item';
    saveMesh.position.copy(finishPos);
    
    // Calculate raw size of saveMesh to scale dynamically to target size (ballRadius * 1.6)
    const saveBox = getGeometryBoundingBox(saveMesh);
    const saveSizeVec = new THREE.Vector3();
    saveBox.getSize(saveSizeVec);
    const maxDim = Math.max(saveSizeVec.x, saveSizeVec.y, saveSizeVec.z);
    
    const targetSize = ballRadius * 2.4;
    const finalScale = (maxDim > 0.0001) ? (targetSize / maxDim) : targetSize;
    saveMesh.scale.set(finalScale, finalScale, finalScale);
    
    saveMesh.traverse((child) => {
      if (child instanceof THREE.Mesh) {
        child.visible = true;
        child.castShadow = true;
        child.receiveShadow = true;
        if (child.material) {
          // Clone material to control individual opacity
          if (Array.isArray(child.material)) {
            child.material = child.material.map(m => {
              const clone = m.clone();
              clone.transparent = true;
              clone.opacity = isTransitioning ? 0.0 : 1.0;
              return clone;
            });
          } else {
            child.material = child.material.clone();
            child.material.transparent = true;
            child.material.opacity = isTransitioning ? 0.0 : 1.0;
          }
        }
      }
    });
    mazeContainer.add(saveMesh);
  }

  // Glowing pulse light at finish
  const finishLight = new THREE.PointLight(0xff00ff, 4, finishRadius * 8);
  finishLight.position.set(finishPos.x, finishPos.y + 0.4, finishPos.z);
  finishLight.name = 'finish-light';
  mazeContainer.add(finishLight); 

  // Ambient neon light at start
  const startLight = new THREE.PointLight(0x00f0ff, 2, ballRadius * 8);
  startLight.position.set(startPos.x, startPos.y + 0.4, startPos.z);
  startLight.name = 'start-light';
  mazeContainer.add(startLight); 

  debugLog(`Ball spawned at: x=${startPos.x.toFixed(2)}, y=${startPos.y.toFixed(2)}, z=${startPos.z.toFixed(2)}`);
  debugLog(`Finish spawned at: x=${finishPos.x.toFixed(2)}, y=${finishPos.y.toFixed(2)}, z=${finishPos.z.toFixed(2)}`);

  isLevelLoading = false;
}

function onWindowResize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  positionCamera();
}

// Game loop
function animate() {
  requestAnimationFrame(animate);

  const dt = Math.min(clock.getDelta(), PHYSICS_TIMESTEP * MAX_PHYSICS_STEPS_PER_FRAME);

  // 1. Static/collected/flying Saves animation
  activeFlyingSaves.forEach((item) => {
    // Continuous rotation: 2.99 rad/s (1 rotation per 2.1s)
    item.mesh.rotation.y += 2.99 * dt;
    
    if (item.progress < 1.0) {
      item.progress = Math.min(1.0, item.progress + dt * 2.0); // 0.5s duration
      
      // Fly up and scaling animation
      const baseScale = ballRadius * 1.6;
      // Target scale is 2.5x base scale
      const currentScale = baseScale * (1.0 + item.progress * 1.5);
      item.mesh.scale.set(currentScale, currentScale, currentScale);
      
      // Interpolate position
      item.mesh.position.lerpVectors(item.origPos, item.targetPos, item.progress);
    }
  });

  // 2. Active Save Mesh Hover/Bobbing animation in the level
  if (saveMesh && saveMesh.parent === mazeContainer) {
    // Normal rotation: 2.99 rad/sec (1 rotation per 2.1s)
    saveMesh.rotation.y += 2.99 * dt;
    // Bobbing up and down slightly (sine wave over time, reduced 2x to 0.04)
    const bobOffset = Math.sin(Date.now() * 0.003) * 0.04;
    saveMesh.position.y = finishPos.y + 0.3 + bobOffset;
  }

  // 3. Fade Transition Animation for level switching
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
      if (ballMesh && ballMesh.material) {
        (ballMesh.material as THREE.Material).opacity = opacity;
      }
      if (saveMesh) {
        saveMesh.traverse((child) => {
          if (child instanceof THREE.Mesh && child.material) {
            if (Array.isArray(child.material)) {
              child.material.forEach(m => m.opacity = opacity);
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
      if (ballMesh && ballMesh.material) {
        (ballMesh.material as THREE.Material).opacity = opacity;
      }
      if (saveMesh) {
        saveMesh.traverse((child) => {
          if (child instanceof THREE.Mesh && child.material) {
            if (Array.isArray(child.material)) {
              child.material.forEach(m => m.opacity = opacity);
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
      
      if (transitionTime <= 0.0) {
        isTransitioning = false;
      }
    }
  }

  if (physicsWorld && ballBody && ballMesh) {
    if (isLevelLoading) {
      // Keep everything flat and unrotated during level build
      currentPitch = 0;
      currentRoll = 0;
      currentYaw = 0;
      if (mazeContainer) {
        mazeContainer.quaternion.set(0, 0, 0, 1);
      }
      physicsWorld.gravity = { x: 0, y: -35.0, z: 0 };
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

      // 1. Smoothly interpolate maze rotation (taking the shortest path for yaw)
      currentPitch += (targetPitch - currentPitch) * lerpFactor;
      currentRoll += (targetRoll - currentRoll) * lerpFactor;
      
      let yawDiff = phoneYaw - currentYaw;
      while (yawDiff < -Math.PI) yawDiff += Math.PI * 2;
      while (yawDiff > Math.PI) yawDiff -= Math.PI * 2;
      currentYaw += yawDiff * lerpFactor;

      // 2. Physics world gravity slant in local coordinates (rotated by visual yaw)
      const gravityStrength = 22.0;
      const rawGx = currentRoll * gravityStrength;
      const rawGz = currentPitch * gravityStrength;
      const cosYaw = Math.cos(currentYaw);
      const sinYaw = Math.sin(currentYaw);

      physicsWorld.gravity = {
        x: rawGx * cosYaw - rawGz * sinYaw,
        y: -35.0,
        z: rawGx * sinYaw + rawGz * cosYaw
      };

      // 3. Visual maze rotation matching gravity tilt and phone yaw
      const visualPitch = currentPitch * maxTiltAngle;
      const visualRoll = -currentRoll * maxTiltAngle;
      const visualYaw = currentYaw; 
      const q = new THREE.Quaternion().setFromEuler(
        new THREE.Euler(visualPitch, visualYaw, visualRoll, 'YXZ')
      );
      
      if (mazeContainer) {
        mazeContainer.quaternion.copy(q);
      }
    }

    // 4. Fixed-rate physics keeps gameplay speed consistent across a 30 FPS 4K
    // display and a high-refresh development monitor.
    physicsAccumulator = Math.min(
      physicsAccumulator + dt,
      PHYSICS_TIMESTEP * MAX_PHYSICS_STEPS_PER_FRAME
    );
    while (physicsAccumulator >= PHYSICS_TIMESTEP) {
      physicsWorld.step();
      physicsAccumulator -= PHYSICS_TIMESTEP;
    }

    // Smooth ball stopping logic
    if (isBallStopping && ballBody) {
      ballStopTimer = Math.min(0.1, ballStopTimer + dt);
      const progress = ballStopTimer / 0.1;
      const factor = 1.0 - progress;
      
      ballBody.setLinvel({
        x: ballStartLinVel.x * factor,
        y: ballStartLinVel.y * factor,
        z: ballStartLinVel.z * factor
      }, true);
      
      ballBody.setAngvel({
        x: ballStartAngVel.x * factor,
        y: ballStartAngVel.y * factor,
        z: ballStartAngVel.z * factor
      }, true);
      
      if (ballStopTimer >= 0.1) {
        isBallStopping = false;
      }
    }

    // 5. Sync Ball graphics
    const ballPos = ballBody.translation();
    const ballRot = ballBody.rotation();
    
    ballMesh.position.set(ballPos.x, ballPos.y, ballPos.z);
    ballMesh.quaternion.set(ballRot.x, ballRot.y, ballRot.z, ballRot.w);

    // 6. Update audio based on velocity
    const linVel = ballBody.linvel();
    const velVec = new THREE.Vector3(linVel.x, linVel.y, linVel.z);
    const speed = velVec.length();

    sounds.updateRolling(speed);

    if (speed > 0.1) {
      aliveTime += dt;
      if (aliveTime > 3.0) {
        resetCount = 0;
      }
    } else {
      aliveTime = 0;
    }

    // Collision thuds
    const acceleration = lastVelocity.clone().sub(velVec);
    const deltaV = acceleration.length();
    
    if (deltaV > 1.2) { 
      sounds.playImpact(deltaV * 2.0);
    }
    lastVelocity.copy(velVec);

    // 7. Check out-of-bounds drop
    const dropLimit = mazeBoundingBox.min.y - Math.max(2.0, mazeSize.y * 1.5);
    if (ballPos.y < dropLimit) {
      debugLog(`Ball fell below threshold (${ballPos.y.toFixed(2)} < ${dropLimit.toFixed(2)}). Resetting...`);
      resetGame();
    }

    // 8. Check Win conditions (collect save item) - using 2D distance for robustness
    const distToFinish2D = Math.hypot(ballPos.x - finishPos.x, ballPos.z - finishPos.z);
    if (distToFinish2D < (ballRadius + finishRadius * 0.8) && isGameActive && !isTransitioning) {
      collectSave();
    }
  }

  // Render Scene
  renderer.render(scene, camera);
}

// Start pairing fetch and render init
fetchServerInfo();
init();

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
    socket.emit('calibrate');
  }
  if (e.key === 'r' || e.key === 'R') {
    resetGame();
  }
  // Switch maze levels with number keys.
  if (e.key >= '1' && e.key <= String(MAZE_FILES.length)) {
    switchMaze(parseInt(e.key) - 1);
  }
});

window.addEventListener('keyup', (e) => {
  if (e.key === 'w' || e.key === 'W') { activeControls.up = false; }
  if (e.key === 's' || e.key === 'S') { activeControls.down = false; }
  if (e.key === 'a' || e.key === 'A') { activeControls.left = false; }
  if (e.key === 'd' || e.key === 'D') { activeControls.right = false; }
});

// Interactive HUD Settings Controls
const settingsTrigger = document.getElementById('settings-trigger') as HTMLButtonElement;
const settingsPanel = document.getElementById('settings-panel') as HTMLElement;
const settingsClose = document.getElementById('settings-close') as HTMLButtonElement;

const sliderCameraHeight = document.getElementById('slider-camera-height') as HTMLInputElement;
const sliderCameraAngle = document.getElementById('slider-camera-angle') as HTMLInputElement;
const sliderSceneHeight = document.getElementById('slider-scene-height') as HTMLInputElement;

const valCameraHeight = document.getElementById('val-camera-height') as HTMLElement;
const valCameraAngle = document.getElementById('val-camera-angle') as HTMLElement;
const valSceneHeight = document.getElementById('val-scene-height') as HTMLElement;

// Toggle settings panel
settingsTrigger?.addEventListener('click', () => {
  settingsPanel?.classList.toggle('hidden');
});

settingsClose?.addEventListener('click', () => {
  settingsPanel?.classList.add('hidden');
});

// Update slider values on UI
function updateSlidersUI() {
  if (sliderCameraHeight && valCameraHeight) {
    sliderCameraHeight.value = cameraHeight.toFixed(1);
    valCameraHeight.textContent = cameraHeight.toFixed(1);
  }
  if (sliderCameraAngle && valCameraAngle) {
    sliderCameraAngle.value = cameraAngleDeg.toFixed(0);
    valCameraAngle.textContent = cameraAngleDeg.toFixed(0) + '°';
  }
  if (sliderSceneHeight && valSceneHeight) {
    sliderSceneHeight.value = sceneYShift.toFixed(1);
    valSceneHeight.textContent = sceneYShift.toFixed(1);
  }
}

// Bind input events
sliderCameraHeight?.addEventListener('input', (e) => {
  const val = parseFloat((e.target as HTMLInputElement).value);
  cameraHeight = val;
  if (valCameraHeight) valCameraHeight.textContent = val.toFixed(1);
  updateCameraPosition();
});

sliderCameraAngle?.addEventListener('input', (e) => {
  const val = parseFloat((e.target as HTMLInputElement).value);
  cameraAngleDeg = val;
  if (valCameraAngle) valCameraAngle.textContent = val.toFixed(0) + '°';
  updateCameraPosition();
});

sliderSceneHeight?.addEventListener('input', (e) => {
  const val = parseFloat((e.target as HTMLInputElement).value);
  sceneYShift = val;
  if (valSceneHeight) valSceneHeight.textContent = val.toFixed(1);
  updateCameraPosition();
});
