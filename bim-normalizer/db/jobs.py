"""
DB-backed async job tracking (bim_jobs table) — replaces the old in-memory
job_registry.py dicts so a backend restart doesn't strand a polling client
with an unrecoverable 404 for a job that may have already completed.

Shared by routers/ingest.py, ifc_export.py, filter_publish.py, ids_check.py,
and clash_check.py.

Every function rolls back on failure before re-raising — a connection handed
back to the pool mid-failed-transaction would poison it for whichever caller
gets it next (Postgres refuses further commands until the transaction ends).
"""
import json
import logging

logger = logging.getLogger(__name__)

JOB_KEEP = 100  # max completed/failed rows to retain per job_type


def _row_to_job(row) -> dict:
    job_id, job_type, status, payload, result, error = row
    return {
        "job_id": str(job_id),
        "job_type": job_type,
        "status": status,
        "payload": payload if payload is not None else {},
        "result": result if result is not None else {},
        "error": error,
    }


def create_job(conn, job_id: str, job_type: str, payload: dict | None = None) -> None:
    try:
        with conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO bim_jobs (job_id, job_type, status, payload)
                VALUES (%s, %s, 'running', %s::jsonb)
                """,
                (job_id, job_type, json.dumps(payload or {}, default=str)),
            )
        conn.commit()
    except Exception:
        conn.rollback()
        raise


def update_job(conn, job_id: str, **fields) -> None:
    """Update any of status/result/error for a job. Unknown kwargs are ignored."""
    set_clauses = ["updated_at = NOW()"]
    values = []
    if "status" in fields:
        set_clauses.append("status = %s")
        values.append(fields["status"])
    if "result" in fields:
        set_clauses.append("result = %s::jsonb")
        values.append(json.dumps(fields["result"], default=str))
    if "error" in fields:
        set_clauses.append("error = %s")
        values.append(fields["error"])
    if not values:
        return
    values.append(job_id)
    try:
        with conn.cursor() as cur:
            cur.execute(f"UPDATE bim_jobs SET {', '.join(set_clauses)} WHERE job_id = %s", values)
        conn.commit()
    except Exception:
        conn.rollback()
        raise


def get_job(conn, job_id: str) -> dict | None:
    try:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT job_id, job_type, status, payload, result, error FROM bim_jobs WHERE job_id = %s",
                (job_id,),
            )
            row = cur.fetchone()
    except Exception:
        conn.rollback()
        raise
    return _row_to_job(row) if row else None


def fail_stale_running_jobs(conn) -> int:
    """Mark every job still 'running'/'pending' as 'failed'. Call once at
    startup, before anything else touches bim_jobs — a 'running' row can only
    mean a job actually in flight in *this* process (job state lives in the
    DB precisely so restarts don't strand polling clients, but the async task
    doing the work does not survive the restart). Left alone, such a row
    permanently zombies: find_running_job() has no liveness check, so every
    later request for the same stream_id/commit_id (or export/check target)
    just gets handed the dead job's id back and polls it forever, with no
    error and no timeout — this is exactly what happened to a forced
    re-ingest that sat at "running" with zero CPU/DB activity for 20+ minutes
    after a mid-job redeploy."""
    try:
        with conn.cursor() as cur:
            cur.execute(
                """
                UPDATE bim_jobs SET status = 'failed', error = %s, updated_at = NOW()
                WHERE status IN ('running', 'pending')
                """,
                ("Backend restarted while this job was in flight",),
            )
            failed = cur.rowcount
        conn.commit()
        if failed:
            logger.warning("Marked %d stale running/pending job(s) as failed on startup", failed)
        return failed
    except Exception:
        conn.rollback()
        raise


def find_running_job(conn, job_type: str, **payload_filters) -> str | None:
    """Return the job_id of a running/pending job of this type whose payload
    matches all given filters, or None. Used to dedupe duplicate requests for
    the same underlying work (e.g. a webhook retry while the first ingest is
    still in flight)."""
    conditions = ["job_type = %s", "status IN ('running', 'pending')"]
    values: list = [job_type]
    for key, val in payload_filters.items():
        conditions.append("payload->>%s = %s")
        values.extend([key, str(val)])
    try:
        with conn.cursor() as cur:
            cur.execute(
                f"SELECT job_id FROM bim_jobs WHERE {' AND '.join(conditions)} ORDER BY created_at LIMIT 1",
                values,
            )
            row = cur.fetchone()
    except Exception:
        conn.rollback()
        raise
    return str(row[0]) if row else None


def prune_jobs(conn, job_type: str, keep: int = JOB_KEEP) -> int:
    """Delete all but the most recent `keep` completed/failed rows for this job_type."""
    try:
        with conn.cursor() as cur:
            cur.execute(
                """
                DELETE FROM bim_jobs
                WHERE job_type = %s
                  AND status IN ('complete', 'failed')
                  AND job_id NOT IN (
                      SELECT job_id FROM bim_jobs
                      WHERE job_type = %s AND status IN ('complete', 'failed')
                      ORDER BY created_at DESC
                      LIMIT %s
                  )
                """,
                (job_type, job_type, keep),
            )
            deleted = cur.rowcount
        conn.commit()
        return deleted
    except Exception:
        conn.rollback()
        raise
