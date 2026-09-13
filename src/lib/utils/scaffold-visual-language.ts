/**
 * Shared visual language for generated Shop Gate dashboards.
 *
 * Retail workbenches should read as one continuous analytical surface. The
 * selectors deliberately have more specificity than the legacy template CSS so
 * restored and scenario-specific dashboards cannot drift back to floating card
 * grids merely because their older component class names still contain `card`.
 */
export function baseDashboardWorkbenchCss(): string {
  return `
/* ==================== RETAIL WORKBENCH CANVAS ==================== */

.dashboard-shell[data-visual-language="retail-workbench"] {
  width: min(1440px, 100vw);
  margin: 0 auto;
  padding: 0 28px 48px;
  border-inline: 1px solid var(--line);
  background: var(--panel);
  --shadow-sm: none;
  --shadow-md: none;
}

.dashboard-shell[data-visual-language="retail-workbench"] .hero-panel {
  margin: 0;
  padding: 18px 0 16px;
  border: 0;
  border-bottom: 1px solid var(--line);
  border-radius: 0;
  background: transparent;
  box-shadow: none;
}

.dashboard-shell[data-visual-language="retail-workbench"] .meta-row,
.dashboard-shell[data-visual-language="retail-workbench"] .insight-strip {
  gap: 0;
  border-block: 1px solid var(--line-light);
}

.dashboard-shell[data-visual-language="retail-workbench"] .meta-row .meta-item,
.dashboard-shell[data-visual-language="retail-workbench"] .insight-strip article {
  border: 0;
  border-right: 1px solid var(--line-light);
  border-radius: 0;
  background: transparent;
}

.dashboard-shell[data-visual-language="retail-workbench"] .meta-row .meta-item:last-of-type,
.dashboard-shell[data-visual-language="retail-workbench"] .insight-strip article:last-child {
  border-right: 0;
}

.dashboard-shell[data-visual-language="retail-workbench"] .metric-strip {
  margin: 0;
  border-inline: 0;
  border-radius: 0;
}

.dashboard-shell[data-visual-language="retail-workbench"] .chart-zone,
.dashboard-shell[data-visual-language="retail-workbench"] .content-grid,
.dashboard-shell[data-visual-language="retail-workbench"] .content-grid.wide,
.dashboard-shell[data-visual-language="retail-workbench"] .backtest-grid {
  gap: 0;
  margin: 0;
  border-bottom: 1px solid var(--line);
}

.dashboard-shell[data-visual-language="retail-workbench"] .chart-panel,
.dashboard-shell[data-visual-language="retail-workbench"] .data-panel {
  border: 0;
  border-radius: 0;
  background: var(--panel);
  box-shadow: none;
}

.dashboard-shell[data-visual-language="retail-workbench"] .chart-zone > * + *,
.dashboard-shell[data-visual-language="retail-workbench"] .content-grid > * + *,
.dashboard-shell[data-visual-language="retail-workbench"] .backtest-grid > * + * {
  border-left: 1px solid var(--line);
}

.dashboard-shell[data-visual-language="retail-workbench"] .trend-chart,
.dashboard-shell[data-visual-language="retail-workbench"] .volume-chart,
.dashboard-shell[data-visual-language="retail-workbench"] .profit-chart,
.dashboard-shell[data-visual-language="retail-workbench"] .chart-empty-state,
.dashboard-shell[data-visual-language="retail-workbench"] .correlation-row,
.dashboard-shell[data-visual-language="retail-workbench"] .compact-row {
  border-radius: 0;
  box-shadow: none;
}

@media (max-width: 800px) {
  .dashboard-shell[data-visual-language="retail-workbench"] {
    width: 100%;
    padding: 0 12px 32px;
    border-inline: 0;
  }

  .dashboard-shell[data-visual-language="retail-workbench"] .chart-zone > * + *,
  .dashboard-shell[data-visual-language="retail-workbench"] .content-grid > * + *,
  .dashboard-shell[data-visual-language="retail-workbench"] .backtest-grid > * + * {
    border-left: 0;
    border-top: 1px solid var(--line);
  }
}
`;
}
