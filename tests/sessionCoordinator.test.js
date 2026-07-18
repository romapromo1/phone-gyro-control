import test from 'node:test';
import assert from 'node:assert/strict';
import { EVENTS, SESSION_COMMANDS } from '../shared/protocol.js';
import { SessionCoordinator } from '../server/sessionCoordinator.js';

class FakeSocket {
  constructor(id, io) {
    this.id = id;
    this.io = io;
    this.data = {};
    this.rooms = new Set();
    this.received = [];
    this.disconnected = false;
    io.sockets.sockets.set(id, this);
  }

  join(room) { this.rooms.add(room); }
  emit(event, payload) { this.received.push({ event, payload }); }
  disconnect() {
    this.disconnected = true;
    this.io.sockets.sockets.delete(this.id);
  }
}

class FakeRoom {
  constructor(io, room) {
    this.io = io;
    this.room = room;
  }
  get volatile() { return this; }
  emit(event, payload) {
    for (const socket of this.io.sockets.sockets.values()) {
      if (socket.rooms.has(this.room)) socket.emit(event, payload);
    }
  }
}

class FakeIo {
  constructor() { this.sockets = { sockets: new Map() }; }
  to(room) { return new FakeRoom(this, room); }
}

function createFixture(options = {}) {
  let now = 10_000;
  const events = [];
  const io = new FakeIo();
  const coordinator = new SessionCoordinator(io, {
    now: () => now,
    record: (event, data) => events.push({ event, data }),
    tokenTtlMs: 60_000,
    disconnectGraceMs: options.disconnectGraceMs || 5_000,
    maxTelemetryPerSecond: 3,
  });
  const desktop = new FakeSocket('desktop', io);
  let registration;
  coordinator.registerDesktop(desktop, {
    stationId: 'main', instanceId: 'desktop-instance-00000001',
  }, (response) => { registration = response; });
  assert.equal(registration.ok, true);
  return { io, coordinator, desktop, events, advance: (ms) => { now += ms; } };
}

function claim(fixture, socketId = 'mobile', pairing = fixture.coordinator.getPairing('main')) {
  const socket = new FakeSocket(socketId, fixture.io);
  let response;
  fixture.coordinator.claimController(socket, {
    stationId: 'main',
    token: pairing.token,
  }, (value) => { response = value; });
  return { socket, response };
}

test('only the first phone can consume a pairing token', () => {
  const fixture = createFixture();
  const pairing = fixture.coordinator.getPairing('main');
  const first = claim(fixture, 'mobile-1', pairing);
  assert.equal(first.response.ok, true);

  const second = claim(fixture, 'mobile-2', pairing);
  assert.deepEqual(second.response, { ok: false, reason: 'session-busy' });
  assert.equal(fixture.coordinator.getHealthSnapshot().stations[0].controllerConnected, true);
});

test('valid telemetry is forwarded once while stale and excessive data is dropped', () => {
  const fixture = createFixture();
  const { socket } = claim(fixture);
  const payload = { beta: 0.25, gamma: -0.5, alpha: 10, sequence: 1, sentAt: 10_000 };
  fixture.coordinator.handleGyro(socket, payload);
  fixture.coordinator.handleGyro(socket, payload);
  fixture.coordinator.handleGyro(socket, { ...payload, sequence: 2 });
  fixture.coordinator.handleGyro(socket, { ...payload, sequence: 3 });
  fixture.coordinator.handleGyro(socket, { ...payload, sequence: 4 });

  const updates = fixture.desktop.received.filter(({ event }) => event === EVENTS.GYRO_UPDATE);
  assert.equal(updates.length, 2);
  assert.equal(fixture.coordinator.getHealthSnapshot().metrics.rateLimitedMessages, 2);
});

test('the same controller can resume during the grace period', () => {
  const fixture = createFixture();
  const first = claim(fixture);
  fixture.coordinator.handleDisconnect(first.socket);
  fixture.io.sockets.sockets.delete(first.socket.id);
  fixture.advance(1_000);

  const resumedSocket = new FakeSocket('mobile-resumed', fixture.io);
  let response;
  fixture.coordinator.claimController(resumedSocket, {
    stationId: 'main',
    sessionId: first.response.sessionId,
    controllerKey: first.response.controllerKey,
  }, (value) => { response = value; });

  assert.equal(response.ok, true);
  assert.equal(response.resumed, true);
  assert.equal(fixture.coordinator.getHealthSnapshot().stations[0].controllerConnected, true);
});

test('a desktop transport reconnect preserves the active game for the same browser instance', () => {
  const fixture = createFixture();
  const controller = claim(fixture);
  fixture.coordinator.handleSessionCommand(fixture.desktop, {
    stationId: 'main', action: SESSION_COMMANDS.PLAYING,
  });

  fixture.coordinator.handleDisconnect(fixture.desktop);
  fixture.io.sockets.sockets.delete(fixture.desktop.id);
  const reconnectedDesktop = new FakeSocket('desktop-reconnected', fixture.io);
  let registration;
  fixture.coordinator.registerDesktop(reconnectedDesktop, {
    stationId: 'main', instanceId: 'desktop-instance-00000001',
  }, (value) => { registration = value; });

  assert.equal(registration.ok, true);
  assert.equal(registration.state, 'playing');
  assert.equal(controller.socket.disconnected, false);
  assert.equal(fixture.coordinator.getHealthSnapshot().stations[0].controllerConnected, true);
});

test('a desktop page reload aborts the unrecoverable old physics session', () => {
  const fixture = createFixture();
  const controller = claim(fixture);
  fixture.coordinator.handleSessionCommand(fixture.desktop, {
    stationId: 'main', action: SESSION_COMMANDS.PLAYING,
  });

  const reloadedDesktop = new FakeSocket('desktop-reloaded', fixture.io);
  let registration;
  fixture.coordinator.registerDesktop(reloadedDesktop, {
    stationId: 'main', instanceId: 'desktop-instance-00000002',
  }, (value) => { registration = value; });

  assert.equal(registration.ok, true);
  assert.equal(registration.state, 'pairing');
  assert.equal(controller.socket.disconnected, true);
  assert.equal(fixture.coordinator.getHealthSnapshot().metrics.sessionsAborted, 1);
});

test('finishing a game revokes old resume credentials and records a PII-free result', () => {
  const fixture = createFixture();
  const first = claim(fixture);
  let started;
  fixture.coordinator.handleSessionCommand(fixture.desktop, {
    stationId: 'main', action: SESSION_COMMANDS.PLAYING,
  }, (value) => { started = value; });
  assert.equal(started.ok, true);

  let finished;
  fixture.coordinator.handleSessionCommand(fixture.desktop, {
    stationId: 'main',
    action: SESSION_COMMANDS.FINISH,
    result: { isWin: true, savesCollected: 4, elapsedMs: 42_000 },
  }, (value) => { finished = value; });
  assert.equal(finished.ok, true);

  const oldController = new FakeSocket('old-controller', fixture.io);
  let resume;
  fixture.coordinator.claimController(oldController, {
    stationId: 'main',
    sessionId: first.response.sessionId,
    controllerKey: first.response.controllerKey,
  }, (value) => { resume = value; });
  assert.equal(resume.ok, false);
  assert.equal(fixture.events.at(-1).event, 'game_finished');
  assert.equal(fixture.events.at(-1).data.savesCollected, 4);
});

test('a disconnected session expires and returns the station to pairing', async () => {
  const fixture = createFixture({ disconnectGraceMs: 10 });
  const first = claim(fixture);
  fixture.coordinator.handleDisconnect(first.socket);
  fixture.io.sockets.sockets.delete(first.socket.id);
  await new Promise((resolve) => setTimeout(resolve, 25));

  const health = fixture.coordinator.getHealthSnapshot();
  assert.equal(health.stations[0].state, 'pairing');
  assert.equal(health.metrics.sessionsAborted, 1);
  assert.equal(fixture.coordinator.getPairing('main').available, true);
});

test('250 sequential guests do not leak sessions or dormant controller sockets', () => {
  const fixture = createFixture();

  for (let guest = 0; guest < 250; guest += 1) {
    if (guest > 0) {
      let reset;
      fixture.coordinator.handleSessionCommand(fixture.desktop, {
        stationId: 'main', action: SESSION_COMMANDS.PAIR,
      }, (value) => { reset = value; });
      assert.equal(reset.ok, true);
    }

    const controller = claim(fixture, `mobile-${guest}`);
    assert.equal(controller.response.ok, true);

    let started;
    fixture.coordinator.handleSessionCommand(fixture.desktop, {
      stationId: 'main', action: SESSION_COMMANDS.PLAYING,
    }, (value) => { started = value; });
    assert.equal(started.ok, true);

    let finished;
    fixture.coordinator.handleSessionCommand(fixture.desktop, {
      stationId: 'main',
      action: SESSION_COMMANDS.FINISH,
      result: { isWin: guest % 2 === 0, savesCollected: guest % 5, elapsedMs: 45_000 },
    }, (value) => { finished = value; });
    assert.equal(finished.ok, true);
    assert.equal(controller.socket.disconnected, true);
  }

  const health = fixture.coordinator.getHealthSnapshot();
  assert.equal(health.metrics.controllersClaimed, 250);
  assert.equal(health.metrics.sessionsStarted, 250);
  assert.equal(health.metrics.sessionsCompleted, 250);
  assert.equal(health.stations.length, 1);
  assert.equal(health.stations[0].controllerConnected, false);
  assert.equal(fixture.io.sockets.sockets.size, 1);
});
