"""
4D schedule: parse IFC work schedules (IfcWorkSchedule) into bim_tasks.
"""
import logging
import re
from datetime import date, datetime

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
    task_id = _insert_task(conn, model_id, None, name, 'NOTSTARTED', is_milestone,
                           _parse_ifc_date(planned_start), _parse_ifc_date(planned_finish),
                           _parse_ifc_date(actual_start), _parse_ifc_date(actual_finish),
                           None, parent_task_id, wbs_code, sort_order)
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
    conn.commit()
    return updated


def delete_task(conn, model_id: str, task_id: str) -> bool:
    with conn.cursor() as cur:
        cur.execute("DELETE FROM bim_tasks WHERE task_id = %s AND model_id = %s", (task_id, model_id))
        deleted = cur.rowcount > 0
    conn.commit()
    return deleted


def _insert_task(conn, model_id, app_id, name, status, is_milestone,
                 planned_start, planned_finish, actual_start, actual_finish,
                 duration_days, parent_db_id, wbs_code, sort_order) -> str | None:
    with conn.cursor() as cur:
        cur.execute("""
            INSERT INTO bim_tasks (
                model_id, application_id, name, status, is_milestone,
                planned_start, planned_finish, actual_start, actual_finish,
                duration_days, parent_task_id, wbs_code, sort_order
            ) VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
            RETURNING task_id
        """, (model_id, app_id, name, status, is_milestone,
              planned_start, planned_finish, actual_start, actual_finish,
              duration_days, parent_db_id, wbs_code, sort_order))
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
    status         = getattr(task, 'Status', None) or 'NOTSTARTED'
    is_milestone   = bool(getattr(task, 'IsMilestone', False))
    wbs            = getattr(task, 'Identification', None) or getattr(task, 'TaskId', None)

    sort_order = sort_counter[0]
    sort_counter[0] += 1

    db_id = _insert_task(conn, model_id, app_id, name, status, is_milestone,
                         planned_start, planned_finish, actual_start, actual_finish,
                         duration_days, parent_db_id, wbs, sort_order)
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

    conn.commit()
    return {'schedules': len(schedules), 'tasks': sort_counter[0]}


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

        db_id = _insert_task(conn, model_id, None, name, status, is_milestone,
                             planned_start, planned_finish, actual_start, actual_finish,
                             duration_days, parent_db_id, wbs, sort_order)
        sort_order += 1
        if db_id:
            level_stack.append((level, db_id))
            if text(task_el, 'Critical') == '1':
                critical_ids.append(db_id)

    if critical_ids:
        with conn.cursor() as cur:
            cur.execute('UPDATE bim_tasks SET is_critical = TRUE WHERE task_id = ANY(%s::uuid[])', (critical_ids,))

    conn.commit()
    return {'schedules': 1, 'tasks': sort_order}


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
        return {'tasks': [], 'project_start': None, 'project_end': None, 'task_count': 0}

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

    return {
        'tasks':         tasks,
        'task_count':    len(tasks),
        'project_start': min(all_starts).isoformat() if all_starts else None,
        'project_end':   max(all_ends).isoformat()   if all_ends   else None,
    }


def get_tasks_for_export(conn, model_id: str) -> tuple[list[dict], dict[str, list[str]]]:
    """
    Tasks + task->element links in the shape ifc/export.py's export_model()
    needs to build IfcWorkSchedule/IfcTask/IfcRelAssignsToProcess: element ids
    here (not speckle_ids) so export_model can look products up directly from
    the element_id -> ifc_elem map it builds during the main product loop.
    """
    with conn.cursor() as cur:
        cur.execute("""
            SELECT task_id, name, wbs_code, is_milestone,
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
            'is_milestone':    is_milestone,
            'planned_start':   p_start.isoformat()  if p_start  else None,
            'planned_finish':  p_finish.isoformat() if p_finish else None,
            'actual_start':    a_start.isoformat()  if a_start  else None,
            'actual_finish':   a_finish.isoformat() if a_finish else None,
            'parent_task_id':  str(parent_id) if parent_id else None,
            'sort_order':      sort_order,
        } for (task_id, name, wbs, is_milestone, p_start, p_finish, a_start, a_finish,
               parent_id, sort_order) in rows]

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
