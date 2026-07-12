import { io } from 'socket.io-client';

// Connect to the Socket.io server
const socket = io();

// UI Elements
const permissionScreen = document.getElementById('permission-screen') as HTMLElement;
const dashboardScreen = document.getElementById('dashboard-screen') as HTMLElement;
const btnRequestPermission = document.getElementById('btn-request-permission') as HTMLButtonElement;
const btnCalibrateMobile = document.getElementById('btn-calibrate-mobile') as HTMLButtonElement;

const valPitch = document.getElementById('val-pitch') as HTMLElement;
const valRoll = document.getElementById('val-roll') as HTMLElement;
const levelBubble = document.getElementById('level-bubble') as HTMLElement;

// D-pad Elements
const btnDpadUp = document.getElementById('btn-dpad-up') as HTMLButtonElement;
const btnDpadDown = document.getElementById('btn-dpad-down') as HTMLButtonElement;
const btnDpadLeft = document.getElementById('btn-dpad-left') as HTMLButtonElement;
const btnDpadRight = document.getElementById('btn-dpad-right') as HTMLButtonElement;

// Calibration & Sensor variables
let offsetBeta = 0;
let offsetGamma = 0;
let offsetAlpha = 0;
let isCalibrated = false;

let sensorBeta = 0;
let sensorGamma = 0;
let sensorAlpha = 0;
let hasSensor = false;
let trackingStarted = false;

// D-pad Active States
const activeDirections = { up: false, down: false, left: false, right: false };
let manualBeta = 0;
let manualGamma = 0;

// Socket connection initialization
socket.on('connect', () => {
  console.log('Connected to server. Waiting for controller activation...');
  if (trackingStarted) socket.emit('register', 'mobile');
});

socket.on('calibrate-request', () => {
  console.log('Calibration request received from desktop.');
  isCalibrated = false;
});

// Request DeviceOrientation permission and start listening
btnRequestPermission.addEventListener('click', async () => {
  try {
    if (typeof DeviceOrientationEvent !== 'undefined') {
      const deviceOrientationEvent = DeviceOrientationEvent as any;
      if (typeof deviceOrientationEvent.requestPermission === 'function') {
        const permissionState = await deviceOrientationEvent.requestPermission();
        if (permissionState === 'granted') {
          startOrientationTracking();
        } else {
          alert('Доступ к гироскопу отклонен. Мы не сможем управлять лабиринтом.');
        }
      } else {
        // Standard Android/Chrome
        startOrientationTracking();
      }
    } else {
      alert('Датчики движения не обнаружены. Используйте экранные стрелки для управления.');
      startOrientationTracking();
    }
  } catch (error) {
    console.error('Error requesting orientation permission:', error);
    startOrientationTracking();
  }
});

// Bind calibration button
btnCalibrateMobile.addEventListener('click', () => {
  calibrate();
});

function calibrate() {
  isCalibrated = false; 
  socket.emit('calibrate');
}

// Helper to bind touch/mouse hold state to a D-pad button
function bindDpad(btn: HTMLElement, direction: keyof typeof activeDirections) {
  const start = (e: Event) => {
    activeDirections[direction] = true;
    e.preventDefault();
  };
  const end = (e: Event) => {
    activeDirections[direction] = false;
    e.preventDefault();
  };
  
  btn.addEventListener('touchstart', start, { passive: false });
  btn.addEventListener('touchend', end, { passive: false });
  btn.addEventListener('mousedown', start);
  btn.addEventListener('mouseup', end);
  btn.addEventListener('mouseleave', end);
}

// Bind D-pad buttons
if (btnDpadUp && btnDpadDown && btnDpadLeft && btnDpadRight) {
  bindDpad(btnDpadUp, 'up');
  bindDpad(btnDpadDown, 'down');
  bindDpad(btnDpadLeft, 'left');
  bindDpad(btnDpadRight, 'right');
}

// Screen Wake Lock API to prevent mobile screen sleep
let wakeLock: any = null;

async function requestWakeLock() {
  try {
    if ('wakeLock' in navigator) {
      wakeLock = await (navigator as any).wakeLock.request('screen');
      console.log('Screen Wake Lock acquired successfully.');
      wakeLock.addEventListener('release', () => {
        console.log('Screen Wake Lock was released.');
      });
    }
  } catch (err) {
    console.warn('Failed to acquire Screen Wake Lock:', err);
  }
}

// Re-acquire Wake Lock when tab becomes active again
document.addEventListener('visibilitychange', async () => {
  if (wakeLock !== null && document.visibilityState === 'visible') {
    await requestWakeLock();
  }
});

function startOrientationTracking() {
  if (trackingStarted) return;
  trackingStarted = true;
  socket.emit('register', 'mobile');

  permissionScreen.classList.add('hidden');
  dashboardScreen.classList.remove('hidden');

  // Trigger wake lock to keep screen active
  requestWakeLock();

  // Listen to orientation changes
  window.addEventListener('deviceorientation', handleOrientation);

  // 30 Hz remains responsive after desktop smoothing and avoids websocket
  // backpressure on a busy event Wi-Fi network.
  setInterval(updateTelemetry, 33);
}

function handleOrientation(event: DeviceOrientationEvent) {
  const beta = event.beta;
  const gamma = event.gamma;
  const alpha = event.alpha;

  if (beta === null || gamma === null) return;

  // DeviceOrientation axes rotate together with the screen. Normalize them so
  // portrait and both landscape orientations control the same maze axes.
  const orientationAngle = screen.orientation?.angle ?? (window as any).orientation ?? 0;
  const normalizedAngle = ((orientationAngle % 360) + 360) % 360;

  hasSensor = true;
  if (alpha !== null) {
    sensorAlpha = alpha;
  }

  if (normalizedAngle === 90) {
    sensorBeta = -gamma;
    sensorGamma = beta;
  } else if (normalizedAngle === 270) {
    sensorBeta = gamma;
    sensorGamma = -beta;
  } else if (normalizedAngle === 180) {
    sensorBeta = -beta;
    sensorGamma = -gamma;
  } else {
    sensorBeta = beta;
    sensorGamma = gamma;
  }
}

// Update telemetry calculations and emit to socket at 60Hz
function updateTelemetry() {
  const dpadStep = 2.2; // degrees to tilt per 16ms frame while holding
  const centerReturnSpeed = 2.8; // degrees to center per frame on release

  // 1. Smoothly update manual offsets from D-pad
  if (activeDirections.up) {
    manualBeta = Math.min(30, manualBeta + dpadStep);
  } else if (activeDirections.down) {
    manualBeta = Math.max(-30, manualBeta - dpadStep);
  } else {
    // Return to flat 0
    if (manualBeta > 0) manualBeta = Math.max(0, manualBeta - centerReturnSpeed);
    if (manualBeta < 0) manualBeta = Math.min(0, manualBeta + centerReturnSpeed);
  }

  if (activeDirections.right) {
    manualGamma = Math.min(30, manualGamma + dpadStep);
  } else if (activeDirections.left) {
    manualGamma = Math.max(-30, manualGamma - dpadStep);
  } else {
    // Return to flat 0
    if (manualGamma > 0) manualGamma = Math.max(0, manualGamma - centerReturnSpeed);
    if (manualGamma < 0) manualGamma = Math.min(0, manualGamma + centerReturnSpeed);
  }

  // 2. Compute base relative angles from sensor
  let relBeta = 0;
  let relGamma = 0;
  let relAlpha = 0;

  if (hasSensor) {
    if (!isCalibrated) {
      offsetBeta = sensorBeta;
      offsetGamma = sensorGamma;
      offsetAlpha = sensorAlpha;
      isCalibrated = true;
      console.log(`Calibrated! Offsets - Beta: ${offsetBeta.toFixed(1)}, Gamma: ${offsetGamma.toFixed(1)}, Alpha: ${offsetAlpha.toFixed(1)}`);
    }

    let rawRelBeta = sensorBeta - offsetBeta;
    let rawRelGamma = sensorGamma - offsetGamma;
    relAlpha = sensorAlpha - offsetAlpha;

    // Handle wrap-arounds
    if (rawRelBeta > 180) rawRelBeta -= 360;
    if (rawRelBeta < -180) rawRelBeta += 360;
    if (rawRelGamma > 90) rawRelGamma -= 180;
    if (rawRelGamma < -90) rawRelGamma += 180;
    if (relAlpha > 180) relAlpha -= 360;
    if (relAlpha < -180) relAlpha += 360;

    // Rotate phone-local relative tilts by -relAlpha to align with screen space calibration
    const radAlpha = -relAlpha * Math.PI / 180;
    const cosA = Math.cos(radAlpha);
    const sinA = Math.sin(radAlpha);
    relGamma = rawRelGamma * cosA - rawRelBeta * sinA;
    relBeta = rawRelGamma * sinA + rawRelBeta * cosA;
  }

  // 3. Combine sensor input with manual D-pad controls
  const totalBeta = relBeta + manualBeta;
  const totalGamma = relGamma + manualGamma;

  // Clamp final values (max 35 degrees)
  const maxTilt = 35;
  const clampedBeta = Math.max(-maxTilt, Math.min(maxTilt, totalBeta));
  const clampedGamma = Math.max(-maxTilt, Math.min(maxTilt, totalGamma));

  // Update UI values
  valPitch.textContent = `${clampedBeta.toFixed(1)}°`;
  valRoll.textContent = `${clampedGamma.toFixed(1)}°`;

  // Update visual bubble level
  const maxDisplacement = 78;
  let x = (clampedGamma / maxTilt) * maxDisplacement;
  let y = (clampedBeta / maxTilt) * maxDisplacement;

  // Keep bubble inside circular bounds
  const distance = Math.sqrt(x * x + y * y);
  if (distance > maxDisplacement) {
    x = (x / distance) * maxDisplacement;
    y = (y / distance) * maxDisplacement;
  }

  levelBubble.style.transform = `translate(${x}px, ${y}px)`;

  // Send data to Holobox via Socket.io (normalized between -1.0 and 1.0)
  socket.volatile.emit('gyro-data', {
    beta: clampedBeta / maxTilt,   // Pitch (-1.0 to 1.0)
    gamma: clampedGamma / maxTilt, // Roll (-1.0 to 1.0)
    alpha: relAlpha,               // Yaw in degrees (-180 to 180)
    rawPitch: clampedBeta,
    rawRoll: clampedGamma
  });
}
