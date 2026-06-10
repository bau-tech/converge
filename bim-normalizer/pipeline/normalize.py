import logging
import time
from typing import Any

from config.settings import SPECKLE_SERVER_URL, SPECKLE_TOKEN
from db.connection import get_conn, release_conn
from db.insert import (
    upsert_model,
    upsert_element,
    upsert_geometry,
    extract_and_upsert_parameters,
)
from ifc.classify import classify_element, compute_element_hash
from ifc.geometry import extract_geometry
from ifc.spatial import get_storey, get_application_id
from speckle.fetch import fetch_commit, flatten_elements, detect_source, collect_instance_definitions, build_object_map

logger = logging.getLogger(__name__)


def ingest_commit(
    stream_id: str,
    commit_id: str,
    token: str | None = None,
    server_url: str | None = None,
) -> dict[str, Any]:
    """
    Full pipeline: receive Speckle commit → normalise → persist.

    Returns:
        {model_id, element_count, skipped_count, duration_s}
    """
    t0 = time.monotonic()
    token = token or SPECKLE_TOKEN

    # ------------------------------------------------------------------ #
    # 1. Fetch commit + root object                                        #
    # ------------------------------------------------------------------ #
    logger.info("Fetching commit %s / %s", stream_id, commit_id)
    root, commit_meta = fetch_commit(stream_id, commit_id, token=token, server_url=server_url)

    branch_name = commit_meta.get("branch_name", "")
    author      = commit_meta.get("author", "")
    message     = commit_meta.get("message", "")
    source_app  = commit_meta.get("source_application", "")

    source = detect_source(root, source_app)
    instance_defs = collect_instance_definitions(root)
    obj_map = build_object_map(root)
    instance_defs.update(obj_map)  # merge so string IDs in InstanceDefinitionProxy.objects can be resolved
    logger.info("Object map built: %d entries total in instance_defs after merge", len(instance_defs))

    # ------------------------------------------------------------------ #
    # 2. Flatten element tree                                              #
    # ------------------------------------------------------------------ #
    # flatten_elements returns (Base, category_hint) tuples.
    # category_hint is the nearest ancestor Collection name that matches a known
    # Revit category — passed through to classify_element instead of mutating
    # the SpecklePy object.
    element_tuples = flatten_elements(root)
    logger.info("Flattened %d elements (source=%s)", len(element_tuples), source)

    # Log unique collection hints to verify they are being picked up
    hints = {hint for _, hint in element_tuples if hint}
    if hints:
        logger.info("Category hints found in tree: %s", sorted(hints))

    # ------------------------------------------------------------------ #
    # 3. DB work                                                           #
    # ------------------------------------------------------------------ #
    conn = get_conn()
    try:
        model_id = upsert_model(
            conn,
            stream_id=stream_id,
            commit_id=commit_id,
            branch_name=branch_name,
            source=source,
            author=author,
            message=message,
        )

        element_count = 0
        skipped_count = 0
        geo_count = 0
        no_geo_by_type: dict[str, int] = {}

        for obj, category_hint in element_tuples:
            speckle_id = getattr(obj, "id", None)
            if not speckle_id:
                skipped_count += 1
                continue

            speckle_type = getattr(obj, "speckle_type", "") or ""

            try:
                classification = classify_element(speckle_type, obj, category_hint, source=source)
                ifc_class    = classification["ifc_class"]
                category     = classification["category"]
                storey       = get_storey(obj)
                app_id       = get_application_id(obj)
                elem_hash    = compute_element_hash(obj)
                name         = _get_name(obj)

                element_id = upsert_element(
                    conn,
                    model_id=model_id,
                    application_id=app_id,
                    speckle_id=speckle_id,
                    speckle_type=speckle_type,
                    ifc_class=ifc_class,
                    category=category,
                    name=name,
                    storey=storey,
                    elem_hash=elem_hash,
                )

                geo = extract_geometry(obj, instance_defs=instance_defs)
                if geo:
                    upsert_geometry(conn, element_id, geo)
                    geo_count += 1
                else:
                    # Track which types are missing geometry
                    short = speckle_type.split(".")[-1] or speckle_type
                    no_geo_by_type[short] = no_geo_by_type.get(short, 0) + 1

                extract_and_upsert_parameters(conn, element_id, obj)

                element_count += 1

            except Exception as exc:
                logger.warning("Skipping element %s: %s", speckle_id, exc)
                skipped_count += 1
                continue

        conn.commit()
        duration = round(time.monotonic() - t0, 2)
        logger.info(
            "Ingested %d elements (%d with geometry, %d skipped) in %.1fs — model_id=%s",
            element_count, geo_count, skipped_count, duration, model_id,
        )
        if no_geo_by_type:
            for t, cnt in sorted(no_geo_by_type.items(), key=lambda x: -x[1]):
                logger.info("  no geometry: %s × %d", t, cnt)
        return {
            "model_id":      model_id,
            "element_count": element_count,
            "skipped_count": skipped_count,
            "duration_s":    duration,
        }

    except Exception:
        conn.rollback()
        raise
    finally:
        release_conn(conn)


def _get_name(obj) -> str:
    """Best-effort element name from common Speckle attributes."""
    for attr in ("name", "Name", "family", "type", "elementType"):
        val = getattr(obj, attr, None)
        if val and isinstance(val, str) and val.strip():
            return val.strip()
    # Tekla / v3 DataObject
    props = getattr(obj, "properties", None)
    if isinstance(props, dict):
        for key in ("Name", "name", "profile", "Profile"):
            val = props.get(key)
            if val and isinstance(val, str):
                return val.strip()
    return ""
