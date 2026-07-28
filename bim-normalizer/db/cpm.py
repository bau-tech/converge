"""
Critical Path Method (CPM) engine for bim_tasks / bim_task_dependencies.

compute_cpm() is a pure, in-memory graph algorithm (no DB access) so it can
be unit-tested directly. recompute_and_persist_cpm() is the DB-facing
wrapper that every mutating function in db/schedule.py calls before its own
commit, so is_critical/float_days on bim_tasks stay authoritative regardless
of entry point (manual task/dependency CRUD, IFC import, MSPDI import) —
previously these columns were only ever correct if a source file happened to
carry its own IsCritical/TotalFloat/Critical values.
"""
import logging
from collections import defaultdict, deque
from datetime import date

logger = logging.getLogger(__name__)

_SEQUENCE_TYPES = {'FINISH_START', 'START_START', 'FINISH_FINISH', 'START_FINISH'}


def _effective_duration(task: dict) -> float:
    if task.get('duration_days') is not None:
        return float(task['duration_days'])
    start, finish = task.get('planned_start'), task.get('planned_finish')
    if start and finish:
        return float((finish - start).days)
    return 0.0


def compute_cpm(tasks: list[dict], dependencies: list[dict]) -> dict[str, dict]:
    """
    tasks: [{'task_id': str, 'planned_start': date|None, 'planned_finish': date|None,
             'duration_days': float|None}, ...]
    dependencies: [{'predecessor_task_id': str, 'successor_task_id': str,
                     'sequence_type': 'FINISH_START'|'START_START'|'FINISH_FINISH'|'START_FINISH',
                     'lag_days': float|None}, ...]

    Returns {task_id: {'is_critical': bool, 'float_days': float|None}} for
    every task_id in `tasks`. Only tasks that participate in the dependency
    graph (at least one predecessor or successor edge) get a float value;
    isolated tasks and tasks caught in a cycle get float_days=None,
    is_critical=False (cycles are logged and skipped, never raised — a
    malformed source IFC/MSPDI file could contain one).

    Activity-on-node CPM in date space (days from the earliest planned_start
    present, or today if none is set):
      1. Topological sort (Kahn's algorithm) over the dependency graph only
         — NOT parent_task_id/WBS hierarchy. WBS summary tasks participate
         in CPM only if they carry their own explicit dependency rows; there
         is no auto-rollup of child dates onto parents (that's hammock-task
         behavior, out of scope).
      2. Forward pass: early start (ES) for a task with no predecessors is
         its own planned_start if set, else 0 (the anchor day). For a task
         with predecessors, ES is the max over each incoming edge of the
         constraint implied by sequence_type + lag_days:
           FINISH_START:  ES(s) >= EF(p) + lag
           START_START:   ES(s) >= ES(p) + lag
           FINISH_FINISH: ES(s) >= EF(p) + lag - duration(s)
           START_FINISH:  ES(s) >= ES(p) + lag - duration(s)
         EF = ES + duration.
      3. project_finish = max(EF) over network sinks (tasks with no
         outgoing edges in the connected subgraph).
      4. Backward pass (reverse topological order): sinks get LF = project
         finish. Non-sink tasks take the min over each outgoing edge of the
         mirrored constraint:
           FINISH_START:  LF(p) = LS(s) - lag
           START_START:   LF(p) = LS(s) - lag + duration(p)
           FINISH_FINISH: LF(p) = LF(s) - lag
           START_FINISH:  LF(p) = LF(s) - lag + duration(p)
         LS = LF - duration.
      5. float_days = round(LS - ES, 2); is_critical = round(float_days) <= 0
         (rounded to whole days before comparing, since durations/lags are
         day-granular in this schema — avoids float-epsilon false negatives).
    """
    by_id = {t['task_id']: t for t in tasks}
    valid_deps = [
        d for d in dependencies
        if d['predecessor_task_id'] in by_id
        and d['successor_task_id'] in by_id
        and d['predecessor_task_id'] != d['successor_task_id']
    ]

    preds = defaultdict(list)   # successor_id   -> [(predecessor_id, seq_type, lag), ...]
    succs = defaultdict(list)   # predecessor_id -> [(successor_id,   seq_type, lag), ...]
    indeg = defaultdict(int)
    connected = set()
    for d in valid_deps:
        p, s = d['predecessor_task_id'], d['successor_task_id']
        seq_type = d.get('sequence_type') if d.get('sequence_type') in _SEQUENCE_TYPES else 'FINISH_START'
        lag = float(d.get('lag_days') or 0)
        preds[s].append((p, seq_type, lag))
        succs[p].append((s, seq_type, lag))
        indeg[s] += 1
        indeg.setdefault(p, 0)
        connected.add(p)
        connected.add(s)

    starts = [t['planned_start'] for t in tasks if t.get('planned_start')]
    anchor: date = min(starts) if starts else date.today()

    def to_days(d: date) -> float:
        return float((d - anchor).days)

    durations = {tid: _effective_duration(t) for tid, t in by_id.items()}

    queue = deque(tid for tid in connected if indeg.get(tid, 0) == 0)
    order: list[str] = []
    indeg_work = dict(indeg)
    while queue:
        tid = queue.popleft()
        order.append(tid)
        for succ_id, _, _ in succs.get(tid, []):
            indeg_work[succ_id] -= 1
            if indeg_work[succ_id] == 0:
                queue.append(succ_id)

    cyclic = connected - set(order)
    if cyclic:
        logger.warning("CPM: skipping %d task(s) in a circular dependency: %s",
                        len(cyclic), sorted(cyclic))

    es: dict[str, float] = {}
    ef: dict[str, float] = {}
    for tid in order:
        dur = durations.get(tid, 0.0)
        own_start = by_id[tid].get('planned_start')
        candidates = [to_days(own_start)] if own_start else []
        for pred_id, seq_type, lag in preds.get(tid, []):
            if pred_id not in ef:
                continue
            if seq_type == 'FINISH_START':
                candidates.append(ef[pred_id] + lag)
            elif seq_type == 'START_START':
                candidates.append(es[pred_id] + lag)
            elif seq_type == 'FINISH_FINISH':
                candidates.append(ef[pred_id] + lag - dur)
            elif seq_type == 'START_FINISH':
                candidates.append(es[pred_id] + lag - dur)
        es[tid] = max(candidates) if candidates else 0.0
        ef[tid] = es[tid] + dur

    sinks = [tid for tid in order if not succs.get(tid)]
    project_finish = max((ef[tid] for tid in sinks), default=0.0)

    ls: dict[str, float] = {}
    lf: dict[str, float] = {}
    for tid in reversed(order):
        dur = durations.get(tid, 0.0)
        succ_edges = succs.get(tid, [])
        if not succ_edges:
            lf[tid] = project_finish
        else:
            candidates = []
            for succ_id, seq_type, lag in succ_edges:
                if succ_id not in lf:
                    continue
                if seq_type == 'FINISH_START':
                    candidates.append(ls[succ_id] - lag)
                elif seq_type == 'START_START':
                    candidates.append(ls[succ_id] - lag + dur)
                elif seq_type == 'FINISH_FINISH':
                    candidates.append(lf[succ_id] - lag)
                elif seq_type == 'START_FINISH':
                    candidates.append(lf[succ_id] - lag + dur)
            lf[tid] = min(candidates) if candidates else project_finish
        ls[tid] = lf[tid] - dur

    result: dict[str, dict] = {}
    for tid in by_id:
        if tid not in es:
            result[tid] = {'is_critical': False, 'float_days': None}
            continue
        float_days = round(ls[tid] - es[tid], 2)
        result[tid] = {'is_critical': round(float_days) <= 0, 'float_days': float_days}
    return result


def recompute_and_persist_cpm(conn, model_id: str) -> dict:
    """
    Recompute CPM for every task in model_id and persist any changed
    is_critical/float_days values back to bim_tasks in a single bulk UPDATE.
    Does NOT call conn.commit() — the caller (an existing db/schedule.py
    mutation function) commits once, atomically, alongside its own change.
    """
    with conn.cursor() as cur:
        cur.execute("""
            SELECT task_id, planned_start, planned_finish, duration_days, is_critical, float_days
            FROM bim_tasks WHERE model_id = %s
        """, (model_id,))
        rows = cur.fetchall()

    if not rows:
        return {'recomputed': 0}

    tasks = [{
        'task_id': str(r[0]), 'planned_start': r[1], 'planned_finish': r[2], 'duration_days': r[3],
    } for r in rows]
    current = {str(r[0]): (r[4], r[5]) for r in rows}

    with conn.cursor() as cur:
        cur.execute("""
            SELECT d.predecessor_task_id::text, d.successor_task_id::text, d.sequence_type, d.lag_days
            FROM bim_task_dependencies d
            JOIN bim_tasks t ON t.task_id = d.predecessor_task_id
            WHERE t.model_id = %s
        """, (model_id,))
        dependencies = [{
            'predecessor_task_id': p, 'successor_task_id': s, 'sequence_type': st, 'lag_days': lag,
        } for p, s, st, lag in cur.fetchall()]

    results = compute_cpm(tasks, dependencies)
    changed = [
        (tid, r['is_critical'], r['float_days'])
        for tid, r in results.items()
        if current.get(tid) != (r['is_critical'], r['float_days'])
    ]
    if changed:
        from psycopg2.extras import execute_values
        with conn.cursor() as cur:
            # Explicit casts on the SET side, not just the VALUES side: when a
            # task has no float value (terminal task with nothing downstream),
            # float_days is NULL, and a bare NULL literal in a VALUES(...)
            # clause carries no type — Postgres resolves the whole column to
            # "unknown"/text instead of double precision whenever that NULL
            # lands in the first row of the batch, so a later UPDATE assigning
            # it straight into a double precision column fails with
            # "column is of type double precision but expression is of type
            # text". Casting here fixes it regardless of row order.
            execute_values(cur, """
                UPDATE bim_tasks AS t SET
                    is_critical = v.is_critical::boolean,
                    float_days  = v.float_days::double precision
                FROM (VALUES %s) AS v(task_id, is_critical, float_days)
                WHERE t.task_id = v.task_id::uuid
            """, changed)
    return {'recomputed': len(changed)}
