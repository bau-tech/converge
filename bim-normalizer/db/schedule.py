"""
4D schedule: parse IFC work schedules (IfcWorkSchedule) into bim_tasks.
"""
import logging
import re
from datetime import date, datetime

logger = logging.getLogger(__name__)

_ISO_DURATION = re.compile(r'P(?:(\d+(?:\.\d+)?)Y)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)W)?(?:(\d+(?:\.\d+)?)D)?', re.I)


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
