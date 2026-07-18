import express from 'express';
import fs from 'fs';
import { createServer as createHttpServer } from 'http';
import { createServer as createHttpsServer } from 'https';
import { Server } from 'socket.io';
import path from 'path';
import { fileURLToPath } from 'url';
import os from 'os';
import crypto from 'crypto';
import qrcode from 'qrcode';
import { EVENTS, normalizeStationId } from './shared/protocol.js';
import { createEventRecorder } from './server/eventStore.js';
import { selectLanIpv4 } from './server/networkAddress.js';
import { SessionCoordinator } from './server/sessionCoordinator.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export async function startServer(options = {}) {
  const app = express();
  const localIp = selectLanIpv4(
    os.networkInterfaces(),
    options.localIp ?? process.env.LOCAL_IP,
  );
  const isProd = options.isProd ?? (
    process.env.NODE_ENV === 'production' || process.argv.includes('--prod')
  );
  const requestedPort = Number(options.port ?? process.env.PORT ?? 3000);
  let boundPort = requestedPort;
  const publicUrl = normalizePublicUrl(
    firstNonBlank(
      options.publicUrl,
      process.env.PUBLIC_URL,
      process.env.RENDER_EXTERNAL_URL,
      renderExternalUrl(process.env.RENDER_EXTERNAL_HOSTNAME),
    ),
  );
  const trustProxy = options.trustProxy ?? (
    process.env.RENDER === 'true' || process.env.TRUST_PROXY === '1'
  );
  const operatorToken = options.operatorToken ?? process.env.OPERATOR_TOKEN ?? '';
  const kioskToken = options.kioskToken ?? process.env.KIOSK_TOKEN ?? '';
  const kioskAuthRequired = isProd && Boolean(publicUrl || trustProxy);
  const openRouterApiKey = normalizeSecret(
    options.openRouterApiKey ?? process.env.OPENROUTER_API_KEY,
  );
  const openRouterImageModel = normalizeOpenRouterImageModel(
    options.openRouterImageModel ?? process.env.OPENROUTER_IMAGE_MODEL,
  );
  const openRouterTimeoutMs = normalizeOpenRouterTimeout(
    options.openRouterTimeoutMs ?? process.env.OPENROUTER_TIMEOUT_MS,
  );
  const openRouterFetch = options.openRouterFetch ?? fetch;
  const imageGenerationStatus = createImageGenerationStatus(
    Boolean(openRouterApiKey),
    openRouterImageModel,
    openRouterTimeoutMs,
  );
  const eventDataDirectory = options.eventDataDirectory
    || process.env.EVENT_DATA_DIR
    || path.join(__dirname, 'data');
  const record = createEventRecorder(eventDataDirectory);

  app.disable('x-powered-by');
  app.set('trust proxy', trustProxy ? 1 : false);
  app.use(createSecurityHeaders(isProd));

  let httpServer;
  if (isProd) {
    console.log('[server] Production mode: HTTP origin behind the Render HTTPS proxy.');
    httpServer = createHttpServer(app);
  } else {
    const credentials = await getDevelopmentCredentials(localIp);
    console.log('[server] Development mode: local HTTPS with a self-signed certificate.');
    httpServer = createHttpsServer(credentials, app);
  }

  // Render keeps long-running HTTP requests open, but recommends explicit
  // keep-alive/header timeouts for Node services to avoid intermittent proxy
  // connection resets. Image generation itself has a separate timeout below.
  httpServer.keepAliveTimeout = 120_000;
  httpServer.headersTimeout = 125_000;
  httpServer.requestTimeout = 15 * 60_000;

  const io = new Server(httpServer, {
    // WebSocket is preferred after the initial handshake. Keeping Socket.IO's
    // HTTP long-polling transport available makes QR controllers work in
    // embedded QR browsers and on venue/mobile networks that block upgrades.
    transports: ['polling', 'websocket'],
    maxHttpBufferSize: 16 * 1024,
    pingInterval: 10_000,
    pingTimeout: 8_000,
    perMessageDeflate: false,
  });
  const coordinator = new SessionCoordinator(io, { record });

  io.on('connection', (socket) => {
    socket.on(EVENTS.REGISTER_DESKTOP, (payload, ack) => {
      if (!isAuthorizedToken(kioskToken, payload?.kioskToken, kioskAuthRequired)) {
        safeAck(ack)({ ok: false, reason: 'kiosk-unauthorized' });
        socket.disconnect(true);
        return;
      }
      coordinator.registerDesktop(socket, payload, safeAck(ack));
    });
    socket.on(EVENTS.CLAIM_CONTROLLER, (payload, ack) => {
      coordinator.claimController(socket, payload, safeAck(ack));
    });
    socket.on(EVENTS.GYRO_DATA, (payload) => coordinator.handleGyro(socket, payload));
    socket.on(EVENTS.CALIBRATE, () => coordinator.handleCalibrate(socket));
    socket.on(EVENTS.SESSION_COMMAND, (payload, ack) => {
      coordinator.handleSessionCommand(socket, payload, safeAck(ack));
    });
    socket.on('disconnect', () => coordinator.handleDisconnect(socket));
  });

  app.get('/health', (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json(coordinator.getHealthSnapshot());
  });

  app.get('/api/operator/status', requireOperator(operatorToken), (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json({
      ...coordinator.getHealthSnapshot(),
      imageGenerationConfigured: Boolean(openRouterApiKey),
      imageGenerationModel: openRouterApiKey ? openRouterImageModel : null,
      imageGeneration: snapshotImageGenerationStatus(imageGenerationStatus),
    });
  });

  const imageRequestParser = express.json({ limit: '12mb' });
  app.post(
    '/api/detect-gender',
    requireKiosk(kioskToken, kioskAuthRequired),
    imageRequestParser,
    (_req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      res.json({ gender: 'unknown' });
    },
  );
  app.post(
    '/api/generate-image',
    requireKiosk(kioskToken, kioskAuthRequired),
    imageRequestParser,
    (req, res) => void generateOpenRouterImage(req, res, {
      apiKey: openRouterApiKey,
      model: openRouterImageModel,
      fetchImpl: openRouterFetch,
      httpReferer: publicUrl,
      timeoutMs: openRouterTimeoutMs,
      status: imageGenerationStatus,
    }),
  );

  app.post('/api/operator/stations/:stationId/reset', requireOperator(operatorToken), (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json({ ok: true, ...coordinator.forcePairing(req.params.stationId) });
  });

  app.post('/api/operator/stations/:stationId/calibrate', requireOperator(operatorToken), (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json(coordinator.forceCalibrate(req.params.stationId));
  });

  app.get('/api/server-info', requireKiosk(kioskToken, kioskAuthRequired), async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const stationId = normalizeStationId(req.query.station);
    const pairing = coordinator.getPairing(stationId);
    if (!pairing.available) {
      return res.status(409).json(pairing);
    }

    const baseUrl = resolveMobileBaseUrl(req, {
      publicUrl,
      isProd,
      localIp,
      boundPort,
      isTrustedProxy: Boolean(trustProxy),
    });
    if (!baseUrl) {
      console.error('[server] Refusing to issue a QR without a reachable HTTPS public origin.');
      return res.status(503).json({ error: 'mobile-origin-unavailable' });
    }
    const mobileUrl = new URL('/controller.html', `${baseUrl}/`);
    mobileUrl.searchParams.set('station', pairing.stationId);
    mobileUrl.searchParams.set('token', pairing.token);

    try {
      const qrDataUrl = await qrcode.toDataURL(mobileUrl.toString(), {
        errorCorrectionLevel: 'M',
        margin: 2,
        width: 640,
      });
      res.json({
        ip: localIp,
        port: boundPort,
        stationId: pairing.stationId,
        mobileUrl: mobileUrl.toString(),
        qrDataUrl,
        expiresAt: pairing.expiresAt,
        secureContext: mobileUrl.protocol === 'https:',
        localCertificate: !isProd && mobileUrl.protocol === 'https:',
      });
    } catch (error) {
      console.error('[server] QR generation failed:', error);
      res.status(500).json({ error: 'qr-generation-failed' });
    }
  });

  if (options.serveStatic === false) {
    // Route-only mode is used by integration tests.
  } else if (!isProd) {
    app.use(express.static(path.join(__dirname, 'public'), {
      index: false,
      etag: true,
      maxAge: 0,
    }));
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      publicDir: false,
      server: {
        middlewareMode: true,
        hmr: { server: httpServer },
      },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDirectory = path.join(__dirname, 'dist');
    if (!fs.existsSync(path.join(distDirectory, 'index.html'))) {
      throw new Error('Production build is missing. Run "npm run build" before starting the server.');
    }
    app.use(express.static(distDirectory, {
      etag: true,
      maxAge: 0,
      setHeaders(res, filePath) {
        if (filePath.endsWith('.html')) {
          res.setHeader('Cache-Control', 'no-cache');
        } else if (filePath.includes(`${path.sep}assets${path.sep}`)) {
          res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        } else {
          res.setHeader('Cache-Control', 'public, max-age=3600, must-revalidate');
        }
      },
    }));
  }

  await new Promise((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(requestedPort, '0.0.0.0', () => {
      httpServer.off('error', reject);
      const address = httpServer.address();
      if (address && typeof address === 'object') boundPort = address.port;
      resolve();
    });
  });

  const protocol = isProd ? 'http' : 'https';
  console.log('[server] Ready:');
  console.log(`  Kiosk:      ${protocol}://localhost:${boundPort}/`);
  console.log(`  LAN:        ${protocol}://${localIp}:${boundPort}/`);
  console.log(`  Health:     ${protocol}://localhost:${boundPort}/health`);
  console.log('  Pairing API: ready (/api/server-info)');
  console.log(
    `  Image API:  ${openRouterApiKey
      ? `ready (${openRouterImageModel}, timeout ${Math.round(openRouterTimeoutMs / 1000)}s)`
      : 'disabled (set OPENROUTER_API_KEY)'}`,
  );
  if (publicUrl) console.log(`  Public URL: ${publicUrl}`);
  if (isProd && !publicUrl && !trustProxy) {
    console.warn('[server] PUBLIC_URL/RENDER_EXTERNAL_URL is not set. QR links will use insecure HTTP.');
  }
  if (kioskAuthRequired && !kioskToken) {
    console.error('[server] KIOSK_TOKEN is required when a public production URL is configured.');
  }

  return {
    app,
    httpServer,
    io,
    coordinator,
    port: boundPort,
    async close(reason = 'server-shutdown') {
      coordinator.shutdown(reason);
      await record.flush();
      await new Promise((resolve) => io.close(resolve));
    },
  };
}

async function getDevelopmentCredentials(localIp) {
  const certPath = path.join(__dirname, 'server.cert');
  const keyPath = path.join(__dirname, 'server.key');
  if (fs.existsSync(certPath) && fs.existsSync(keyPath)) {
    const certificate = fs.readFileSync(certPath, 'utf8');
    if (developmentCertificateSupportsIp(certificate, localIp)) {
      return {
        key: fs.readFileSync(keyPath, 'utf8'),
        cert: certificate,
      };
    }
    console.log(`[server] LAN address changed to ${localIp}; refreshing the local certificate.`);
  }

  const { default: selfsigned } = await import('selfsigned');
  const pems = await selfsigned.generate(
    [{ name: 'commonName', value: 'localhost' }],
    {
      days: 30,
      keySize: 2048,
      algorithm: 'sha256',
      extensions: [{
        name: 'subjectAltName',
        altNames: [
          { type: 2, value: 'localhost' },
          { type: 7, value: '127.0.0.1' },
          { type: 7, value: localIp },
        ],
      }],
    },
  );
  fs.writeFileSync(keyPath, pems.private, { encoding: 'utf8', mode: 0o600 });
  fs.writeFileSync(certPath, pems.cert, 'utf8');
  return { key: pems.private, cert: pems.cert };
}

function developmentCertificateSupportsIp(certificate, localIp) {
  try {
    const subjectAltNames = new crypto.X509Certificate(certificate).subjectAltName || '';
    return subjectAltNames.split(/,\s*/).includes(`IP Address:${localIp}`);
  } catch {
    return false;
  }
}

function createSecurityHeaders(isProd) {
  return (_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader(
      'Permissions-Policy',
      'camera=(self), accelerometer=(self), gyroscope=(self), microphone=(), geolocation=()',
    );
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    if (isProd) {
      res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
      res.setHeader(
        'Content-Security-Policy',
        "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' ws: wss:; font-src 'self' data:; worker-src 'self' blob:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
      );
    }
    next();
  };
}

function normalizePublicUrl(value) {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:') {
      console.warn('[server] Public URL must use HTTPS; ignoring insecure value.');
      return null;
    }
    return url.toString().replace(/\/$/, '');
  } catch {
    console.warn('[server] Public URL is invalid; ignoring it.');
    return null;
  }
}

function firstNonBlank(...values) {
  return values.find((value) => typeof value === 'string' && value.trim()) || null;
}

function renderExternalUrl(hostname) {
  if (typeof hostname !== 'string' || !hostname.trim()) return null;
  return `https://${hostname.trim()}`;
}

function resolveMobileBaseUrl(req, configuration) {
  if (configuration.publicUrl) return configuration.publicUrl;

  // A real production proxy terminates TLS before forwarding the request to
  // Node. In that environment the public request origin is reachable from the
  // phone; the container's 10.x address and PORT are not. Only trust forwarded
  // headers when Express proxy trust is explicitly enabled.
  if (configuration.isProd && configuration.isTrustedProxy) {
    return trustedPublicRequestOrigin(req);
  }

  // Local production preview intentionally uses HTTP so the page can be opened
  // without trusting a development certificate. Gyroscope APIs still require
  // HTTPS in current mobile browsers, so event/phone testing should use the
  // public HTTPS deployment or a locally trusted certificate.
  const protocol = configuration.isProd ? 'http' : 'https';
  return `${protocol}://${configuration.localIp}:${configuration.boundPort}`;
}

function trustedPublicRequestOrigin(req) {
  const protocol = String(req.protocol || '').toLowerCase();
  if (protocol !== 'https') return null;

  const forwardedHost = String(req.get('x-forwarded-host') || '').split(',')[0];
  const host = String(forwardedHost || req.get('host') || '').trim().toLowerCase();
  if (!isSafePublicHost(host)) return null;
  return `https://${host}`;
}

function isSafePublicHost(host) {
  if (!host || host.length > 253 || /[\\/@\s]/.test(host)) return false;
  try {
    const parsed = new URL(`https://${host}`);
    return parsed.protocol === 'https:'
      && parsed.username === ''
      && parsed.password === ''
      && parsed.pathname === '/'
      && parsed.search === ''
      && parsed.hash === '';
  } catch {
    return false;
  }
}

function normalizeSecret(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeOpenRouterImageModel(value) {
  const defaultModel = 'google/gemini-3.1-flash-image';
  if (!value) return defaultModel;
  const model = String(value).trim();
  if (/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{2,160}$/.test(model)) return model;
  console.warn('[server] OPENROUTER_IMAGE_MODEL is invalid; using the default image model.');
  return defaultModel;
}

function normalizeOpenRouterTimeout(value) {
  const defaultTimeoutMs = 8 * 60_000;
  if (value === undefined || value === null || value === '') return defaultTimeoutMs;
  const parsed = Number(value);
  if (Number.isFinite(parsed) && parsed >= 30_000 && parsed <= 15 * 60_000) {
    return Math.round(parsed);
  }
  console.warn('[server] OPENROUTER_TIMEOUT_MS is invalid; using 480000ms.');
  return defaultTimeoutMs;
}

function createImageGenerationStatus(configured, model, timeoutMs) {
  return {
    configured,
    model: configured ? model : null,
    timeoutMs,
    inFlight: 0,
    totalAttempts: 0,
    totalSuccesses: 0,
    lastAttemptAt: null,
    lastSuccessAt: null,
    lastDurationMs: null,
    lastFailure: null,
  };
}

function snapshotImageGenerationStatus(status) {
  return {
    configured: status.configured,
    model: status.model,
    timeoutMs: status.timeoutMs,
    inFlight: status.inFlight,
    totalAttempts: status.totalAttempts,
    totalSuccesses: status.totalSuccesses,
    lastAttemptAt: status.lastAttemptAt,
    lastSuccessAt: status.lastSuccessAt,
    lastDurationMs: status.lastDurationMs,
    lastFailure: status.lastFailure ? { ...status.lastFailure } : null,
  };
}

async function generateOpenRouterImage(req, res, configuration) {
  res.setHeader('Cache-Control', 'no-store');
  const requestId = crypto.randomUUID();
  res.setHeader('X-Request-Id', requestId);
  if (!configuration.apiKey) {
    return res.status(503).json({
      error: 'image-generation-not-configured',
      requestId,
      retryable: false,
    });
  }

  const request = validateImageGenerationRequest(req.body);
  if (!request.ok) {
    return res.status(400).json({ error: request.error, requestId, retryable: false });
  }

  if (configuration.status.inFlight > 0) {
    return res.status(409).json({
      error: 'image-generation-busy',
      requestId,
      retryable: true,
    });
  }

  const startedAt = Date.now();
  configuration.status.inFlight += 1;
  configuration.status.totalAttempts += 1;
  configuration.status.lastAttemptAt = new Date(startedAt).toISOString();
  configuration.status.lastFailure = null;

  const clientAbortController = new AbortController();
  let clientDisconnected = false;
  const handleClientDisconnect = () => {
    if (res.writableEnded) return;
    clientDisconnected = true;
    clientAbortController.abort();
  };
  res.once('close', handleClientDisconnect);

  try {
    const upstream = await configuration.fetchImpl('https://openrouter.ai/api/v1/images', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${configuration.apiKey}`,
        'Content-Type': 'application/json',
        ...(configuration.httpReferer ? { 'HTTP-Referer': configuration.httpReferer } : {}),
        'X-Title': 'Holobox Gyro Labyrinth',
      },
      body: JSON.stringify({
        model: configuration.model,
        prompt: request.promptText,
        resolution: '4K',
        aspect_ratio: '9:16',
        n: 1,
        input_references: [{
          type: 'image_url',
          image_url: { url: request.imageDataUrl },
        }],
      }),
      signal: AbortSignal.any([
        clientAbortController.signal,
        AbortSignal.timeout(configuration.timeoutMs),
      ]),
    });

    const responseBody = await readLimitedResponseBody(upstream, 64 * 1024 * 1024);
    if (!responseBody.ok) {
      return sendImageGenerationFailure(res, configuration.status, {
        requestId,
        startedAt,
        httpStatus: 502,
        error: 'image-generation-response-too-large',
        retryable: false,
        upstreamStatus: upstream.status,
      });
    }

    let payload;
    try {
      payload = JSON.parse(responseBody.buffer.toString('utf8'));
    } catch {
      if (!upstream.ok) {
        return sendMappedUpstreamFailure(
          res,
          configuration.status,
          requestId,
          startedAt,
          upstream,
          null,
        );
      }
      return sendImageGenerationFailure(res, configuration.status, {
        requestId,
        startedAt,
        httpStatus: 502,
        error: 'image-generation-invalid-response',
        retryable: true,
        upstreamStatus: upstream.status,
      });
    }

    if (!upstream.ok || payload?.error) {
      return sendMappedUpstreamFailure(
        res,
        configuration.status,
        requestId,
        startedAt,
        upstream,
        payload,
      );
    }

    const generatedImage = payload?.data?.[0];
    if (typeof generatedImage?.b64_json !== 'string' || !generatedImage.b64_json) {
      return sendImageGenerationFailure(res, configuration.status, {
        requestId,
        startedAt,
        httpStatus: 502,
        error: 'image-generation-missing-image',
        retryable: true,
        upstreamStatus: upstream.status,
      });
    }

    const mediaType = normalizeGeneratedMediaType(generatedImage.media_type);
    const durationMs = Date.now() - startedAt;
    configuration.status.totalSuccesses += 1;
    configuration.status.lastSuccessAt = new Date().toISOString();
    configuration.status.lastDurationMs = durationMs;
    configuration.status.lastFailure = null;
    console.log(`[image-generation] request=${requestId} completed in ${durationMs}ms.`);
    return res.json({
      imageDataUrl: `data:${mediaType};base64,${generatedImage.b64_json}`,
      model: configuration.model,
      requestId,
    });
  } catch (error) {
    if (clientDisconnected) {
      recordImageGenerationFailure(configuration.status, {
        requestId,
        error: 'image-generation-client-disconnected',
        retryable: true,
        durationMs: Date.now() - startedAt,
      });
      return;
    }
    const failure = classifyOpenRouterTransportError(error);
    console.error(
      `[image-generation] request=${requestId} transport=${failure.category}`
      + ` code=${failure.diagnosticCode || 'none'} elapsedMs=${Date.now() - startedAt}.`,
    );
    return sendImageGenerationFailure(res, configuration.status, {
      requestId,
      startedAt,
      httpStatus: failure.httpStatus,
      error: failure.error,
      retryable: failure.retryable,
      diagnosticCode: failure.diagnosticCode,
    });
  } finally {
    configuration.status.inFlight = Math.max(0, configuration.status.inFlight - 1);
    res.off('close', handleClientDisconnect);
  }
}

async function readLimitedResponseBody(response, maximumBytes) {
  const contentLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > maximumBytes) return { ok: false };
  if (!response.body) return { ok: true, buffer: Buffer.alloc(0) };

  const chunks = [];
  let totalBytes = 0;
  const reader = response.body.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > maximumBytes) {
      await reader.cancel('response-too-large').catch(() => {});
      return { ok: false };
    }
    chunks.push(Buffer.from(value));
  }
  return { ok: true, buffer: Buffer.concat(chunks, totalBytes) };
}

function sendMappedUpstreamFailure(res, status, requestId, startedAt, upstream, payload) {
  const upstreamErrorType = normalizeDiagnosticCode(
    payload?.error_type
      ?? payload?.error?.error_type
      ?? payload?.error?.metadata?.error_type,
    true,
  );
  const payloadStatus = Number(payload?.error?.code);
  const upstreamStatus = Number.isInteger(payloadStatus) && payloadStatus >= 400 && payloadStatus <= 599
    ? payloadStatus
    : upstream.status;
  const mapping = mapOpenRouterFailure(upstreamStatus, upstreamErrorType);
  const retryAfterSeconds = parseRetryAfter(upstream.headers.get('retry-after'));
  if (retryAfterSeconds !== null && mapping.retryable) {
    res.setHeader('Retry-After', String(retryAfterSeconds));
  }
  console.warn(
    `[image-generation] request=${requestId} upstreamStatus=${upstreamStatus}`
    + ` errorType=${upstreamErrorType || 'unknown'} elapsedMs=${Date.now() - startedAt}.`,
  );
  return sendImageGenerationFailure(res, status, {
    requestId,
    startedAt,
    httpStatus: mapping.httpStatus,
    error: mapping.error,
    retryable: mapping.retryable,
    upstreamStatus,
    upstreamErrorType,
  });
}

function mapOpenRouterFailure(upstreamStatus, errorType) {
  if (upstreamStatus === 408 || errorType === 'timeout') {
    return { httpStatus: 504, error: 'image-generation-timeout', retryable: true };
  }
  if (upstreamStatus === 429 || errorType === 'rate_limit_exceeded') {
    return { httpStatus: 503, error: 'image-generation-rate-limited', retryable: true };
  }
  if (upstreamStatus === 402) {
    return { httpStatus: 503, error: 'image-generation-insufficient-credits', retryable: false };
  }
  if (errorType === 'content_policy_violation' || errorType === 'refusal') {
    return { httpStatus: 422, error: 'image-generation-content-rejected', retryable: false };
  }
  if (upstreamStatus === 401) {
    return { httpStatus: 503, error: 'image-generation-credentials-rejected', retryable: false };
  }
  if (upstreamStatus === 403) {
    // A valid OpenRouter key may still be forbidden from a model/provider by
    // account permissions or data-policy routing. Do not misreport that as an
    // invalid credential: 401 is the authentication failure.
    return { httpStatus: 503, error: 'image-generation-access-denied', retryable: false };
  }
  if ([
    'invalid_image',
    'image_too_large',
    'image_too_small',
    'unsupported_image_format',
    'image_not_found',
    'image_download_failed',
  ].includes(errorType)) {
    return { httpStatus: 422, error: 'image-generation-reference-rejected', retryable: false };
  }
  if (
    upstreamStatus >= 500
    || errorType === 'provider_overloaded'
    || errorType === 'provider_unavailable'
    || errorType === 'server'
  ) {
    return { httpStatus: 503, error: 'image-generation-upstream-unavailable', retryable: true };
  }
  return { httpStatus: 502, error: 'image-generation-upstream-failed', retryable: false };
}

function classifyOpenRouterTransportError(error) {
  const diagnosticCode = normalizeDiagnosticCode(error?.cause?.code ?? error?.code);
  const errorName = error instanceof Error ? error.name : '';
  if (
    errorName === 'TimeoutError'
    || ['ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT']
      .includes(diagnosticCode)
  ) {
    return {
      category: 'timeout',
      diagnosticCode,
      httpStatus: 504,
      error: 'image-generation-timeout',
      retryable: true,
    };
  }
  if ([
    'EACCES',
    'EAI_AGAIN',
    'ENETDOWN',
    'ENETUNREACH',
    'ENOTFOUND',
    'ECONNREFUSED',
  ].includes(diagnosticCode)) {
    return {
      category: 'network-unavailable',
      diagnosticCode,
      httpStatus: 503,
      error: 'image-generation-network-unavailable',
      retryable: true,
    };
  }
  return {
    category: 'transport-failed',
    diagnosticCode,
    httpStatus: 502,
    error: 'image-generation-unavailable',
    retryable: true,
  };
}

function sendImageGenerationFailure(res, status, details) {
  const durationMs = Date.now() - details.startedAt;
  recordImageGenerationFailure(status, {
    requestId: details.requestId,
    error: details.error,
    retryable: details.retryable,
    durationMs,
    upstreamStatus: details.upstreamStatus,
    upstreamErrorType: details.upstreamErrorType,
    diagnosticCode: details.diagnosticCode,
  });
  return res.status(details.httpStatus).json({
    error: details.error,
    requestId: details.requestId,
    retryable: details.retryable,
    ...(details.upstreamStatus ? { upstreamStatus: details.upstreamStatus } : {}),
    ...(details.upstreamErrorType ? { upstreamErrorType: details.upstreamErrorType } : {}),
  });
}

function recordImageGenerationFailure(status, details) {
  status.lastDurationMs = details.durationMs;
  status.lastFailure = {
    at: new Date().toISOString(),
    requestId: details.requestId,
    error: details.error,
    retryable: details.retryable,
    durationMs: details.durationMs,
    ...(details.upstreamStatus ? { upstreamStatus: details.upstreamStatus } : {}),
    ...(details.upstreamErrorType ? { upstreamErrorType: details.upstreamErrorType } : {}),
    ...(details.diagnosticCode ? { diagnosticCode: details.diagnosticCode } : {}),
  };
}

function normalizeDiagnosticCode(value, lowercase = false) {
  if (typeof value !== 'string') return null;
  const normalized = (lowercase ? value.toLowerCase() : value.toUpperCase()).trim();
  return /^[a-zA-Z0-9_-]{1,80}$/.test(normalized) ? normalized : null;
}

function parseRetryAfter(value) {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(3600, Math.ceil(seconds));
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return null;
  return Math.min(3600, Math.max(0, Math.ceil((timestamp - Date.now()) / 1000)));
}

function validateImageGenerationRequest(body) {
  const promptText = typeof body?.promptText === 'string' ? body.promptText.trim() : '';
  if (!promptText || promptText.length > 6_000) {
    return { ok: false, error: 'invalid-image-prompt' };
  }

  const suppliedImage = typeof body?.base64Image === 'string' ? body.base64Image.trim() : '';
  const match = suppliedImage.match(/^data:(image\/(?:jpeg|png|webp));base64,(.+)$/is);
  const mediaType = match?.[1]?.toLowerCase() || 'image/jpeg';
  const base64Image = (match?.[2] || suppliedImage).replace(/\s/g, '');
  if (
    base64Image.length < 4
    || base64Image.length > 12 * 1024 * 1024
    || base64Image.length % 4 !== 0
    || !/^[a-zA-Z0-9+/]+={0,2}$/.test(base64Image)
  ) {
    return { ok: false, error: 'invalid-reference-image' };
  }

  return {
    ok: true,
    promptText,
    imageDataUrl: `data:${mediaType};base64,${base64Image}`,
  };
}

function normalizeGeneratedMediaType(value) {
  return value === 'image/jpeg' || value === 'image/webp' ? value : 'image/png';
}

function safeAck(ack) {
  return typeof ack === 'function' ? ack : () => {};
}

function requireOperator(configuredToken) {
  return (req, res, next) => {
    if (!configuredToken) return res.status(503).json({ error: 'operator-token-not-configured' });
    const suppliedToken = req.headers.authorization?.replace(/^Bearer\s+/i, '') || '';
    if (!isAuthorizedToken(configuredToken, suppliedToken, true)) {
      return res.status(401).json({ error: 'unauthorized' });
    }
    next();
  };
}

function requireKiosk(configuredToken, required) {
  return (req, res, next) => {
    const suppliedToken = req.headers.authorization?.replace(/^Bearer\s+/i, '') || '';
    if (!isAuthorizedToken(configuredToken, suppliedToken, required)) {
      const status = configuredToken ? 401 : 503;
      return res.status(status).json({ error: configuredToken ? 'unauthorized' : 'kiosk-token-not-configured' });
    }
    next();
  };
}

function isAuthorizedToken(configuredToken, suppliedToken, required) {
  if (!required && !configuredToken) return true;
  if (!configuredToken || typeof suppliedToken !== 'string') return false;
  const expected = Buffer.from(configuredToken);
  const supplied = Buffer.from(suppliedToken);
  return expected.length === supplied.length && crypto.timingSafeEqual(expected, supplied);
}

export function loadLocalEnvironment(envPath = path.join(__dirname, '.env')) {
  // Render injects secrets through its Environment settings. Never let a
  // repository file shadow or supplement those deployment values.
  if (process.env.RENDER === 'true') return false;
  if (!fs.existsSync(envPath)) return false;

  process.loadEnvFile(envPath);
  console.log(`[server] Loaded local environment from ${path.basename(envPath)}.`);
  return true;
}

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === __filename;
if (isDirectRun) {
  let runtime = null;
  let stopping = false;

  const stop = async (signal) => {
    if (stopping) return;
    stopping = true;
    console.log(`[server] ${signal} received, closing active sessions.`);
    const hardStop = setTimeout(() => process.exit(1), 20_000);
    hardStop.unref();
    try {
      await runtime?.close('server-restarting');
      clearTimeout(hardStop);
      process.exit(0);
    } catch (error) {
      console.error('[server] Graceful shutdown failed:', error);
      process.exit(1);
    }
  };

  process.once('SIGTERM', () => void stop('SIGTERM'));
  process.once('SIGINT', () => void stop('SIGINT'));

  Promise.resolve()
    .then(() => loadLocalEnvironment())
    .then(() => startServer())
    .then((startedRuntime) => { runtime = startedRuntime; })
    .catch((error) => {
      if (error?.code === 'EADDRINUSE') {
        console.error(
          `[server] Port ${process.env.PORT || 3000} is already in use. `
          + 'Stop the old Node/Vite process, then run "npm run dev" again.',
        );
      } else {
        console.error('[server] Fatal startup error:', error);
      }
      process.exitCode = 1;
    });
}
