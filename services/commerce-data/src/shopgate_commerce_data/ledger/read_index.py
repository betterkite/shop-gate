"""Versioned, date-partitioned projections of the canonical accounting events."""

import json
import zlib
from collections import defaultdict
from datetime import date, timedelta
from decimal import Decimal
from operator import itemgetter

from .operations import OperationConflict, bind_scope, checked_dataset
from .recalculation import ALGORITHM_VERSION

FORMAT = 3
PART_SIZE = 1000
MIN_ORDERS = 5000
DECIMAL_FIELDS = {"quantity", "revenue", "cost", "refund", "recovery", "expense"}


def encode_part(numbered):
    # Share keys across rows in a block. Decimal text retains original precision.
    shapes, records = {}, []
    for position, event in numbered:
        keys = tuple(key for key in event if key != "date")
        shape = shapes.setdefault(keys, len(shapes))
        records.append([position, shape, *(event[key] for key in keys)])
    data = json.dumps([list(shapes), records], ensure_ascii=False, separators=(",", ":"),
                      default=str)
    return zlib.compress(data.encode(), 1)


def decode_part(day, payload):
    shapes, records = json.loads(zlib.decompress(payload))
    numeric = [[i for i, key in enumerate(keys, 2) if key in DECIMAL_FIELDS] for keys in shapes]
    result = []
    for row in records:
        shape = row[1]
        for i in numeric[shape]:
            if row[i] is not None:
                row[i] = Decimal(row[i])
        event = dict(zip(shapes[shape], row[2:], strict=True), date=day)
        if "missing" in event["source"]:
            event["source"]["missing"] = tuple(event["source"]["missing"])
        result.append((row[0], event))
    return result


class IndexedEvents:
    """Decoded blocks are local to one authorized, repeatable-read transaction."""

    def __init__(self, connection, scope, *, overview=False):
        self.table = "bi.overview_index_parts" if overview else "bi.read_index_parts"
        self.connection = connection
        self.dataset = (scope.workspace_id, scope.dataset_id)
        self.blocks = {}
        self.dates = {}
        self.header = connection.execute(
            "SELECT generation,first_day,last_day FROM bi.read_index "
            "WHERE workspace_id=%s AND dataset_id=%s AND revision=%s AND format_version=%s",
            (*self.dataset, scope.version, FORMAT),
        ).fetchone()

    def events(self, query, item_scope):
        generation, _, last = self.header
        end = date.fromisoformat(query.end) if query.end else last
        start = (date.fromisoformat(query.start) if query.start
                 else end - timedelta(days=min(29, end.toordinal() - 1)))
        spans = [(start, end)]
        if query.group_condition:
            spans.append((date.fromisoformat(query.condition_start),
                          date.fromisoformat(query.condition_end)))
        basis = query.refund_basis
        if basis not in self.dates:
            self.dates[basis] = self.connection.execute(
                f"SELECT DISTINCT business_day,is_marker FROM {self.table} WHERE "
                "workspace_id=%s AND dataset_id=%s AND basis=%s AND generation=%s "
                "ORDER BY business_day,is_marker", (*self.dataset, basis, generation)
            ).fetchall()
        days = [(day, marker) for day, marker in self.dates[basis] if (item_scope or not marker)
                and any(first <= day <= final for first, final in spans)]
        for marker in (False, True) if item_scope else (False,):
            missing = [day for day, flag in days if flag == marker
                       and (basis, day, flag) not in self.blocks]
            if missing:
                rows = self.connection.execute(
                    f"SELECT business_day,payload FROM {self.table} WHERE workspace_id=%s "
                    "AND dataset_id=%s AND basis=%s AND generation=%s AND is_marker=%s "
                    "AND business_day=ANY(%s) ORDER BY business_day,part",
                    (*self.dataset, basis, generation, marker, missing),
                )
                for day, payload in rows:
                    block = self.blocks.setdefault((basis, day, marker), [])
                    block.extend(decode_part(day, payload))
        # Some evidence rows pick the first original posting as a representative.
        ordered = [row for day, marker in days for row in self.blocks[basis, day, marker]]
        ordered.sort(key=itemgetter(0))
        return [event for _, event in ordered], last


def _overview_events(events):
    """Keep only fields used by whole-store/platform KPIs. Known fees may be summed
    within the same day, ownership, completeness and type. Unknowns keep source IDs."""
    compact = []
    known_fees = {}
    shared = ("kind", "date", "channel_id", "channel_name", "store_id", "store_name", "complete")
    fields = {
        "sale": ("line_id", "order_id", "quantity", "unit", "revenue", "cost"),
        "refund": ("line_id", "order_id", "refund", "recovery"),
        "expense": ("expense_id", "expense", "unallocated"),
    }
    for position, event in enumerate(events):
        if event.get("attribution_marker"):
            continue
        kind = event["kind"]
        row = {k: event[k] for k in (*shared, *fields[kind]) if k in event}
        source = event["source"]
        row["source"] = {key: source[key] for key in ("expense_type", "missing") if key in source}
        if kind == "expense" and row["expense"] is not None:
            key = (row["date"], row.get("channel_id"), row.get("store_id"), row["complete"],
                   row.get("unallocated", False), source["expense_type"])
            if key in known_fees:
                known_fees[key]["expense"] += row["expense"]
                continue
            known_fees[key] = row
        compact.append((position, row))
    return compact


def _write_basis(connection, scope, basis, generation):
    from .query import LedgerReadSnapshot, Query

    read = LedgerReadSnapshot(connection, scope, {"revision": scope.version,
                                                  "algorithm_version": ALGORITHM_VERSION})
    events, last = read._events(Query(dimension="sku", refund_basis=basis))
    first = read.recorded_start
    del read  # Release raw database rows before encoding the two projections.
    _write_parts(connection, scope, basis, generation, enumerate(events), overview=False)
    _write_parts(connection, scope, basis, generation, _overview_events(events), overview=True)
    return first, last


def _write_parts(connection, scope, basis, generation, numbered, *, overview):
    table = "bi.overview_index_parts" if overview else "bi.read_index_parts"
    buckets = defaultdict(list)
    for position, event in numbered:
        buckets[event["date"], bool(event.get("attribution_marker"))].append((position, event))
    with connection.cursor() as cursor:
        for (day, marker), group in buckets.items():
            for offset in range(0, len(group), PART_SIZE):
                cursor.execute(
                    f"INSERT INTO {table} "
                    "(workspace_id,dataset_id,basis,business_day,is_marker,part,generation,payload)"
                    "VALUES (%s,%s,%s,%s,%s,%s,%s,%s) ON CONFLICT "
                    "(workspace_id,dataset_id,basis,business_day,is_marker,part) DO UPDATE SET "
                    "generation=EXCLUDED.generation,payload=EXCLUDED.payload",
                    (scope.workspace_id, scope.dataset_id, basis, day, marker, offset // PART_SIZE,
                     generation, encode_part(group[offset:offset + PART_SIZE])),
                )


def build_index(connection, scope):
    scope.require("ledger.manage")
    if checked_dataset(connection, scope, lock=True) != scope.version:
        raise OperationConflict("核算版本已更新，请按当前版本重建查询索引。")
    run = connection.execute("SELECT algorithm_version FROM bi.accounting_runs WHERE revision=%s",
                             (scope.version,)).fetchone()
    if run != (ALGORITHM_VERSION,):
        raise OperationConflict("请先完成当前数据版本的经营核算。")
    previous = connection.execute(
        "SELECT generation FROM bi.read_index WHERE workspace_id=%s AND dataset_id=%s",
        (scope.workspace_id, scope.dataset_id),
    ).fetchone()
    generation = previous[0] + 1 if previous else 1
    bounds = _write_basis(connection, scope, "payment", generation)
    if bounds == (None, None):
        return False
    if bounds != _write_basis(connection, scope, "occurred", generation):
        raise OperationConflict("两种退款日期口径的账本边界不一致，请检查核算记录。")
    connection.execute(
        "INSERT INTO bi.read_index(workspace_id,dataset_id,revision,generation,"
        "format_version,first_day,last_day) VALUES (%s,%s,%s,%s,%s,%s,%s) "
        "ON CONFLICT(workspace_id,dataset_id) DO UPDATE SET revision=EXCLUDED.revision,"
        "generation=EXCLUDED.generation,format_version=EXCLUDED.format_version,"
        "first_day=EXCLUDED.first_day,last_day=EXCLUDED.last_day",
        (scope.workspace_id, scope.dataset_id, scope.version, generation, FORMAT, *bounds),
    )
    return True


def maintain_index(connection, scope, kind):
    """Run after the dataset version advances, inside the confirmed mutation transaction."""
    if not connection.execute("SELECT 1 FROM bi.orders OFFSET %s LIMIT 1",
                              (MIN_ORDERS - 1,)).fetchone():
        return
    if kind in ("costs", "target", "mapping") and connection.execute(
        "UPDATE bi.read_index SET revision=%s WHERE workspace_id=%s AND dataset_id=%s "
        "AND revision=%s AND format_version=%s RETURNING 1",
        (scope.version, scope.workspace_id, scope.dataset_id, scope.version - 1, FORMAT),
    ).fetchone():
        return
    build_index(connection, scope)


def rebuild_existing(connection, scope):
    with connection.transaction():
        bind_scope(connection, scope)
        return build_index(connection, scope)
