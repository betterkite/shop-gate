#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { createAuthenticatedStorageState, getVisualCredentials } = require('./visual-auth');

const rootDir = path.join(__dirname, '..', '..');
const outputDir = path.join(rootDir, 'tmp', 'visual-checks', 'analytics-workbench');
const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
const baseUrl = (process.env.ANALYTICS_WORKBENCH_URL || 'http://localhost:3000').replace(/\/+$/, '');
const datasetId = process.env.ANALYTICS_WORKBENCH_DATASET_ID || 'retail-demo-p28-elasticity-v1';
const drilldownUrl = `${baseUrl}/analytics-workbench?view=drilldown&dataset_id=${encodeURIComponent(datasetId)}&dimension=item&value=1000009`;
const inventoryUrl = `${baseUrl}/analytics-workbench?view=inventory&dataset_id=${encodeURIComponent(datasetId)}&page=1`;
const profiles = [
  { id: 'desktop-light', viewport: { width: 1440, height: 900 }, hasTouch: false, isMobile: false },
  { id: 'mobile-light', viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true },
];

function clean(value) {
  return String(value).replace(/\s+/g, ' ').trim();
}

function fail(message, details = []) {
  console.error(`\n❌ 经营分析 BI 视觉检查失败：${message}`);
  for (const detail of details) console.error(`- ${detail}`);
  process.exitCode = 1;
}

async function inspectProfile(browser, storageState, profile) {
  const context = await browser.newContext({
    storageState,
    viewport: profile.viewport,
    hasTouch: profile.hasTouch,
    isMobile: profile.isMobile,
    colorScheme: 'light',
    deviceScaleFactor: 1,
  });
  const page = await context.newPage();
  const pageErrors = [];
  const failedResources = [];
  page.on('pageerror', (error) => pageErrors.push(clean(error.message)));
  page.on('response', (response) => {
    if (response.status() < 400) return;
    const type = response.request().resourceType();
    if (['document', 'script', 'stylesheet', 'font', 'fetch', 'xhr'].includes(type)) {
      failedResources.push(`${response.status()} ${type} ${response.url()}`);
    }
  });

  try {
    const response = await page.goto(drilldownUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    if (!response?.ok() || new URL(page.url()).pathname === '/login') {
      return { profile: profile.id, problems: [`页面请求或登录失败：HTTP ${response?.status() ?? '无响应'}`] };
    }
    await page.getByRole('heading', { name: '当前查看范围的日趋势' }).waitFor({ state: 'visible', timeout: 20_000 });
    const state = await page.evaluate(() => {
      const nav = document.querySelector('nav[aria-label="经营分析 BI视图"]');
      const text = document.body.innerText;
      return {
        pageOverflow: document.documentElement.scrollWidth > window.innerWidth + 1,
        navOverflow: Boolean(nav && nav.scrollWidth > nav.clientWidth + 1),
        trend: text.includes('当前查看范围的日趋势'),
        scope: text.includes('当前查看条件：') && text.includes('1000009'),
        metrics: text.includes('页面浏览量（PV）') && text.includes('购买转化率'),
        table: document.querySelectorAll('table').length > 0,
        keepFilterLink: [...document.querySelectorAll('a')].some((link) => link.textContent?.includes('回到总览（保留当前筛选）')),
        contextLink: [...document.querySelectorAll('a')].some((link) => link.textContent?.includes('打开这份明细结果')),
      };
    });
    fs.mkdirSync(outputDir, { recursive: true });
    const screenshotPath = path.join(outputDir, `${profile.id}-${timestamp}.png`);
    await page.screenshot({ path: screenshotPath, fullPage: true });
    const problems = [];
    if (state.pageOverflow) problems.push(`${profile.id}: 页面出现横向溢出`);
    if (!state.trend) problems.push(`${profile.id}: 缺少当前下钻范围趋势`);
    if (!state.scope) problems.push(`${profile.id}: 缺少商品筛选上下文`);
    if (!state.metrics) problems.push(`${profile.id}: 缺少中文指标标签`);
    if (!state.table) problems.push(`${profile.id}: 缺少下钻结果表`);
    if (!state.keepFilterLink || !state.contextLink) problems.push(`${profile.id}: 缺少筛选保留或上下文链接`);
    problems.push(...failedResources.map((item) => `${profile.id}: 资源失败 ${item}`));
    problems.push(...pageErrors.map((item) => `${profile.id}: 页面错误 ${item}`));

    const inventoryResponse = await page.goto(inventoryUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    if (!inventoryResponse?.ok() || new URL(page.url()).pathname === '/login') {
      problems.push(`${profile.id}: 库存页请求或登录失败`);
    } else {
      await page.getByRole('heading', { name: '库存健康' }).waitFor({ state: 'visible', timeout: 20_000 });
      const firstPage = await page.evaluate(() => {
        const text = document.body.innerText;
        return {
          allCount: /全部商品\s+[\d,]+\s+个/.test(text),
          pageSize: text.includes('每页 20 个'),
          nextPage: text.includes('下一页'),
          rowCount: document.querySelectorAll('table tbody tr').length,
          firstRow: document.querySelector('table tbody tr')?.textContent?.trim() || '',
          detailLink: [...document.querySelectorAll('a')].some((link) => link.textContent?.includes('查看商品明细')),
        };
      });
      const inventoryPage2Response = await page.goto(inventoryUrl.replace('page=1', 'page=2'), { waitUntil: 'domcontentloaded', timeout: 30_000 });
      if (!inventoryPage2Response?.ok()) problems.push(`${profile.id}: 库存第 2 页请求失败`);
      await page.getByRole('heading', { name: '库存健康' }).waitFor({ state: 'visible', timeout: 20_000 });
      const secondPageFirstRow = await page.locator('table tbody tr').first().textContent().catch(() => '');
      if (!firstPage.allCount) problems.push(`${profile.id}: 库存页缺少全部商品数量`);
      if (!firstPage.pageSize || !firstPage.nextPage) problems.push(`${profile.id}: 库存页缺少每页 20 个或翻页说明`);
      if (firstPage.rowCount < 20) problems.push(`${profile.id}: 库存第一页不足 20 行`);
      if (!firstPage.detailLink) problems.push(`${profile.id}: 库存页缺少查看商品明细入口`);
      if (!secondPageFirstRow || secondPageFirstRow === firstPage.firstRow) problems.push(`${profile.id}: 库存第 2 页未展示不同商品`);
      const inventoryScreenshotPath = path.join(outputDir, `inventory-${profile.id}-${timestamp}.png`);
      await page.screenshot({ path: inventoryScreenshotPath, fullPage: true });
      return { profile: profile.id, state, screenshotPath, inventoryScreenshotPath, problems };
    }
    return { profile: profile.id, state, screenshotPath, problems };
  } finally {
    await context.close();
  }
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  try {
    const credentials = getVisualCredentials('ANALYTICS_WORKBENCH');
    const storageState = await createAuthenticatedStorageState(browser, baseUrl, credentials);
    const results = [];
    for (const profile of profiles) results.push(await inspectProfile(browser, storageState, profile));
    const problems = results.flatMap((result) => result.problems || []);
    if (problems.length) {
      fail('关键桌面/移动结构不符合预期', problems);
      return;
    }
    console.log('✅ 经营分析 BI 桌面/移动视觉检查通过');
    console.log(`数据集：${datasetId}`);
    for (const result of results) console.log(`${result.profile}: screenshot=${result.screenshotPath}`);
  } finally {
    await browser.close();
  }
}

main().catch((error) => fail(error instanceof Error ? error.message : String(error)));
