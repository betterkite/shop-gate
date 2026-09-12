#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { createAuthenticatedStorageState, getVisualCredentials } = require('./visual-auth');

const rootDir = path.join(__dirname, '..', '..');
const outputDir = path.join(rootDir, 'tmp', 'visual-checks', 'analytics-workbench');
const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
const baseUrl = (process.env.ANALYTICS_WORKBENCH_URL || 'http://localhost:3000').replace(/\/+$/, '');
const commerceApiBase = (process.env.SHOPGATE_MARKET_API_URL || 'http://127.0.0.1:8000').replace(/\/+$/, '');
const datasetId = process.env.ANALYTICS_WORKBENCH_DATASET_ID || 'retail-demo-p28-elasticity-v1';
const drilldownUrl = `${baseUrl}/analytics-workbench?view=drilldown&dataset_id=${encodeURIComponent(datasetId)}&dimension=item&value=1000009`;
const scopedOverviewUrl = `${baseUrl}/analytics-workbench?view=overview&dataset_id=${encodeURIComponent(datasetId)}&filter_dimension=item&filter_value=1000009`;
const scopedChannelDrilldownUrl = `${baseUrl}/analytics-workbench?view=drilldown&dataset_id=${encodeURIComponent(datasetId)}&dimension=channel&value=organic&filter_dimension=category&filter_value=10009`;
const inventoryUrl = `${baseUrl}/analytics-workbench?view=inventory&dataset_id=${encodeURIComponent(datasetId)}&page=1`;
const inventoryHealthUrl = `${inventoryUrl}&health=${encodeURIComponent('缺货风险')}`;
const scopedInventoryUrl = `${baseUrl}/analytics-workbench?view=inventory&dataset_id=${encodeURIComponent(datasetId)}&filter_dimension=item&filter_value=1000009&page=1`;
const replenishmentUrl = baseUrl + '/analytics-workbench?view=replenishment&dataset_id=' + encodeURIComponent(datasetId) + '&page=1';
const replenishmentPriorityUrl = `${replenishmentUrl}&priority=${encodeURIComponent('优先评估补货')}`;
const customerUrl = `${baseUrl}/analytics-workbench?view=customers&dataset_id=${encodeURIComponent(datasetId)}&page=1`;
const customerSegmentUrl = `${customerUrl}&segment=${encodeURIComponent('新近购买')}`;
const retentionUrl = `${baseUrl}/analytics-workbench?view=retention&dataset_id=${encodeURIComponent(datasetId)}`;
const elasticityUrl = `${baseUrl}/analytics-workbench?view=elasticity&dataset_id=${encodeURIComponent(datasetId)}&page=1`;
const elasticityPriceBandUrl = `${elasticityUrl}&price_band=${encodeURIComponent('50-200')}`;
const profitUrl = `${baseUrl}/analytics-workbench?view=profit&dataset_id=${encodeURIComponent(datasetId)}`;
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

async function gotoWithRetry(page, url, options) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await page.goto(url, options);
    } catch (error) {
      if (!String(error?.message || error).includes('ERR_ABORTED') || attempt === 2) throw error;
      await page.waitForTimeout(250 * (attempt + 1));
    }
  }
  return null;
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
  const problems = [];
  let scopedExpected = null;
  try {
    const [overviewResponse, profitResponse] = await Promise.all([
      fetch(`${commerceApiBase}/api/v1/commerce/analytics/overview?dataset_id=${encodeURIComponent(datasetId)}&dimension=item&value=1000009`),
      fetch(`${commerceApiBase}/api/v1/commerce/analytics/profit?dataset_id=${encodeURIComponent(datasetId)}&dimension=item&value=1000009`),
    ]);
    if (overviewResponse.ok && profitResponse.ok) {
      const overview = await overviewResponse.json();
      const profit = await profitResponse.json();
      scopedExpected = {
        orders: Number(overview?.metrics?.orders ?? NaN),
        grossProfit: Number(profit?.total?.gross_profit ?? NaN),
      };
    }
  } catch (error) {
    problems.push(`${profile.id}: 无法读取当前商品范围验收基准：${error instanceof Error ? error.message : String(error)}`);
  }
  page.on('pageerror', (error) => pageErrors.push(clean(error.message)));
  page.on('response', (response) => {
    if (response.status() < 400) return;
    const type = response.request().resourceType();
    if (['document', 'script', 'stylesheet', 'font', 'fetch', 'xhr'].includes(type)) {
      failedResources.push(`${response.status()} ${type} ${response.url()}`);
    }
  });

  try {
    const response = await gotoWithRetry(page, drilldownUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    if (!response?.ok() || new URL(page.url()).pathname === '/login') {
      return { profile: profile.id, problems: [`页面请求或登录失败：HTTP ${response?.status() ?? '无响应'}`] };
    }
    await page.locator('main').getByRole('heading', { name: '当前查看范围的日趋势', exact: true }).waitFor({ state: 'visible', timeout: 20_000 });
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
    if (state.pageOverflow) problems.push(`${profile.id}: 页面出现横向溢出`);
    if (!state.trend) problems.push(`${profile.id}: 缺少当前下钻范围趋势`);
    if (!state.scope) problems.push(`${profile.id}: 缺少商品筛选上下文`);
    if (!state.metrics) problems.push(`${profile.id}: 缺少中文指标标签`);
    if (!state.table) problems.push(`${profile.id}: 缺少下钻结果表`);
    if (!state.keepFilterLink || !state.contextLink) problems.push(`${profile.id}: 缺少筛选保留或上下文链接`);
    problems.push(...failedResources.map((item) => `${profile.id}: 资源失败 ${item}`));
    problems.push(...pageErrors.map((item) => `${profile.id}: 页面错误 ${item}`));

    const scopedOverviewResponse = await gotoWithRetry(page, scopedOverviewUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    if (!scopedOverviewResponse?.ok() || new URL(page.url()).pathname === '/login') {
      problems.push(`${profile.id}: 筛选后的总览页请求或登录失败`);
    } else {
      await page.getByText('当前筛选：商品 1000009', { exact: false }).first().waitFor({ state: 'visible', timeout: 20_000 });
      const scopedOverview = await page.evaluate((expected) => {
        const text = document.body.innerText;
        const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
        const ordersIndex = lines.findIndex((line) => line === '订单数');
        const ordersValue = ordersIndex >= 0 ? lines[ordersIndex + 1] : '';
        const scopedCustomerLink = [...document.querySelectorAll('a')].some((link) => link.getAttribute('href')?.includes('view=customers') && link.getAttribute('href')?.includes('filter_dimension=item') && link.getAttribute('href')?.includes('filter_value=1000009'));
        const lifecycleStageLink = [...document.querySelectorAll('a')].some((link) => link.getAttribute('href')?.includes('view=lifecycle') && link.getAttribute('href')?.includes('stage=') && link.getAttribute('href')?.includes('filter_dimension=item') && link.getAttribute('href')?.includes('filter_value=1000009'));
        const inventoryHealthLink = [...document.querySelectorAll('a')].some((link) => link.getAttribute('href')?.includes('view=inventory') && link.getAttribute('href')?.includes('health=') && link.getAttribute('href')?.includes('filter_dimension=item') && link.getAttribute('href')?.includes('filter_value=1000009'));
        const channelsFullLink = [...document.querySelectorAll('a')].some((link) => link.textContent?.includes('查看全部渠道和活动') && link.getAttribute('href')?.includes('view=channels') && link.getAttribute('href')?.includes('filter_dimension=item') && link.getAttribute('href')?.includes('filter_value=1000009'));
        const retentionLink = [...document.querySelectorAll('a')].some((link) => link.textContent?.includes('查看完整留存分析') && link.getAttribute('href')?.includes('view=retention') && link.getAttribute('href')?.includes('filter_dimension=item') && link.getAttribute('href')?.includes('filter_value=1000009'));
        const replenishmentLink = [...document.querySelectorAll('a')].some((link) => link.textContent?.includes('查看完整补货参考') && link.getAttribute('href')?.includes('view=replenishment') && link.getAttribute('href')?.includes('filter_dimension=item') && link.getAttribute('href')?.includes('filter_value=1000009'));
        return {
          scopeNotice: text.includes('当前筛选：商品 1000009') && text.includes('已按此范围重新计算'),
          scopedOrders: Number.isFinite(expected?.orders) && Number(ordersValue.replaceAll(',', '')) === expected.orders,
          scopedProfit: Number.isFinite(expected?.grossProfit) && text.includes('¥' + new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 }).format(expected.grossProfit)),
            scopedCustomerLink,
          segmentLink: [...document.querySelectorAll('a')].some((link) => link.getAttribute('href')?.includes('view=customers') && link.getAttribute('href')?.includes('segment=')),
          lifecycleStageLink,
          inventoryHealthLink,
          channelsFullLink,
          retentionLink,
          replenishmentLink,
          channelPanel: text.includes('筛选范围的渠道销售') || text.includes('渠道与活动贡献'),
          channelScopeNote: text.includes('不提供') && text.includes('按订单关联渠道统计'),
          inventoryPanel: text.includes('库存健康'),
          lifecyclePanel: text.includes('商品阶段'),
          retentionPanel: text.includes('用户留存'),
          replenishmentPanel: text.includes('补货参考'),
        };
      }, scopedExpected);
      if (!scopedOverview.scopeNotice) problems.push(`${profile.id}: 筛选总览缺少当前范围说明`);
      if (!scopedOverview.scopedOrders) problems.push(`${profile.id}: 筛选总览订单数未按商品范围更新`);
      if (!scopedOverview.scopedProfit) problems.push(`${profile.id}: 筛选总览毛利未按商品范围更新`);
      if (!scopedOverview.scopedCustomerLink) problems.push(`${profile.id}: 筛选总览未保留用户分群范围链接`);
      if (!scopedOverview.segmentLink) problems.push(`${profile.id}: 总览用户分群卡片未保留具体分群链接`);
      if (!scopedOverview.lifecycleStageLink) problems.push(`${profile.id}: 筛选总览商品阶段卡片未保留阶段筛选链接`);
      if (!scopedOverview.inventoryHealthLink) problems.push(`${profile.id}: 筛选总览库存判断卡片未保留库存判断链接`);
      if (!scopedOverview.channelsFullLink) problems.push(`${profile.id}: 筛选总览缺少保留范围的全部渠道入口`);
      if (!scopedOverview.retentionLink) problems.push(`${profile.id}: 筛选总览缺少保留范围的用户留存入口`);
      if (!scopedOverview.replenishmentLink) problems.push(`${profile.id}: 筛选总览缺少保留范围的补货参考入口`);
      if (!scopedOverview.channelPanel || !scopedOverview.channelScopeNote || !scopedOverview.inventoryPanel || !scopedOverview.lifecyclePanel || !scopedOverview.retentionPanel || !scopedOverview.replenishmentPanel) problems.push(`${profile.id}: 筛选总览缺少关联分析模块或口径说明`);
      const scopedOverviewScreenshotPath = path.join(outputDir, `scoped-overview-${profile.id}-${timestamp}.png`);
      await page.screenshot({ path: scopedOverviewScreenshotPath, fullPage: true });
    }

    const scopedChannelResponse = await gotoWithRetry(page, scopedChannelDrilldownUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    if (!scopedChannelResponse?.ok() || new URL(page.url()).pathname === '/login') {
      problems.push(`${profile.id}: 复合渠道明细页请求或登录失败`);
    } else {
      await page.locator('main').getByRole('heading', { name: '当前查看范围的日趋势', exact: true }).waitFor({ state: 'visible', timeout: 20_000 });
      const scopedChannelState = await page.evaluate(() => {
        const text = document.body.innerText;
        return {
          parentScope: text.includes('父级范围：类目 10009'),
          contextLink: [...document.querySelectorAll('a')].some((link) => link.getAttribute('href')?.includes('filter_dimension=category') && link.getAttribute('href')?.includes('filter_value=10009')),
        };
      });
      if (!scopedChannelState.parentScope || !scopedChannelState.contextLink) problems.push(`${profile.id}: 渠道明细未保留商品/类目父级范围`);
    }

    const inventoryResponse = await gotoWithRetry(page, inventoryUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    if (!inventoryResponse?.ok() || new URL(page.url()).pathname === '/login') {
      problems.push(`${profile.id}: 库存页请求或登录失败`);
    } else {
      await page.locator('main').getByRole('heading', { name: '库存健康', exact: true }).waitFor({ state: 'visible', timeout: 20_000 });
      const firstPage = await page.evaluate(() => {
        const text = document.body.innerText;
        return {
          allCount: text.includes('全部商品') && /共\s+[\d,]+\s+个商品/.test(text),
          pageSize: text.includes('每页 20 个'),
          nextPage: text.includes('下一页'),
          rowCount: document.querySelectorAll('table tbody tr').length,
          firstRow: document.querySelector('table tbody tr')?.textContent?.trim() || '',
          detailLink: [...document.querySelectorAll('a')].some((link) => link.textContent?.includes('查看商品明细')),
        };
      });
      const inventoryPage2Response = await gotoWithRetry(page, inventoryUrl.replace('page=1', 'page=2'), { waitUntil: 'commit', timeout: 30_000 });
      if (!inventoryPage2Response?.ok()) problems.push(`${profile.id}: 库存第 2 页请求失败`);
      await page.locator('main').getByRole('heading', { name: '库存健康', exact: true }).waitFor({ state: 'visible', timeout: 20_000 });
      const secondPageFirstRow = await page.locator('table tbody tr').first().textContent().catch(() => '');
      if (!firstPage.allCount) problems.push(`${profile.id}: 库存页缺少全部商品数量`);
      if (!firstPage.pageSize || !firstPage.nextPage) problems.push(`${profile.id}: 库存页缺少每页 20 个或翻页说明`);
      if (firstPage.rowCount < 20) problems.push(`${profile.id}: 库存第一页不足 20 行`);
      if (!firstPage.detailLink) problems.push(`${profile.id}: 库存页缺少查看商品明细入口`);
      if (!secondPageFirstRow || secondPageFirstRow === firstPage.firstRow) problems.push(`${profile.id}: 库存第 2 页未展示不同商品`);
      const inventoryScreenshotPath = path.join(outputDir, `inventory-${profile.id}-${timestamp}.png`);
      await page.screenshot({ path: inventoryScreenshotPath, fullPage: true });

      const scopedInventoryResponse = await gotoWithRetry(page, scopedInventoryUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      if (!scopedInventoryResponse?.ok()) problems.push(`${profile.id}: 商品筛选库存页请求失败`);
      const scopedInventoryNextHref = await page.locator('a').filter({ hasText: '下一页' }).getAttribute('href').catch(() => null);
      if (!scopedInventoryNextHref?.includes('filter_dimension=item') || !scopedInventoryNextHref.includes('filter_value=1000009')) problems.push(`${profile.id}: 商品筛选库存翻页未保留筛选范围`);

      const inventoryHealthResponse = await gotoWithRetry(page, inventoryHealthUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      if (!inventoryHealthResponse?.ok()) problems.push(`${profile.id}: 库存判断筛选页请求失败`);
      await page.locator('main').getByRole('heading', { name: '库存健康', exact: true }).waitFor({ state: 'visible', timeout: 20_000 });
      await page.getByText('当前查看：缺货风险', { exact: false }).first().waitFor({ state: 'visible', timeout: 20_000 });
      const inventoryHealthState = await page.evaluate(() => {
        const text = document.body.innerText;
        const rows = [...document.querySelectorAll('table tbody tr')];
        return {
          selected: text.includes('当前查看：缺货风险'),
          allRowsMatch: rows.length === 0 || rows.every((row) => row.textContent?.includes('缺货风险')),
          linksKeepHealth: [...document.querySelectorAll('a')].filter((link) => link.textContent?.includes('下一页')).every((link) => link.getAttribute('href')?.includes('health=')),
        };
      });
      if (!inventoryHealthState.selected || !inventoryHealthState.allRowsMatch || !inventoryHealthState.linksKeepHealth) problems.push(`${profile.id}: 库存判断筛选未生效或翻页未保留判断条件`);

      const replenishmentResponse = await gotoWithRetry(page, replenishmentUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      if (!replenishmentResponse?.ok()) {
        problems.push(profile.id + ': 补货参考页请求失败');
      } else {
        await page.locator('main').getByRole('heading', { name: '补货参考', exact: true }).waitFor({ state: 'visible', timeout: 20_000 });
        const replenishmentState = await page.evaluate(() => {
          const text = document.body.innerText;
          return {
            summary: text.includes('优先评估补货') && text.includes('参考补货件数'),
            assumptions: text.includes('供货周期') && text.includes('目标覆盖'),
            pageSize: text.includes('每页 20 个'),
            rowCount: document.querySelectorAll('table tbody tr').length,
            firstRow: document.querySelector('table tbody tr')?.textContent?.trim() || '',
            nextPage: text.includes('下一页'),
          };
        });
        const replenishmentPage2Response = await gotoWithRetry(page, replenishmentUrl.replace('page=1', 'page=2'), { waitUntil: 'commit', timeout: 30_000 });
        if (!replenishmentPage2Response?.ok()) problems.push(profile.id + ': 补货参考第 2 页请求失败');
        await page.locator('main').getByRole('heading', { name: '补货参考', exact: true }).waitFor({ state: 'visible', timeout: 20_000 });
        const secondReplenishmentFirstRow = await page.locator('table tbody tr').first().textContent().catch(() => '');
        if (!replenishmentState.summary || !replenishmentState.assumptions) problems.push(profile.id + ': 补货参考页缺少摘要或假设说明');
        if (!replenishmentState.pageSize || !replenishmentState.nextPage || replenishmentState.rowCount < 20) problems.push(profile.id + ': 补货参考页缺少每页 20 个或翻页内容');
        if (!secondReplenishmentFirstRow || secondReplenishmentFirstRow === replenishmentState.firstRow) problems.push(profile.id + ': 补货参考第 2 页未展示不同商品');
        const replenishmentPriorityResponse = await gotoWithRetry(page, replenishmentPriorityUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
        if (!replenishmentPriorityResponse?.ok()) problems.push(`${profile.id}: 补货判断筛选页请求失败`);
        await page.locator('main').getByRole('heading', { name: '补货参考', exact: true }).waitFor({ state: 'visible', timeout: 20_000 });
        await page.getByText('当前查看：优先评估补货', { exact: false }).first().waitFor({ state: 'visible', timeout: 20_000 });
        const replenishmentPriorityState = await page.evaluate(() => {
          const text = document.body.innerText;
          const rows = [...document.querySelectorAll('table tbody tr')];
          return {
            selected: text.includes('当前查看：优先评估补货'),
            allRowsMatch: rows.length === 0 || rows.every((row) => row.textContent?.includes('优先评估补货')),
            linksKeepPriority: [...document.querySelectorAll('a')].filter((link) => link.textContent?.includes('下一页')).every((link) => link.getAttribute('href')?.includes('priority=')),
          };
        });
        if (!replenishmentPriorityState.selected || !replenishmentPriorityState.allRowsMatch || !replenishmentPriorityState.linksKeepPriority) problems.push(`${profile.id}: 补货判断筛选未生效或翻页未保留判断条件`);
        const replenishmentScreenshotPath = path.join(outputDir, 'replenishment-' + profile.id + '-' + timestamp + '.png');
        await page.screenshot({ path: replenishmentScreenshotPath, fullPage: true });
      }

      const customerResponse = await gotoWithRetry(page, customerUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      if (!customerResponse?.ok()) {
        problems.push(`${profile.id}: 用户分群页请求失败`);
      } else {
        await page.locator('main').getByRole('heading', { name: '用户分群（RFM）', exact: true }).waitFor({ state: 'visible', timeout: 20_000 });
        const firstCustomerPage = await page.evaluate(() => {
          const text = document.body.innerText;
          return {
            allCount: /全部用户\s+[\d,]+\s+个/.test(text),
            pageSize: text.includes('每页 20 个'),
            rowCount: document.querySelectorAll('table tbody tr').length,
            firstRow: document.querySelector('table tbody tr')?.textContent?.trim() || '',
            detailLink: [...document.querySelectorAll('a')].some((link) => link.textContent?.includes('查看用户明细')),
          };
        });
        const customerPage2Response = await gotoWithRetry(page, customerUrl.replace('page=1', 'page=2'), { waitUntil: 'commit', timeout: 30_000 });
        if (!customerPage2Response?.ok()) problems.push(`${profile.id}: 用户分群第 2 页请求失败`);
        await page.locator('main').getByRole('heading', { name: '用户分群（RFM）', exact: true }).waitFor({ state: 'visible', timeout: 20_000 });
        const secondCustomerFirstRow = await page.locator('table tbody tr').first().textContent().catch(() => '');
        if (!firstCustomerPage.allCount) problems.push(`${profile.id}: 用户分群页缺少全部用户数量`);
        if (!firstCustomerPage.pageSize) problems.push(`${profile.id}: 用户分群页缺少每页 20 个说明`);
        if (firstCustomerPage.rowCount < 20) problems.push(`${profile.id}: 用户分群第一页不足 20 行`);
        if (!firstCustomerPage.detailLink) problems.push(`${profile.id}: 用户分群页缺少查看明细入口`);
        if (!secondCustomerFirstRow || secondCustomerFirstRow === firstCustomerPage.firstRow) problems.push(`${profile.id}: 用户分群第 2 页未展示不同用户`);
        const customerScreenshotPath = path.join(outputDir, `customers-${profile.id}-${timestamp}.png`);
        await page.screenshot({ path: customerScreenshotPath, fullPage: true });

        const customerSegmentResponse = await gotoWithRetry(page, customerSegmentUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
        if (!customerSegmentResponse?.ok()) problems.push(`${profile.id}: 指定用户分群页请求失败`);
        await page.getByText('当前分群：新近购买', { exact: false }).first().waitFor({ state: 'visible', timeout: 20_000 });
        const customerSegmentState = await page.evaluate(() => ({
          label: document.body.innerText.includes('当前分群：新近购买'),
          rows: document.querySelectorAll('table tbody tr').length,
          nextHref: [...document.querySelectorAll('a')].find((link) => link.textContent?.includes('下一页'))?.getAttribute('href') || '',
        }));
        if (!customerSegmentState.label || customerSegmentState.rows === 0) problems.push(`${profile.id}: 指定用户分群页未按分群过滤`);
        if (!customerSegmentState.nextHref.includes('segment=')) problems.push(`${profile.id}: 用户分群翻页未保留分群条件`);
      }

      const retentionResponse = await gotoWithRetry(page, retentionUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      if (!retentionResponse?.ok()) {
        problems.push(`${profile.id}: 用户留存页请求失败`);
      } else {
        await page.locator('main').getByRole('heading', { name: '用户留存分析', exact: true }).waitFor({ state: 'visible', timeout: 20_000 });
        const retentionState = await page.evaluate(() => {
          const text = document.body.innerText;
          return {
            definition: text.includes('第一次购买所在周') && text.includes('是否再次购买'),
            metrics: text.includes('7 日留存率') && text.includes('首购用户数'),
            cohortTable: text.includes('首购周') && document.querySelectorAll('table tbody tr').length > 0,
          };
        });
        if (!retentionState.definition) problems.push(`${profile.id}: 用户留存页缺少口径说明`);
        if (!retentionState.metrics) problems.push(`${profile.id}: 用户留存页缺少核心指标`);
        if (!retentionState.cohortTable) problems.push(`${profile.id}: 用户留存页缺少 cohort 表格`);
        const retentionScreenshotPath = path.join(outputDir, `retention-${profile.id}-${timestamp}.png`);
        await page.screenshot({ path: retentionScreenshotPath, fullPage: true });
      }

      const profitResponse = await gotoWithRetry(page, profitUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      if (!profitResponse?.ok()) {
        problems.push(`${profile.id}: 毛利分析页请求失败`);
      } else {
        await page.locator('main').getByRole('heading', { name: '毛利分析', exact: true }).waitFor({ state: 'visible', timeout: 20_000 });
        const profitState = await page.evaluate(() => ({
          detailLink: [...document.querySelectorAll('a')].some((link) => link.textContent?.includes('查看渠道明细')),
          detailHref: [...document.querySelectorAll('a')].some((link) => link.getAttribute('href')?.includes('view=drilldown') && link.getAttribute('href')?.includes('dimension=channel')),
        }));
        if (!profitState.detailLink || !profitState.detailHref) problems.push(`${profile.id}: 毛利分析缺少渠道明细链接`);
      }

      const elasticityResponse = await gotoWithRetry(page, elasticityUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      if (!elasticityResponse?.ok()) {
        problems.push(`${profile.id}: 价格弹性页请求失败`);
      } else {
        await page.locator('main').getByRole('heading', { name: '价格带对比与价格弹性参考', exact: true }).waitFor({ state: 'visible', timeout: 20_000 });
        const firstElasticityPage = await page.evaluate(() => {
          const text = document.body.innerText;
          const tables = [...document.querySelectorAll('table')];
          return {
            observations: /商品级价格观察（共\s+[\d,]+\s+个，每页 20 个）/.test(text),
            priceBandLink: [...document.querySelectorAll('a')].some((link) => link.getAttribute('href')?.includes('price_band=')),
            itemDetailLink: [...document.querySelectorAll('a')].some((link) => link.getAttribute('href')?.includes('view=drilldown') && link.getAttribute('href')?.includes('dimension=item')),
            rowCount: tables[0]?.querySelectorAll('tbody tr').length || 0,
            firstRow: tables[0]?.querySelector('tbody tr')?.textContent?.trim() || '',
            nextPage: text.includes('下一页'),
          };
        });
        const elasticityPage2Response = await gotoWithRetry(page, elasticityUrl.replace('page=1', 'page=2'), { waitUntil: 'commit', timeout: 30_000 });
        if (!elasticityPage2Response?.ok()) problems.push(`${profile.id}: 价格弹性第 2 页请求失败`);
        await page.locator('main').getByRole('heading', { name: '价格带对比与价格弹性参考', exact: true }).waitFor({ state: 'visible', timeout: 20_000 });
        const secondElasticityFirstRow = await page.locator('table').first().locator('tbody tr').first().textContent().catch(() => '');
        if (!firstElasticityPage.observations) problems.push(`${profile.id}: 价格弹性页缺少商品观察总数/分页说明`);
        if (!firstElasticityPage.priceBandLink) problems.push(`${profile.id}: 价格弹性页缺少价格带筛选入口`);
        if (!firstElasticityPage.itemDetailLink) problems.push(`${profile.id}: 价格观察缺少商品明细入口`);
        if (!firstElasticityPage.nextPage) problems.push(`${profile.id}: 价格弹性页缺少翻页入口`);
        if (firstElasticityPage.rowCount < 20) problems.push(`${profile.id}: 价格弹性第一页不足 20 行`);
        if (!secondElasticityFirstRow || secondElasticityFirstRow === firstElasticityPage.firstRow) problems.push(`${profile.id}: 价格弹性第 2 页未展示不同商品`);
        const elasticityPriceBandResponse = await gotoWithRetry(page, elasticityPriceBandUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
        if (!elasticityPriceBandResponse?.ok()) problems.push(`${profile.id}: 价格带筛选页请求失败`);
        await page.locator('main').getByRole('heading', { name: '价格带对比与价格弹性参考', exact: true }).waitFor({ state: 'visible', timeout: 20_000 });
        await page.getByText('当前查看：¥50-200', { exact: false }).first().waitFor({ state: 'visible', timeout: 20_000 });
        const elasticityPriceBandState = await page.evaluate(() => {
          const tables = [...document.querySelectorAll('table')];
          const bandRows = tables.at(-1)?.querySelectorAll('tbody tr') || [];
          return {
            selected: document.body.innerText.includes('当前查看：¥50-200'),
            oneBand: bandRows.length === 0 || [...bandRows].every((row) => row.textContent?.includes('50-200')),
          };
        });
        if (!elasticityPriceBandState.selected || !elasticityPriceBandState.oneBand) problems.push(`${profile.id}: 价格带筛选未生效或仍展示其他价格带`);
        const elasticityScreenshotPath = path.join(outputDir, `elasticity-${profile.id}-${timestamp}.png`);
        await page.screenshot({ path: elasticityScreenshotPath, fullPage: true });
      }

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
