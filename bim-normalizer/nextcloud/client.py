"""
Nextcloud WebDAV + OCS HTTP client. Same requests.* convention as
speckle/webhooks.py — plain functions over a shared requests.Session, no
class/state beyond the module-level settings import.

All file operations authenticate as NEXTCLOUD_USER/NEXTCLOUD_APP_PASSWORD (a
single service account — see nextcloud/provisioning.py for the separate admin
credential used only for OCS user/group provisioning). Every path this module
touches is under that account's own DAV root, which is where Nextcloud's
Groupfolders app mounts group folders for their members — so uploading to
"project-<stream_id>/01_WIP/foo.ifc" just works once the service account is a
member of that project's group.
"""
import logging
from urllib.parse import quote, urlsplit, urlunsplit
from xml.etree import ElementTree as ET

import requests

from config import settings

logger = logging.getLogger(__name__)

_DAV_NS = {"d": "DAV:", "oc": "http://owncloud.org/ns", "nc": "http://nextcloud.org/ns"}


class NextcloudError(Exception):
    pass


class NextcloudConflictError(NextcloudError):
    """OCS statuscode 102 — e.g. 'user/group already exists'. Callers doing
    idempotent ensure_*() provisioning catch this specifically and treat it
    as success, rather than string-matching the error message."""
    pass


def _auth() -> tuple[str, str]:
    return (settings.NEXTCLOUD_USER, settings.NEXTCLOUD_APP_PASSWORD)


def _dav_url(path: str) -> str:
    path = path.strip("/")
    return f"{settings.NEXTCLOUD_URL}/remote.php/dav/files/{settings.NEXTCLOUD_USER}/{path}"


def _ocs_request(method: str, path: str, auth: tuple[str, str], base: str = "ocs/v2.php", **kwargs) -> dict:
    """Shared by provisioning.py/groupfolders.py — those call with the admin
    credential, this module's own OCS helpers (none yet) would use _auth().

    base defaults to the standard OCS namespace (core Provisioning API routes
    — cloud/users, cloud/groups — live here). The Groupfolders app's
    FolderController extends OCSController (same {"ocs":{...}} envelope) but
    registers its routes as plain #[FrontpageRoute]s, not #[ApiRoute]s — so
    its endpoints live directly under the app path with no /ocs/vN.php/
    prefix at all. groupfolders.py passes base="" for those calls."""
    url = f"{settings.NEXTCLOUD_URL}/{path.lstrip('/')}" if not base else f"{settings.NEXTCLOUD_URL}/{base}/{path.lstrip('/')}"
    resp = requests.request(
        method, url, auth=auth,
        headers={"OCS-APIRequest": "true", "Accept": "application/json"},
        timeout=30,
        **kwargs,
    )
    # Nextcloud's OCS envelope is the real source of truth for success/
    # conflict/error (its own meta.statuscode), independent of the HTTP
    # status code wrapping it — confirmed "group already exists" comes back
    # as HTTP 400 with a perfectly valid {"ocs":{"meta":{"statuscode":102,
    # "message":"group exists"}...}} body. Parsing JSON first (regardless of
    # HTTP status) is what makes that conflict detection actually reachable;
    # checking resp.status_code >= 400 up front would raise a generic error
    # before ever seeing statuscode 102. A non-JSON body (Nextcloud's own
    # setup-wizard/untrusted-domain HTML pages) is the only case that still
    # falls back to the raw HTTP status.
    try:
        body = resp.json()
    except ValueError:
        raise NextcloudError(f"OCS {method} {path} failed: {resp.status_code} {resp.text[:300]}")
    meta = body.get("ocs", {}).get("meta", {})
    statuscode = meta.get("statuscode")
    if statuscode == 102:
        raise NextcloudConflictError(f"OCS {method} {path}: {meta.get('message') or 'already exists'}")
    if statuscode not in (100, 200):
        raise NextcloudError(f"OCS {method} {path}: {meta.get('message') or meta}")
    return body.get("ocs", {}).get("data", {})


_PROPFIND_BODY = """<?xml version="1.0"?>
<d:propfind xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns" xmlns:nc="http://nextcloud.org/ns">
  <d:prop>
    <d:getlastmodified/>
    <d:getcontentlength/>
    <d:getcontenttype/>
    <d:getetag/>
    <d:resourcetype/>
    <oc:fileid/>
  </d:prop>
</d:propfind>"""


def _parse_propfind(xml_bytes: bytes, base_path: str) -> list[dict]:
    root = ET.fromstring(xml_bytes)
    dav_prefix = f"/remote.php/dav/files/{settings.NEXTCLOUD_USER}/"
    entries = []
    for response in root.findall("d:response", _DAV_NS):
        href = response.findtext("d:href", default="", namespaces=_DAV_NS)
        prop = response.find("d:propstat/d:prop", _DAV_NS)
        if prop is None:
            continue
        rel = href
        if dav_prefix in href:
            rel = href.split(dav_prefix, 1)[1]
        rel = requests.utils.unquote(rel).rstrip("/")
        if rel == base_path.strip("/"):
            continue  # PROPFIND depth-1 always includes the folder itself
        is_dir = prop.find("d:resourcetype/d:collection", _DAV_NS) is not None
        fileid = prop.findtext("oc:fileid", namespaces=_DAV_NS)
        entries.append({
            "path": rel,
            "name": rel.rsplit("/", 1)[-1],
            "is_dir": is_dir,
            "fileid": int(fileid) if fileid else None,
            "etag": (prop.findtext("d:getetag", namespaces=_DAV_NS) or "").strip('"'),
            "size": int(prop.findtext("d:getcontentlength", default="0", namespaces=_DAV_NS) or 0),
            "mime_type": prop.findtext("d:getcontenttype", namespaces=_DAV_NS),
            "last_modified": prop.findtext("d:getlastmodified", namespaces=_DAV_NS),
        })
    return entries


def list_folder(path: str, depth: str = "1") -> list[dict]:
    """List immediate children of `path` (Depth: 1) or the whole subtree
    (Depth: infinity, used by reconcile.py). Returns [] if the folder
    doesn't exist yet rather than raising, since callers create-on-demand."""
    resp = requests.request(
        "PROPFIND", _dav_url(path), auth=_auth(),
        headers={"Depth": depth, "Content-Type": "application/xml"},
        data=_PROPFIND_BODY, timeout=30,
    )
    if resp.status_code == 404:
        return []
    if resp.status_code >= 400:
        raise NextcloudError(f"PROPFIND {path} failed: {resp.status_code} {resp.text[:300]}")
    return _parse_propfind(resp.content, path)


def get_file_metadata(path: str) -> dict | None:
    entries = list_folder(path.rsplit("/", 1)[0] if "/" in path else "", depth="1")
    name = path.rsplit("/", 1)[-1]
    for e in entries:
        if e["name"] == name:
            return e
    return None


def download_bytes(path: str) -> bytes:
    resp = requests.get(_dav_url(path), auth=_auth(), timeout=120)
    if resp.status_code == 404:
        raise NextcloudError(f"File not found: {path}")
    resp.raise_for_status()
    return resp.content


def ensure_folder(path: str) -> None:
    """MKCOL is idempotent-ish here — 405 means it already exists."""
    resp = requests.request("MKCOL", _dav_url(path), auth=_auth(), timeout=30)
    if resp.status_code not in (201, 405):
        raise NextcloudError(f"MKCOL {path} failed: {resp.status_code} {resp.text[:300]}")


def upload_bytes(path: str, content: bytes, overwrite: bool) -> dict:
    """Upload to `path`. overwrite=False (new document) refuses to clobber an
    existing file and instead retries once with a "(1)" suffix on collision;
    overwrite=True (a revision) omits If-None-Match so Nextcloud auto-versions
    the prior content instead of rejecting the write."""
    headers = {} if overwrite else {"If-None-Match": "*"}
    resp = requests.put(_dav_url(path), auth=_auth(), data=content, headers=headers, timeout=120)
    if resp.status_code == 412 and not overwrite:
        stem, _, ext = path.rpartition(".")
        alt_path = f"{stem} (1).{ext}" if stem else f"{path} (1)"
        # Keep If-None-Match: * on the retry too — omitting it here meant a
        # second collision (the " (1)" path already existing, e.g. two
        # racing uploads of the same filename) silently overwrote it instead
        # of raising, bypassing the "refuse to clobber" contract this
        # function documents for overwrite=False: no version bump, no
        # bim_document_events record, none of revise()'s gate resets.
        resp = requests.put(_dav_url(alt_path), auth=_auth(), data=content, headers=headers, timeout=120)
        path = alt_path
    if resp.status_code >= 400:
        raise NextcloudError(f"PUT {path} failed: {resp.status_code} {resp.text[:300]}")
    meta = get_file_metadata(path)
    if meta is None:
        raise NextcloudError(f"Upload to {path} succeeded but metadata lookup failed")
    return meta


def move(src_path: str, dst_path: str) -> None:
    # The Destination header is a raw header value — unlike the request's
    # own `url` kwarg (which requests/urllib3 percent-encodes automatically,
    # why GET/PUT/DELETE below work fine with spaces/non-ASCII filenames
    # straight from _dav_url()), header values are sent as-is. SabreDAV then
    # tries to parse that literal string as a URI and throws
    # Sabre\Uri\InvalidUriException on unescaped spaces or UTF-8 characters
    # (confirmed: a filename containing "ä" and multiple spaces reproduced
    # this in production). Percent-encode just the path component, leaving
    # '/' unescaped so path segments survive.
    dst_url = _dav_url(dst_path)
    parts = urlsplit(dst_url)
    dst_url = urlunsplit((parts.scheme, parts.netloc, quote(parts.path, safe="/"), parts.query, parts.fragment))
    resp = requests.request(
        "MOVE", _dav_url(src_path), auth=_auth(),
        headers={"Destination": dst_url, "Overwrite": "F"},
        timeout=30,
    )
    if resp.status_code >= 400:
        raise NextcloudError(f"MOVE {src_path} -> {dst_path} failed: {resp.status_code} {resp.text[:300]}")


def delete(path: str) -> None:
    resp = requests.delete(_dav_url(path), auth=_auth(), timeout=30)
    if resp.status_code not in (204, 404):
        raise NextcloudError(f"DELETE {path} failed: {resp.status_code} {resp.text[:300]}")


def list_versions(fileid: int) -> list[dict]:
    """Nextcloud's WebDAV versions API is keyed by fileid, not path — stable
    across moves/renames, which is why bim_documents stores nc_fileid."""
    url = f"{settings.NEXTCLOUD_URL}/remote.php/dav/versions/{settings.NEXTCLOUD_USER}/versions/{fileid}"
    resp = requests.request(
        "PROPFIND", url, auth=_auth(),
        headers={"Depth": "1", "Content-Type": "application/xml"},
        data=_PROPFIND_BODY, timeout=30,
    )
    if resp.status_code == 404:
        return []
    if resp.status_code >= 400:
        raise NextcloudError(f"PROPFIND versions/{fileid} failed: {resp.status_code} {resp.text[:300]}")
    root = ET.fromstring(resp.content)
    versions = []
    for response in root.findall("d:response", _DAV_NS):
        href = response.findtext("d:href", default="", namespaces=_DAV_NS)
        prop = response.find("d:propstat/d:prop", _DAV_NS)
        if prop is None or href.rstrip("/").endswith(str(fileid)):
            continue  # the versions collection itself
        version_id = href.rstrip("/").rsplit("/", 1)[-1]
        versions.append({
            "version_id": version_id,
            "size": int(prop.findtext("d:getcontentlength", default="0", namespaces=_DAV_NS) or 0),
            "last_modified": prop.findtext("d:getlastmodified", namespaces=_DAV_NS),
        })
    return sorted(versions, key=lambda v: v["version_id"], reverse=True)


def download_version(fileid: int, version_id: str) -> bytes:
    url = f"{settings.NEXTCLOUD_URL}/remote.php/dav/versions/{settings.NEXTCLOUD_USER}/versions/{fileid}/{version_id}"
    resp = requests.get(url, auth=_auth(), timeout=120)
    resp.raise_for_status()
    return resp.content
