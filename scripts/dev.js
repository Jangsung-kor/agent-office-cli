const { spawn } = require('child_process');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const viteBin = path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js');
const officePort = process.env.OFFICE_PORT || '3110';
const childEnv = { ...process.env, OFFICE_PORT: officePort };

const bridge = spawn(process.execPath, [path.join(ROOT, 'server', 'bridge.js')], {
  cwd: ROOT,
  env: childEnv,
  stdio: 'inherit'
});

const vite = spawn(process.execPath, [viteBin], {
  cwd: ROOT,
  env: childEnv,
  stdio: 'inherit'
});

function shutdown(exitCode = 0) {
  if (!bridge.killed) bridge.kill();
  if (!vite.killed) vite.kill();
  process.exit(exitCode);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

bridge.on('exit', code => {
  if (code !== null && code !== 0) {
    console.error(`[dev] bridge 종료 (code=${code})`);
    shutdown(code);
  }
});

vite.on('exit', code => {
  if (code !== null && code !== 0) {
    console.error(`[dev] vite 종료 (code=${code})`);
    shutdown(code);
  }
});
