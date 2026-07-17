import * as THREE from 'three';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import RAPIER from '@dimforge/rapier3d-compat';
import { io } from 'socket.io-client';

// Connect to the socket server
const socket = io();

// Logging helper to relay browser logs to the Node.js server terminal
function debugLog(msg: string) {
  console.log(msg);
  socket.emit('log', msg);
}

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

const btnHudRestart = document.getElementById('btn-hud-restart') as HTMLButtonElement;
const modalTitle = document.getElementById('modal-title') as HTMLElement;
const modalSubtitle = document.getElementById('modal-subtitle') as HTMLElement;

// Start Screen elements
const startOverlay = document.getElementById('start-overlay') as HTMLElement;
const btnStartGame = document.getElementById('btn-start-game') as HTMLButtonElement;

// Debug UI elements
const btnDebugToggle = document.getElementById('btn-debug-toggle') as HTMLButtonElement;
const debugPanel = document.getElementById('debug-panel') as HTMLElement;
const debugLevelSelect = document.getElementById('debug-level-select') as HTMLSelectElement;

const sliderSaveX = document.getElementById('slider-save-x') as HTMLInputElement;
const sliderSaveZ = document.getElementById('slider-save-z') as HTMLInputElement;

const valSaveX = document.getElementById('val-save-x') as HTMLElement;
const valSaveZ = document.getElementById('val-save-z') as HTMLElement;

const debugOutput = document.getElementById('debug-output') as HTMLTextAreaElement;

// Maze level management (Level 2 to Level 7 from /new/)
const MAZE_FILES = [
  '/source/fixed/labirint2.fbx',
  '/source/fixed/labirint3.fbx',
  '/source/fixed/labirint5.fbx',
  '/source/fixed/labirint7.fbx'
];
const DEFAULT_SAVE_COORDS = [
  { x: 5.3,   z: 1.8 },   // Лабиринт 2 (индекс 0)
  { x: -2.95, z: -2.95 }, // Лабиринт 3 (индекс 1)
  { x: 2.9,   z: -0.55 }, // Лабиринт 5 (индекс 2)
  { x: 4.15,  z: -1.8 }   // Лабиринт 7 (индекс 3)
];
let currentMazeIndex = 0;
let isAnimating = false; // prevent calling animate() multiple times

// Game mode state variables
let savesCollected = 0;
const totalSavesGoal = 4;
let gameTimeLeft = 60.0;
let isGameActive = false;
let gameTimerInterval: any = null;

// Transition and save object state
let saveTemplate: THREE.Group | null = null;
let saveMesh: THREE.Group | null = null;
const customSaveCoordinates: { [key: number]: { x: number, z: number } } = {};

// Football and Gates Templates & State
let footballTemplate: THREE.Group | null = null;
let isSaveCollected = false;
let isDebugModeActive = false;

// Start Screen State
let isStartScreenActive = false;

let isTransitioning = false;
let transitionTime = 0.0;
let transitionDir = 1; // 1: fading out, -1: fading in
let nextMazeIndexToLoad = -1;

let mazeMaterial: THREE.MeshPhysicalMaterial;
let floorMaterial: THREE.MeshStandardMaterial;
let activeLoadId = 0;

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
let ballMesh: THREE.Object3D | null = null;
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
let phonePitch = 0;
let phoneRoll = 0;
let manualPitch = 0;
let manualRoll = 0;

// Camera angle setting (adjustable via Keyboard ArrowUp/ArrowDown)
let cameraAngleDeg = 0.0; // starts at 0 degrees horizontal front look (straight at screen)
let mazeYOffset = 0.0;
let cameraHeight = 0.0; // will be dynamically set based on maze size
let sceneYShift = 0.0;  // moves the entire scene up/down visually
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

// Self-healing reset logic
let resetCount = 0;
let aliveTime = 0;

// For collision impact detection
let lastVelocity = new THREE.Vector3();

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

  // If pairing overlay is visible, it means we were waiting for connection
  if (!pairingOverlay.classList.contains('hidden')) {
    pairingOverlay.classList.add('hidden');
    hudOverlay.classList.remove('hidden');
    
    // Initialize audio context
    sounds.init();
    // Start game mode
    startNewGame();
  }

  // Save raw normalized sensor telemetry (-1.0 to 1.0)
  phonePitch = data.beta;
  phoneRoll = data.gamma;
  if (data.alpha !== undefined) {
    phoneYaw = data.alpha * Math.PI / 180; // convert calibrated yaw from degrees to radians
  }
});

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
  currentLevelSpan.textContent = String(currentMazeIndex + 1).padStart(2, '0');
  debugLog(`Switching to maze ${currentMazeIndex + 1}: ${MAZE_FILES[currentMazeIndex]}`);

  // 1. Remove old ball body and mesh
  if (ballBody) {
    physicsWorld.removeRigidBody(ballBody);
    ballBody = null;
  }
  if (ballMesh) {
    mazeContainer.remove(ballMesh);
    ballMesh = null;
  }

  // 2. Remove old maze body
  if (mazeBody) {
    physicsWorld.removeRigidBody(mazeBody);
    mazeBody = null;
  }

  // 3. Remove old visual maze
  if (mazeGroup) {
    mazeContainer.remove(mazeGroup);
    mazeGroup = null;
  }

  // 4. Remove markers and lights
  const oldFinish = mazeContainer.getObjectByName('finish-marker');
  if (oldFinish) mazeContainer.remove(oldFinish);

  const oldFinishLight = mazeContainer.getObjectByName('finish-light');
  if (oldFinishLight) mazeContainer.remove(oldFinishLight);

  const oldStartLight = mazeContainer.getObjectByName('start-light');
  if (oldStartLight) mazeContainer.remove(oldStartLight);

  const oldSaveItem = mazeContainer.getObjectByName('save-item');
  if (oldSaveItem) mazeContainer.remove(oldSaveItem);

  // Remove old floor plane
  const oldFloor = mazeContainer.getObjectByName('floor-mesh');
  if (oldFloor) mazeContainer.remove(oldFloor);

  // 5. Reset level state
  resetCount = 0;
  aliveTime = 0;
  victoryOverlay.classList.add('hidden');

  // 6. Load new maze
  loadMazeAsset();
}

function startTimer() {
  if (gameTimerInterval) clearInterval(gameTimerInterval);
  
  gameTimeLeft = 60.0;
  if (timerSpan) timerSpan.textContent = String(Math.ceil(gameTimeLeft));
  
  gameTimerInterval = setInterval(() => {
    if (!isGameActive) return;
    
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
  if (ballMesh) {
    mazeContainer.remove(ballMesh);
    ballMesh = null;
  }
  if (mazeBody && physicsWorld) {
    physicsWorld.removeRigidBody(mazeBody);
    mazeBody = null;
  }
  if (mazeGroup) {
    mazeContainer.remove(mazeGroup);
    mazeGroup = null;
  }
  
  // Remove old markers, lights, save meshes, etc.
  const oldFinish = mazeContainer.getObjectByName('finish-marker');
  if (oldFinish) mazeContainer.remove(oldFinish);

  const oldFinishLight = mazeContainer.getObjectByName('finish-light');
  if (oldFinishLight) mazeContainer.remove(oldFinishLight);

  const oldStartLight = mazeContainer.getObjectByName('start-light');
  if (oldStartLight) mazeContainer.remove(oldStartLight);

  const oldSaveItem = mazeContainer.getObjectByName('save-item');
  if (oldSaveItem) mazeContainer.remove(oldSaveItem);

  const oldFloor = mazeContainer.getObjectByName('floor-mesh');
  if (oldFloor) mazeContainer.remove(oldFloor);

  // Reset graphic HUD
  updateSavesHUD();
  
  isGameActive = true;
  if (victoryOverlay) {
    victoryOverlay.classList.add('hidden');
  }
  
  // Reset states
  isSaveCollected = false;
  const oldGates = mazeContainer.getObjectByName('football-gates');
  if (oldGates) mazeContainer.remove(oldGates);
  
  // Clear any remaining floating saves
  const savesToRemove: THREE.Object3D[] = [];
  scene.traverse((child) => {
    if (child.name === 'save-item' && child.parent === scene) {
      savesToRemove.push(child);
    }
  });
  savesToRemove.forEach(s => scene.remove(s));
  
  currentLevelSpan.textContent = String(currentMazeIndex + 1).padStart(2, '0');
  loadMazeAsset();
  
  startTimer();
}

function updateSavesHUD() {
  const container = document.getElementById('saves-icons');
  if (!container) return;
  
  container.innerHTML = '';
  for (let i = 0; i < totalSavesGoal; i++) {
    const slot = document.createElement('div');
    slot.className = `save-icon-slot ${i < savesCollected ? 'collected' : ''}`;
    slot.innerHTML = `
      <svg class="save-icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
        <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"></path>
        <polyline points="17 21 17 13 7 13 7 21"></polyline>
        <polyline points="7 3 7 8 15 8"></polyline>
      </svg>
    `;
    container.appendChild(slot);
  }
}

function collectSave() {
  if (isTransitioning || !isGameActive || isSaveCollected || !saveMesh) return;
  
  isSaveCollected = true;
  savesCollected++;
  
  sounds.playVictory();
  
  // Remove save mesh from mazeContainer instantly
  mazeContainer.remove(saveMesh);
  saveMesh = null;
  
  // Update graphic HUD
  updateSavesHUD();
  
  // Save collected -> transition to next level immediately!
  completeLevel();
}

function completeLevel() {
  if (isTransitioning || !isGameActive) return;

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



function showStartScreen() {
  isStartScreenActive = true;
  mazeContainer.visible = false;
  
  const mainLight = scene.getObjectByName('main-light');
  if (mainLight) mainLight.visible = false;
  
  camera.position.set(0, 0.5, 10);
  camera.lookAt(0, 0.5, 0);
  camera.up.set(0, 1, 0);
}

function hideStartScreen() {
  isStartScreenActive = false;
  mazeContainer.visible = true;
  
  const mainLight = scene.getObjectByName('main-light');
  if (mainLight) mainLight.visible = true;
}

function initDebugControls() {
  const urlParams = new URLSearchParams(window.location.search);
  if (urlParams.has('debug')) {
    btnDebugToggle.style.display = 'block';
  } else {
    btnDebugToggle.style.display = 'none';
  }

  btnDebugToggle.addEventListener('click', () => {
    isDebugModeActive = !isDebugModeActive;
    if (isDebugModeActive) {
      debugPanel.classList.remove('hidden');
      btnDebugToggle.textContent = '❌ ВЫЙТИ ИЗ ОТЛАДКИ';
      btnDebugToggle.style.borderColor = 'red';
      btnDebugToggle.style.color = 'red';
      
      // Stop gameplay
      isGameActive = false;
      
      // Set select values
      debugLevelSelect.value = String(currentMazeIndex);
      
      // Sync sliders
      syncDebugSlidersFromScene();
      
      // Top down camera look
      camera.position.set(0, 30, 0);
      camera.lookAt(0, 0, 0);
      camera.up.set(0, 0, -1);
    } else {
      debugPanel.classList.add('hidden');
      btnDebugToggle.textContent = '🔧 ОТЛАДКА';
      btnDebugToggle.style.borderColor = 'var(--accent-cyan)';
      btnDebugToggle.style.color = 'var(--accent-cyan)';
      
      // Resume game
      isGameActive = true;
      positionCamera();
    }
  });

  debugLevelSelect.addEventListener('change', () => {
    const nextIndex = parseInt(debugLevelSelect.value);
    // Switch level
    isLevelLoading = true;
    switchMaze(nextIndex);
  });

  const onSliderChange = () => {
    if (!saveMesh) return;
    
    const sx = parseFloat(sliderSaveX.value);
    const sz = parseFloat(sliderSaveZ.value);
    
    // Update Save
    saveMesh.position.x = sx;
    saveMesh.position.z = sz;
    
    // Cache the custom coordinates for the current level index
    customSaveCoordinates[currentMazeIndex] = {
      x: parseFloat(sx.toFixed(3)),
      z: parseFloat(sz.toFixed(3))
    };
    
    // Update labels
    valSaveX.textContent = sx.toFixed(2);
    valSaveZ.textContent = sz.toFixed(2);
    
    // Update output text
    updateDebugOutputText();
  };

  const sliders = [sliderSaveX, sliderSaveZ];
  sliders.forEach(s => {
    s.addEventListener('input', onSliderChange);
  });
}

function syncDebugSlidersFromScene() {
  if (!saveMesh) return;
  
  sliderSaveX.value = String(saveMesh.position.x);
  sliderSaveZ.value = String(saveMesh.position.z);
  
  // Set text labels
  valSaveX.textContent = saveMesh.position.x.toFixed(2);
  valSaveZ.textContent = saveMesh.position.z.toFixed(2);
  
  updateDebugOutputText();
}

function updateDebugOutputText() {
  if (!saveMesh) return;
  
  const currentData = {
    levelIndex: currentMazeIndex,
    levelName: MAZE_FILES[currentMazeIndex].split('/').pop(),
    save: {
      x: parseFloat(saveMesh.position.x.toFixed(3)),
      y: parseFloat(saveMesh.position.y.toFixed(3)),
      z: parseFloat(saveMesh.position.z.toFixed(3))
    }
  };
  
  const combined = {
    currentLevel: currentData,
    allCustomizedSession: customSaveCoordinates
  };
  
  debugOutput.value = JSON.stringify(combined, null, 2);
}

// Initialize Graphics & Physics
async function init() {
  // 1. Initialize Rapier Physics WASM
  await RAPIER.init();
  physicsWorld = new RAPIER.World({ x: 0.0, y: -35.0, z: 0.0 });

  // 2. Set up Three.js Scene
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0xffffff); // White background

  clock = new THREE.Clock();

  // Create visual container group centered at (0, 0, 0)
  mazeContainer = new THREE.Group();
  scene.add(mazeContainer);

  // Camera setup optimized for 9:16 layout
  camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.1, 1000);
  
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

  // 2. Add Studio Lights (increased intensities so everything is well-lit from all sides)
  // Ambient fill light for base brightness
  const ambientLight = new THREE.AmbientLight(0xffffff, 0.8);
  scene.add(ambientLight);

  // Key Light (main light casting shadows with optimized frustum bounds)
  const mainLight = new THREE.DirectionalLight(0xffffff, 1.8);
  mainLight.position.set(20, 50, 10);
  mainLight.castShadow = true;
  mainLight.shadow.mapSize.width = 2048;
  mainLight.shadow.mapSize.height = 2048;
  mainLight.shadow.bias = -0.0005;
  mainLight.shadow.camera.left = -15;
  mainLight.shadow.camera.right = 15;
  mainLight.shadow.camera.top = 15;
  mainLight.shadow.camera.bottom = -15;
  mainLight.shadow.camera.near = 0.5;
  mainLight.shadow.camera.far = 120;
  mainLight.name = 'main-light';
  scene.add(mainLight);

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

  // Load Save 3D asset template
  const fbxLoader = new FBXLoader();
  fbxLoader.load('/source/save.fbx', (fbx) => {
    saveTemplate = fbx;
    saveTemplate.traverse((child) => {
      if (child instanceof THREE.Mesh) {
        child.castShadow = true;
        child.receiveShadow = true;
      }
    });
    debugLog('Loaded save.fbx template successfully.');
  }, undefined, (err) => {
    console.error('Error loading save.fbx template:', err);
  });



  // Load football.glb template
  const gltfLoader = new GLTFLoader();
  gltfLoader.load('/source/football.glb', (gltf) => {
    footballTemplate = gltf.scene;
    footballTemplate.traverse((child) => {
      if (child instanceof THREE.Mesh) {
        child.castShadow = true;
        child.receiveShadow = true;
      }
    });
    debugLog('Loaded football.glb template successfully.');
  }, undefined, (err) => {
    console.error('Error loading football.glb template:', err);
  });



  // Bind 2D Start Button Click Event
  btnStartGame.addEventListener('click', () => {
    hideStartScreen();
    startOverlay.classList.add('hidden');
    
    if (isControllerConnected) {
      pairingOverlay.classList.add('hidden');
      hudOverlay.classList.remove('hidden');
      sounds.init();
      startNewGame();
    } else {
      pairingOverlay.classList.remove('hidden');
      fetchServerInfo();
    }
  });

  // Load the Maze asset (they just go in order from 01 to 06)
  currentLevelSpan.textContent = String(currentMazeIndex + 1).padStart(2, '0');
  loadMazeAsset();

  // Initialize Debug Controls
  initDebugControls();

  // Show Start Screen immediately on launch
  showStartScreen();

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
  const v = Date.now();
  const mazeFile = MAZE_FILES[currentMazeIndex];

  // Load only the normal texture map (avoiding 8MB+ bandwidth waste of unused textures)
  const textureLoader = new THREE.TextureLoader();
  const normalMap = textureLoader.load('/textures/DefaultMaterial_Normal_OpenGL.png');

  normalMap.wrapS = THREE.RepeatWrapping;
  normalMap.wrapT = THREE.RepeatWrapping;

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

  loader.load(mazeFile + '?v=' + v, (fbx) => {
    if (thisLoadId !== activeLoadId) {
      debugLog('Ignoring superseded maze load callback.');
      return;
    }
    mazeGroup = fbx;
    mazeContainer.add(mazeGroup);

    debugLog('Loaded labyrinth FBX successfully.');

    if (mazeGroup) {
      // Apply PBR material to all meshes (FBX has no embedded textures)
      mazeGroup.traverse((child) => {
      const nameLower = child.name.toLowerCase();
      // Hide legacy start/finish placeholders if any remain in legacy files
      if (nameLower === 'start' || nameLower === 'finish') {
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
        const activeMaterial = isFloor ? floorMaterial : mazeMaterial;

        child.material = activeMaterial;
        child.castShadow = true;
        child.receiveShadow = true;
      }
    });
    }

    // If we are transitioning, start level fully transparent
    if (isTransitioning) {
      mazeMaterial.opacity = 0.0;
      floorMaterial.opacity = 0.0;
    } else {
      mazeMaterial.opacity = 0.6;
      floorMaterial.opacity = 1.0;
    }

    // 1. Get original size of the mesh
    mazeBoundingBox = getGeometryBoundingBox(mazeGroup);
    mazeBoundingBox.getSize(mazeSize);
    
    // Scale maze to a realistic size (12.0 meters wide/deep)
    const targetWidth = 12.0;
    const maxDim = Math.max(mazeSize.x, mazeSize.z);
    const scaleFactor = targetWidth / maxDim;
    
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
    console.error('An error happened loading the FBX model:', error);
    const msg = error instanceof Error ? error.message : String(error);
    debugLog('Error loading FBX model: ' + msg);
  });
}

// Recalculates camera coordinates based on cameraAngleDeg
function updateCameraPosition() {
  if (!mazeGroup) return;
  const distance = Math.max(mazeSize.x, mazeSize.z);
  const angleRad = cameraAngleDeg * Math.PI / 180;
  
  // Adjust distance for vertical screens (aspect < 1.0) so maze fits horizontally
  let camDistance = distance * 1.5;
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
  cameraHeight = distance * 0.40;
  
  // Sync HTML inputs with new geometry settings
  updateSlidersUI();
  
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
  const finishCoord = DEFAULT_SAVE_COORDS[currentMazeIndex];
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
  if (footballTemplate) {
    ballMesh = footballTemplate.clone();
    
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
        child.receiveShadow = true;
        if (child.material) {
          if (Array.isArray(child.material)) {
            child.material = child.material.map((mat) => {
              const cloned = mat.clone();
              cloned.transparent = true;
              cloned.opacity = isTransitioning ? 0.0 : 1.0;
              return cloned;
            });
          } else {
            child.material = child.material.clone();
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
    ballMesh.receiveShadow = true;
  }
  mazeContainer.add(ballMesh);

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
  if (saveTemplate) {
    saveMesh = saveTemplate.clone();
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
        child.receiveShadow = true;
        if (child.material) {
          if (Array.isArray(child.material)) {
            child.material = child.material.map((mat) => {
              const cloned = mat.clone();
              cloned.transparent = true;
              cloned.opacity = isTransitioning ? 0.0 : 1.0;
              return cloned;
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

  if (isDebugModeActive) {
    syncDebugSlidersFromScene();
  }

  // Expose to window for real-time console debugging
  (window as any).physicsWorld = physicsWorld;
  (window as any).ballBody = ballBody;
  (window as any).ballMesh = ballMesh;
  (window as any).mazeGroup = mazeGroup;
  (window as any).startPos = startPos;
  (window as any).finishPos = finishPos;
}

function onWindowResize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  if (isStartScreenActive) {
    camera.position.set(0, 0.5, 10);
    camera.lookAt(0, 0.5, 0);
    camera.up.set(0, 1, 0);
  } else if (isDebugModeActive) {
    camera.position.set(0, 30, 0);
    camera.lookAt(0, 0, 0);
    camera.up.set(0, 0, -1);
  } else {
    positionCamera();
  }
}

// Game loop
function animate() {
  requestAnimationFrame(animate);

  const dt = clock.getDelta();





  // 3. Normal active Save Mesh Hover rotation in the level
  if (saveMesh && saveMesh.parent === mazeContainer) {
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
      }
    }
  }

  if (physicsWorld && ballBody && ballMesh) {
    if (isLevelLoading || isStartScreenActive) {
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
      const q = new THREE.Quaternion().setFromEuler(
        new THREE.Euler(visualPitch, visualYaw, visualRoll, 'YXZ')
      );

      if (mazeContainer) {
        mazeContainer.quaternion.copy(q);
      }
    }

    // 4. Step Physics simulation with fixed timestep accumulator
    physicsAccumulator = Math.min(physicsAccumulator + dt, PHYSICS_TIMESTEP * MAX_PHYSICS_STEPS_PER_FRAME);
    while (physicsAccumulator >= PHYSICS_TIMESTEP) {
      physicsWorld.step();
      physicsAccumulator -= PHYSICS_TIMESTEP;
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

    // 8. Check Win / Collection conditions
    const ballWorldPos = new THREE.Vector3(ballPos.x, ballPos.y, ballPos.z);
    
    // Save checkpoint collection check
    if (!isSaveCollected && saveMesh) {
      const ballPosXZ = new THREE.Vector2(ballWorldPos.x, ballWorldPos.z);
      const savePosXZ = new THREE.Vector2(saveMesh.position.x, saveMesh.position.z);
      const distToSave = ballPosXZ.distanceTo(savePosXZ);
      
      if (distToSave < (ballRadius + (ballRadius * 1.6) * 0.8) && isGameActive && !isTransitioning) {
        collectSave();
      }
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
