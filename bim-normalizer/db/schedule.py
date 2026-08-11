"""
4D schedule: parse IFC work schedules (IfcWorkSchedule) into bim_tasks.
"""
import logging
import re
from datetime import date, datetime, timedelta

from db.cpm import recompute_and_persist_cpm

logger = logging.getLogger(__name__)

_ISO_DURATION = re.compile(r'P(?:(\d+(?:\.\d+)?)Y)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)W)?(?:(\d+(?:\.\d+)?)D)?', re.I)
_MSPDI_DURATION = re.compile(r'PT?(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?', re.I)


def _parse_ifc_date(val) -> date | None:
    if not val:
        return None
    s = str(val)[:10]
    for fmt in ('%Y-%m-%d', '%d.%m.%Y', '%d/%m/%Y', '%m/%d/%Y'):
        try:
            return datetime.strptime(s, fmt).date()
        except ValueError:
            pass
    return None


def _parse_ifc_duration(val) -> float | None:
    if not val:
        return None
    m = _ISO_DURATION.match(str(val))
    if not m:
        return None
    years, months, weeks, days = (float(g or 0) for g in m.groups())
    return years * 365 + months * 30 + weeks * 7 + days


def _parse_mspdi_duration(val) -> float | None:
    """MSPDI durations are ISO 8601 in hours/minutes/seconds (e.g. 'PT40H0M0S').
    Convert to days assuming an 8-hour work day, matching MS Project's default calendar."""
    if not val:
        return None
    m = _MSPDI_DURATION.match(str(val))
    if not m or not any(m.groups()):
        return None
    hours, minutes, seconds = (float(g or 0) for g in m.groups())
    return round((hours + minutes / 60 + seconds / 3600) / 8, 2)


def _link_elements(conn, db_task_id: str, model_id: str, global_ids: list[str]):
    if not global_ids or not db_task_id:
        return
    with conn.cursor() as cur:
        for gid in global_ids:
            cur.execute("""
                INSERT INTO bim_task_elements (task_id, element_id)
                SELECT %s, e.element_id
                FROM bim_elements e
                WHERE e.model_id = %s AND e.application_id = %s
                ON CONFLICT DO NOTHING
            """, (db_task_id, model_id, gid))


def link_elements_by_speckle_id(conn, task_id: str, model_id: str, speckle_ids: list[str]) -> int:
    """Link elements to a manually-created task by Speckle object id (works for
    any element regardless of source, unlike _link_elements' IFC-GlobalId match)."""
    if not speckle_ids:
        return 0
    with conn.cursor() as cur:
        cur.execute("""
            INSERT INTO bim_task_elements (task_id, element_id)
            SELECT %s, e.element_id
            FROM bim_elements e
            WHERE e.model_id = %s AND e.speckle_id = ANY(%s)
            ON CONFLICT DO NOTHING
        """, (task_id, model_id, speckle_ids))
        linked = cur.rowcount
    conn.commit()
    return linked


def unlink_elements_by_speckle_id(conn, task_id: str, model_id: str, speckle_ids: list[str]) -> int:
    if not speckle_ids:
        return 0
    with conn.cursor() as cur:
        cur.execute("""
            DELETE FROM bim_task_elements te
            USING bim_elements e
            WHERE te.element_id = e.element_id
              AND te.task_id = %s
              AND e.model_id = %s
              AND e.speckle_id = ANY(%s)
        """, (task_id, model_id, speckle_ids))
        unlinked = cur.rowcount
    conn.commit()
    return unlinked


def create_task(conn, model_id: str, name: str, planned_start=None, planned_finish=None,
                actual_start=None, actual_finish=None, parent_task_id: str | None = None,
                wbs_code: str | None = None, is_milestone: bool = False) -> str:
    with conn.cursor() as cur:
        cur.execute("SELECT COALESCE(MAX(sort_order), -1) + 1 FROM bim_tasks WHERE model_id = %s", (model_id,))
        sort_order = cur.fetchone()[0]
    task_id = _insert_task(conn, model_id, None, name, 'NOTSTARTED', is_milestone, False,
                           _parse_ifc_date(planned_start), _parse_ifc_date(planned_finish),
                           _parse_ifc_date(actual_start), _parse_ifc_date(actual_finish),
                           None, None, parent_task_id, wbs_code, sort_order)
    recompute_and_persist_cpm(conn, model_id)
    conn.commit()
    return task_id


_UPDATABLE_TASK_FIELDS = {
    'name', 'wbs_code', 'is_milestone', 'status',
    'planned_start', 'planned_finish', 'actual_start', 'actual_finish',
    'parent_task_id',
}
_TASK_DATE_FIELDS = {'planned_start', 'planned_finish', 'actual_start', 'actual_finish'}


def update_task(conn, model_id: str, task_id: str, **fields) -> bool:
    """Update a task's editable fields. Unknown keys are ignored; date-shaped
    fields are normalised the same way create_task/import_from_ifc do."""
    updates = {k: v for k, v in fields.items() if k in _UPDATABLE_TASK_FIELDS}
    if not updates:
        return False
    for key in _TASK_DATE_FIELDS:
        if key in updates:
            updates[key] = _parse_ifc_date(updates[key])
    set_clause = ', '.join(f'{k} = %s' for k in updates)
    with conn.cursor() as cur:
        cur.execute(
            f'UPDATE bim_tasks SET {set_clause} WHERE task_id = %s AND model_id = %s',
            (*updates.values(), task_id, model_id),
        )
        updated = cur.rowcount > 0
    if updated:
        recompute_and_persist_cpm(conn, model_id)
    conn.commit()
    return updated


def delete_task(conn, model_id: str, task_id: str) -> bool:
    with conn.cursor() as cur:
        cur.execute("DELETE FROM bim_tasks WHERE task_id = %s AND model_id = %s", (task_id, model_id))
        deleted = cur.rowcount > 0
    if deleted:
        recompute_and_persist_cpm(conn, model_id)
    conn.commit()
    return deleted


def delete_schedule(conn, model_id: str) -> int:
    """Wipe the entire schedule for a model (bim_task_elements/bim_task_dependencies
    cascade off bim_tasks). Same statement the import_from_* functions already run
    before re-populating, exposed standalone for a plain "delete plan" action."""
    with conn.cursor() as cur:
        cur.execute("DELETE FROM bim_tasks WHERE model_id = %s", (model_id,))
        deleted = cur.rowcount
    conn.commit()
    return deleted


# ─────────────────────────────────────────────────────────────────────────
# Auto-generate a schedule from the model's own data (no IFC/MSPDI import)
# ─────────────────────────────────────────────────────────────────────────
#
# One task per group, elements assigned to their group's task, groups laid
# out sequentially along a calendar. Modeled on ifc-lite's client-side
# "Generate schedule" dialog (github.com/LTplus-AG/ifc-lite,
# apps/viewer/src/components/viewer/schedule/generate-schedule.ts), but
# computed here from data already captured at ingest time —
# bim_elements.storey and bim_geometry.centroid_si — rather than re-parsing
# an IFC file or scanning mesh vertices in the browser.
GENERATE_STRATEGIES = {'storey', 'height'}
GENERATE_ORDERS = {'bottom-up', 'top-down'}


def _group_elements_by_storey(conn, model_id: str) -> list[dict]:
    """One group per distinct bim_elements.storey value. Elements with no
    storey assigned are excluded — nothing to schedule them by. Ordered by
    each group's mean geometry Z (ascending); groups with no geometry at all
    sort as if Z=0 rather than being dropped, since storey is still a
    meaningful grouping even without geometry to order by precisely."""
    # element_id::text — array_agg(uuid) comes back as an unparsed literal
    # string ("{a,b,c}") rather than a Python list, since this connection has
    # no uuid[] typecaster registered (only scalar uuid, via the ::text casts
    # used elsewhere in this file); text[] is one of psycopg2's built-in
    # array types and needs no such registration.
    with conn.cursor() as cur:
        cur.execute("""
            SELECT e.storey, array_agg(e.element_id::text) AS element_ids, AVG(g.centroid_si[3]) AS avg_z
            FROM bim_elements e
            LEFT JOIN bim_geometry g ON g.element_id = e.element_id
            WHERE e.model_id = %s AND e.storey IS NOT NULL AND e.storey <> ''
            GROUP BY e.storey
        """, (model_id,))
        rows = cur.fetchall()

    groups = [
        {'name': storey, 'element_ids': list(element_ids), 'sort_key': avg_z if avg_z is not None else 0.0}
        for storey, element_ids, avg_z in rows
    ]
    groups.sort(key=lambda g: g['sort_key'])
    return groups


def _format_z(z: float) -> str:
    """'+3 m' for whole metres, '+3.25 m' when the band boundary isn't."""
    rounded = round(z, 2)
    text = f'{rounded:g}'
    return f"{'+' if rounded >= 0 else ''}{text} m"


def _group_elements_by_height(conn, model_id: str, band_m: float) -> list[dict]:
    """Ignores the spatial hierarchy entirely and buckets elements into
    band_m-metre Z bands using bim_geometry.centroid_si — a rescue path for
    models where storey assignment is missing or unreliable (a common
    authoring issue: everything pooled under the ground floor regardless of
    real elevation). Elements with no geometry are excluded."""
    band_m = max(0.1, band_m)
    with conn.cursor() as cur:
        cur.execute("""
            SELECT FLOOR(g.centroid_si[3] / %s)::int AS bin, array_agg(e.element_id::text) AS element_ids
            FROM bim_elements e
            JOIN bim_geometry g ON g.element_id = e.element_id
            WHERE e.model_id = %s AND g.centroid_si IS NOT NULL
            GROUP BY bin
            ORDER BY bin
        """, (band_m, model_id))
        rows = cur.fetchall()

    groups = []
    for bin_idx, element_ids in rows:
        z_from = bin_idx * band_m
        z_to = z_from + band_m
        groups.append({
            'name': f'Elements {_format_z(z_from)} – {_format_z(z_to)}',
            'element_ids': list(element_ids),
            'sort_key': bin_idx,
        })
    return groups


def generate_schedule(
    conn, model_id: str, strategy: str, start_date, days_per_group: float,
    lag_days: float = 0, order: str = 'bottom-up', link_sequences: bool = True,
    height_band_m: float = 3.0,
) -> dict:
    """Replace this model's schedule with one auto-generated from its own
    grouping data — always a full replace (like import_from_ifc/mspdi), not
    a merge, so re-running with different options doesn't leave orphaned
    tasks from a previous attempt.

    strategy: 'storey' groups by bim_elements.storey; 'height' buckets by
      Z elevation in height_band_m-metre bands (ignores storey — see
      _group_elements_by_height for why that's sometimes the better choice).
    order: 'bottom-up' (ascending Z — site/ground first) or 'top-down'.
    Raises ValueError on bad input (caller maps this to HTTP 422).
    """
    if strategy not in GENERATE_STRATEGIES:
        raise ValueError(f"strategy must be one of {sorted(GENERATE_STRATEGIES)}, got {strategy!r}")
    if order not in GENERATE_ORDERS:
        raise ValueError(f"order must be one of {sorted(GENERATE_ORDERS)}, got {order!r}")
    if not days_per_group or days_per_group <= 0:
        raise ValueError('days_per_group must be positive')
    if lag_days is None or lag_days < 0:
        lag_days = 0

    start = start_date if isinstance(start_date, date) else _parse_ifc_date(start_date)
    if not start:
        raise ValueError(f'Invalid start_date: {start_date!r}')

    groups = (
        _group_elements_by_storey(conn, model_id) if strategy == 'storey'
        else _group_elements_by_height(conn, model_id, height_band_m)
    )
    if order == 'top-down':
        groups.reverse()

    if not groups:
        return {'tasks': 0, 'products_linked': 0, 'groups': 0}

    with conn.cursor() as cur:
        cur.execute('DELETE FROM bim_tasks WHERE model_id = %s', (model_id,))

    duration = timedelta(days=days_per_group)
    stride = duration + timedelta(days=lag_days)

    tasks_created = 0
    products_linked = 0
    prev_task_id = None

    for index, group in enumerate(groups):
        group_start = start + index * stride
        group_finish = group_start + duration

        task_id = _insert_task(
            conn, model_id, None, group['name'], 'NOTSTARTED', False, False,
            group_start, group_finish, None, None,
            days_per_group, None, None, None, index,
        )
        if not task_id:
            continue
        tasks_created += 1

        if group['element_ids']:
            with conn.cursor() as cur:
                cur.execute("""
                    INSERT INTO bim_task_elements (task_id, element_id)
                    SELECT %s, unnest(%s::uuid[])
                    ON CONFLICT DO NOTHING
                """, (task_id, group['element_ids']))
            products_linked += len(group['element_ids'])

        if link_sequences and prev_task_id:
            with conn.cursor() as cur:
                cur.execute("""
                    INSERT INTO bim_task_dependencies (predecessor_task_id, successor_task_id, sequence_type, lag_days)
                    VALUES (%s, %s, 'FINISH_START', %s)
                    ON CONFLICT (predecessor_task_id, successor_task_id) DO UPDATE SET
                        sequence_type = EXCLUDED.sequence_type, lag_days = EXCLUDED.lag_days
                """, (prev_task_id, task_id, lag_days if lag_days > 0 else None))
        prev_task_id = task_id

    recompute_and_persist_cpm(conn, model_id)
    conn.commit()
    return {'tasks': tasks_created, 'products_linked': products_linked, 'groups': len(groups)}


def _insert_task(conn, model_id, app_id, name, status, is_milestone, is_critical,
                 planned_start, planned_finish, actual_start, actual_finish,
                 duration_days, float_days, parent_db_id, wbs_code, sort_order) -> str | None:
    with conn.cursor() as cur:
        cur.execute("""
            INSERT INTO bim_tasks (
                model_id, application_id, name, status, is_milestone, is_critical,
                planned_start, planned_finish, actual_start, actual_finish,
                duration_days, float_days, parent_task_id, wbs_code, sort_order
            ) VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
            RETURNING task_id
        """, (model_id, app_id, name, status, is_milestone, is_critical,
              planned_start, planned_finish, actual_start, actual_finish,
              duration_days, float_days, parent_db_id, wbs_code, sort_order))
        row = cur.fetchone()
        return str(row[0]) if row else None


def _walk_task(ifc, conn, model_id: str, task, parent_db_id: str | None,
               task_id_map: dict, sort_counter: list):
    app_id = task.GlobalId
    name = task.Name or app_id
    tt = getattr(task, 'TaskTime', None)

    planned_start  = _parse_ifc_date(getattr(tt, 'ScheduleStart',  None) if tt else None)
    planned_finish = _parse_ifc_date(getattr(tt, 'ScheduleFinish', None) if tt else None)
    actual_start   = _parse_ifc_date(getattr(tt, 'ActualStart',    None) if tt else None)
    actual_finish  = _parse_ifc_date(getattr(tt, 'ActualFinish',   None) if tt else None)
    duration_days  = _parse_ifc_duration(getattr(tt, 'ScheduleDuration', None) if tt else None)
    # IsCritical/TotalFloat are standard IfcTaskTime attributes (IFC4/IFC4X3
    # spec, not a vendor extension) — confirmed against a real scheduling
    # tool's writer (Open Planner Studio's ifcWriter.ts writes both), but
    # previously only ever read from the MSPDI import path, never from IFC.
    is_critical    = bool(getattr(tt, 'IsCritical', False)) if tt else False
    float_days     = _parse_ifc_duration(getattr(tt, 'TotalFloat', None) if tt else None)
    status         = getattr(task, 'Status', None) or 'NOTSTARTED'
    is_milestone   = bool(getattr(task, 'IsMilestone', False))
    wbs            = getattr(task, 'Identification', None) or getattr(task, 'TaskId', None)

    sort_order = sort_counter[0]
    sort_counter[0] += 1

    db_id = _insert_task(conn, model_id, app_id, name, status, is_milestone, is_critical,
                         planned_start, planned_finish, actual_start, actual_finish,
                         duration_days, float_days, parent_db_id, wbs, sort_order)
    if db_id:
        task_id_map[app_id] = db_id

        # Link IFC products assigned to this task via IfcRelAssignsToProcess
        operates_on = getattr(task, 'OperatesOn', []) or []
        for rel in operates_on:
            related = getattr(rel, 'RelatedObjects', []) or []
            gids = [p.GlobalId for p in related if hasattr(p, 'GlobalId')]
            _link_elements(conn, db_id, model_id, gids)

    # Recurse into nested sub-tasks
    is_nested_by = getattr(task, 'IsNestedBy', []) or []
    for rel in is_nested_by:
        for nested in (getattr(rel, 'RelatedObjects', []) or []):
            if nested.is_a('IfcTask'):
                _walk_task(ifc, conn, model_id, nested, db_id, task_id_map, sort_counter)


_SEQUENCE_TYPES = {'FINISH_START', 'START_START', 'FINISH_FINISH', 'START_FINISH'}


def _import_dependencies(conn, ifc, task_id_map: dict[str, str]) -> int:
    """Parse IfcRelSequence (predecessor/successor task links) into
    bim_task_dependencies. Standard IFC4/IFC4X3 entity — confirmed against a
    real scheduling tool's writer (RelatingProcess=predecessor,
    RelatedProcess=successor, optional TimeLag, SequenceType enum).
    Silently skips relations referencing a task outside this schedule
    (not in task_id_map) rather than failing the whole import."""
    count = 0
    with conn.cursor() as cur:
        for seq in ifc.by_type('IfcRelSequence'):
            pred = getattr(seq, 'RelatingProcess', None)
            succ = getattr(seq, 'RelatedProcess', None)
            if not pred or not succ or not pred.is_a('IfcTask') or not succ.is_a('IfcTask'):
                continue
            pred_id = task_id_map.get(pred.GlobalId)
            succ_id = task_id_map.get(succ.GlobalId)
            if not pred_id or not succ_id:
                continue

            seq_type = getattr(seq, 'SequenceType', None)
            seq_type = seq_type if seq_type in _SEQUENCE_TYPES else 'FINISH_START'

            lag_days = None
            time_lag = getattr(seq, 'TimeLag', None)
            if time_lag is not None:
                lag_value = getattr(time_lag, 'LagValue', None)
                # LagValue is an IFC SELECT type (IfcDuration | IfcRatio) — ifcopenshell
                # may hand back a wrapper with the raw value under `wrappedValue` rather
                # than a plain string. Percentage-based lag (IfcRatio) won't match the
                # ISO-8601 duration regex and safely stays None rather than raising.
                lag_value = getattr(lag_value, 'wrappedValue', lag_value)
                lag_days = _parse_ifc_duration(lag_value)

            cur.execute("""
                INSERT INTO bim_task_dependencies (predecessor_task_id, successor_task_id, sequence_type, lag_days)
                VALUES (%s, %s, %s, %s)
                ON CONFLICT (predecessor_task_id, successor_task_id) DO UPDATE SET
                    sequence_type = EXCLUDED.sequence_type, lag_days = EXCLUDED.lag_days
            """, (pred_id, succ_id, seq_type, lag_days))
            count += 1
    return count


def import_from_ifc(conn, model_id: str, ifc_path: str) -> dict:
    """Extract IfcWorkSchedule(s) from an IFC file and store tasks."""
    import ifcopenshell
    ifc = ifcopenshell.open(ifc_path)
    schedules = ifc.by_type('IfcWorkSchedule')
    if not schedules:
        return {'schedules': 0, 'tasks': 0}

    with conn.cursor() as cur:
        cur.execute('DELETE FROM bim_tasks WHERE model_id = %s', (model_id,))

    task_id_map: dict[str, str] = {}
    sort_counter = [0]

    for ws in schedules:
        controls = getattr(ws, 'Controls', []) or []
        for rel in controls:
            for obj in (getattr(rel, 'RelatedObjects', []) or []):
                if obj.is_a('IfcTask'):
                    _walk_task(ifc, conn, model_id, obj, None, task_id_map, sort_counter)

    dependency_count = _import_dependencies(conn, ifc, task_id_map)

    recompute_and_persist_cpm(conn, model_id)
    conn.commit()
    return {'schedules': len(schedules), 'tasks': sort_counter[0], 'dependencies': dependency_count}


def import_from_mspdi(conn, model_id: str, xml_bytes: bytes) -> dict:
    """Extract tasks from a Microsoft Project XML (MSPDI) export into bim_tasks.

    MSPDI has no nested task hierarchy in the XML itself - tasks are a flat
    list ordered with an OutlineLevel per task, so parent/child links are
    rebuilt from a stack of the most recent task seen at each level."""
    import xml.etree.ElementTree as ET

    try:
        root = ET.fromstring(xml_bytes)
    except ET.ParseError as e:
        raise ValueError(f'Invalid XML: {e}')

    ns_uri = root.tag[1:].split('}')[0] if root.tag.startswith('{') else ''
    ns = {'p': ns_uri} if ns_uri else {}

    def find(elem, tag):
        return elem.find(f'p:{tag}', ns) if ns else elem.find(tag)

    def findall(elem, tag):
        return elem.findall(f'p:{tag}', ns) if ns else elem.findall(tag)

    def text(elem, tag):
        child = find(elem, tag)
        return child.text if child is not None else None

    tasks_el = find(root, 'Tasks')
    if tasks_el is None:
        raise ValueError('No <Tasks> element found - is this an MS Project XML (MSPDI) export?')

    with conn.cursor() as cur:
        cur.execute('DELETE FROM bim_tasks WHERE model_id = %s', (model_id,))

    level_stack: list[tuple[int, str]] = []  # (outline_level, db_task_id)
    sort_order = 0
    critical_ids: list[str] = []

    for task_el in findall(tasks_el, 'Task'):
        uid = text(task_el, 'UID')
        if uid == '0':
            continue  # UID 0 is MSPDI's synthetic project-summary row

        name = text(task_el, 'Name') or uid or 'Unnamed Task'
        level = int(text(task_el, 'OutlineLevel') or 1)
        wbs = text(task_el, 'OutlineNumber')

        planned_start  = _parse_ifc_date(text(task_el, 'Start'))
        planned_finish = _parse_ifc_date(text(task_el, 'Finish'))
        actual_start   = _parse_ifc_date(text(task_el, 'ActualStart'))
        actual_finish  = _parse_ifc_date(text(task_el, 'ActualFinish'))
        duration_days  = _parse_mspdi_duration(text(task_el, 'Duration'))

        is_milestone = text(task_el, 'Milestone') == '1'
        pct_complete = text(task_el, 'PercentComplete')
        if pct_complete == '100':
            status = 'DONE'
        elif pct_complete and pct_complete != '0':
            status = 'INPROGRESS'
        else:
            status = 'NOTSTARTED'

        while level_stack and level_stack[-1][0] >= level:
            level_stack.pop()
        parent_db_id = level_stack[-1][1] if level_stack else None

        # is_critical is set via the bulk UPDATE below (existing pattern); MSPDI's
        # TotalSlack isn't wired to float_days yet (unverified units without a
        # real sample) — leave None rather than guess.
        db_id = _insert_task(conn, model_id, None, name, status, is_milestone, False,
                             planned_start, planned_finish, actual_start, actual_finish,
                             duration_days, None, parent_db_id, wbs, sort_order)
        sort_order += 1
        if db_id:
            level_stack.append((level, db_id))
            if text(task_el, 'Critical') == '1':
                critical_ids.append(db_id)

    if critical_ids:
        with conn.cursor() as cur:
            cur.execute('UPDATE bim_tasks SET is_critical = TRUE WHERE task_id = ANY(%s::uuid[])', (critical_ids,))

    recompute_and_persist_cpm(conn, model_id)
    conn.commit()
    return {'schedules': 1, 'tasks': sort_order}


_CSV_HEADER_ALIASES = {
    'name': 'name', 'task name': 'name', 'task': 'name',
    'wbs': 'wbs', 'wbs code': 'wbs', 'outline number': 'wbs',
    'outline level': 'level', 'level': 'level',
    'start': 'start', 'planned start': 'start',
    'finish': 'finish', 'end': 'finish', 'planned finish': 'finish',
    'actual start': 'actual_start',
    'actual finish': 'actual_finish', 'actual end': 'actual_finish',
    'duration': 'duration', 'duration (days)': 'duration', 'duration days': 'duration',
    '% complete': 'pct_complete', 'percent complete': 'pct_complete', 'percentcomplete': 'pct_complete',
    'milestone': 'milestone',
    'status': 'status',
}


def _parse_csv_duration(val) -> float | None:
    """Plain day count, optionally suffixed like '5d' or '5 days'."""
    if not val:
        return None
    m = re.match(r'\s*(\d+(?:\.\d+)?)', str(val))
    return float(m.group(1)) if m else None


def _parse_csv_bool(val) -> bool:
    return str(val).strip().lower() in ('1', 'true', 'yes', 'y')


_ISO_DATE = re.compile(r'^\d{4}-\d{2}-\d{2}')


def _detect_csv_date_format(raw_values: list) -> str:
    """CSV dates are frequently ambiguous slash-dates ('01/05/2026') where D/M
    vs M/D depends on the exporting tool's locale. Scan every date-shaped
    value in the file for one where a component is unambiguously > 12 (e.g.
    '13' can only be a month in DD/MM), and lock the whole file to that
    format. Raises if different values imply different formats - a single
    export shouldn't mix locales, so that means the guess can't be trusted.
    Defaults to month-first (MM/DD/YYYY) when nothing settles it, matching
    the common Excel/MS Project US export convention."""
    verdict = None
    example = None
    for raw in raw_values:
        if not raw or _ISO_DATE.match(str(raw)):
            continue
        parts = re.split(r'[/.]', str(raw).strip())
        if len(parts) != 3:
            continue
        try:
            a, b = int(parts[0]), int(parts[1])
        except ValueError:
            continue
        if a > 12 and b <= 12:
            this = 'DMY'
        elif b > 12 and a <= 12:
            this = 'MDY'
        else:
            continue
        if verdict is None:
            verdict, example = this, raw
        elif verdict != this:
            fmt_name = {'DMY': 'DD/MM/YYYY', 'MDY': 'MM/DD/YYYY'}
            raise ValueError(
                f"Inconsistent date format in CSV: '{raw}' looks like {fmt_name[this]}, but "
                f"'{example}' earlier in the file looks like {fmt_name[verdict]}. "
                f"Use a consistent date format (ISO 'YYYY-MM-DD' is unambiguous)."
            )
    return verdict or 'MDY'


def _parse_csv_date(val, date_fmt: str) -> date | None:
    if not val:
        return None
    s = str(val).strip()[:10]
    if _ISO_DATE.match(s):
        try:
            return datetime.strptime(s, '%Y-%m-%d').date()
        except ValueError:
            return None
    normalized = s.replace('.', '/')
    fmt = '%d/%m/%Y' if date_fmt == 'DMY' else '%m/%d/%Y'
    try:
        return datetime.strptime(normalized, fmt).date()
    except ValueError:
        return None


def import_from_csv(conn, model_id: str, csv_bytes: bytes) -> dict:
    """Extract tasks from a CSV schedule export into bim_tasks.

    Column names are matched case-insensitively against _CSV_HEADER_ALIASES;
    only a Name column is required. Hierarchy is rebuilt from an Outline
    Level column the same way as MSPDI, when present - otherwise every row
    is a top-level task in file order."""
    import csv
    import io

    try:
        text = csv_bytes.decode('utf-8-sig')
    except UnicodeDecodeError:
        text = csv_bytes.decode('latin-1')

    reader = csv.DictReader(io.StringIO(text))
    if not reader.fieldnames:
        raise ValueError('Empty CSV file')

    field_map = {}
    for raw in reader.fieldnames:
        key = _CSV_HEADER_ALIASES.get(raw.strip().lower())
        if key:
            field_map[key] = raw
    if 'name' not in field_map:
        raise ValueError('No "Name" column found - expected a header like "Name" or "Task Name"')

    rows = list(reader)

    if not rows:
        with conn.cursor() as cur:
            cur.execute('DELETE FROM bim_tasks WHERE model_id = %s', (model_id,))
        conn.commit()
        return {'schedules': 1, 'tasks': 0}

    def get(row, key):
        col = field_map.get(key)
        val = row.get(col) if col else None
        return val.strip() if isinstance(val, str) else val

    date_keys = ('start', 'finish', 'actual_start', 'actual_finish')
    date_fmt = _detect_csv_date_format(
        get(row, key) for row in rows for key in date_keys
    )

    with conn.cursor() as cur:
        cur.execute('DELETE FROM bim_tasks WHERE model_id = %s', (model_id,))

    has_level = 'level' in field_map
    level_stack: list[tuple[int, str]] = []
    sort_order = 0

    for row in rows:
        name = get(row, 'name')
        if not name:
            continue

        planned_start  = _parse_csv_date(get(row, 'start'), date_fmt)
        planned_finish = _parse_csv_date(get(row, 'finish'), date_fmt)
        actual_start   = _parse_csv_date(get(row, 'actual_start'), date_fmt)
        actual_finish  = _parse_csv_date(get(row, 'actual_finish'), date_fmt)
        duration_days  = _parse_csv_duration(get(row, 'duration'))
        wbs = get(row, 'wbs')
        is_milestone = _parse_csv_bool(get(row, 'milestone'))

        status = (get(row, 'status') or '').upper()
        if status not in ('NOTSTARTED', 'INPROGRESS', 'DONE'):
            pct_raw = get(row, 'pct_complete')
            try:
                pct = float(str(pct_raw).rstrip('%')) if pct_raw else 0
            except ValueError:
                pct = 0
            status = 'DONE' if pct >= 100 else ('INPROGRESS' if pct > 0 else 'NOTSTARTED')

        parent_db_id = None
        level = 1
        if has_level:
            try:
                level = int(get(row, 'level') or 1)
            except ValueError:
                level = 1
            while level_stack and level_stack[-1][0] >= level:
                level_stack.pop()
            parent_db_id = level_stack[-1][1] if level_stack else None

        db_id = _insert_task(conn, model_id, None, name, status, is_milestone, False,
                             planned_start, planned_finish, actual_start, actual_finish,
                             duration_days, None, parent_db_id, wbs, sort_order)
        sort_order += 1
        if has_level and db_id:
            level_stack.append((level, db_id))

    recompute_and_persist_cpm(conn, model_id)
    conn.commit()
    return {'schedules': 1, 'tasks': sort_order}


def _would_create_cycle(conn, model_id: str, predecessor_task_id: str, successor_task_id: str) -> bool:
    """BFS forward from successor_task_id over existing dependency edges; if
    predecessor_task_id is reachable, adding predecessor->successor would
    close a cycle."""
    with conn.cursor() as cur:
        cur.execute("""
            SELECT d.predecessor_task_id::text, d.successor_task_id::text
            FROM bim_task_dependencies d
            JOIN bim_tasks t ON t.task_id = d.predecessor_task_id
            WHERE t.model_id = %s
        """, (model_id,))
        edges = cur.fetchall()

    succs: dict[str, list[str]] = {}
    for pred_id, succ_id in edges:
        succs.setdefault(pred_id, []).append(succ_id)

    seen = set()
    queue = [successor_task_id]
    while queue:
        tid = queue.pop()
        if tid == predecessor_task_id:
            return True
        if tid in seen:
            continue
        seen.add(tid)
        queue.extend(succs.get(tid, []))
    return False


def create_dependency(conn, model_id: str, predecessor_task_id: str, successor_task_id: str,
                      sequence_type: str = 'FINISH_START', lag_days: float | None = None) -> dict:
    if predecessor_task_id == successor_task_id:
        raise ValueError('A task cannot depend on itself')
    if sequence_type not in _SEQUENCE_TYPES:
        sequence_type = 'FINISH_START'

    with conn.cursor() as cur:
        cur.execute(
            "SELECT task_id FROM bim_tasks WHERE model_id = %s AND task_id = ANY(%s::uuid[])",
            (model_id, [predecessor_task_id, successor_task_id]),
        )
        found = {str(row[0]) for row in cur.fetchall()}
    if len(found) != 2:
        raise ValueError('Task not found in this model')

    if _would_create_cycle(conn, model_id, predecessor_task_id, successor_task_id):
        raise ValueError('This would create a circular dependency')

    with conn.cursor() as cur:
        cur.execute("""
            INSERT INTO bim_task_dependencies (predecessor_task_id, successor_task_id, sequence_type, lag_days)
            VALUES (%s, %s, %s, %s)
            ON CONFLICT (predecessor_task_id, successor_task_id) DO UPDATE SET
                sequence_type = EXCLUDED.sequence_type, lag_days = EXCLUDED.lag_days
            RETURNING id
        """, (predecessor_task_id, successor_task_id, sequence_type, lag_days))
        dependency_id = cur.fetchone()[0]

    recompute_and_persist_cpm(conn, model_id)
    conn.commit()
    return {'dependency_id': str(dependency_id)}


def delete_dependency(conn, model_id: str, dependency_id: int) -> bool:
    with conn.cursor() as cur:
        cur.execute("""
            DELETE FROM bim_task_dependencies d
            USING bim_tasks t
            WHERE d.id = %s AND d.predecessor_task_id = t.task_id AND t.model_id = %s
        """, (dependency_id, model_id))
        deleted = cur.rowcount > 0
    if deleted:
        recompute_and_persist_cpm(conn, model_id)
    conn.commit()
    return deleted


def get_schedule(conn, model_id: str) -> dict:
    """Return the full task tree with element counts and speckle_ids for viewer sync."""
    with conn.cursor() as cur:
        cur.execute("""
            SELECT
                t.task_id,
                t.name,
                t.wbs_code,
                t.status,
                t.is_milestone,
                t.is_critical,
                t.planned_start,
                t.planned_finish,
                t.actual_start,
                t.actual_finish,
                t.duration_days,
                t.float_days,
                t.parent_task_id,
                t.sort_order,
                COUNT(te.element_id)                                            AS element_count,
                COALESCE(
                    JSON_AGG(e.speckle_id) FILTER (WHERE e.speckle_id IS NOT NULL),
                    '[]'::json
                )                                                               AS speckle_ids
            FROM bim_tasks t
            LEFT JOIN bim_task_elements te ON te.task_id = t.task_id
            LEFT JOIN bim_elements e       ON e.element_id = te.element_id
            WHERE t.model_id = %s
            GROUP BY t.task_id, t.name, t.wbs_code, t.status,
                     t.is_milestone, t.is_critical,
                     t.planned_start, t.planned_finish,
                     t.actual_start, t.actual_finish,
                     t.duration_days, t.float_days,
                     t.parent_task_id, t.sort_order
            ORDER BY t.sort_order, t.planned_start NULLS LAST, t.name
        """, (model_id,))
        rows = cur.fetchall()

    if not rows:
        return {'tasks': [], 'dependencies': [], 'project_start': None, 'project_end': None, 'task_count': 0}

    tasks = []
    all_starts, all_ends = [], []

    for row in rows:
        (task_id, name, wbs, status, is_milestone, is_critical,
         p_start, p_finish, a_start, a_finish, duration, float_d,
         parent_id, sort_order, elem_count, speckle_ids) = row

        tasks.append({
            'task_id':        str(task_id),
            'name':           name or 'Unnamed Task',
            'wbs_code':       wbs,
            'status':         status,
            'is_milestone':   is_milestone,
            'is_critical':    is_critical,
            'planned_start':  p_start.isoformat()  if p_start  else None,
            'planned_finish': p_finish.isoformat() if p_finish else None,
            'actual_start':   a_start.isoformat()  if a_start  else None,
            'actual_finish':  a_finish.isoformat() if a_finish else None,
            'duration_days':  duration,
            'float_days':     float_d,
            'parent_task_id': str(parent_id) if parent_id else None,
            'sort_order':     sort_order,
            'element_count':  elem_count or 0,
            'speckle_ids':    list(speckle_ids) if speckle_ids else [],
        })

        eff_start = p_start or a_start
        eff_end   = p_finish or a_finish
        if eff_start:
            all_starts.append(eff_start)
        if eff_end:
            all_ends.append(eff_end)

    with conn.cursor() as cur:
        cur.execute("""
            SELECT d.id, d.predecessor_task_id, d.successor_task_id, d.sequence_type, d.lag_days
            FROM bim_task_dependencies d
            JOIN bim_tasks t ON t.task_id = d.predecessor_task_id
            WHERE t.model_id = %s
        """, (model_id,))
        dependencies = [
            {
                'dependency_id':       str(dep_id),
                'predecessor_task_id': str(pred_id),
                'successor_task_id':   str(succ_id),
                'sequence_type':       seq_type,
                'lag_days':            lag_days,
            }
            for dep_id, pred_id, succ_id, seq_type, lag_days in cur.fetchall()
        ]

    return {
        'tasks':         tasks,
        'dependencies':  dependencies,
        'task_count':    len(tasks),
        'project_start': min(all_starts).isoformat() if all_starts else None,
        'project_end':   max(all_ends).isoformat()   if all_ends   else None,
    }


def get_tasks_for_element(conn, model_id: str, speckle_id: str) -> list[dict]:
    """Reverse of link_elements_by_speckle_id — which tasks reference a given
    element. Only element->task lookups (get_schedule's per-task speckle_ids,
    get_tasks_for_export's task_elements map) existed before this; nothing
    let a caller start from an element and find its tasks."""
    with conn.cursor() as cur:
        cur.execute("""
            SELECT t.task_id, t.name, t.wbs_code, t.status, t.is_milestone, t.is_critical,
                   t.planned_start, t.planned_finish, t.actual_start, t.actual_finish,
                   t.duration_days, t.float_days
            FROM bim_tasks t
            JOIN bim_task_elements te ON te.task_id = t.task_id
            JOIN bim_elements e       ON e.element_id = te.element_id
            WHERE t.model_id = %s AND e.speckle_id = %s
            ORDER BY t.sort_order, t.planned_start NULLS LAST, t.name
        """, (model_id, speckle_id))
        rows = cur.fetchall()

    return [
        {
            'task_id':        str(task_id),
            'name':           name or 'Unnamed Task',
            'wbs_code':       wbs,
            'status':         status,
            'is_milestone':   is_milestone,
            'is_critical':    is_critical,
            'planned_start':  p_start.isoformat()  if p_start  else None,
            'planned_finish': p_finish.isoformat() if p_finish else None,
            'actual_start':   a_start.isoformat()  if a_start  else None,
            'actual_finish':  a_finish.isoformat() if a_finish else None,
            'duration_days':  duration,
            'float_days':     float_d,
        }
        for (task_id, name, wbs, status, is_milestone, is_critical,
             p_start, p_finish, a_start, a_finish, duration, float_d) in rows
    ]


def get_tasks_for_export(conn, model_id: str) -> tuple[list[dict], dict[str, list[str]]]:
    """
    Tasks + task->element links in the shape ifc/export.py's export_model()
    needs to build IfcWorkSchedule/IfcTask/IfcRelAssignsToProcess: element ids
    here (not speckle_ids) so export_model can look products up directly from
    the element_id -> ifc_elem map it builds during the main product loop.
    """
    with conn.cursor() as cur:
        cur.execute("""
            SELECT task_id, name, wbs_code, status, is_milestone, is_critical, float_days,
                   planned_start, planned_finish, actual_start, actual_finish,
                   parent_task_id, sort_order
            FROM bim_tasks
            WHERE model_id = %s
            ORDER BY sort_order
        """, (model_id,))
        rows = cur.fetchall()
        tasks = [{
            'task_id':         str(task_id),
            'name':            name or 'Unnamed Task',
            'wbs_code':        wbs,
            'status':          status,
            'is_milestone':    is_milestone,
            'is_critical':     is_critical,
            'float_days':      float_d,
            'planned_start':   p_start.isoformat()  if p_start  else None,
            'planned_finish':  p_finish.isoformat() if p_finish else None,
            'actual_start':    a_start.isoformat()  if a_start  else None,
            'actual_finish':   a_finish.isoformat() if a_finish else None,
            'parent_task_id':  str(parent_id) if parent_id else None,
            'sort_order':      sort_order,
        } for (task_id, name, wbs, status, is_milestone, is_critical, float_d,
               p_start, p_finish, a_start, a_finish, parent_id, sort_order) in rows]

        if not tasks:
            return [], {}

        cur.execute("""
            SELECT te.task_id::text, te.element_id::text
            FROM bim_task_elements te
            JOIN bim_tasks t ON t.task_id = te.task_id
            WHERE t.model_id = %s
        """, (model_id,))
        task_elements: dict[str, list[str]] = {}
        for task_id, element_id in cur.fetchall():
            task_elements.setdefault(task_id, []).append(element_id)

    return tasks, task_elements
