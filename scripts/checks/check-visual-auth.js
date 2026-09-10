#!/usr/bin/env node

const { chromium } = require('playwright');
const { createAuthenticatedStorageState, getVisualCredentials } = require('./visual-auth');

const baseUrl = (process.env.SHOPGATE_WEB_URL || 'http://localhost:3000').replace(/\/+$/, '');

async function main() {
  const browser = await chromium.launch({ headless: true });
  const credentials = getVisualCredentials('VISUAL_AUTH');

  try {
    const storageState = await createAuthenticatedStorageState(browser, baseUrl, credentials);
    const context = await browser.newContext({ storageState });
    try {
      const page = await context.newPage();
      const response = await page.goto(`${baseUrl}/`, {
        waitUntil: 'domcontentloaded',
        timeout: 30_000,
      });
      if (!response?.ok()) {
        throw new Error(`首页请求返回 HTTP ${response?.status() ?? '无响应'}`);
      }
      if (new URL(page.url()).pathname === '/login') {
        throw new Error('登录态未复用，首页仍跳转到 /login');
      }
      await page.locator('textarea[aria-label="经营分析需求"]').waitFor({
        state: 'visible',
        timeout: 20_000,
      });

      const projects = await context.request.get(`${baseUrl}/api/projects`);
      if (!projects.ok()) {
        throw new Error(`登录态项目接口返回 HTTP ${projects.status()}`);
      }
      console.log('✅ 登录态视觉 smoke 通过');
      console.log(`地址：${baseUrl}/`);
      console.log('检查：首页未回到登录页、经营分析输入框可见、项目接口返回 2xx');
    } finally {
      await context.request.post(`${baseUrl}/api/auth/sign-out`).catch(() => {});
      await context.close();
    }
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(`❌ 登录态视觉 smoke 失败：${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
