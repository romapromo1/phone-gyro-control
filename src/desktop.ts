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

// Maze level management
const MAZE_FILES = [
  '/source/labirint.fbx',
  '/source/labirint_2.fbx',
  '/source/labirint_3.fbx',
  '/source/labirint_4.fbx'
];
let currentMazeIndex = 0;
let isAnimating = false; // prevent calling animate() multiple times

// Sound Manager using Web Audio API (Synthesized sounds)
class SoundManager {
  private ctx: AudioContext | null = null;
  private rollOsc: OscillatorNode | null = null;
  private rollGain: GainNode | null = null;
  private filter: BiquadFilterNode | null = null;
  private isInitialized = false;

  init() {
    if (this.isInitialized) return;
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

    const now = this.ctx.currentTime;
    const notes = [261.63, 329.63, 392.00, 523.25, 659.25]; // C4, E4, G4, C5, E5 arpeggio

    notes.forEach((freq, index) => {
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(freq, now + index * 0.12);
      
      gain.gain.setValueAtTime(0, now + index * 0.12);
      gain.gain.linearRampToValueAtTime(0.2, now + index * 0.12 + 0.03);
      gain.gain.exponentialRampToValueAtTime(0.001, now + index * 0.12 + 0.3);
      
      osc.connect(gain);
      gain.connect(this.ctx.destination);
      
      osc.start(now + index * 0.12);
      osc.stop(now + index * 0.12 + 0.4);
    });
  }
}

const sounds = new SoundManager();

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
let hasWon = false;
let isFirstTelemetry = true;
let mazeBoundingBox = new THREE.Box3();
let mazeSize = new THREE.Vector3();

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
  if (isFirstTelemetry) {
    pairingOverlay.classList.add('hidden');
    hudOverlay.classList.remove('hidden');
    isFirstTelemetry = false;
    // Initialize audio context
    sounds.init();
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
  resetCount = 0; 
  resetGame();
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

  // 4. Remove finish marker
  const oldFinish = mazeContainer.getObjectByName('finish-marker');
  if (oldFinish) mazeContainer.remove(oldFinish);

  // Remove old floor plane
  const oldFloor = mazeContainer.getObjectByName('floor-mesh');
  if (oldFloor) mazeContainer.remove(oldFloor);

  // 5. Reset game state
  hasWon = false;
  resetCount = 0;
  aliveTime = 0;
  victoryOverlay.classList.add('hidden');

  // 6. Load new maze
  loadMazeAsset();
}

function resetGame() {
  hasWon = false;
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

  // Add Lights
  const ambientLight = new THREE.AmbientLight(0xffffff, 0.6);
  scene.add(ambientLight);

  const mainLight = new THREE.DirectionalLight(0xffffff, 1.2);
  mainLight.position.set(20, 50, 10);
  mainLight.castShadow = true;
  mainLight.shadow.mapSize.width = 2048;
  mainLight.shadow.mapSize.height = 2048;
  mainLight.shadow.bias = -0.0005;
  scene.add(mainLight);

  // Load the Maze asset
  currentLevelSpan.textContent = String(currentMazeIndex + 1).padStart(2, '0');
  loadMazeAsset();

  // Window Resize
  window.addEventListener('resize', onWindowResize);
}

function loadMazeAsset() {
  isLevelLoading = true;
  if (mazeContainer) {
    mazeContainer.quaternion.set(0, 0, 0, 1);
  }
  const loader = new FBXLoader();
  const v = Date.now();
  const mazeFile = MAZE_FILES[currentMazeIndex];

  // Load external PBR textures (not embedded in FBX)
  const textureLoader = new THREE.TextureLoader();
  const baseColorMap = textureLoader.load('/textures/DefaultMaterial_Base_color.png?v=' + v);
  const normalMap = textureLoader.load('/textures/DefaultMaterial_Normal_OpenGL.png?v=' + v);
  const metallicMap = textureLoader.load('/textures/DefaultMaterial_Metallic.png?v=' + v);
  const roughnessMap = textureLoader.load('/textures/DefaultMaterial_Roughness.png?v=' + v);

  [baseColorMap, normalMap, metallicMap, roughnessMap].forEach(tex => {
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
  });

  const mazeMaterial = new THREE.MeshPhysicalMaterial({
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
    normalMap: normalMap,
    normalScale: new THREE.Vector2(0.2, 0.2),
    side: THREE.DoubleSide
  });

  const floorMaterial = new THREE.MeshStandardMaterial({
    color: 0xddff68, // #ddff68 (requested color)
    roughness: 0.3,  // requested: 0.3
    metalness: 0.7,  // requested: 0.7
    side: THREE.DoubleSide // Render both sides in case normals are inverted in the model
  });

  loader.load(mazeFile + '?v=' + v, (fbx) => {
    mazeGroup = fbx;
    mazeContainer.add(mazeGroup);

    debugLog('Loaded labyrinth FBX successfully.');

    // Apply PBR material to all meshes (FBX has no embedded textures)
    mazeGroup.traverse((child) => {
      if (child instanceof THREE.Mesh) {
        if (!child.geometry.boundingBox) {
          child.geometry.computeBoundingBox();
        }
        const size = new THREE.Vector3();
        child.geometry.boundingBox.getSize(size);
        debugLog(`Mesh "${child.name}": visible=${child.visible} scale=(${child.scale.x},${child.scale.y},${child.scale.z}) pos=(${child.position.x},${child.position.y},${child.position.z}) size=(${size.x.toFixed(2)},${size.y.toFixed(2)},${size.z.toFixed(2)})`);

        // Force visibility to true in case it was exported as hidden from Blender
        child.visible = true;

        const nameLower = child.name.toLowerCase();
        const isFloor = nameLower.includes('floor') || 
                        nameLower.includes('ground') || 
                        nameLower.includes('plane') || 
                        nameLower.includes('cube.001');
        const activeMaterial = isFloor ? floorMaterial : mazeMaterial;

        child.material = activeMaterial;
        child.castShadow = true;
        child.receiveShadow = true;
      }
    });

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
    debugLog('Error loading FBX model: ' + error.message);
  });
}

// Recalculates camera coordinates based on cameraAngleDeg
function updateCameraPosition() {
  if (!mazeGroup) return;
  const distance = Math.max(mazeSize.x, mazeSize.z);
  const angleRad = cameraAngleDeg * Math.PI / 180;
  
  // Keep the distance from camera to center constant
  const camDistance = distance * 1.5;
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
  // Create STATIC fixed body for stable mesh collisions.
  const mazeBodyDesc = RAPIER.RigidBodyDesc.fixed();
  mazeBody = physicsWorld.createRigidBody(mazeBodyDesc);

  // Accumulate all mesh vertices and indices to build Rapier trimesh colliders
  mazeGroup!.traverse((child) => {
    if (child instanceof THREE.Mesh) {
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
        const colliderDesc = RAPIER.ColliderDesc.trimesh(vertices, indices);
        physicsWorld.createCollider(colliderDesc, mazeBody);
      } catch (err) {
        console.error('Failed to create collider for child mesh:', err);
      }
    }
  });
  // Create a thick solid physical floor collider at the bottom of the maze to prevent falling through
  const floorThickness = 0.2;
  const floorColliderDesc = RAPIER.ColliderDesc.cuboid(
    mazeSize.x * 0.5 + 1.0,
    floorThickness * 0.5,
    mazeSize.z * 0.5 + 1.0
  )
  .setTranslation(0, mazeBoundingBox.min.y - floorThickness * 0.5, 0)
  .setFriction(0.4)
  .setRestitution(0.2);

  physicsWorld.createCollider(floorColliderDesc, mazeBody);
  debugLog('Solid physical floor collider added to maze body.');

  debugLog('Physics maze colliders built successfully.');
}

function spawnGameElements() {
  const maxDim = Math.max(mazeSize.x, mazeSize.z);
  ballRadius = maxDim * 0.022; 
  finishRadius = ballRadius * 2.0;

  // Spawn ball ABOVE the maze walls — it will drop down into the corridor below
  // This avoids embedding in walls regardless of maze geometry
  startPos.set(
    mazeBoundingBox.min.x + mazeSize.x * 0.12,
    mazeBoundingBox.max.y + ballRadius + 0.3, // Above wall tops for a visible drop
    mazeBoundingBox.min.z + mazeSize.z * 0.12
  );

  finishPos.set(
    mazeBoundingBox.max.x - mazeSize.x * 0.12,
    mazeBoundingBox.min.y + 0.1,
    mazeBoundingBox.max.z - mazeSize.z * 0.12
  );

  // 1. Visual representation of the Ball (Glowing holographic sphere)
  const ballGeo = new THREE.SphereGeometry(ballRadius, 32, 32);
  const ballMat = new THREE.MeshStandardMaterial({
    color: 0x00f0ff,
    emissive: 0x003366,
    roughness: 0.15,
    metalness: 0.95
  });
  ballMesh = new THREE.Mesh(ballGeo, ballMat);
  ballMesh.castShadow = true;
  ballMesh.receiveShadow = true;
  mazeContainer.add(ballMesh); // Added directly to mazeContainer so it inherits visual rotations automatically

  // 2. Physics representation of the Ball (Dynamic sphere)
  const ballBodyDesc = RAPIER.RigidBodyDesc.dynamic()
    .setTranslation(startPos.x, startPos.y, startPos.z)
    .setLinearDamping(1.2)  // Increased from 0.25 for calmer movement
    .setAngularDamping(1.2) // Increased from 0.25 for calmer rotation
    .setCanSleep(false); // Make sure the ball is ALWAYS awake and rolls instantly on gravity shift!
  ballBody = physicsWorld.createRigidBody(ballBodyDesc);

  // Enable CCD to prevent tunneling through thin walls
  ballBody.enableCcd(true);

  // Configure ball physics materials
  const ballColliderDesc = RAPIER.ColliderDesc.ball(ballRadius)
    .setRestitution(0.15) // Reduced from 0.35 to prevent wild bouncing
    .setFriction(0.6);   // Increased from 0.35 for better grip and control
  physicsWorld.createCollider(ballColliderDesc, ballBody);

  // 3. Visual representation of the Finish Zone (Glowing hologram disk)
  const finishGeo = new THREE.CylinderGeometry(finishRadius, finishRadius, 0.05, 32);
  const finishMat = new THREE.MeshBasicMaterial({
    color: 0xff00ff,
    transparent: true,
    opacity: 0.6,
    wireframe: false
  });
  const finishMesh = new THREE.Mesh(finishGeo, finishMat);
  finishMesh.position.copy(finishPos);
  mazeContainer.add(finishMesh); 

  // Glowing pulse light at finish
  const finishLight = new THREE.PointLight(0xff00ff, 4, finishRadius * 8);
  finishLight.position.set(finishPos.x, finishPos.y + 0.4, finishPos.z);
  mazeContainer.add(finishLight); 

  // Ambient neon light at start
  const startLight = new THREE.PointLight(0x00f0ff, 2, ballRadius * 8);
  startLight.position.set(startPos.x, startPos.y + 0.4, startPos.z);
  mazeContainer.add(startLight); 

  debugLog(`Ball spawned at: x=${startPos.x.toFixed(2)}, y=${startPos.y.toFixed(2)}, z=${startPos.z.toFixed(2)}`);
  debugLog(`Finish spawned at: x=${finishPos.x.toFixed(2)}, y=${finishPos.y.toFixed(2)}, z=${finishPos.z.toFixed(2)}`);

  // Set load complete to resume visual rotation updates
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

  const dt = clock.getDelta();

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

      // 2. Physics world gravity slant in local coordinates
      // (Since ballMesh is a child of mazeContainer, Three.js automatically rotates the visual ball position,
      // so we apply physical gravity directly in local coordinates of the maze)
      const gravityStrength = 22.0; // Reduced from 40.0 to make ball movement calmer and more controllable
      physicsWorld.gravity = {
        x: currentRoll * gravityStrength,
        y: -35.0,
        z: currentPitch * gravityStrength
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

    // 4. Step Physics simulation (static maze + dynamic rolling ball)
    physicsWorld.step();

    // 5. Sync Ball graphics, in the coordinate space of mazeContainer
    const ballPos = ballBody.translation();
    const ballRot = ballBody.rotation();
    
    ballMesh.position.set(ballPos.x, ballPos.y, ballPos.z);
    ballMesh.quaternion.set(ballRot.x, ballRot.y, ballRot.z, ballRot.w);

    // 6. Update audio based on velocity
    const linVel = ballBody.linvel();
    const velVec = new THREE.Vector3(linVel.x, linVel.y, linVel.z);
    const speed = velVec.length();

    // Rolling sound
    sounds.updateRolling(speed);

    // Self-healing check
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

    // 8. Check Win conditions
    const distToFinish = new THREE.Vector3(ballPos.x, ballPos.y, ballPos.z).distanceTo(finishPos);
    if (distToFinish < (ballRadius + finishRadius * 0.8) && !hasWon) {
      triggerVictory();
    }
  }

  // Render Scene
  renderer.render(scene, camera);
}

function triggerVictory() {
  hasWon = true;
  debugLog('VICTORY ACHIEVED!');
  sounds.playVictory();
  victoryOverlay.classList.remove('hidden');
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
  // Switch maze levels with number keys 1-4
  if (e.key >= '1' && e.key <= '4') {
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
