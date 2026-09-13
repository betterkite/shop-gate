/** Runtime scripts embedded into generated Shop Gate workspaces. */
export function generatedDevScriptContents(): string {
  return `#!/usr/bin/env node

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const projectRoot = path.join(__dirname, '..');
const isWindows = process.platform === 'win32';

function parseCliArgs(argv) {
  const passthrough = [];
  let preferredPort;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--port' || arg === '-p') {
      const value = argv[i + 1];
      if (value && !value.startsWith('-')) {
        const parsed = Number.parseInt(value, 10);
        if (!Number.isNaN(parsed)) preferredPort = parsed;
        i += 1;
        continue;
      }
    } else if (arg.startsWith('--port=')) {
      const parsed = Number.parseInt(arg.slice('--port='.length), 10);
      if (!Number.isNaN(parsed)) preferredPort = parsed;
      continue;
    } else if (arg.startsWith('-p=')) {
      const parsed = Number.parseInt(arg.slice('-p='.length), 10);
      if (!Number.isNaN(parsed)) preferredPort = parsed;
      continue;
    }
    passthrough.push(arg);
  }
  return { preferredPort, passthrough };
}

function resolvePort(preferredPort) {
  const candidates = [preferredPort, process.env.PORT, process.env.WEB_PORT, process.env.PREVIEW_PORT_START, 4100];
  for (const candidate of candidates) {
    if (candidate === undefined || candidate === null) continue;
    const numeric = typeof candidate === 'number' ? candidate : Number.parseInt(String(candidate), 10);
    if (!Number.isNaN(numeric) && numeric > 0 && numeric <= 65535) return numeric;
  }
  return 4100;
}

(async () => {
  const { preferredPort, passthrough } = parseCliArgs(process.argv.slice(2));
  const port = resolvePort(preferredPort);
  const url = process.env.NEXT_PUBLIC_APP_URL || \`http://localhost:\${port}\`;
  process.env.PORT = String(port);
  process.env.WEB_PORT = String(port);
  process.env.NEXT_PUBLIC_APP_URL = url;
  console.log(\`🚀 Starting Next.js dev server on \${url}\`);
  const hasProductionBuild = fs.existsSync(path.join(projectRoot, '.next', 'BUILD_ID'));
  const hasBundlerFlag = passthrough.some((arg) => ['--webpack', '--turbo', '--turbopack'].includes(arg));
  const defaultBundlerArgs = hasBundlerFlag ? [] : ['--webpack'];
  const commandArgs = hasProductionBuild
    ? ['next', 'start', '--port', String(port), ...passthrough]
    : ['next', 'dev', ...defaultBundlerArgs, '--port', String(port), ...passthrough];
  const runtimeEnv = {
    ...process.env,
    PORT: String(port),
    WEB_PORT: String(port),
    NEXT_PUBLIC_APP_URL: url,
    SHOPGATE_WORKSPACE_ROOT: process.env.SHOPGATE_WORKSPACE_ROOT || path.resolve(projectRoot, '../../..'),
    NEXT_TELEMETRY_DISABLED: '1',
  };
  const child = spawn('npx', commandArgs, { cwd: projectRoot, stdio: 'inherit', shell: isWindows, env: runtimeEnv });
  child.on('exit', (code) => {
    if (typeof code === 'number' && code !== 0) {
      console.error(\`❌ Next.js dev server exited with code \${code}\`);
      process.exit(code);
    }
  });
  child.on('error', (error) => {
    console.error('❌ Failed to start Next.js dev server');
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
})();
`;
}
