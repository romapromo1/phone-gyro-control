import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeControllerClaim,
  normalizeGyroPayload,
  normalizeStationId,
} from '../shared/protocol.js';

test('normalizes station identifiers without accepting arbitrary room names', () => {
  assert.equal(normalizeStationId('holobox_2'), 'holobox_2');
  assert.equal(normalizeStationId('../desktop'), 'main');
  assert.equal(normalizeStationId('x'.repeat(64)), 'main');
});

test('gyro payload is finite, ordered and clamped', () => {
  assert.deepEqual(
    normalizeGyroPayload({ beta: 2, gamma: -3, alpha: 360, sequence: 7, sentAt: 100 }),
    { beta: 1, gamma: -1, alpha: 180, sequence: 7, sentAt: 100 },
  );
  assert.equal(normalizeGyroPayload({ beta: '0.5', gamma: 0, alpha: 0, sequence: 1, sentAt: 1 }), null);
  assert.equal(normalizeGyroPayload({ beta: Number.NaN, gamma: 0, alpha: 0, sequence: 1, sentAt: 1 }), null);
  assert.equal(normalizeGyroPayload({ beta: 0, gamma: 0, alpha: 0, sequence: -1, sentAt: 1 }), null);
});

test('controller claims require an opaque token or complete resume credentials', () => {
  const token = 'a'.repeat(32);
  assert.deepEqual(normalizeControllerClaim({ stationId: 'main', token }), {
    stationId: 'main', token, sessionId: null, controllerKey: null,
  });
  assert.equal(normalizeControllerClaim({ stationId: 'main', token: 'short' }), null);
  assert.equal(normalizeControllerClaim({ stationId: 'main', sessionId: token }), null);
});
