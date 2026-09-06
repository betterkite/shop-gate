import type { StrategyCatalogItem, StrategyTemplate } from './strategy-types';

export function readinessFor(template: StrategyTemplate): StrategyCatalogItem['readiness'] {
  if (template.dataReadiness?.missing.length) {
    return {
      label: template.status === 'research' ? '需补数据' : '可执行',
      score: template.status === 'research' ? 64 : 82,
      riskLevel: template.status === 'research' ? 'high' : 'medium',
      summary:
        template.status === 'research'
          ? `策略口径明确，但仍缺 ${template.dataReadiness.missing.slice(0, 2).join('、')} 等数据。`
          : '可基于现有日线数据执行，部分盘中细节需人工确认。',
    };
  }
  if (template.status === 'ready') {
    return {
      label: template.kind === 'stock_selection' ? '可选股' : template.kind === 'trade_price' ? '可定价' : '可回测',
      score: 92,
      riskLevel: 'medium',
      summary: '已接入本地日线数据和回测端点，可生成可复现参数、净值、回撤和交易明细。',
    };
  }
  if (template.status === 'research') {
    return {
      label: '研究中',
      score: 68,
      riskLevel: 'medium',
      summary: '可生成策略研究工作空间，但收益验证前必须展示假设和待验证项。',
    };
  }
  return {
    label: '规划中',
    score: 54,
    riskLevel: 'medium',
    summary: '策略设计方向明确，等待补齐数据接口、参数扫描或回测脚本。',
  };
}
