import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { io as createClient } from 'socket.io-client';
import { loadLocalEnvironment, startServer } from '../server.js';
import { EVENTS } from '../shared/protocol.js';

test('local .env loading preserves explicit process environment values', async (t) => {
  const temporaryDirectory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'gyro-env-test-'));
  const envPath = path.join(temporaryDirectory, '.env');
  const loadedName = 'GYRO_TEST_ENV_LOADED';
  const preservedName = 'GYRO_TEST_ENV_PRESERVED';
  const previousLoaded = process.env[loadedName];
  const previousPreserved = process.env[preservedName];
  const previousRender = process.env.RENDER;

  t.after(async () => {
    restoreEnvironmentValue(loadedName, previousLoaded);
    restoreEnvironmentValue(preservedName, previousPreserved);
    restoreEnvironmentValue('RENDER', previousRender);
    await fs.promises.rm(temporaryDirectory, { recursive: true, force: true });
  });

  delete process.env.RENDER;
  delete process.env[loadedName];
  process.env[preservedName] = 'from-process';
  await fs.promises.writeFile(
    envPath,
    `${loadedName}=from-file\n${preservedName}=from-file\n`,
    'utf8',
  );

  assert.equal(loadLocalEnvironment(envPath), true);
  assert.equal(process.env[loadedName], 'from-file');
  assert.equal(process.env[preservedName], 'from-process');
});

test('production HTTP routes and WebSocket pairing work together', async (t) => {
  const dataDirectory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'gyro-server-test-'));
  const operatorToken = 'operator-test-token-1234567890';
  const kioskToken = 'kiosk-test-token-123456789012';
  const runtime = await startServer({
    isProd: true,
    port: 0,
    serveStatic: false,
    operatorToken,
    kioskToken,
    openRouterApiKey: '',
    publicUrl: 'https://gyro-test.onrender.com',
    eventDataDirectory: dataDirectory,
  });
  const clients = [];
  const baseUrl = `http://127.0.0.1:${runtime.port}`;

  t.after(async () => {
    for (const client of clients) client.disconnect();
    await runtime.close('integration-test-complete');
    await fs.promises.rm(dataDirectory, { recursive: true, force: true });
  });

  const healthResponse = await fetch(`${baseUrl}/health`);
  assert.equal(healthResponse.status, 200);
  assert.equal(healthResponse.headers.get('cache-control'), 'no-store');
  assert.match(healthResponse.headers.get('permissions-policy') || '', /camera=\(self\)/);
  assert.match(healthResponse.headers.get('permissions-policy') || '', /accelerometer=\(self\)/);
  assert.match(healthResponse.headers.get('permissions-policy') || '', /gyroscope=\(self\)/);
  assert.equal((await healthResponse.json()).status, 'ok');

  const unauthorized = await fetch(`${baseUrl}/api/operator/status`);
  assert.equal(unauthorized.status, 401);
  const authorized = await fetch(`${baseUrl}/api/operator/status`, {
    headers: { Authorization: `Bearer ${operatorToken}` },
  });
  assert.equal(authorized.status, 200);
  assert.equal((await authorized.json()).imageGenerationConfigured, false);

  const generationUnavailable = await fetch(`${baseUrl}/api/generate-image`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${kioskToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ promptText: 'test', base64Image: 'dGVzdA==' }),
  });
  assert.equal(generationUnavailable.status, 503);

  const unauthorizedDesktop = createSocket(baseUrl);
  clients.push(unauthorizedDesktop);
  await waitForConnect(unauthorizedDesktop);
  const rejectedRegistration = await emitWithAck(unauthorizedDesktop, EVENTS.REGISTER_DESKTOP, {
    stationId: 'main', kioskToken: 'wrong-kiosk-token-123456789', instanceId: 'hostile-desktop-000001',
  });
  assert.deepEqual(rejectedRegistration, { ok: false, reason: 'kiosk-unauthorized' });

  const desktop = createSocket(baseUrl);
  clients.push(desktop);
  await waitForConnect(desktop);
  const registration = await emitWithAck(desktop, EVENTS.REGISTER_DESKTOP, {
    stationId: 'main', kioskToken, instanceId: 'desktop-integration-000001',
  });
  assert.equal(registration.ok, true);

  const publicPairingResponse = await fetch(`${baseUrl}/api/server-info?station=main`);
  assert.equal(publicPairingResponse.status, 401);
  const pairingResponse = await fetch(`${baseUrl}/api/server-info?station=main`, {
    headers: { Authorization: `Bearer ${kioskToken}` },
  });
  assert.equal(pairingResponse.status, 200);
  const pairing = await pairingResponse.json();
  const controllerUrl = new URL(pairing.mobileUrl);
  assert.equal(controllerUrl.origin, 'https://gyro-test.onrender.com');
  assert.equal(controllerUrl.searchParams.get('station'), 'main');
  assert.ok(controllerUrl.searchParams.get('token'));

  // A controller must still connect when an embedded QR browser or venue
  // network cannot upgrade from HTTP long-polling to WebSocket.
  const mobile = createSocket(baseUrl, ['polling', 'websocket']);
  clients.push(mobile);
  await waitForConnect(mobile);
  await waitForTransport(mobile, 'websocket');
  const claim = await emitWithAck(mobile, EVENTS.CLAIM_CONTROLLER, {
    stationId: 'main',
    token: controllerUrl.searchParams.get('token'),
  });
  assert.equal(claim.ok, true);

  const secondMobile = createSocket(baseUrl);
  clients.push(secondMobile);
  await waitForConnect(secondMobile);
  const rejectedClaim = await emitWithAck(secondMobile, EVENTS.CLAIM_CONTROLLER, {
    stationId: 'main',
    token: controllerUrl.searchParams.get('token'),
  });
  assert.deepEqual(rejectedClaim, { ok: false, reason: 'session-busy' });

  const reset = await fetch(`${baseUrl}/api/operator/stations/main/reset`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${operatorToken}` },
  });
  assert.equal(reset.status, 200);
  assert.equal((await reset.json()).available, true);
});

test('production QR uses the trusted incoming HTTPS origin instead of a container LAN address', async (t) => {
  const dataDirectory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'gyro-proxy-origin-'));
  const kioskToken = 'kiosk-proxy-test-token-123456789';
  const runtime = await startServer({
    isProd: true,
    port: 0,
    serveStatic: false,
    trustProxy: true,
    kioskToken,
    publicUrl: null,
    eventDataDirectory: dataDirectory,
  });
  const baseUrl = `http://127.0.0.1:${runtime.port}`;

  t.after(async () => {
    await runtime.close('proxy-origin-test-complete');
    await fs.promises.rm(dataDirectory, { recursive: true, force: true });
  });

  const insecureOrigin = await fetch(`${baseUrl}/api/server-info?station=main`, {
    headers: {
      Authorization: `Bearer ${kioskToken}`,
      'X-Forwarded-Proto': 'http',
      'X-Forwarded-Host': 'gyro.example.test',
    },
  });
  assert.equal(insecureOrigin.status, 503);
  assert.deepEqual(await insecureOrigin.json(), { error: 'mobile-origin-unavailable' });

  const response = await fetch(`${baseUrl}/api/server-info?station=main`, {
    headers: {
      Authorization: `Bearer ${kioskToken}`,
      'X-Forwarded-Proto': 'https',
      'X-Forwarded-Host': 'gyro.example.test',
    },
  });
  assert.equal(response.status, 200);
  const pairing = await response.json();
  const controllerUrl = new URL(pairing.mobileUrl);
  assert.equal(controllerUrl.origin, 'https://gyro.example.test');
  assert.equal(controllerUrl.pathname, '/controller.html');
  assert.equal(pairing.secureContext, true);
  assert.equal(pairing.localCertificate, false);
});

test('image generation sends a protected 4K reference request to OpenRouter', async (t) => {
  const dataDirectory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'gyro-openrouter-test-'));
  const kioskToken = 'kiosk-image-test-token-123456789';
  const calls = [];
  const runtime = await startServer({
    isProd: true,
    port: 0,
    serveStatic: false,
    kioskToken,
    publicUrl: 'https://gyro-test.onrender.com',
    eventDataDirectory: dataDirectory,
    openRouterApiKey: 'test-openrouter-key-not-a-secret',
    openRouterImageModel: 'google/gemini-3.1-flash-image',
    openRouterFetch: async (url, init) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({
        data: [{ b64_json: 'Z2VuZXJhdGVkLWltYWdl', media_type: 'image/png' }],
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    },
  });
  const baseUrl = `http://127.0.0.1:${runtime.port}`;

  t.after(async () => {
    await runtime.close('openrouter-integration-test-complete');
    await fs.promises.rm(dataDirectory, { recursive: true, force: true });
  });

  const response = await fetch(`${baseUrl}/api/generate-image`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${kioskToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      promptText: 'Keep the person and generate a full-body football portrait.',
      base64Image: 'dGVzdC1waG90bw==',
    }),
  });

  assert.equal(response.status, 200);
  const generated = await response.json();
  assert.deepEqual({
    imageDataUrl: generated.imageDataUrl,
    model: generated.model,
  }, {
    imageDataUrl: 'data:image/png;base64,Z2VuZXJhdGVkLWltYWdl',
    model: 'google/gemini-3.1-flash-image',
  });
  assert.match(generated.requestId, /^[0-9a-f-]{36}$/);
  assert.equal(response.headers.get('x-request-id'), generated.requestId);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://openrouter.ai/api/v1/images');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer test-openrouter-key-not-a-secret');
  assert.equal(calls[0].init.headers['HTTP-Referer'], 'https://gyro-test.onrender.com');

  const outbound = JSON.parse(calls[0].init.body);
  assert.equal(outbound.model, 'google/gemini-3.1-flash-image');
  assert.equal(outbound.resolution, '4K');
  assert.equal(outbound.aspect_ratio, '9:16');
  assert.equal(outbound.n, 1);
  assert.equal(outbound.input_references[0].image_url.url, 'data:image/jpeg;base64,dGVzdC1waG90bw==');
});

test('image generation classifies transport failures without leaking exception details', async (t) => {
  const dataDirectory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'gyro-openrouter-failure-'));
  const kioskToken = 'kiosk-network-test-token-123456789';
  const operatorToken = 'operator-network-test-token-123456789';
  const runtime = await startServer({
    isProd: true,
    port: 0,
    serveStatic: false,
    kioskToken,
    operatorToken,
    publicUrl: 'https://gyro-test.onrender.com',
    eventDataDirectory: dataDirectory,
    openRouterApiKey: 'test-openrouter-key-not-a-secret',
    openRouterTimeoutMs: 90_000,
    openRouterFetch: async () => {
      const cause = new Error('sensitive transport details must stay in the server');
      cause.code = 'EACCES';
      const error = new TypeError('fetch failed');
      error.cause = cause;
      throw error;
    },
  });
  const baseUrl = `http://127.0.0.1:${runtime.port}`;

  t.after(async () => {
    await runtime.close('openrouter-failure-test-complete');
    await fs.promises.rm(dataDirectory, { recursive: true, force: true });
  });

  const response = await fetch(`${baseUrl}/api/generate-image`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${kioskToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ promptText: 'test prompt', base64Image: 'dGVzdC1waG90bw==' }),
  });
  const failure = await response.json();
  assert.equal(response.status, 503);
  assert.equal(failure.error, 'image-generation-network-unavailable');
  assert.equal(failure.retryable, true);
  assert.equal(response.headers.get('x-request-id'), failure.requestId);
  assert.doesNotMatch(JSON.stringify(failure), /sensitive transport details/i);

  const statusResponse = await fetch(`${baseUrl}/api/operator/status`, {
    headers: { Authorization: `Bearer ${operatorToken}` },
  });
  const status = await statusResponse.json();
  assert.equal(status.imageGeneration.timeoutMs, 90_000);
  assert.equal(status.imageGeneration.inFlight, 0);
  assert.equal(status.imageGeneration.totalAttempts, 1);
  assert.equal(status.imageGeneration.lastFailure.error, 'image-generation-network-unavailable');
  assert.equal(status.imageGeneration.lastFailure.diagnosticCode, 'EACCES');
  assert.doesNotMatch(JSON.stringify(status), /sensitive transport details/i);
});

test('image generation preserves safe OpenRouter error categories and Retry-After', async (t) => {
  const dataDirectory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'gyro-openrouter-upstream-'));
  const kioskToken = 'kiosk-upstream-test-token-123456789';
  const responses = [
    new Response(JSON.stringify({
      error: { code: 429, message: 'rate limited', metadata: { error_type: 'rate_limit_exceeded' } },
    }), { status: 429, headers: { 'Content-Type': 'application/json', 'Retry-After': '7' } }),
    new Response(JSON.stringify({
      error: { code: 400, message: 'bad image', metadata: { error_type: 'invalid_image' } },
    }), { status: 400, headers: { 'Content-Type': 'application/json' } }),
    new Response(JSON.stringify({
      error: { code: 401, message: 'invalid key' },
    }), { status: 401, headers: { 'Content-Type': 'application/json' } }),
    new Response(JSON.stringify({
      error: { code: 403, message: 'model access denied' },
    }), { status: 403, headers: { 'Content-Type': 'application/json' } }),
    new Response(JSON.stringify({
      error: {
        code: 403,
        message: 'request refused by safety policy',
        metadata: { error_type: 'content_policy_violation' },
      },
    }), { status: 403, headers: { 'Content-Type': 'application/json' } }),
  ];
  const runtime = await startServer({
    isProd: true,
    port: 0,
    serveStatic: false,
    kioskToken,
    publicUrl: 'https://gyro-test.onrender.com',
    eventDataDirectory: dataDirectory,
    openRouterApiKey: 'test-openrouter-key-not-a-secret',
    openRouterFetch: async () => responses.shift(),
  });
  const baseUrl = `http://127.0.0.1:${runtime.port}`;

  t.after(async () => {
    await runtime.close('openrouter-upstream-test-complete');
    await fs.promises.rm(dataDirectory, { recursive: true, force: true });
  });

  const submit = () => fetch(`${baseUrl}/api/generate-image`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${kioskToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ promptText: 'test prompt', base64Image: 'dGVzdC1waG90bw==' }),
  });

  const rateLimited = await submit();
  assert.equal(rateLimited.status, 503);
  assert.equal(rateLimited.headers.get('retry-after'), '7');
  assert.deepEqual(
    pickFailureFields(await rateLimited.json()),
    {
      error: 'image-generation-rate-limited',
      retryable: true,
      upstreamStatus: 429,
      upstreamErrorType: 'rate_limit_exceeded',
    },
  );

  const invalidImage = await submit();
  assert.equal(invalidImage.status, 422);
  assert.deepEqual(
    pickFailureFields(await invalidImage.json()),
    {
      error: 'image-generation-reference-rejected',
      retryable: false,
      upstreamStatus: 400,
      upstreamErrorType: 'invalid_image',
    },
  );

  const invalidCredentials = await submit();
  assert.equal(invalidCredentials.status, 503);
  assert.deepEqual(
    pickFailureFields(await invalidCredentials.json()),
    {
      error: 'image-generation-credentials-rejected',
      retryable: false,
      upstreamStatus: 401,
      upstreamErrorType: undefined,
    },
  );

  const accessDenied = await submit();
  assert.equal(accessDenied.status, 503);
  assert.deepEqual(
    pickFailureFields(await accessDenied.json()),
    {
      error: 'image-generation-access-denied',
      retryable: false,
      upstreamStatus: 403,
      upstreamErrorType: undefined,
    },
  );

  const contentRejected = await submit();
  assert.equal(contentRejected.status, 422);
  assert.deepEqual(
    pickFailureFields(await contentRejected.json()),
    {
      error: 'image-generation-content-rejected',
      retryable: false,
      upstreamStatus: 403,
      upstreamErrorType: 'content_policy_violation',
    },
  );
});

function pickFailureFields(value) {
  return {
    error: value.error,
    retryable: value.retryable,
    upstreamStatus: value.upstreamStatus,
    upstreamErrorType: value.upstreamErrorType,
  };
}

function createSocket(baseUrl, transports = ['websocket']) {
  return createClient(baseUrl, {
    transports,
    forceNew: true,
    reconnection: false,
  });
}

function waitForConnect(socket, timeoutMs = 3_000) {
  if (socket.connected) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Socket connection timed out')), timeoutMs);
    socket.once('connect', () => {
      clearTimeout(timer);
      resolve();
    });
    socket.once('connect_error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

function waitForTransport(socket, transportName, timeoutMs = 3_000) {
  if (socket.io.engine?.transport?.name === transportName) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Transport did not upgrade to ${transportName}`)), timeoutMs);
    socket.io.engine.once('upgrade', (transport) => {
      if (transport.name !== transportName) return;
      clearTimeout(timer);
      resolve();
    });
  });
}

function emitWithAck(socket, event, payload, timeoutMs = 3_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Ack timed out: ${event}`)), timeoutMs);
    socket.emit(event, payload, (response) => {
      clearTimeout(timer);
      resolve(response);
    });
  });
}

function restoreEnvironmentValue(name, value) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
