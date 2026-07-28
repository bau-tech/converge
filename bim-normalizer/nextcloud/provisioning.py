"""
Real Nextcloud accounts for bcf_users + per-project group membership.

Interim RBAC note: this app has no per-project access grant of its own yet
(every bcf_users row already sees every Speckle project today — see
bcf/projects.py's _AUTHORIZATION comment). So for now every user is added to
every project's Nextcloud group, matching that existing flat-access reality
exactly (no regression) while still building the real per-project
group-folder infrastructure that a future per-project grant/revoke feature
(Phase 3) can plug into by just adding/removing group membership instead of
re-architecting storage.
"""
import logging
import secrets

from bcf.db import fetch_all
from db.connection import get_conn, release_conn
from nextcloud.client import NextcloudConflictError, _ocs_request
from nextcloud.groupfolders import add_user_to_group, ensure_group_folder, group_id_for_project

logger = logging.getLogger(__name__)


def _admin_auth() -> tuple[str, str]:
    from config import settings
    return (settings.NEXTCLOUD_ADMIN_USER, settings.NEXTCLOUD_ADMIN_PASSWORD)


def _nc_username(email: str) -> str:
    """Nextcloud usernames can't contain '@' by default in this app's usage
    pattern — use the email as-is anyway; Nextcloud accepts it as a username
    (it has no special meaning there, just an opaque identifier)."""
    return email


def _all_project_stream_ids() -> list[str]:
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT DISTINCT stream_id FROM bim_models")
            return [r[0] for r in cur.fetchall()]
    finally:
        release_conn(conn)


def _all_user_emails() -> list[str]:
    return [r["email"] for r in fetch_all("SELECT email FROM bcf_users ORDER BY email")]


def ensure_user(email: str) -> None:
    """Idempotent: create the Nextcloud account if it doesn't exist yet, then
    add it to every existing project's group (see module docstring). Account
    creation failing for this one user must not be silently retried as a
    group-membership failure on every later document operation — if it
    fails, log and stop here rather than looping over projects for an
    account that doesn't exist."""
    username = _nc_username(email)
    try:
        _ocs_request(
            "POST", "cloud/users", _admin_auth(),
            data={"userid": username, "password": secrets.token_urlsafe(24), "email": email},
        )
        logger.info("Provisioned Nextcloud account for %s", email)
    except NextcloudConflictError:
        pass
    except Exception as exc:
        logger.warning("Could not create Nextcloud account for %s: %s", email, exc)
        return

    for stream_id in _all_project_stream_ids():
        try:
            ensure_group_folder(stream_id)
            add_user_to_group(username, group_id_for_project(stream_id))
        except Exception as exc:
            logger.warning("Could not add %s to project %s's Nextcloud group: %s", email, stream_id, exc)


def deprovision_user(email: str) -> None:
    """Disables rather than deletes — matches bcf_users' own delete_user
    semantics of removing access without destroying uploaded/approved
    documents' attribution history."""
    username = _nc_username(email)
    try:
        _ocs_request("PUT", f"cloud/users/{username}/disable", _admin_auth())
    except Exception as exc:
        logger.warning("Could not disable Nextcloud account for %s: %s", email, exc)


def ensure_project_group(stream_id: str) -> None:
    """Ensure this project's group folder exists and every current bcf_user
    is a member — called the first time a project's Documents panel opens or
    a Speckle project is ingested, not a manual per-project admin step.

    One user's Nextcloud account being missing/broken (e.g. it predates this
    feature, or its own provisioning failed earlier) must not block document
    operations for the whole project — this is a best-effort membership
    sync, not a precondition for uploading."""
    ensure_group_folder(stream_id)
    group_id = group_id_for_project(stream_id)
    for email in _all_user_emails():
        try:
            add_user_to_group(_nc_username(email), group_id)
        except Exception as exc:
            logger.warning("Could not add %s to project %s's Nextcloud group: %s", email, stream_id, exc)
