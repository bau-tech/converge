import logging
import time
from typing import Any

from config.settings import SPECKLE_SERVER_URL, SPECKLE_TOKEN
from db.connection import get_conn, release_conn
from db.insert import (
    upsert_model,
    upsert_element,
    upsert_elements_batch,
    upsert_geometry,
    upsert_geometries_batch,
    upsert_parameters,
    upsert_parameters_batch,
    extract_parameters,
    get_element_ids_missing_embedding,
    upsert_element_embeddings_batch,
    build_relationships,
)
from db.query import get_elements_with_params_for_embedding
from ifc.classify import classify_element, compute_element_hash
from ifc.geometry import extract_geometry, extract_axis_footprint
from ifc.schema import length_to_m, LENGTH_TO_M
from ifc.spatial import get_storey, get_application_id
from speckle.fetch import fetch_commit, flatten_elements, detect_source, collect_instance_definitions, build_object_map

logger = logging.getLogger(__name__)

# 256 reliably OOM-killed the worker process — confirmed by direct RSS
# measurement (resource.getrusage) in this deployment's own container: a
# single embed_many() call for a 256-text batch climbed steadily from
# ~280MB to ~4GB *within that one call*, well past search/embeddings.py's
# per-batch session recycling (which only bounds growth *between* calls —
# and even then only in principle, since discarding the Python model
# object doesn't actually return memory to the OS; a freshly restarted
# worker process measured the exact same climb again from scratch).
# Almost certainly self-attention memory scaling with batch size and
# padded-to-longest-in-batch sequence length (long element-description
# texts push the padding length up, and attention cost is quadratic in
# it) rather than a fixed per-text cost. 128 measured flat and fast
# (~500MB total, no growth) against this same deployment's data — halving
# batch size roughly quarters (or better, given the quadratic term) peak
# memory, with proportionally more but individually cheaper DB round-trips.
_EMBED_BATCH_SIZE = 128


def _build_missing_embeddings(conn, model_id: str) -> tuple[int, int]:
    """
    Embed any elements in this model without a bim_element_embeddings row yet
    (new elements from this ingest, or a model ingested before this feature
    existed). Best-effort and batched — a batch failure (e.g. the embedding
    model failing to load) is logged and skipped rather than raised, since
    semantic search is a nice-to-have on top of ingest, not a required stage.
    Returns (embedded_count, skip_count).

    CPU-bound ONNX inference, not I/O — a few hundred elements per second at
    best on this host, so a 30k+-element model can take much longer than the
    ingest itself (which — see ingest_commit() — now finishes in well under
    a minute once fetch is done). This is called from generate_embeddings_for_model()
    as a separate step *after* ingest_commit() returns, specifically so a
    slow embedding run doesn't hold the ingest job at "running" — the model's
    elements/geometry/parameters are already fully committed and queryable
    at that point; embeddings just haven't caught up yet.
    """
    from search.embeddings import build_embed_text, embed_many

    embedded = 0
    skipped = 0
    try:
        missing_ids = get_element_ids_missing_embedding(conn, model_id)
    except Exception as exc:
        logger.warning("Could not determine elements missing embeddings for model %s: %s", model_id, exc)
        return 0, 0
    if not missing_ids:
        return 0, 0

    for i in range(0, len(missing_ids), _EMBED_BATCH_SIZE):
        batch_ids = missing_ids[i:i + _EMBED_BATCH_SIZE]
        try:
            _t_fetch = time.monotonic()
            data = get_elements_with_params_for_embedding(conn, batch_ids)
            ids_in_order, texts = [], []
            for eid in batch_ids:
                el = data.get(eid)
                if el is None:
                    skipped += 1
                    continue
                ids_in_order.append(eid)
                texts.append(build_embed_text(el, el["params"]))
            _t_embed = time.monotonic()

            vectors = embed_many(texts)
            _t_write = time.monotonic()

            rows = list(zip(ids_in_order, texts, vectors))
            upsert_element_embeddings_batch(conn, rows)
            conn.commit()
            _t_done = time.monotonic()
            embedded += len(ids_in_order)
            logger.info(
                "DIAG: embeddings batch — model_id=%s embedded_so_far=%d/%d "
                "fetch=%.1fs embed=%.1fs write=%.1fs total=%.1fs",
                model_id, embedded, len(missing_ids),
                _t_embed - _t_fetch, _t_write - _t_embed, _t_done - _t_write, _t_done - _t_fetch,
            )
        except Exception as exc:
            conn.rollback()
            logger.warning("Embedding batch failed for model %s (%d elements): %s",
                            model_id, len(batch_ids), exc)
            skipped += len(batch_ids)

    return embedded, skipped


def generate_embeddings_for_model(model_id: str) -> dict:
    """Best-effort semantic-search embedding generation for a model, run as
    its own background step *after* ingest_commit() has already reported the
    ingest complete — see _build_missing_embeddings' docstring for why this
    is no longer inline in ingest_commit() itself. Manages its own
    connection since it runs independently of any ingest's connection
    lifetime."""
    conn = get_conn()
    try:
        embedded_count, skip_embed_count = _build_missing_embeddings(conn, model_id)
        logger.info("Embeddings for model %s: embedded=%d skipped=%d",
                    model_id, embedded_count, skip_embed_count)
        return {"embedded_count": embedded_count, "skip_embed_count": skip_embed_count}
    finally:
        release_conn(conn)


def ingest_commit(
    stream_id: str,
    commit_id: str,
    token: str | None = None,
    server_url: str | None = None,
    forced_source: str | None = None,
) -> dict[str, Any]:
    """
    Full pipeline: receive Speckle commit → normalise → persist. Semantic-
    search embeddings are *not* generated here — see
    generate_embeddings_for_model(), run as a separate step by the caller
    after this returns, since embedding generation is CPU-bound ONNX
    inference that can take far longer than ingest itself and shouldn't
    hold a fully-persisted, fully-queryable model at "still ingesting".

    Returns:
        {model_id, element_count, skipped_count, skip_geo_count, skip_param_count, duration_s}

    skipped_count    — elements that never got a bim_elements row (classification/upsert_element failed)
    skip_geo_count   — element row exists, but geometry extraction/upsert failed
    skip_param_count — element row exists, but parameter extraction failed
    """
    t0 = time.monotonic()
    token = token or SPECKLE_TOKEN
    resolved_server_url = (server_url or SPECKLE_SERVER_URL).rstrip("/")

    # ------------------------------------------------------------------ #
    # 1. Fetch commit + root object                                        #
    # ------------------------------------------------------------------ #
    logger.info("Fetching commit %s / %s", stream_id, commit_id)
    root, commit_meta = fetch_commit(stream_id, commit_id, token=token, server_url=resolved_server_url)

    branch_name = commit_meta.get("branch_name", "")
    author      = commit_meta.get("author", "")
    message     = commit_meta.get("message", "")
    source_app  = commit_meta.get("source_application", "")

    source = forced_source or detect_source(root, source_app)
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
            server_url=resolved_server_url,
        )

        element_count = 0
        skipped_count = 0      # classification/upsert_element failed — no DB row at all
        skip_geo_count = 0     # element row exists, but geometry extraction/upsert failed
        skip_param_count = 0   # element row exists, but parameter extraction failed
        geo_count = 0
        no_geo_by_type: dict[str, int] = {}
        _prop_debug_quota = 10  # log at most this many "no prop values found" lines

        # Classifying/extracting an element is pure CPU work; only the
        # upsert itself is a DB round trip. Buffering BATCH_SIZE elements'
        # worth of writes and flushing them together with execute_values
        # turns what used to be ~3-4 round trips per *element*
        # (upsert_element, upsert_geometry, DELETE+INSERT parameters) into
        # ~3-4 round trips per *batch* — for a 50k-element model that's the
        # difference between ~150k-200k round trips and a few hundred. That
        # per-element round-trip overhead is also why CPU utilization during
        # ingest never went past 30-45%: most of the wall clock was spent
        # waiting on the network, not computing. Flushing also commits,
        # which keeps the per-transaction lock count bounded (see the
        # "out of shared memory" note further down).
        BATCH_SIZE = 500
        pending_rows: list[dict] = []               # for upsert_elements_batch
        pending_geo: dict[str, dict] = {}            # speckle_id -> geo dict
        pending_params: dict[str, list[dict]] = {}   # speckle_id -> param rows

        def _flush_batch() -> None:
            """Upsert everything buffered above, batched per stage. A whole
            batch failing (one bad row poisons the statement) falls back to
            retrying that stage one element at a time with a SAVEPOINT
            around each — same containment the per-element path used before
            batching, just only paid for on the rare batch that actually
            has a bad row instead of on every element."""
            nonlocal skipped_count, skip_geo_count, skip_param_count
            if not pending_rows:
                return

            with conn.cursor() as cur:
                cur.execute("SAVEPOINT sp_batch_elem")
            try:
                id_map = upsert_elements_batch(conn, model_id, pending_rows)
            except Exception as exc:
                with conn.cursor() as cur:
                    cur.execute("ROLLBACK TO SAVEPOINT sp_batch_elem")
                logger.warning("Batch element upsert failed (%s): %s — retrying %d elements individually",
                                type(exc).__name__, exc, len(pending_rows))
                id_map = {}
                for row in pending_rows:
                    with conn.cursor() as cur:
                        cur.execute("SAVEPOINT sp_one_elem")
                    try:
                        id_map[row["speckle_id"]] = upsert_element(
                            conn, model_id=model_id, application_id=row["application_id"],
                            speckle_id=row["speckle_id"], speckle_type=row["speckle_type"],
                            ifc_class=row["ifc_class"], category=row["category"], name=row["name"],
                            storey=row["storey"], elem_hash=row["elem_hash"],
                        )
                    except Exception as exc2:
                        with conn.cursor() as cur:
                            cur.execute("ROLLBACK TO SAVEPOINT sp_one_elem")
                        logger.warning("Element %s: upsert_element failed (%s): %s",
                                        row["speckle_id"], type(exc2).__name__, exc2)
                        skipped_count += 1

            geo_rows = [{"element_id": id_map[sid], "geo": geo}
                        for sid, geo in pending_geo.items() if sid in id_map]
            skip_geo_count += sum(1 for sid in pending_geo if sid not in id_map)
            if geo_rows:
                with conn.cursor() as cur:
                    cur.execute("SAVEPOINT sp_batch_geo")
                try:
                    upsert_geometries_batch(conn, geo_rows)
                except Exception as exc:
                    with conn.cursor() as cur:
                        cur.execute("ROLLBACK TO SAVEPOINT sp_batch_geo")
                    logger.warning("Batch geometry upsert failed (%s): %s — retrying %d elements individually",
                                    type(exc).__name__, exc, len(geo_rows))
                    for r in geo_rows:
                        with conn.cursor() as cur:
                            cur.execute("SAVEPOINT sp_one_geo")
                        try:
                            upsert_geometry(conn, r["element_id"], r["geo"])
                        except Exception as exc2:
                            with conn.cursor() as cur:
                                cur.execute("ROLLBACK TO SAVEPOINT sp_one_geo")
                            logger.warning("Geometry upsert failed for element_id %s (%s): %s",
                                            r["element_id"], type(exc2).__name__, exc2)
                            skip_geo_count += 1

            param_rows = [(id_map[sid], rows) for sid, rows in pending_params.items() if sid in id_map]
            skip_param_count += sum(1 for sid in pending_params if sid not in id_map)
            if param_rows:
                with conn.cursor() as cur:
                    cur.execute("SAVEPOINT sp_batch_param")
                try:
                    upsert_parameters_batch(conn, param_rows)
                except Exception as exc:
                    with conn.cursor() as cur:
                        cur.execute("ROLLBACK TO SAVEPOINT sp_batch_param")
                    logger.warning("Batch parameter upsert failed (%s): %s — retrying %d elements individually",
                                    type(exc).__name__, exc, len(param_rows))
                    for eid, rows in param_rows:
                        with conn.cursor() as cur:
                            cur.execute("SAVEPOINT sp_one_param")
                        try:
                            upsert_parameters(conn, eid, rows)
                        except Exception as exc2:
                            with conn.cursor() as cur:
                                cur.execute("ROLLBACK TO SAVEPOINT sp_one_param")
                            logger.warning("Parameter upsert failed for element_id %s (%s): %s",
                                            eid, type(exc2).__name__, exc2)
                            skip_param_count += 1

        for _loop_idx, (obj, category_hint) in enumerate(element_tuples):
            if _loop_idx % 2000 == 0:
                logger.info("DIAG: loop progress idx=%d/%d elapsed=%.1fs",
                            _loop_idx, len(element_tuples), time.monotonic() - t0)
            speckle_id = getattr(obj, "id", None)
            if not speckle_id:
                skipped_count += 1
                continue

            speckle_type = getattr(obj, "speckle_type", "") or ""

            # ── Stage 1: classify — pure CPU, the actual upsert_element write ─
            # happens in _flush_batch() once BATCH_SIZE elements are queued.
            try:
                classification = classify_element(speckle_type, obj, category_hint, source=source)
                ifc_class    = classification["ifc_class"]
                category     = classification["category"]
                storey       = get_storey(obj)
                app_id       = get_application_id(obj)
                elem_hash    = compute_element_hash(obj)
                name         = _get_name(obj)
            except Exception as exc:
                logger.warning("Element %s: classification failed (%s): %s",
                                speckle_id, type(exc).__name__, exc)
                skipped_count += 1
                continue

            pending_rows.append({
                "application_id": app_id, "speckle_id": speckle_id, "speckle_type": speckle_type,
                "ifc_class": ifc_class, "category": category, "name": name,
                "storey": storey, "elem_hash": elem_hash,
            })
            element_count += 1

            # ── Stage 2: geometry — pure CPU; upsert_geometry also deferred ──
            # to _flush_batch(). Independent of stage 3 — a failure here must
            # not discard parameters that would otherwise extract fine.
            try:
                geo = extract_geometry(obj, instance_defs=instance_defs)

                # IFC files: mesh geometry is often absent or non-watertight, so
                # volume_m3 / area_m2 are null even when Qto_*BaseQuantities values exist.
                # Fall back to the IFC quantity sets to fill in the gap.
                if source == "IFC":
                    # Property scan first — deep-traverse the whole object tree.
                    # These values take priority over mesh-derived ones (IFC meshes are
                    # often non-watertight, making signed-volume and area unreliable).
                    # Mesh geometry is kept for bbox/centroid/viewer but volume/area
                    # are overwritten whenever the property scan finds an authoritative value.
                    prop_vol  = _prop_volume_m3(obj)
                    prop_area = _prop_area_m2(obj)
                    if prop_vol is not None or prop_area is not None:
                        logger.debug(
                            "IFC prop scan [%s]: vol=%.4f area=%.4f",
                            speckle_id[:8], prop_vol or 0, prop_area or 0,
                        )
                        if geo is None:
                            geo = {
                                "bbox_min": None, "bbox_max": None,
                                "centroid": None, "centroid_si": None,
                                "volume_m3": prop_vol, "area_m2": prop_area, "mesh": None,
                            }
                        else:
                            if prop_vol  is not None: geo["volume_m3"] = prop_vol
                            if prop_area is not None: geo["area_m2"]   = prop_area
                    elif _prop_debug_quota > 0:
                        _prop_debug_quota -= 1
                        logger.debug(
                            "IFC prop scan [%s] NO VALUES — layout: %s",
                            speckle_id[:8], _debug_prop_layout(obj),
                        )

                # Axis/footprint enrichment — own try/except so a bug here can
                # never take down the mesh/bbox extraction above it; this is
                # enrichment on top of already-successful geometry, not a
                # required part of it.
                if geo:
                    try:
                        axis_footprint = extract_axis_footprint(obj, geo.get("bbox_min"), geo.get("bbox_max"))
                        if axis_footprint:
                            geo["axis"] = axis_footprint.get("axis")
                            geo["footprint"] = axis_footprint.get("footprint")
                    except Exception as exc:
                        logger.debug("Element %s: axis/footprint extraction failed (%s): %s",
                                     speckle_id, type(exc).__name__, exc)

                if geo:
                    pending_geo[speckle_id] = geo
                    geo_count += 1
                else:
                    # Track which types are missing geometry
                    short = speckle_type.split(".")[-1] or speckle_type
                    no_geo_by_type[short] = no_geo_by_type.get(short, 0) + 1
            except Exception as exc:
                logger.warning("Element %s: geometry extraction failed (%s): %s",
                                speckle_id, type(exc).__name__, exc)
                skip_geo_count += 1

            # ── Stage 3: parameters — pure CPU; upsert also deferred. ────────
            # Independent of stage 2's outcome.
            try:
                pending_params[speckle_id] = extract_parameters(obj, speckle_id)
            except Exception as exc:
                logger.warning("Element %s: parameter extraction failed (%s): %s",
                                speckle_id, type(exc).__name__, exc)
                skip_param_count += 1

            if len(pending_rows) >= BATCH_SIZE:
                _flush_batch()
                pending_rows.clear()
                pending_geo.clear()
                pending_params.clear()
                # Flushing also commits: a single transaction spanning the
                # whole model accumulates one row/index lock per write, and a
                # 50k-element model blows past Postgres's shared lock table
                # (max_locks_per_transaction * max_connections, sized at
                # server startup) well before the loop ends otherwise —
                # committing per batch keeps that bounded and, same as the
                # per-element SAVEPOINTs, limits how much a mid-run crash can
                # lose to one batch instead of the whole model.
                conn.commit()
                logger.info("DIAG: batch flush + commit — model_id=%s element_count=%d", model_id, element_count)

        _flush_batch()
        logger.info("DIAG: about to commit main loop — model_id=%s element_count=%d", model_id, element_count)
        conn.commit()
        logger.info("DIAG: main loop committed OK — model_id=%s", model_id)

        # Relationship resolution (parent/room/space) needs every element's
        # element_id to already exist — must run after the per-object loop's
        # commit above, not per-object during it, since the *referenced*
        # element may not have been upserted yet at that point.
        try:
            relationship_count = build_relationships(conn, model_id)
            conn.commit()
        except Exception as exc:
            conn.rollback()
            logger.warning("build_relationships failed for model %s: %s", model_id, exc)
            relationship_count = 0

        # Only reached once every stage above (including relationship
        # resolution) has actually finished — a crash anywhere earlier
        # leaves this model_id at its 'in_progress' default from
        # upsert_model() forever, which is the point: 'in_progress' that
        # never flips to 'complete' IS the failure signal, no separate
        # 'failed' state needed.
        with conn.cursor() as cur:
            cur.execute("UPDATE bim_models SET ingest_status = 'complete' WHERE model_id = %s", (model_id,))
        conn.commit()

        duration = round(time.monotonic() - t0, 2)
        logger.info(
            "Ingested %d elements (%d with geometry, %d classify-skipped, "
            "%d geo-failed, %d param-failed, %d relationships) in %.1fs — "
            "model_id=%s (embeddings run separately, see generate_embeddings_for_model)",
            element_count, geo_count, skipped_count, skip_geo_count, skip_param_count,
            relationship_count, duration, model_id,
        )
        if no_geo_by_type:
            for t, cnt in sorted(no_geo_by_type.items(), key=lambda x: -x[1]):
                logger.info("  no geometry: %s × %d", t, cnt)
        return {
            "model_id":         model_id,
            "element_count":    element_count,
            "skipped_count":    skipped_count,
            "skip_geo_count":   skip_geo_count,
            "skip_param_count": skip_param_count,
            "duration_s":       duration,
        }

    except Exception:
        conn.rollback()
        raise
    finally:
        release_conn(conn)


# Ordered (not set) so lookup is deterministic "first match wins" — Net
# variants are listed before Gross/ambiguous ones so the normalizer
# consistently prefers Net (excludes voids/openings, the standard
# quantity-takeoff basis) whenever an element exposes both. A frozenset here
# would iterate in a hash-seed-dependent order (PYTHONHASHSEED is unpinned in
# this repo), silently picking a different key — and possibly Net vs Gross —
# across process restarts.
_VOL_KEYS = (
    # Explicit Net first
    "NetVolume",
    # Generic/ambiguous (no Net/Gross distinction in the source)
    "VOLUME", "Volume", "Volumen",
    # Explicit Gross last
    "GrossVolume",
)
_AREA_KEYS = (
    # Explicit Net first
    "NetSideArea", "NetArea", "NetFootprintArea",
    # Generic/ambiguous (no Net/Gross distinction in the source)
    "AREA", "Area", "Fläche", "Grundfläche", "Superficie", "Surface",
    # Explicit Gross / outer-surface last
    "GrossSideArea", "GrossArea", "GrossFootprintArea",
    "OuterSurfaceArea", "GrossSurfaceArea", "Mantelfläche",
)
_DEEP_SKIP = frozenset({
    "displayValue", "@displayValue", "elements", "vertices", "@vertices",
    "faces", "@faces", "renderMesh", "definition", "objects",
    "id", "speckle_type", "applicationId", "totalChildrenCount",
})
# All top-level Speckle attribute names that may carry property/quantity data
_PROP_ATTRS = (
    "qtos", "psets", "properties", "parameters", "typeParameters",
    "udas", "archicadParameters",
)


def _read_numeric(raw) -> float | None:
    """Extract a positive float from a plain value or Speckle parameter wrapper."""
    if raw is None:
        return None
    if isinstance(raw, dict) and "value" in raw:
        raw = raw["value"]
    elif hasattr(raw, "value") and not isinstance(raw, (int, float)):
        raw = getattr(raw, "value")
    try:
        v = float(raw)
        return v if v > 0 else None
    except (TypeError, ValueError):
        return None


def _deep_find_in_dict(d: dict, target_keys: tuple, _depth: int = 0) -> float | None:
    """
    Recursively walk a plain dict tree looking for target_keys, in order —
    the first key in target_keys present in d wins, so target_keys' ordering
    encodes a priority (e.g. Net before Gross).
    Values that are SpecklePy Base objects are converted to dicts via __dict__.
    Geometry/element keys are skipped to avoid false positives.
    """
    if _depth > 8 or not d:
        return None

    # Check keys at this level first
    for key in target_keys:
        if key in d:
            v = _read_numeric(d[key])
            if v is not None:
                return v

    # Recurse into nested containers
    for k, v in d.items():
        if k in _DEEP_SKIP:
            continue
        if isinstance(v, dict):
            result = _deep_find_in_dict(v, target_keys, _depth + 1)
            if result is not None:
                return result
        elif hasattr(v, "__dict__") and not isinstance(v, (str, int, float, bool, type(None), list)):
            # SpecklePy Base nested inside a dict value — convert and recurse
            inner = {ik: iv for ik, iv in v.__dict__.items() if not ik.startswith("_")}
            if inner:
                result = _deep_find_in_dict(inner, target_keys, _depth + 1)
                if result is not None:
                    return result

    return None


def _vol_factor(units: str, raw: float) -> float:
    """
    Return the multiplier that converts a raw volume value to m³.

    When units are explicitly known, use ifc.schema's shared unit table
    (recognizes IFC/Speckle abbreviations and full words — same table used
    everywhere else in the normalizer, so this can't drift out of sync).
    When units are missing/unknown entirely, fall back to a magnitude
    heuristic:
      - raw > 1e6 → almost certainly mm³ (1e6 mm³ = 1 litre, tiny for structure)
      - raw ≤ 1e6 → almost certainly already in m³
    This heuristic is a last resort, not exact — a very small element (a
    bolt, a plate) reported in bare mm³ with no unit metadata at all could
    still be misread as already-m³ if its mm³ value happens to be ≤ 1e6
    (≤ 1 litre). Real Speckle objects normally carry `.units`, so this path
    should rarely be hit in practice.
    """
    u = (units or "").strip().lower()
    if u:
        factor = LENGTH_TO_M.get(u)
        if factor is not None:
            return factor ** 3
        logger.warning("_vol_factor: unrecognized unit %r, using magnitude heuristic", units)
    return 1e-9 if raw > 1e6 else 1.0


def _area_factor(units: str, raw: float) -> float:
    """
    Return the multiplier that converts a raw area value to m².
    Same approach as _vol_factor: shared unit table first, magnitude
    heuristic (raw > 1e6 → mm², else → m²) only when units are unknown.
    """
    u = (units or "").strip().lower()
    if u:
        factor = LENGTH_TO_M.get(u)
        if factor is not None:
            return factor ** 2
        logger.warning("_area_factor: unrecognized unit %r, using magnitude heuristic", units)
    return 1e-6 if raw > 1e6 else 1.0


def _prop_volume_m3(obj) -> float | None:
    """
    Scan all known property containers on a Speckle object for a volume quantity.
    Uses getattr (not __dict__) so SpecklePy's __getattr__ is respected regardless
    of internal storage implementation.
    """
    units = getattr(obj, "units", None) or ""
    for attr in _PROP_ATTRS:
        container = getattr(obj, attr, None)
        if not isinstance(container, dict):
            continue
        raw = _deep_find_in_dict(container, _VOL_KEYS)
        if raw is not None:
            return raw * _vol_factor(units, raw)
    return None


def _prop_area_m2(obj) -> float | None:
    """
    Scan all known property containers on a Speckle object for an area quantity.
    """
    units = getattr(obj, "units", None) or ""
    for attr in _PROP_ATTRS:
        container = getattr(obj, attr, None)
        if not isinstance(container, dict):
            continue
        raw = _deep_find_in_dict(container, _AREA_KEYS)
        if raw is not None:
            return raw * _area_factor(units, raw)
    return None


def _debug_prop_layout(obj) -> str:
    """
    Return a compact string showing which top-level property containers exist
    and what their first-level keys are.  Used when prop scan finds nothing.
    """
    parts = []
    parts.append(f"units={getattr(obj, 'units', 'MISSING')!r}")
    for attr in _PROP_ATTRS:
        val = getattr(obj, attr, None)
        if val is None:
            continue
        if isinstance(val, dict):
            # For nested dicts (e.g. properties → 'Property Sets' → ...) show 2 levels
            def _keys2(d, depth=0):
                if depth > 1 or not isinstance(d, dict):
                    return list(d.keys()) if isinstance(d, dict) else repr(d)[:40]
                return {k: _keys2(v, depth + 1) for k, v in d.items()}
            parts.append(f"{attr}={_keys2(val)}")
        else:
            parts.append(f"{attr}={type(val).__name__}")
    return " | ".join(parts)


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
