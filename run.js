import { spawn } from 'child_process';

const projectDirectory = new URL('.', import.meta.url);
const children = new Set();
let stopping = false;

const server = spawn(process.execPath, ['server.js', '--prod'], {
  cwd: projectDirectory,
  env: { ...process.env, NODE_ENV: 'production' },
  stdio: 'inherit',
  windowsHide: true,
});
children.add(server);

server.on('exit', (code) => {
  children.delete(server);
  if (!stopping) stopAll(code || 1, '[launcher] Game server stopped unexpectedly.');
});

void waitForHealth();

process.on('SIGINT', () => stopAll(0));
process.on('SIGTERM', () => stopAll(0));

async function waitForHealth() {
  const port = process.env.PORT || '3000';
  for (let attempt = 1; attempt <= 20 && !stopping; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) {
        console.log(`[launcher] Health check passed on port ${port}.`);
        return;
      }
    } catch {
      // The child process is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  if (!stopping) stopAll(1, '[launcher] Server health check failed.');
}

function stopAll(exitCode, message) {
  if (stopping) return;
  stopping = true;
  if (message) console.error(message);
  for (const child of children) {
    if (!child.killed) child.kill('SIGTERM');
  }
  setTimeout(() => process.exit(exitCode), 250).unref();
}
