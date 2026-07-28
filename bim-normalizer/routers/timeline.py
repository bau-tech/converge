import logging

from fastapi import APIRouter, HTTPException, UploadFile
from pydantic import BaseModel

logger = logging.getLogger(__name__)
router = APIRouter(tags=["timeline"])


class TaskCreateRequest(BaseModel):
    name: str
    planned_start: str | None = None
    planned_finish: str | None = None
    actual_start: str | None = None
    actual_finish: str | None = None
    parent_task_id: str | None = None
    wbs_code: str | None = None
    is_milestone: bool = False


class TaskUpdateRequest(BaseModel):
    name: str | None = None
    planned_start: str | None = None
    planned_finish: str | None = None
    actual_start: str | None = None
    actual_finish: str | None = None
    parent_task_id: str | None = None
    wbs_code: str | None = None
    is_milestone: bool | None = None
    status: str | None = None


class ElementLinkRequest(BaseModel):
    speckle_ids: list[str]


class DependencyCreateRequest(BaseModel):
    predecessor_task_id: str
    successor_task_id: str
    sequence_type: str = 'FINISH_START'
    lag_days: float | None = None


class GenerateScheduleRequest(BaseModel):
    strategy: str = 'storey'           # 'storey' | 'height'
    start_date: str                    # 'YYYY-MM-DD'
    days_per_group: float = 5
    lag_days: float = 0
    order: str = 'bottom-up'           # 'bottom-up' | 'top-down'
    link_sequences: bool = True
    height_band_m: float = 3.0         # only used when strategy == 'height'


@router.get("/models/{model_id}/timeline/params")
def get_timeline_params(model_id: str):
    """Discover parameters that can drive a 4D build-up animation."""
    from db.connection import get_conn, release_conn
    from db.timeline import get_timeline_params as _params
    conn = get_conn()
    try:
        return _params(conn, model_id)
    finally:
        release_conn(conn)


@router.get("/models/{model_id}/timeline/data")
def get_timeline_data(model_id: str, param_key: str):
    """Return elements grouped by param_key, sorted chronologically."""
    from db.connection import get_conn, release_conn
    from db.timeline import get_timeline_data as _data
    conn = get_conn()
    try:
        return _data(conn, model_id, param_key)
    finally:
        release_conn(conn)


@router.get("/models/{model_id}/schedule")
def get_schedule(model_id: str):
    """Return the full task tree with element speckle_ids for viewer sync."""
    from db.connection import get_conn, release_conn
    from db.schedule import get_schedule as _get
    conn = get_conn()
    try:
        return _get(conn, model_id)
    finally:
        release_conn(conn)


@router.delete("/models/{model_id}/schedule")
def delete_schedule(model_id: str):
    """Wipe the entire schedule (all tasks, dependencies, element links) for a model."""
    from db.connection import get_conn, release_conn
    from db.schedule import delete_schedule as _delete_schedule
    conn = get_conn()
    try:
        deleted = _delete_schedule(conn, model_id)
        return {"deleted_tasks": deleted}
    finally:
        release_conn(conn)


@router.post("/models/{model_id}/schedule/import")
async def import_schedule(model_id: str, file: UploadFile):
    """Import a schedule into bim_tasks, from either an IFC file containing
    IfcWorkSchedule or a Microsoft Project XML (MSPDI) export."""
    from db.connection import get_conn, release_conn
    from db.schedule import import_from_ifc, import_from_mspdi

    filename = (file.filename or '').lower()
    if not (filename.endswith('.ifc') or filename.endswith('.xml')):
        raise HTTPException(status_code=400, detail='Unsupported file type. Upload an IFC file containing IfcWorkSchedule, or an MS Project XML (MSPDI) export.')

    content = await file.read()
    conn = get_conn()
    try:
        if filename.endswith('.xml'):
            return import_from_mspdi(conn, model_id, content)

        import tempfile, os
        with tempfile.NamedTemporaryFile(suffix='.ifc', delete=False) as f:
            f.write(content)
            tmp = f.name
        try:
            return import_from_ifc(conn, model_id, tmp)
        finally:
            os.unlink(tmp)
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))
    except Exception as e:
        logger.exception("Schedule import failed for model %s (%s)", model_id, filename)
        raise HTTPException(status_code=422, detail=f'Import failed: {e}')
    finally:
        release_conn(conn)


@router.post("/models/{model_id}/schedule/generate")
def generate_schedule(model_id: str, body: GenerateScheduleRequest):
    """Auto-generate a schedule from the model's own storey/geometry data —
    one task per storey (or per Z-height band), elements auto-assigned,
    consecutive tasks optionally chained FINISH_START. Replaces any existing
    schedule, same as import."""
    from db.connection import get_conn, release_conn
    from db.schedule import generate_schedule as _generate_schedule
    conn = get_conn()
    try:
        return _generate_schedule(
            conn, model_id, body.strategy, body.start_date, body.days_per_group,
            lag_days=body.lag_days, order=body.order, link_sequences=body.link_sequences,
            height_band_m=body.height_band_m,
        )
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))
    finally:
        release_conn(conn)


@router.get("/models/{model_id}/schedule/export-ifc")
def export_schedule_ifc(model_id: str):
    """Minimal schedule-only IFC (no geometry) for round-tripping the current
    schedule to other tools. Synchronous (unlike /export/ifc's async job)
    since a schedule-only file is small/fast."""
    from fastapi.responses import Response
    from db.connection import get_conn, release_conn
    from db.schedule import get_tasks_for_export
    from ifc.export import export_schedule_only

    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT * FROM bim_models WHERE model_id = %s", (model_id,))
            row = cur.fetchone()
            if not row:
                raise HTTPException(status_code=404, detail="Model not found")
            model_row = dict(zip([d[0] for d in cur.description], row))
        tasks, _task_elements = get_tasks_for_export(conn, model_id)
    finally:
        release_conn(conn)

    ifc_bytes = export_schedule_only(model_row, tasks)
    return Response(content=ifc_bytes, media_type="application/x-step")


@router.post("/models/{model_id}/schedule/tasks")
def create_task(model_id: str, body: TaskCreateRequest):
    """Manually create a 4D task (no IFC schedule import required)."""
    from db.connection import get_conn, release_conn
    from db.schedule import create_task as _create_task
    conn = get_conn()
    try:
        task_id = _create_task(
            conn, model_id, body.name,
            planned_start=body.planned_start, planned_finish=body.planned_finish,
            actual_start=body.actual_start, actual_finish=body.actual_finish,
            parent_task_id=body.parent_task_id, wbs_code=body.wbs_code,
            is_milestone=body.is_milestone,
        )
        return {"task_id": task_id}
    finally:
        release_conn(conn)


@router.patch("/models/{model_id}/schedule/tasks/{task_id}")
def update_task(model_id: str, task_id: str, body: TaskUpdateRequest):
    """Edit a task's fields. Only fields present in the request body are changed."""
    from db.connection import get_conn, release_conn
    from db.schedule import update_task as _update_task
    conn = get_conn()
    try:
        updated = _update_task(conn, model_id, task_id, **body.model_dump(exclude_unset=True))
        if not updated:
            raise HTTPException(status_code=404, detail="Task not found or no fields to update")
        return {"updated": True}
    finally:
        release_conn(conn)


@router.delete("/models/{model_id}/schedule/tasks/{task_id}")
def delete_task(model_id: str, task_id: str):
    from db.connection import get_conn, release_conn
    from db.schedule import delete_task as _delete_task
    conn = get_conn()
    try:
        deleted = _delete_task(conn, model_id, task_id)
        if not deleted:
            raise HTTPException(status_code=404, detail="Task not found")
        return {"deleted": True}
    finally:
        release_conn(conn)


@router.post("/models/{model_id}/schedule/tasks/{task_id}/elements")
def link_task_elements(model_id: str, task_id: str, body: ElementLinkRequest):
    """Link the given Speckle element ids (e.g. the current viewer selection) to a task."""
    from db.connection import get_conn, release_conn
    from db.schedule import link_elements_by_speckle_id
    conn = get_conn()
    try:
        linked = link_elements_by_speckle_id(conn, task_id, model_id, body.speckle_ids)
        return {"linked": linked}
    finally:
        release_conn(conn)


@router.delete("/models/{model_id}/schedule/tasks/{task_id}/elements")
def unlink_task_elements(model_id: str, task_id: str, body: ElementLinkRequest):
    from db.connection import get_conn, release_conn
    from db.schedule import unlink_elements_by_speckle_id
    conn = get_conn()
    try:
        unlinked = unlink_elements_by_speckle_id(conn, task_id, model_id, body.speckle_ids)
        return {"unlinked": unlinked}
    finally:
        release_conn(conn)


@router.post("/models/{model_id}/schedule/dependencies")
def create_dependency(model_id: str, body: DependencyCreateRequest):
    """Create (or edit the type/lag of an existing) dependency between two
    tasks in this model. Rejects a request that would create a cycle, or
    that references a task_id not belonging to this model, with HTTP 422.
    Triggers a CPM recompute before returning."""
    from db.connection import get_conn, release_conn
    from db.schedule import create_dependency as _create_dependency
    conn = get_conn()
    try:
        return _create_dependency(
            conn, model_id, body.predecessor_task_id, body.successor_task_id,
            body.sequence_type, body.lag_days,
        )
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))
    finally:
        release_conn(conn)


@router.delete("/models/{model_id}/schedule/dependencies/{dependency_id}")
def delete_dependency(model_id: str, dependency_id: int):
    from db.connection import get_conn, release_conn
    from db.schedule import delete_dependency as _delete_dependency
    conn = get_conn()
    try:
        deleted = _delete_dependency(conn, model_id, dependency_id)
        if not deleted:
            raise HTTPException(status_code=404, detail="Dependency not found")
        return {"deleted": True}
    finally:
        release_conn(conn)
