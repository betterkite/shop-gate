"""Authorized master-data choices independent of transaction dates and activity."""

from dataclasses import dataclass

from .query import Query, ledger_read_snapshot
from .scope import IDENTIFIER

# Only these server-owned SQL sources and bound parameters reach PostgreSQL.
SOURCES = {
    "channel": "SELECT channel_id AS key,name,channel_id FROM bi.channels",
    "store": (
        "SELECT s.store_id AS key,s.name,s.store_id,s.channel_id,c.name AS channel_name "
        "FROM bi.stores s JOIN bi.channels c USING(workspace_id,dataset_id,channel_id)"
    ),
    "product": "SELECT product_id AS key,name,product_id,category FROM bi.products",
    "sku": (
        "SELECT s.sku_id AS key,s.name,s.sku_id,s.product_id,s.unit,"
        "p.name AS product_name,p.category FROM bi.skus s "
        "JOIN bi.products p USING(workspace_id,dataset_id,product_id)"
    ),
    "listing": (
        "SELECT l.listing_id AS key,l.name,l.listing_id,l.platform_sku_id,"
        "l.store_id,s.name AS store_name,s.channel_id,c.name AS channel_name "
        "FROM bi.listings l JOIN bi.stores s USING(workspace_id,dataset_id,store_id) "
        "JOIN bi.channels c USING(workspace_id,dataset_id,channel_id)"
    ),
    "category": (
        "SELECT DISTINCT category AS key,"
        "CASE WHEN category='' THEN '未分类' ELSE category END AS name FROM bi.products"
    ),
}
PARENTS = {
    "channel": (), "store": ("channel_id",), "product": ("category",),
    "sku": ("product_id", "category"), "listing": ("channel_id", "store_id"),
    "category": (),
}


@dataclass(frozen=True)
class ReferenceRequest:
    kind: str = "product"
    search: str = ""
    page: int = 1
    page_size: int = 20
    sort: str = "name"
    descending: bool = False
    channel_id: str | None = None
    store_id: str | None = None
    product_id: str | None = None
    category: str | None = None

    def validate(self):
        if not isinstance(self.kind, str) or self.kind not in SOURCES:
            raise ValueError("目录类型无效。")
        if type(self.page) is not int or not 1 <= self.page <= 999999:
            raise ValueError("目录页码无效。")
        if type(self.page_size) is not int or self.page_size != 20:
            raise ValueError("目录每页显示20条。")
        if self.sort not in ("key", "name") or type(self.descending) is not bool:
            raise ValueError("目录排序方式无效。")
        if not isinstance(self.search, str) or len(self.search) > 200:
            raise ValueError("搜索内容过长或无效。")
        for field in ("channel_id", "store_id", "product_id", "category"):
            value = getattr(self, field)
            if value is None:
                continue
            if field not in PARENTS[self.kind]:
                raise ValueError("此目录不支持该上级范围。")
            if not isinstance(value, str) or (
                len(value) > 200 if field == "category" else not IDENTIFIER.fullmatch(value)
            ):
                raise ValueError("上级范围无效。")


def reference_names(read, query: Query):
    """Resolve names within the overview's existing repeatable-read snapshot."""
    query.validate()
    result = []
    for kind, values in (
        ("channel", query.channel_ids), ("store", query.store_ids),
        ("product", query.product_ids), ("sku", query.sku_ids),
        ("listing", query.listing_ids),
        ("category", () if query.category is None else (query.category,)),
    ):
        if not values:
            continue
        rows = read._rows(
            read._connection,
            f"SELECT key,name FROM ({SOURCES[kind]}) directory "
            f"WHERE key IN ({','.join('%s' for _ in values)})",
            values,
        )
        names = {row["key"]: row["name"] for row in rows}
        result.extend({"kind": kind, "key": key, "name": names.get(key)} for key in values)
    return result


def references(connection, scope, request: ReferenceRequest):
    request.validate()
    conditions, params = [], []
    for field in PARENTS[request.kind]:
        value = getattr(request, field)
        if value is not None:
            conditions.append(f"{field}=%s")
            params.append(value)
    if request.search:
        conditions.append("strpos(lower(name || ' ' || key),lower(%s))>0")
        params.append(request.search)
    source = f"({SOURCES[request.kind]}) directory"
    where = " WHERE " + " AND ".join(conditions) if conditions else ""
    direction = "DESC" if request.descending else "ASC"
    order = f'{request.sort} COLLATE "C" {direction}'
    if request.sort != "key":
        order += ',key COLLATE "C" ASC'
    with ledger_read_snapshot(connection, scope) as read:
        total = read._rows(
            read._connection, f"SELECT count(*) AS total FROM {source}{where}", tuple(params)
        )[0]["total"]
        rows = read._rows(
            read._connection,
            f"SELECT * FROM {source}{where} ORDER BY {order} LIMIT %s OFFSET %s",
            (*params, 20, (request.page - 1) * 20),
        )
        return {
            "workspace_id": scope.workspace_id, "dataset_id": scope.dataset_id,
            "version": scope.version, "accounting_revision": scope.version,
            "kind": request.kind, "rows": rows, "total": total,
            "page": request.page, "page_size": 20,
        }
