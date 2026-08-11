"""
OCS provisioning for the Groupfolders app — a project's group folder and its
4 status subfolders, distinct from the one-time `occ app:install groupfolders`
deploy step (see README/testing-documents.md). Called automatically the
first time a project's Documents panel is opened, not a manual admin step.

All calls authenticate as the admin account (settings.NEXTCLOUD_ADMIN_USER),
which is what the OCS Provisioning API and the Groupfolders OCS endpoint both
require — separate from the WebDAV service account in client.py.
"""
import logging
import time

from config import settings
from nextcloud.client import NextcloudConflictError, NextcloudError, _ocs_request, ensure_folder

logger = logging.getLogger(__name__)

# Single source of truth for the status <-> subfolder mapping, shared by
# routers/documents.py (route validation) and nextcloud/reconcile.py.
STATUS_FOLDERS = {
    "WIP": "01_WIP",
    "Shared": "02_Shared",
    "Published": "03_Published",
    "Archived": "04_Archived",
}
STATUS_SUBFOLDERS = tuple(STATUS_FOLDERS.values())


def _admin_auth() -> tuple[str, str]:
    return (settings.NEXTCLOUD_ADMIN_USER, settings.NEXTCLOUD_ADMIN_PASSWORD)


def group_id_for_project(stream_id: str) -> str:
    return f"project-{stream_id}"


def group_folder_mountpoint(stream_id: str) -> str:
    return group_id_for_project(stream_id)


def ensure_group(group_id: str) -> None:
    try:
        _ocs_request("POST", "cloud/groups", _admin_auth(), data={"groupid": group_id})
    except NextcloudConflictError:
        pass


def add_user_to_group(username: str, group_id: str) -> None:
    try:
        _ocs_request(
            "POST", f"cloud/users/{username}/groups", _admin_auth(),
            data={"groupid": group_id},
        )
    except NextcloudConflictError:
        pass


def remove_user_from_group(username: str, group_id: str) -> None:
    _ocs_request("DELETE", f"cloud/users/{username}/groups", _admin_auth(), data={"groupid": group_id})


def _list_group_folders() -> dict:
    """Returns {folder_id (str): {mount_point, groups, ...}}."""
    data = _ocs_request("GET", "apps/groupfolders/folders", _admin_auth(), base="")
    # Nextcloud's OCS JSON renderer returns a dict keyed by id when there are
    # results, but an empty list when there are none — normalize both.
    return data if isinstance(data, dict) else {}


def ensure_group_folder(stream_id: str) -> int:
    """Ensure the project's group folder exists, is owned by its group, and
    has the 4 status subfolders. Returns the group folder's numeric id."""
    group_id = group_id_for_project(stream_id)
    mount_point = group_folder_mountpoint(stream_id)
    ensure_group(group_id)

    folders = _list_group_folders()
    existing = next((fid for fid, f in folders.items() if f.get("mount_point") == mount_point), None)
    if existing is not None:
        folder_id = int(existing)
    else:
        created = _ocs_request(
            "POST", "apps/groupfolders/folders", _admin_auth(), base="",
            data={"mountpoint": mount_point},
        )
        folder_id = int(created["id"])

    groups = folders.get(str(folder_id), {}).get("groups", {}) if existing is not None else {}
    if group_id not in groups:
        _ocs_request(
            "POST", f"apps/groupfolders/folders/{folder_id}/groups", _admin_auth(), base="",
            data={"group": group_id},
        )

    # Group folders are strictly ACL'd by group membership — even for a
    # Nextcloud admin account — so the WebDAV service account client.py
    # always operates as (settings.NEXTCLOUD_USER) needs explicit membership
    # too, independent of which bcf_users get added by provisioning.py.
    add_user_to_group(settings.NEXTCLOUD_USER, group_id)

    # A group folder mount just created via the Groupfolders OCS API isn't
    # always immediately visible over WebDAV — Nextcloud's mount-provider
    # cache can lag a moment behind the OCS call that registered it — so the
    # very first MKCOL for its status subfolders can 409 "Parent node does
    # not exist" even though the parent mount was just created above.
    # Retrying with a short backoff clears this within a couple seconds;
    # once the mount is registered every later call (including this one on
    # an existing project) hits it immediately with no delay.
    for sub in STATUS_SUBFOLDERS:
        path = f"{mount_point}/{sub}"
        for attempt in range(5):
            try:
                ensure_folder(path)
                break
            except NextcloudError as exc:
                # Only retry the specific transient race (409 = parent mount
                # not visible yet) — anything else (permissions, a real
                # config error) is permanent and should fail immediately
                # rather than eating ~5s of retries first.
                if exc.status_code != 409 or attempt == 4:
                    raise
                time.sleep(0.5 * (attempt + 1))

    return folder_id


def delete_group_folder(stream_id: str) -> bool:
    """Tear down a project's group folder — the reverse of
    ensure_group_folder(): removes the Groupfolders mount (and everything in
    it, via the Groupfolders app's own delete, which is atomic and doesn't
    need per-file WebDAV deletes) and its dedicated group. Used only by the
    explicit "delete this project" admin action (bcf/admin.py), never by
    unattended webhook/sync cleanup.

    Best-effort and idempotent: a project whose Documents panel was never
    opened has no group folder to begin with, which is normal, not an
    error. Returns True if a group folder was actually found and deleted.
    """
    group_id = group_id_for_project(stream_id)
    mount_point = group_folder_mountpoint(stream_id)

    folders = _list_group_folders()
    folder_id = next((fid for fid, f in folders.items() if f.get("mount_point") == mount_point), None)
    found = folder_id is not None
    if found:
        _ocs_request("DELETE", f"apps/groupfolders/folders/{folder_id}", _admin_auth(), base="")

    try:
        _ocs_request("DELETE", f"cloud/groups/{group_id}", _admin_auth())
    except NextcloudError as exc:
        logger.info("Group %s delete skipped during project teardown (likely never existed): %s", group_id, exc)

    return found
