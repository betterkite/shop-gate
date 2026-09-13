# Router Boundary

`routers/commerce.py` 是 commerce-data 唯一的 HTTP 领域路由，负责参数解析、状态码和零售能力发现；健康与就绪端点留在 `api.py`。

零售查询和纯计算落在同包的 `retail.py`，数据库连接与共享转换落在 `database_core.py`。本服务只保留电商数据查询、导入和分析路由。
