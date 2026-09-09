# ISSUE-P13 后端遗留清理范围

## 运行入口审计

当前 `commerce-data` 的生产运行图只有：

```text
shopgate-commerce-api
  -> cli.load_market_environment
  -> api.app
  -> routers.commerce.create_commerce_router
  -> retail.* -> database_core.connect -> commerce.* SQL

shopgate-commerce-import
  -> import_cli
  -> database_core.database_url_from_env
  -> synthetic + commerce.* SQL
```

`/health`、`/ready` 和 `RedisJsonCache` 是平台就绪链路；它们不依赖金融数据模块。

## 本次清理范围

以下内容没有被 `api.py`、`cli.py`、`import_cli.py`、`retail.py`、前端 commerce consumer 或当前 commerce SQL 引用，且只服务上游股票/研究域，因此随 P13 删除：

- 股票行情、回测、财务、技术指标和 provider candidate 模块；
- `providers/`、旧金融 `routers/`、`services/`、`repositories/` 和 ClickHouse adapter；
- 旧金融后端测试；
- ClickHouse 可选依赖、Compose 服务、环境初始化和旧行情维护/新鲜度脚本；
- 只包含旧金融合同的 Pydantic `models.py`，并移除已无消费者的本地 MarketDataCache。

保留内容：

- `api.py`、`cli.py`、`import_cli.py`、`retail.py`、`synthetic.py`、`database_core.py`、`cache.py`、`readiness.py`；
- `routers/commerce.py`；
- UserBehavior/合成零售导入、`commerce.*` SQL 和对应文档。

## 不在本次范围

主应用 `src/lib/generation/`、eval、scaffold 中仍存在的历史金融语义另由 `ISSUE-P14` 处理；本 PR 不删除这些主应用能力，避免把后端运行链路清理与生成/评测重写混成一个不可审查变更。

## 验收证据

完成后至少运行：

```bash
cd services/commerce-data
uv run ruff check src tests
uv run pytest -q tests

cd ../..
npm run check:backend-architecture
npm run check:service-catalog
npm run check:module-boundaries
```

并用 `rg` 确认 commerce-data 源码、依赖和本地编排不再包含已删除的金融模块名。
