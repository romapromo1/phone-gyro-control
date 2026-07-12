import express from 'express';
import { createServer as createHttpServer } from 'http';
import { createServer as createHttpsServer } from 'https';
import { Server } from 'socket.io';
import { createServer as createViteServer } from 'vite';
import path from 'path';
import { fileURLToPath } from 'url';
import os from 'os';
import qrcode from 'qrcode';
import selfsigned from 'selfsigned';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function startServer() {
  const app = express();
  const localIp = getLocalIpAddress();
  const isProd = process.env.NODE_ENV === 'production' || process.argv.includes('--prod');
  const port = process.env.PORT || 3000;

  let httpServer;
  
  if (isProd) {
    console.log('Running in PRODUCTION mode (creating standard HTTP server)...');
    httpServer = createHttpServer(app);
  } else {
    console.log('Running in DEVELOPMENT mode (generating self-signed certificate for HTTPS)...');
    // Generate self-signed certificate for HTTPS with 2048-bit keys and SAN extension
    const attrs = [{ name: 'commonName', value: 'localhost' }];
    const extensions = [
      {
        name: 'subjectAltName',
        altNames: [
          { type: 2, value: 'localhost' }, // DNS
          { type: 7, value: '127.0.0.1' }, // IP
          { type: 7, value: localIp }      // IP
        ]
      }
    ];
    
    const pems = await selfsigned.generate(attrs, {
      days: 365,
      keySize: 2048,
      algorithm: 'sha256',
      extensions
    });
    const credentials = { key: pems.private, cert: pems.cert };
    httpServer = createHttpsServer(credentials, app);
  }
  
  // Set up socket.io with CORS enabled
  const io = new Server(httpServer, {
    cors: {
      origin: "*",
      methods: ["GET", "POST"]
    }
  });

  let activeMobileSocketId = null;

  // Socket.io logic
  io.on('connection', (socket) => {
    console.log('Client connected:', socket.id);

    socket.on('register', (type) => {
      console.log(`Socket ${socket.id} registered as ${type}`);
      socket.data.clientType = type;

      if (type === 'mobile') {
        const previousMobileSocketId = activeMobileSocketId;
        activeMobileSocketId = socket.id;

        if (previousMobileSocketId && previousMobileSocketId !== socket.id) {
          const previousController = io.sockets.sockets.get(previousMobileSocketId);
          if (previousController) {
            console.log(`Replacing previous mobile controller: ${previousMobileSocketId}`);
            previousController.disconnect(true);
          }
        }
        io.to('desktop').emit('controller-status', { connected: true });
      } else if (type === 'desktop') {
        socket.emit('controller-status', { connected: Boolean(activeMobileSocketId) });
      }

      socket.join(type);
    });

    socket.on('gyro-data', (data) => {
      if (socket.id !== activeMobileSocketId || socket.data.clientType !== 'mobile') return;
      // Forward gyro telemetry to desktop client(s)
      io.to('desktop').volatile.emit('gyro-update', data);
    });

    socket.on('calibrate', () => {
      if (socket.data.clientType === 'mobile' && socket.id !== activeMobileSocketId) return;
      console.log(`Calibration requested by ${socket.data.clientType || 'unknown'} client: ${socket.id}`);
      if (socket.data.clientType === 'desktop') {
        if (activeMobileSocketId) io.to(activeMobileSocketId).emit('calibrate-request');
      } else if (socket.data.clientType === 'mobile') {
        io.to('desktop').emit('calibrate-request');
      }
    });

    socket.on('log', (msg) => {
      console.log(`[Browser]: ${msg}`);
      if (!isProd) {
        try {
          fs.appendFileSync(path.join(__dirname, 'socket_errors.log'), `[${new Date().toISOString()}] [Browser]: ${msg}\n`);
        } catch (err) {
          console.error('Failed to write to socket_errors.log:', err);
        }
      }
    });

    socket.on('disconnect', () => {
      if (socket.id === activeMobileSocketId) {
        activeMobileSocketId = null;
        io.to('desktop').emit('controller-status', { connected: false });
      }
      console.log('Client disconnected:', socket.id);
    });
  });

  // Endpoint to get server info
  app.get('/api/server-info', async (req, res) => {
    const tunnelUrl = process.env.TUNNEL_URL;
    let mobileUrl;
    
    if (tunnelUrl) {
      mobileUrl = `${tunnelUrl.replace(/\/$/, '')}/controller.html`;
    } else if (isProd || req.headers['x-forwarded-host'] || req.headers.host) {
      const host = req.headers['x-forwarded-host'] || req.headers.host;
      const forwardedProto = req.headers['x-forwarded-proto'];
      const proto = Array.isArray(forwardedProto) ? forwardedProto[0] : forwardedProto || req.protocol;
      mobileUrl = `${proto}://${host}/controller.html`;
    } else {
      mobileUrl = `https://${localIp}:${port}/controller.html`;
    }
      
    try {
      const qrDataUrl = await qrcode.toDataURL(mobileUrl);
      res.json({ ip: localIp, port, mobileUrl, qrDataUrl });
    } catch (err) {
      res.status(500).json({ error: 'Failed to generate QR code' });
    }
  });

  if (!isProd) {
    // Setup Vite server in middleware mode for hot reloading
    console.log('Running in DEVELOPMENT mode with Vite middleware...');
    const vite = await createViteServer({
      server: { 
        middlewareMode: true,
        hmr: {
          server: httpServer // Link Vite's HMR websocket to our server
        }
      },
      appType: 'spa'
    });
    app.use(vite.middlewares);
  } else {
    // Serve production static files
    console.log('Running in PRODUCTION mode...');
    app.use(express.static(path.join(__dirname, 'dist')));
  }

  httpServer.listen(port, '0.0.0.0', () => {
    const tunnelUrl = process.env.TUNNEL_URL;
    const protocolStr = isProd ? 'http' : 'https';
    console.log(`----------------------------------------------------------------`);
    console.log(`${isProd ? 'HTTP' : 'HTTPS'} Server running at:`);
    console.log(`  - Local:      ${protocolStr}://localhost:${port}/`);
    console.log(`  - Network:    ${protocolStr}://${localIp}:${port}/`);
    console.log(`  - Controller: ${protocolStr}://${localIp}:${port}/controller.html`);
    if (tunnelUrl) {
      console.log(`  - Tunnel:     ${tunnelUrl.replace(/\/$/, '')}/controller.html`);
    }
    console.log(`----------------------------------------------------------------`);
  });
}

function getLocalIpAddress() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return 'localhost';
}

startServer();
