"""Authorized master-data choices independent of transaction dates and activity."""

from dataclasses import dataclass
from datetime import date, datetime, time
from decimal import Decimal

from .accounting import Cost, choose_cost
from .query import Query, ledger_read_snapshot
from .recalculation import BUSINESS_ZONE
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

# One row per platform listing, including listings with no sales or no effective rule.
# A rule starting at the following midnight is outside the selected business day.
MAPPING_DIRECTORY = """
    SELECT l.listing_id AS key,l.name,l.listing_id,l.platform_sku_id,l.platform_product_id,
           l.unit AS listing_unit,l.store_id,s.name AS store_name,
           s.channel_id,c.name AS channel_name,
           m.mapping_id,m.valid_from,m.valid_to,m.unit_multiplier::text AS multiplier,
           k.sku_id,k.name AS sku_name,k.unit,p.product_id,p.name AS product_name,p.category,
           CASE WHEN m.mapping_id IS NULL THEN 'missing' ELSE 'mapped' END AS mapping_status
    FROM bi.listings l
    JOIN bi.stores s USING(workspace_id,dataset_id,store_id)
    JOIN bi.channels c USING(workspace_id,dataset_id,channel_id)
    CROSS JOIN (SELECT ((%s::date + 1)::timestamp AT TIME ZONE 'Asia/Shanghai') AS cutoff) d
    LEFT JOIN bi.mappings m ON m.workspace_id=l.workspace_id AND m.dataset_id=l.dataset_id
                           AND m.listing_id=l.listing_id AND m.superseded_version IS NULL
                           AND m.valid_from < d.cutoff
                           AND (m.valid_to IS NULL OR m.valid_to >= d.cutoff)
    LEFT JOIN bi.skus k ON k.workspace_id=l.workspace_id AND k.dataset_id=l.dataset_id
                       AND k.sku_id=m.sku_id
    LEFT JOIN bi.products p ON p.workspace_id=l.workspace_id AND p.dataset_id=l.dataset_id
                           AND p.product_id=k.product_id
"""

SOURCES["mapping"] = MAPPING_DIRECTORY
PARENTS = {
    "listing_cost": ("listing_id",),
    "mapping": ("channel_id", "store_id", "product_id", "sku_id", "listing_id", "category"),
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
    sku_id: str | None = None
    listing_id: str | None = None
    as_of: str | None = None
    mapping_status: str | None = None

    def validate(self):
        if not isinstance(self.kind, str) or self.kind not in PARENTS:
            raise ValueError("目录类型无效。")
        if type(self.page) is not int or not 1 <= self.page <= 999999:
            raise ValueError("目录页码无效。")
        if type(self.page_size) is not int or self.page_size != 20:
            raise ValueError("目录每页显示20条。")
        sorts = ("key", "name", "valid_from") if self.kind == "listing_cost" else ("key", "name")
        if self.sort not in sorts or type(self.descending) is not bool:
            raise ValueError("目录排序方式无效。")
        if not isinstance(self.search, str) or len(self.search) > 200:
            raise ValueError("搜索内容过长或无效。")
        if self.kind in ("mapping", "listing_cost"):
            try:
                if date.fromisoformat(self.as_of).isoformat() != self.as_of:
                    raise ValueError()
            except (TypeError, ValueError):
                raise ValueError("请选择有效的查询日期。") from None
            if self.kind == "listing_cost" and (
                not self.listing_id or self.mapping_status is not None
            ):
                raise ValueError("查看成本需要指定平台商品。")
            if self.mapping_status not in (None, "mapped", "missing"):
                raise ValueError("规格对应状态无效。")
        elif self.mapping_status is not None or self.as_of is not None:
            raise ValueError("此目录不支持规格对应条件。")
        for field in ("channel_id", "store_id", "product_id", "category", "sku_id", "listing_id"):
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
    if request.kind == "listing_cost":
        return listing_cost_history(connection, scope, request)
    conditions, params = [], []
    for field in PARENTS[request.kind]:
        value = getattr(request, field)
        if value is not None:
            conditions.append(f"{field}=%s")
            params.append(value)
    if request.kind == "mapping":
        params.insert(0, request.as_of)
        if request.mapping_status:
            conditions.append("mapping_status=%s")
            params.append(request.mapping_status)
    if request.search:
        searchable = ("concat_ws(' ',name,key,platform_product_id,platform_sku_id,mapping_id,"
                      "sku_id,sku_name,product_name,product_id,store_name,channel_name)"
                      if request.kind == "mapping" else "name || ' ' || key")
        conditions.append(f"strpos(lower({searchable}),lower(%s))>0")
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
            **({"as_of": request.as_of} if request.kind == "mapping" else {}),
            "page": request.page, "page_size": 20,
        }


def listing_cost_history(connection, scope, request):
    """Read a listing's effective unit cost and all relevant versions in the same snapshot."""
    at = datetime.combine(date.fromisoformat(request.as_of), time.max, BUSINESS_ZONE)
    result = {
        "workspace_id": scope.workspace_id, "dataset_id": scope.dataset_id,
        "version": scope.version, "accounting_revision": scope.version,
        "kind": request.kind, "as_of": request.as_of, "listing_id": request.listing_id,
        "listing": None, "applied": None, "rows": [], "total": 0,
        "page": request.page, "page_size": 20,
    }
    with ledger_read_snapshot(connection, scope) as read:
        def select(statement, params):
            return read._rows(connection, statement, params)

        listings = select(
            f"SELECT * FROM ({MAPPING_DIRECTORY}) directory WHERE key=%s",
            (request.as_of, request.listing_id),
        )
        if not listings:
            return result
        listing = result["listing"] = listings[0]
        if listing["sku_id"] is None:
            return result
        criteria = (
            " FROM bi.cost_versions WHERE sku_id=%s AND (level='base' OR "
            "(level='channel' AND channel_id=%s) OR (level='store' AND store_id=%s))"
        )
        params = (listing["sku_id"], listing["channel_id"], listing["store_id"])
        fields = (
            "SELECT cost_id,sku_id,level,channel_id,store_id,unit_cost::text AS unit_cost,"
            "currency,source,valid_from,valid_to,created_version,superseded_version"
        )
        active = select(
            fields + criteria + " AND superseded_version IS NULL AND valid_from<=%s"
            " AND (valid_to IS NULL OR valid_to>%s)",
            (*params, at, at),
        )
        choices = [
            Cost(row["cost_id"], row["sku_id"], row["level"], Decimal(row["unit_cost"]),
                 row["currency"], row["valid_from"], row["valid_to"],
                 row["channel_id"], row["store_id"])
            for row in active
        ]
        applied = choose_cost(
            at, listing["sku_id"], listing["channel_id"], listing["store_id"], choices
        )
        if applied is not None:
            result["applied"] = next(row for row in active if row["cost_id"] == applied.cost_id)
        if request.search:
            criteria += " AND strpos(lower(concat_ws(' ',cost_id,source,currency)),lower(%s))>0"
            params = (*params, request.search)
        result["total"] = select("SELECT count(*) AS n" + criteria, params)[0]["n"]
        order_fields = {
            "key": 'cost_id COLLATE "C"', "name": 'source COLLATE "C"', "valid_from": "valid_from",
        }
        sort = order_fields[request.sort]
        direction = "DESC" if request.descending else "ASC"
        order = f' ORDER BY {sort} {direction},cost_id COLLATE "C"'
        result["rows"] = select(
            fields + criteria + order + " LIMIT 20 OFFSET %s",
            (*params, (request.page - 1) * 20),
        )
    return result
