import crypto from 'crypto';
import {
  EVENTS,
  SESSION_COMMANDS,
  SESSION_STATES,
  normalizeControllerClaim,
  normalizeDesktopRegistration,
  normalizeGyroPayload,
  normalizeSessionCommand,
  normalizeStationId,
} from '../shared/protocol.js';

const noop = () => {};

export class SessionCoordinator {
  constructor(io, options = {}) {
    this.io = io;
    this.now = options.now || Date.now;
    this.record = options.record || noop;
    this.tokenTtlMs = options.tokenTtlMs || 90_000;
    this.disconnectGraceMs = options.disconnectGraceMs || 5_000;
    this.maxTelemetryPerSecond = options.maxTelemetryPerSecond || 45;
    this.stations = new Map();
    this.metrics = {
      controllersClaimed: 0,
      sessionsStarted: 0,
      sessionsCompleted: 0,
      sessionsAborted: 0,
      invalidMessages: 0,
      rateLimitedMessages: 0,
    };
  }

  getPairing(stationIdValue) {
    const station = this.getStation(stationIdValue);
    if (station.activeControllerSocketId || station.state !== SESSION_STATES.PAIRING) {
      return { available: false, state: station.state, stationId: station.stationId };
    }
    if (!station.pairingToken || station.tokenExpiresAt <= this.now()) {
      this.issuePairingToken(station);
    }
    return {
      available: true,
      stationId: station.stationId,
      token: station.pairingToken,
      expiresAt: station.tokenExpiresAt,
      state: station.state,
    };
  }

  registerDesktop(socket, rawPayload, ack = noop) {
    const payload = normalizeDesktopRegistration(rawPayload);
    if (!payload) return this.rejectInvalid(ack, 'invalid-desktop-registration');
    const station = this.getStation(payload.stationId);
    const isSameBrowserInstance = Boolean(
      payload.instanceId && station.desktopInstanceId === payload.instanceId
    );

    if (station.desktopSocketId && station.desktopSocketId !== socket.id) {
      const previous = this.io.sockets.sockets.get(station.desktopSocketId);
      previous?.emit(EVENTS.SESSION_ENDED, { reason: 'desktop-replaced' });
      previous?.disconnect(true);
    }

    station.desktopSocketId = socket.id;
    station.desktopInstanceId = payload.instanceId;
    socket.data.clientType = 'desktop';
    socket.data.stationId = station.stationId;
    socket.join(this.desktopRoom(station.stationId));

    if (station.sessionId && !isSameBrowserInstance) {
      this.metrics.sessionsAborted += 1;
      this.record('session_aborted', {
        stationId: station.stationId,
        sessionId: station.sessionId,
        reason: 'desktop-reloaded',
      });
      this.resetToPairing(station, 'desktop-reloaded');
    } else if (!station.sessionId && station.state !== SESSION_STATES.PAIRING) {
      this.resetToPairing(station, 'desktop-registered');
    }

    socket.emit(EVENTS.CONTROLLER_STATUS, this.controllerStatus(station));
    socket.emit(EVENTS.SESSION_STATE, this.publicState(station));
    if (station.activeControllerSocketId) {
      this.emitController(station, EVENTS.SESSION_STATE, {
        ...this.publicState(station),
        stationOnline: true,
      });
    }
    ack({ ok: true, stationId: station.stationId, state: station.state });
  }

  claimController(socket, rawPayload, ack = noop) {
    const payload = normalizeControllerClaim(rawPayload);
    if (!payload) return this.rejectInvalid(ack, 'invalid-controller-claim');
    const station = this.getStation(payload.stationId);

    if (!this.isDesktopOnline(station)) {
      return ack({ ok: false, reason: 'station-offline' });
    }

    const isResume = Boolean(
      payload.sessionId &&
      payload.controllerKey &&
      payload.sessionId === station.sessionId &&
      payload.controllerKey === station.controllerKey &&
      !station.activeControllerSocketId &&
      station.disconnectedAt &&
      this.now() - station.disconnectedAt <= this.disconnectGraceMs
    );

    if (isResume) {
      this.cancelDisconnectTimer(station);
      station.activeControllerSocketId = socket.id;
      station.disconnectedAt = 0;
      station.state = station.pausedFrom || SESSION_STATES.CALIBRATING;
      station.pausedFrom = null;
      this.bindControllerSocket(socket, station);
      this.emitDesktop(station, EVENTS.CONTROLLER_STATUS, this.controllerStatus(station, true));
      this.emitDesktop(station, EVENTS.SESSION_STATE, this.publicState(station));
      this.record('controller_resumed', { stationId: station.stationId, sessionId: station.sessionId });
      return ack({
        ok: true,
        resumed: true,
        stationId: station.stationId,
        sessionId: station.sessionId,
        controllerKey: station.controllerKey,
        state: station.state,
      });
    }

    if (station.activeControllerSocketId || station.sessionId) {
      return ack({ ok: false, reason: 'session-busy' });
    }
    if (
      station.state !== SESSION_STATES.PAIRING ||
      !payload.token ||
      payload.token !== station.pairingToken ||
      station.tokenExpiresAt <= this.now()
    ) {
      return ack({ ok: false, reason: 'token-expired-or-used' });
    }

    station.sessionId = this.randomToken(18);
    station.controllerKey = this.randomToken(24);
    station.activeControllerSocketId = socket.id;
    station.pairingToken = null;
    station.tokenExpiresAt = 0;
    station.state = SESSION_STATES.CALIBRATING;
    station.lastTelemetryAt = 0;
    station.lastSequence = -1;
    station.disconnectedAt = 0;
    this.bindControllerSocket(socket, station);

    this.metrics.controllersClaimed += 1;
    this.record('controller_claimed', { stationId: station.stationId, sessionId: station.sessionId });
    this.emitDesktop(station, EVENTS.CONTROLLER_STATUS, this.controllerStatus(station));
    this.emitDesktop(station, EVENTS.SESSION_STATE, this.publicState(station));

    ack({
      ok: true,
      resumed: false,
      stationId: station.stationId,
      sessionId: station.sessionId,
      controllerKey: station.controllerKey,
      state: station.state,
    });
  }

  handleGyro(socket, rawPayload) {
    const station = this.stationForController(socket);
    if (!station || station.activeControllerSocketId !== socket.id) return;
    if (!this.consumeTelemetryBudget(socket)) {
      this.metrics.rateLimitedMessages += 1;
      return;
    }
    const payload = normalizeGyroPayload(rawPayload);
    if (!payload || payload.sequence <= station.lastSequence) {
      this.metrics.invalidMessages += 1;
      return;
    }

    station.lastSequence = payload.sequence;
    station.lastTelemetryAt = this.now();
    this.io.to(this.desktopRoom(station.stationId)).volatile.emit(EVENTS.GYRO_UPDATE, {
      ...payload,
      sessionId: station.sessionId,
    });
  }

  handleCalibrate(socket) {
    const stationId = normalizeStationId(socket.data.stationId);
    const station = this.stations.get(stationId);
    if (!station) return;

    if (socket.data.clientType === 'desktop' && station.desktopSocketId === socket.id) {
      const controller = this.io.sockets.sockets.get(station.activeControllerSocketId);
      controller?.emit(EVENTS.CALIBRATE_REQUEST);
    } else if (socket.data.clientType === 'mobile' && station.activeControllerSocketId === socket.id) {
      this.emitDesktop(station, EVENTS.CALIBRATE_REQUEST);
    }
  }

  handleSessionCommand(socket, rawPayload, ack = noop) {
    const payload = normalizeSessionCommand(rawPayload);
    if (!payload) return this.rejectInvalid(ack, 'invalid-session-command');
    const station = this.stations.get(payload.stationId);
    if (!station || socket.data.clientType !== 'desktop' || station.desktopSocketId !== socket.id) {
      return ack({ ok: false, reason: 'not-station-desktop' });
    }

    if (payload.action === SESSION_COMMANDS.PAIR) {
      this.resetToPairing(station, 'desktop-reset');
      return ack({ ok: true, ...this.getPairing(station.stationId) });
    }

    if (payload.action === SESSION_COMMANDS.PLAYING) {
      if (!station.sessionId || !station.activeControllerSocketId) {
        return ack({ ok: false, reason: 'controller-not-connected' });
      }
      station.state = SESSION_STATES.PLAYING;
      this.metrics.sessionsStarted += 1;
      this.record('game_started', { stationId: station.stationId, sessionId: station.sessionId });
      this.emitController(station, EVENTS.SESSION_STATE, this.publicState(station));
      this.emitDesktop(station, EVENTS.SESSION_STATE, this.publicState(station));
      return ack({ ok: true, state: station.state });
    }

    if (payload.action === SESSION_COMMANDS.FINISH) {
      if (!station.sessionId) return ack({ ok: false, reason: 'no-active-session' });
      const finishedSessionId = station.sessionId;
      station.state = SESSION_STATES.RESULT;
      this.metrics.sessionsCompleted += 1;
      this.record('game_finished', {
        stationId: station.stationId,
        sessionId: finishedSessionId,
        ...(payload.result || {}),
      });
      this.emitController(station, EVENTS.SESSION_ENDED, {
        reason: 'game-finished',
        result: payload.result,
      });
      this.releaseController(station);
      this.emitDesktop(station, EVENTS.CONTROLLER_STATUS, this.controllerStatus(station));
      this.emitDesktop(station, EVENTS.SESSION_STATE, this.publicState(station));
      return ack({ ok: true, state: station.state });
    }
  }

  handleDisconnect(socket) {
    const stationId = socket.data.stationId;
    if (!stationId) return;
    const station = this.stations.get(stationId);
    if (!station) return;

    if (socket.data.clientType === 'desktop' && station.desktopSocketId === socket.id) {
      station.desktopSocketId = null;
      this.emitController(station, EVENTS.SESSION_STATE, { ...this.publicState(station), stationOnline: false });
      return;
    }

    if (socket.data.clientType !== 'mobile' || station.activeControllerSocketId !== socket.id) return;
    station.activeControllerSocketId = null;
    station.disconnectedAt = this.now();
    station.pausedFrom = station.state;
    station.state = SESSION_STATES.PAUSED;
    this.emitDesktop(station, EVENTS.CONTROLLER_STATUS, this.controllerStatus(station, true));
    this.emitDesktop(station, EVENTS.SESSION_STATE, this.publicState(station));
    this.record('controller_disconnected', { stationId: station.stationId, sessionId: station.sessionId });

    const expectedSessionId = station.sessionId;
    station.disconnectTimer = setTimeout(() => {
      if (station.sessionId !== expectedSessionId || station.activeControllerSocketId) return;
      this.metrics.sessionsAborted += 1;
      this.record('session_aborted', {
        stationId: station.stationId,
        sessionId: expectedSessionId,
        reason: 'disconnect-timeout',
      });
      this.emitDesktop(station, EVENTS.SESSION_ENDED, { reason: 'disconnect-timeout' });
      this.resetToPairing(station, 'disconnect-timeout');
    }, this.disconnectGraceMs);
    station.disconnectTimer.unref?.();
  }

  getHealthSnapshot() {
    const now = this.now();
    return {
      status: 'ok',
      uptimeSeconds: Math.round(process.uptime()),
      metrics: { ...this.metrics },
      stations: [...this.stations.values()].map((station) => ({
        stationId: station.stationId,
        state: station.state,
        desktopConnected: this.isDesktopOnline(station),
        controllerConnected: Boolean(station.activeControllerSocketId),
        telemetryAgeMs: station.lastTelemetryAt ? now - station.lastTelemetryAt : null,
      })),
    };
  }

  forcePairing(stationIdValue, reason = 'operator-reset') {
    const station = this.getStation(stationIdValue);
    this.resetToPairing(station, reason);
    return this.getPairing(station.stationId);
  }

  forceCalibrate(stationIdValue) {
    const station = this.getStation(stationIdValue);
    this.emitDesktop(station, EVENTS.CALIBRATE_REQUEST);
    this.emitController(station, EVENTS.CALIBRATE_REQUEST);
    this.record('operator_calibrate', { stationId: station.stationId });
    return { ok: true, stationId: station.stationId };
  }

  shutdown(reason = 'server-restarting') {
    for (const station of this.stations.values()) {
      this.cancelDisconnectTimer(station);
      if (!station.sessionId) continue;
      this.emitController(station, EVENTS.SESSION_ENDED, { reason });
      this.emitDesktop(station, EVENTS.SESSION_ENDED, { reason });
      this.record('session_interrupted', {
        stationId: station.stationId,
        sessionId: station.sessionId,
        reason,
      });
    }
  }

  getStation(stationIdValue) {
    const stationId = normalizeStationId(stationIdValue);
    if (!this.stations.has(stationId)) {
      const station = {
        stationId,
        desktopSocketId: null,
        desktopInstanceId: null,
        activeControllerSocketId: null,
        sessionId: null,
        controllerKey: null,
        pairingToken: null,
        tokenExpiresAt: 0,
        state: SESSION_STATES.PAIRING,
        pausedFrom: null,
        disconnectedAt: 0,
        disconnectTimer: null,
        lastTelemetryAt: 0,
        lastSequence: -1,
      };
      this.issuePairingToken(station);
      this.stations.set(stationId, station);
    }
    return this.stations.get(stationId);
  }

  resetToPairing(station, reason) {
    this.cancelDisconnectTimer(station);
    if (station.activeControllerSocketId) {
      this.emitController(station, EVENTS.SESSION_ENDED, { reason });
    }
    this.releaseController(station);
    station.state = SESSION_STATES.PAIRING;
    station.pausedFrom = null;
    station.disconnectedAt = 0;
    station.lastTelemetryAt = 0;
    station.lastSequence = -1;
    this.issuePairingToken(station);
    this.emitDesktop(station, EVENTS.CONTROLLER_STATUS, this.controllerStatus(station));
    this.emitDesktop(station, EVENTS.SESSION_STATE, this.publicState(station));
    this.record('pairing_opened', { stationId: station.stationId, reason });
  }

  issuePairingToken(station) {
    station.pairingToken = this.randomToken(24);
    station.tokenExpiresAt = this.now() + this.tokenTtlMs;
  }

  bindControllerSocket(socket, station) {
    socket.data.clientType = 'mobile';
    socket.data.stationId = station.stationId;
    socket.data.sessionId = station.sessionId;
    socket.data.telemetryWindowStart = this.now();
    socket.data.telemetryCount = 0;
    socket.join(this.controllerRoom(station.stationId));
  }

  releaseController(station) {
    const releasedSocket = this.io.sockets.sockets.get(station.activeControllerSocketId);
    station.activeControllerSocketId = null;
    station.sessionId = null;
    station.controllerKey = null;
    station.disconnectedAt = 0;
    station.pausedFrom = null;
    this.cancelDisconnectTimer(station);
    releasedSocket?.disconnect(true);
  }

  consumeTelemetryBudget(socket) {
    const now = this.now();
    if (now - socket.data.telemetryWindowStart >= 1000) {
      socket.data.telemetryWindowStart = now;
      socket.data.telemetryCount = 0;
    }
    socket.data.telemetryCount += 1;
    return socket.data.telemetryCount <= this.maxTelemetryPerSecond;
  }

  stationForController(socket) {
    if (socket.data.clientType !== 'mobile' || !socket.data.stationId) return null;
    return this.stations.get(socket.data.stationId) || null;
  }

  isDesktopOnline(station) {
    return Boolean(station.desktopSocketId && this.io.sockets.sockets.get(station.desktopSocketId));
  }

  controllerStatus(station, recoverable = false) {
    return {
      connected: Boolean(station.activeControllerSocketId),
      recoverable,
      stationId: station.stationId,
      sessionId: station.sessionId,
      state: station.state,
    };
  }

  publicState(station) {
    return {
      stationId: station.stationId,
      sessionId: station.sessionId,
      state: station.state,
    };
  }

  emitDesktop(station, event, payload) {
    this.io.to(this.desktopRoom(station.stationId)).emit(event, payload);
  }

  emitController(station, event, payload) {
    const controller = this.io.sockets.sockets.get(station.activeControllerSocketId);
    controller?.emit(event, payload);
  }

  desktopRoom(stationId) {
    return `station:${stationId}:desktop`;
  }

  controllerRoom(stationId) {
    return `station:${stationId}:controller`;
  }

  cancelDisconnectTimer(station) {
    if (station.disconnectTimer) clearTimeout(station.disconnectTimer);
    station.disconnectTimer = null;
  }

  rejectInvalid(ack, reason) {
    this.metrics.invalidMessages += 1;
    ack({ ok: false, reason });
  }

  randomToken(bytes) {
    return crypto.randomBytes(bytes).toString('base64url');
  }
}
