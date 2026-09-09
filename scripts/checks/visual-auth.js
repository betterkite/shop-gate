const fs = require('fs');
const path = require('path');

function readEnvValue(key) {
  const direct = String(process.env[key] || '').trim();
  if (direct) return direct;

  for (const file of ['.env.local', '.env']) {
    let contents = '';
    try {
      contents = fs.readFileSync(path.join(process.cwd(), file), 'utf8');
    } catch {
      continue;
    }
    const match = contents.match(new RegExp(`^${key}\\s*=\\s*(.*)$`, 'm'));
    if (!match) continue;
    const value = match[1].trim().replace(/^(['"])(.*)\1$/, '$2');
    if (value) return value;
  }
  return '';
}

function getVisualCredentials(prefix) {
  return {
    login: readEnvValue(`${prefix}_LOGIN`)
      || readEnvValue('SHOPGATE_AUTH_ADMIN_EMAIL')
      || readEnvValue('SHOPGATE_TASK_E2E_ADMIN_LOGIN')
      || 'admin@shopgate.local',
    password: readEnvValue(`${prefix}_PASSWORD`)
      || readEnvValue('SHOPGATE_AUTH_ADMIN_PASSWORD')
      || readEnvValue('SHOPGATE_TASK_E2E_ADMIN_PASSWORD')
      || 'admin',
  };
}

async function createAuthenticatedStorageState(browser, baseUrl, credentials) {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    colorScheme: 'light',
  });
  const page = await context.newPage();

  try {
    const response = await page.goto(`${baseUrl}/`, {
      waitUntil: 'domcontentloaded',
      timeout: 30_000,
    });
    if (!response?.ok()) {
      throw new Error(`首页请求返回 ${response?.status() ?? '无响应'}`);
    }
    await page.waitForLoadState('networkidle', { timeout: 8_000 }).catch(() => {});

    const identity = page.locator('#identity');
    if (new URL(page.url()).pathname === '/login' || await identity.isVisible().catch(() => false)) {
        await identity.fill(credentials.login);
        await page.locator('#password').fill(credentials.password);
        await page.locator('button[type="submit"]').click();
      await page.waitForFunction(
        () => window.location.pathname !== '/login',
        null,
        { timeout: 20_000 },
      );
    }

    if (new URL(page.url()).pathname === '/login') {
      const alert = await page.locator('[role="alert"]').textContent().catch(() => null);
      throw new Error(alert?.trim() || '视觉检查管理员登录失败');
    }
    return await context.storageState();
  } finally {
    await context.close();
  }
}

module.exports = { createAuthenticatedStorageState, getVisualCredentials };
