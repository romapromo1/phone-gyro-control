import { spawn, execSync } from 'child_process';

// Automatic self-healing: Clean up leftover processes on Windows before starting
if (process.platform === 'win32') {
  try {
    console.log('Checking for leftover cloudflared processes...');
    execSync('taskkill /F /IM cloudflared.exe', { stdio: 'ignore' });
  } catch (e) {
    // Process wasn't running, ignore error
  }

  try {
    console.log('Checking for leftover servers on port 3000...');
    const stdout = execSync('netstat -ano', { encoding: 'utf8' });
    const lines = stdout.split('\n');
    for (const line of lines) {
      if (line.includes(':3000') && line.includes('LISTENING')) {
        const parts = line.trim().split(/\s+/);
        const pid = parts[parts.length - 1];
        if (pid && pid !== '0') {
          console.log(`Terminating conflicting process (PID: ${pid}) occupying port 3000...`);
          execSync(`taskkill /F /PID ${pid}`, { stdio: 'ignore' });
        }
      }
    }
  } catch (e) {
    // Port was already free, ignore error
  }
}

console.log('Starting Cloudflare Quick Tunnel on port 3000 (HTTP/2 mode + no prechecks)...');
// Spawn cloudflared to tunnel HTTPS local server
// - Force protocol HTTP2 to bypass QUIC/UDP blocking on VPNs
// - Use IPv4 127.0.0.1 to avoid localhost IPv6 resolution bugs
// - Add --no-prechecks so that cloudflared doesn't hard-fail/exit due to VPN routing restrictions
const cf = spawn('npx', ['--yes', 'cloudflared', 'tunnel', '--url', 'https://127.0.0.1:3000', '--no-tls-verify', '--protocol', 'http2', '--no-prechecks'], { shell: true });

let serverStarted = false;

function checkOutput(output) {
  // Extract URL (looks like: "https://xxx.trycloudflare.com")
  const match = output.match(/(https:\/\/[a-zA-Z0-9.-]+\.trycloudflare\.com)/i);
  if (match && !serverStarted) {
    serverStarted = true;
    const tunnelUrl = match[1].trim();
    console.log(`\n=============================================================`);
    console.log(`PUBLIC ACCESSIBLE TUNNEL RUNNING (NO WARNING PAGES):`);
    console.log(`URL: ${tunnelUrl}`);
    console.log(`=============================================================\n`);
    
    console.log('Starting game development server...');
    // Start Vite dev server with TUNNEL_URL environment variable set
    const devServer = spawn('npm', ['run', 'dev'], {
      shell: true,
      env: { ...process.env, TUNNEL_URL: tunnelUrl },
      stdio: 'inherit' // Pipes stdin/stdout directly to control output in this console window
    });

    devServer.on('close', (code) => {
      console.log(`Game dev server exited with code ${code}`);
      cf.kill();
      process.exit(code || 0);
    });
  }
}

cf.stdout.on('data', (data) => {
  const output = data.toString();
  checkOutput(output);
});

cf.stderr.on('data', (data) => {
  const output = data.toString();
  // Cloudflare prints quick tunnel URL status to stderr
  if (output.includes('trycloudflare.com')) {
    console.log(`[Cloudflare info]: ${output.trim()}`);
  }
  checkOutput(output);
});

cf.on('close', (code) => {
  console.log(`Cloudflare tunnel process exited with code ${code}`);
  if (!serverStarted) {
    console.error('Failed to establish Cloudflare tunnel connection.');
    process.exit(code || 1);
  }
});

// Clean up processes on Ctrl+C / exit
process.on('SIGINT', () => {
  console.log('\nStopping servers and cleaning up tunnel...');
  cf.kill();
  process.exit(0);
});
process.on('SIGTERM', () => {
  cf.kill();
  process.exit(0);
});
