"""
Drift detector, not the primary sync mechanism — bim-normalizer performs
(and immediately indexes) every write itself via routers/documents.py, so
this only matters for files that reached Nextcloud some other way (a direct
upload during migration, manual admin intervention, etc.). Mirrors
speckle/webhooks.py's scan_server/_auto_sync_loop pattern: walk every status
subfolder and upsert what's found. Shared by the on-demand
POST /projects/{stream_id}/documents/backfill route and _document_sync_loop
in main.py.
"""
import logging

from nextcloud.groupfolders import STATUS_FOLDERS

logger = logging.getLogger(__name__)


def reconcile_project(conn, stream_id: str) -> int:
    """Upsert every file currently in stream_id's group folder. Returns the
    number of files indexed."""
    from db.documents import upsert_document
    from nextcloud.client import list_folder
    from nextcloud.groupfolders import group_folder_mountpoint

    group_folder = group_folder_mountpoint(stream_id)
    with conn.cursor() as cur:
        cur.execute(
            "SELECT model_id FROM bim_models WHERE stream_id = %s ORDER BY ingested_at DESC LIMIT 1",
            (stream_id,),
        )
        row = cur.fetchone()
    model_id = str(row[0]) if row else None

    indexed = 0
    for status, subfolder in STATUS_FOLDERS.items():
        for entry in list_folder(f"{group_folder}/{subfolder}", "1"):
            if entry["is_dir"]:
                continue
            upsert_document(
                conn, stream_id=stream_id, model_id=model_id,
                nc_fileid=entry["fileid"], nc_path=f"{group_folder}/{subfolder}/{entry['name']}",
                nc_group_folder=group_folder, filename=entry["name"], mime_type=entry.get("mime_type"),
                size_bytes=entry.get("size"), etag=entry.get("etag"), status=status,
            )
            indexed += 1
    return indexed


def reconcile_all_projects(conn) -> int:
    """Reconcile every project that has ever had a Nextcloud group folder
    provisioned (i.e. someone has opened its Documents panel at least once —
    projects that never used Documents have no group folder to scan)."""
    from nextcloud.groupfolders import _list_group_folders

    total = 0
    for folder in _list_group_folders().values():
        mount_point = folder.get("mount_point", "")
        if not mount_point.startswith("project-"):
            continue
        stream_id = mount_point[len("project-"):]
        try:
            total += reconcile_project(conn, stream_id)
        except Exception as exc:
            logger.error("Reconciliation failed for stream %s: %s", stream_id, exc, exc_info=True)
    return total
