from db.connection import get_conn, release_conn

SCHEMA_SQL = """
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "pg_trgm";

CREATE TABLE IF NOT EXISTS bim_models (
    model_id     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    stream_id    TEXT NOT NULL,
    commit_id    TEXT NOT NULL,
    branch_name  TEXT,
    source       TEXT,
    author       TEXT,
    message      TEXT,
    server_url   TEXT,
    ingested_at  TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (stream_id, commit_id)
);

-- Which Speckle server (self-hosted vs. app.speckle.systems, etc.) this model
-- was actually ingested from — needed so later operations that re-query
-- Speckle for this stream (e.g. fetching the original IFC blob for IDS/clash
-- checks) hit the right server instead of always defaulting to the single
-- env-configured one.
ALTER TABLE bim_models ADD COLUMN IF NOT EXISTS server_url TEXT;

CREATE TABLE IF NOT EXISTS bim_elements (
    element_id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    model_id        UUID NOT NULL REFERENCES bim_models(model_id) ON DELETE CASCADE,
    application_id  TEXT,
    speckle_id      TEXT NOT NULL,
    speckle_type    TEXT,
    ifc_class       TEXT,
    category        TEXT,
    name            TEXT,
    storey          TEXT,
    parent_id       UUID,
    hash            TEXT,
    UNIQUE (model_id, speckle_id)
);

CREATE INDEX IF NOT EXISTS idx_bim_elements_model    ON bim_elements(model_id);
CREATE INDEX IF NOT EXISTS idx_bim_elements_app_id   ON bim_elements(application_id);
CREATE INDEX IF NOT EXISTS idx_bim_elements_ifc      ON bim_elements(ifc_class);
CREATE INDEX IF NOT EXISTS idx_bim_elements_category ON bim_elements(category);

CREATE TABLE IF NOT EXISTS bim_geometry (
    element_id  UUID PRIMARY KEY REFERENCES bim_elements(element_id) ON DELETE CASCADE,
    bbox_min    FLOAT[],
    bbox_max    FLOAT[],
    centroid    FLOAT[],
    volume_m3   FLOAT,
    area_m2     FLOAT,
    mesh        JSONB
);
-- centroid_si: centroid converted to meters (SI) using the source object's
-- units, so cross-model/cross-source distance queries (e.g. "find elements
-- within 5m of X") work regardless of whether the source used mm, ft, etc.
-- NULL for elements ingested before this column was added.
ALTER TABLE bim_geometry ADD COLUMN IF NOT EXISTS centroid_si FLOAT[];
-- axis: structural centerline (2+ points, {"points": [[x,y,z],...]}, in the
-- element's own raw units — same convention as bbox_min/mesh, NOT SI) for
-- beams/columns/walls, extracted from bespoke Structural/Tekla structural
-- properties when present (preferred, more complete/current) or the generic
-- Speckle `location` attribute as fallback. NULL when no source was
-- available (older data, non-linear elements) — this is enrichment, not
-- required.
-- footprint: 2D plan contour loops (outer boundary + inner holes,
-- {"loops": [[[x,y,z],...], ...]}, same raw-units convention) for
-- slabs/floors/plates, from Structural.contours, Tekla flat contourPoints,
-- or a closed generic `location` Polycurve.
-- Both feed ifc/export.py's Axis/FootPrint IfcShapeRepresentations.
ALTER TABLE bim_geometry ADD COLUMN IF NOT EXISTS axis JSONB;
ALTER TABLE bim_geometry ADD COLUMN IF NOT EXISTS footprint JSONB;

CREATE TABLE IF NOT EXISTS bim_parameters (
    id            BIGSERIAL PRIMARY KEY,
    element_id    UUID NOT NULL REFERENCES bim_elements(element_id) ON DELETE CASCADE,
    pset          TEXT,
    key           TEXT NOT NULL,
    value         TEXT,
    datatype      TEXT,
    value_numeric FLOAT,
    canonical_key TEXT,
    value_si      FLOAT,
    unit_si       TEXT
);
-- Migrate existing rows: add columns if the table was created without them
ALTER TABLE bim_parameters ADD COLUMN IF NOT EXISTS value_numeric FLOAT;
ALTER TABLE bim_parameters ADD COLUMN IF NOT EXISTS canonical_key TEXT;
-- value_si: value_numeric converted to SI units (m / m2 / m3 / kg) for
-- length/area/volume/weight canonicals, so charts can compare quantities
-- across sources that report in mm, ft, lb, etc. unit_si is the SI symbol
-- ('m', 'm2', 'm3', 'kg'). Both NULL when the source unit is unknown/unconvertible.
ALTER TABLE bim_parameters ADD COLUMN IF NOT EXISTS value_si FLOAT;
ALTER TABLE bim_parameters ADD COLUMN IF NOT EXISTS unit_si TEXT;

CREATE INDEX IF NOT EXISTS idx_bim_params_element   ON bim_parameters(element_id);
CREATE INDEX IF NOT EXISTS idx_bim_params_key       ON bim_parameters(key);
CREATE INDEX IF NOT EXISTS idx_bim_params_key_val   ON bim_parameters(key, value);
CREATE INDEX IF NOT EXISTS idx_bim_params_val_trgm  ON bim_parameters USING gin(value gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_bim_params_key_trgm  ON bim_parameters USING gin(key gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_bim_params_numeric   ON bim_parameters(element_id, value_numeric)
    WHERE value_numeric IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_bim_params_canonical ON bim_parameters(element_id, canonical_key)
    WHERE canonical_key IS NOT NULL;

-- Per-element text embedding for semantic search (speckle_semantic_search MCP
-- tool). embed_text is stored alongside the vector for debuggability — lets
-- you see exactly what was embedded without re-deriving it. No pgvector: at
-- current model sizes (hundreds-to-low-thousands of elements) brute-force
-- cosine similarity in Python is fast enough and avoids a Postgres image swap.
CREATE TABLE IF NOT EXISTS bim_element_embeddings (
    element_id  UUID PRIMARY KEY REFERENCES bim_elements(element_id) ON DELETE CASCADE,
    embed_text  TEXT NOT NULL,
    embedding   FLOAT[] NOT NULL
);

CREATE TABLE IF NOT EXISTS bim_relationships (
    id             BIGSERIAL PRIMARY KEY,
    element_id     UUID NOT NULL REFERENCES bim_elements(element_id) ON DELETE CASCADE,
    related_id     UUID NOT NULL REFERENCES bim_elements(element_id) ON DELETE CASCADE,
    relation_type  TEXT,
    UNIQUE (element_id, related_id, relation_type)
);

CREATE INDEX IF NOT EXISTS idx_bim_rel_element ON bim_relationships(element_id);

CREATE TABLE IF NOT EXISTS bim_tasks (
    task_id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    model_id        UUID NOT NULL REFERENCES bim_models(model_id) ON DELETE CASCADE,
    application_id  TEXT,
    name            TEXT NOT NULL,
    description     TEXT,
    status          TEXT DEFAULT 'NOTSTARTED',
    is_milestone    BOOLEAN DEFAULT FALSE,
    is_critical     BOOLEAN DEFAULT FALSE,
    planned_start   DATE,
    planned_finish  DATE,
    actual_start    DATE,
    actual_finish   DATE,
    duration_days   FLOAT,
    float_days      FLOAT,
    parent_task_id  UUID REFERENCES bim_tasks(task_id) ON DELETE CASCADE,
    wbs_code        TEXT,
    sort_order      INTEGER DEFAULT 0
);
-- Migrate existing databases: the original constraint had no ON DELETE clause,
-- which defaults to NO ACTION and blocks deleting a task that still has
-- children instead of cascading the way every other parent/child relationship
-- in this schema does (bim_elements.model_id, bim_task_elements.task_id, etc).
ALTER TABLE bim_tasks DROP CONSTRAINT IF EXISTS bim_tasks_parent_task_id_fkey;
ALTER TABLE bim_tasks ADD CONSTRAINT bim_tasks_parent_task_id_fkey
    FOREIGN KEY (parent_task_id) REFERENCES bim_tasks(task_id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_bim_tasks_model  ON bim_tasks(model_id);
CREATE INDEX IF NOT EXISTS idx_bim_tasks_parent ON bim_tasks(parent_task_id);

CREATE TABLE IF NOT EXISTS bim_task_elements (
    task_id     UUID NOT NULL REFERENCES bim_tasks(task_id) ON DELETE CASCADE,
    element_id  UUID NOT NULL REFERENCES bim_elements(element_id) ON DELETE CASCADE,
    PRIMARY KEY (task_id, element_id)
);

CREATE INDEX IF NOT EXISTS idx_bim_task_el_task    ON bim_task_elements(task_id);
CREATE INDEX IF NOT EXISTS idx_bim_task_el_element ON bim_task_elements(element_id);

-- Task predecessor/successor links, parsed from IFC's IfcRelSequence (a
-- standard IFC4/IFC4X3 entity, not a vendor extension — confirmed against a
-- real scheduling tool's IFC writer). Previously not read/stored at all, so
-- imported schedules had no dependency graph regardless of source richness.
CREATE TABLE IF NOT EXISTS bim_task_dependencies (
    id                  BIGSERIAL PRIMARY KEY,
    predecessor_task_id UUID NOT NULL REFERENCES bim_tasks(task_id) ON DELETE CASCADE,
    successor_task_id   UUID NOT NULL REFERENCES bim_tasks(task_id) ON DELETE CASCADE,
    sequence_type       TEXT NOT NULL DEFAULT 'FINISH_START',
    lag_days            FLOAT,
    UNIQUE (predecessor_task_id, successor_task_id)
);

CREATE INDEX IF NOT EXISTS idx_bim_task_dep_pred ON bim_task_dependencies(predecessor_task_id);
CREATE INDEX IF NOT EXISTS idx_bim_task_dep_succ ON bim_task_dependencies(successor_task_id);

-- Per-project default dashboard layout: what a first-time visitor sees before
-- they have any localStorage state of their own. Distinct from the in-memory
-- /share snapshots (main.py), which are short-lived, explicitly-created links.
CREATE TABLE IF NOT EXISTS bim_dashboard_layouts (
    project_id  TEXT PRIMARY KEY,
    payload     JSONB NOT NULL,
    updated_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS bim_classification_overrides (
    override_id    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    model_id       UUID NOT NULL REFERENCES bim_models(model_id) ON DELETE CASCADE,
    application_id TEXT,
    speckle_id     TEXT,
    ifc_class      TEXT NOT NULL,
    category       TEXT NOT NULL,
    note           TEXT,
    created_at     TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_overrides_model ON bim_classification_overrides(model_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_overrides_appid
    ON bim_classification_overrides(model_id, application_id)
    WHERE application_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_overrides_speckleid
    ON bim_classification_overrides(model_id, speckle_id)
    WHERE speckle_id IS NOT NULL;

-- Uploaded IDS (Information Delivery Specification) files, kept per model so
-- a spec can be re-run after re-ingesting a newer commit of the same stream.
CREATE TABLE IF NOT EXISTS bim_ids_specs (
    spec_id     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    model_id    UUID NOT NULL REFERENCES bim_models(model_id) ON DELETE CASCADE,
    filename    TEXT NOT NULL,
    content     TEXT NOT NULL,
    uploaded_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_ids_specs_model ON bim_ids_specs(model_id);

-- Speckle servers the backend watches for webhook-driven auto-sync, independent
-- of any frontend session — a webhook can arrive with nobody's browser open.
CREATE TABLE IF NOT EXISTS auto_sync_servers (
    server_url      TEXT PRIMARY KEY,
    token           TEXT NOT NULL,
    enabled         BOOLEAN DEFAULT TRUE,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    last_scanned_at TIMESTAMPTZ
);

-- One row per stream we've registered a Speckle webhook on. The row id is
-- used as the webhook's callback URL path segment, so an incoming request
-- can be routed to the right server/token/secret without trusting anything
-- in the payload itself.
CREATE TABLE IF NOT EXISTS stream_webhooks (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    server_url         TEXT NOT NULL,
    stream_id          TEXT NOT NULL,
    speckle_webhook_id TEXT,
    secret             TEXT NOT NULL,
    created_at         TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (server_url, stream_id)
);

-- Async job state (ingest/export/IDS-check/clash-check/filter-publish), moved
-- out of in-memory dicts so a backend restart doesn't strand polling clients
-- with an unrecoverable 404 for a job that may have already completed.
CREATE TABLE IF NOT EXISTS bim_jobs (
    job_id      UUID PRIMARY KEY,
    job_type    TEXT NOT NULL,
    status      TEXT NOT NULL DEFAULT 'running',
    payload     JSONB,
    result      JSONB,
    error       TEXT,
    created_at  TIMESTAMPTZ DEFAULT NOW(),
    updated_at  TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_bim_jobs_type_status ON bim_jobs(job_type, status);
CREATE INDEX IF NOT EXISTS idx_bim_jobs_created ON bim_jobs(created_at);

-- Documents (Nextcloud-backed document management, see nextcloud/client.py).
-- Scoped by stream_id (survives re-ingestion), not model_id, which is minted
-- fresh per ingested commit and would orphan documents on every re-sync.
CREATE TABLE IF NOT EXISTS bim_documents (
    doc_id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    stream_id         TEXT NOT NULL,
    model_id          UUID REFERENCES bim_models(model_id) ON DELETE SET NULL,

    nc_fileid         BIGINT NOT NULL,
    nc_path           TEXT NOT NULL,
    nc_group_folder   TEXT NOT NULL,
    filename          TEXT NOT NULL,
    mime_type         TEXT,
    size_bytes        BIGINT,
    etag              TEXT,

    status            TEXT NOT NULL,
    nc_last_modified  TIMESTAMPTZ,

    approved          BOOLEAN NOT NULL DEFAULT FALSE,
    approved_by       TEXT,
    approved_at       TIMESTAMPTZ,
    revision          INT NOT NULL DEFAULT 1,

    -- Soft links, no DB FK: bcf-server is a fully separate FastAPI process
    -- with its own schema-init, not reachable from this app's init_schema().
    linked_bcf_topic  UUID,
    linked_element    TEXT,

    deleted_at        TIMESTAMPTZ,
    created_at        TIMESTAMPTZ DEFAULT NOW(),
    updated_at        TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (nc_group_folder, nc_fileid)
);
CREATE INDEX IF NOT EXISTS idx_bim_documents_stream  ON bim_documents(stream_id);
CREATE INDEX IF NOT EXISTS idx_bim_documents_status  ON bim_documents(status);
CREATE INDEX IF NOT EXISTS idx_bim_documents_topic   ON bim_documents(linked_bcf_topic) WHERE linked_bcf_topic IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_bim_documents_element ON bim_documents(linked_element) WHERE linked_element IS NOT NULL;

-- Append-only audit trail for document actions.
CREATE TABLE IF NOT EXISTS bim_document_events (
    id          BIGSERIAL PRIMARY KEY,
    doc_id      UUID NOT NULL REFERENCES bim_documents(doc_id) ON DELETE CASCADE,
    event_type  TEXT NOT NULL,
    from_value  TEXT,
    to_value    TEXT,
    actor       TEXT,
    occurred_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_bim_document_events_doc ON bim_document_events(doc_id);
-- Soft ref to bcf_users.guid (same no-FK reasoning as bim_documents.linked_bcf_topic
-- above) — lets old free-text-only audit rows be told apart from rows recorded
-- after real dashboard login shipped (actor_guid IS NULL == unverified identity).
ALTER TABLE bim_document_events ADD COLUMN IF NOT EXISTS actor_guid UUID;

-- ISO 19650 state-transition gating: WIP->Shared needs `reviewed` (review),
-- Shared->Published needs the pre-existing `approved` (authorisation),
-- ->Archived needs `verified` (verification). Each mirrors the existing
-- approved/approved_by/approved_at triad. bump_revision() resets all three
-- on every new version — a revised document must re-earn every gate again.
ALTER TABLE bim_documents ADD COLUMN IF NOT EXISTS reviewed          BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE bim_documents ADD COLUMN IF NOT EXISTS reviewed_by       TEXT;
ALTER TABLE bim_documents ADD COLUMN IF NOT EXISTS reviewed_by_guid  UUID;
ALTER TABLE bim_documents ADD COLUMN IF NOT EXISTS reviewed_at       TIMESTAMPTZ;
ALTER TABLE bim_documents ADD COLUMN IF NOT EXISTS verified          BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE bim_documents ADD COLUMN IF NOT EXISTS verified_by       TEXT;
ALTER TABLE bim_documents ADD COLUMN IF NOT EXISTS verified_by_guid  UUID;
ALTER TABLE bim_documents ADD COLUMN IF NOT EXISTS verified_at       TIMESTAMPTZ;
-- Real reference alongside the pre-existing free-text approved_by, which
-- stays as-is for back-compat with data recorded before real dashboard
-- login existed.
ALTER TABLE bim_documents ADD COLUMN IF NOT EXISTS approved_by_guid  UUID;

-- Distinguishes drawings (always tied to a model, via the pre-existing
-- model_id column) from generic documents (model_id optional/best-effort —
-- see upload_document's docstring). model_id-required-for-drawing is
-- enforced in routers/documents.py, not a DB constraint, matching this
-- table's existing soft-reference style. Deliberately excluded from
-- upsert_document's ON CONFLICT DO UPDATE SET — reconcile.py's drift-scan
-- re-upserts existing rows with no knowledge of doc_type, so it must never
-- be able to reclassify an existing drawing back to 'document'.
ALTER TABLE bim_documents ADD COLUMN IF NOT EXISTS doc_type TEXT NOT NULL DEFAULT 'document';
DO $$ BEGIN
    ALTER TABLE bim_documents ADD CONSTRAINT bim_documents_doc_type_check CHECK (doc_type IN ('document', 'drawing'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ISO 19650 filename convention (Project-Originator-Volume-Level-Type-Role-
-- Number, see naming/iso19650.py) — advisory only, recomputed on every
-- upsert_document call (upload, revise, reconcile's drift-scan), never
-- blocks a write. naming_fields is NULL whenever the filename doesn't match.
ALTER TABLE bim_documents ADD COLUMN IF NOT EXISTS naming_compliant BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE bim_documents ADD COLUMN IF NOT EXISTS naming_fields    JSONB;

-- ISO 19650 "purpose of issue" suitability code (naming/suitability.py) —
-- distinct from both `status` (container state) and `revision` (plain
-- version counter). Settable only by an approver (routers/documents.py's
-- suitability endpoint), reset to NULL on every bump_revision() the same
-- way reviewed/approved/verified already reset: a new revision must be
-- re-declared, not inherit its predecessor's sign-off.
ALTER TABLE bim_documents ADD COLUMN IF NOT EXISTS suitability_code        TEXT;
ALTER TABLE bim_documents ADD COLUMN IF NOT EXISTS suitability_set_by      TEXT;
ALTER TABLE bim_documents ADD COLUMN IF NOT EXISTS suitability_set_by_guid UUID;
ALTER TABLE bim_documents ADD COLUMN IF NOT EXISTS suitability_set_at      TIMESTAMPTZ;
DO $$ BEGIN
    ALTER TABLE bim_documents ADD CONSTRAINT bim_documents_suitability_check
        CHECK (suitability_code IS NULL OR suitability_code IN
            ('S0', 'S1', 'S2', 'S3', 'S4', 'A1', 'A2', 'B1', 'B2', 'C1', 'D1'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ISO 19650 contractual-container separation: the organization (see
-- bcf_organizations, bcf/db_schema.py) that owns this document, set from
-- the uploader's org at upload time. Soft reference, no FK — same
-- cross-process reasoning as bim_document_roles.user_guid below (bcf_users/
-- bcf_organizations are created by bcf-server's separate schema-init).
-- NULL = unscoped, visible to every project member regardless of status —
-- the default for documents that predate this column and for anyone who
-- hasn't configured organizations. Deliberately excluded from
-- upsert_document's ON CONFLICT DO UPDATE SET, same treatment as doc_type
-- above: reconcile.py's drift-scan must never blank out a value set at
-- first upload. Enforcement (WIP visible only to the same org, or to an
-- unscoped viewer) lives in db/documents.py's list_documents() and
-- routers/documents.py's _require_doc().
ALTER TABLE bim_documents ADD COLUMN IF NOT EXISTS org_id UUID;
CREATE INDEX IF NOT EXISTS idx_bim_documents_org ON bim_documents(org_id) WHERE org_id IS NOT NULL;

-- 2D-drawing-to-3D-model alignment (align 2D DXF/DWG drawings against the
-- Speckle viewer, ACC-"Align Documents"-style): a saved 2D-similarity
-- transform (translate/rotate/uniform-scale, computed client-side from a
-- 2-point-pair calibration — see src/utils/alignmentTransform.js) plus a
-- user-supplied Z elevation, letting the drawing render as a positioned
-- overlay plane in the 3D viewer. A drawing has at most one active alignment
-- at a time, so these are flat columns on bim_documents rather than a join
-- table — same reasoning as doc_type/linked_element/suitability_code above.
-- All nullable/additive: NULL align_transform means "not aligned yet".
ALTER TABLE bim_documents ADD COLUMN IF NOT EXISTS align_transform JSONB;
ALTER TABLE bim_documents ADD COLUMN IF NOT EXISTS align_elevation_z DOUBLE PRECISION;
-- Soft reference to bim_models.model_id, deliberately DISTINCT from this
-- table's own model_id column above: that column's semantics are already
-- "best-effort, orphaned on re-sync" (see its comment). align_model_id
-- instead records which commit's world-space the transform was computed
-- against, so the frontend can detect align_model_id != model_id (the
-- project was re-ingested since this alignment was made, and — since
-- nothing in this app guarantees stable world coordinates across
-- re-ingestion — the overlay may now be mispositioned) and surface a
-- "re-verify alignment" prompt instead of silently rendering a stale plane.
ALTER TABLE bim_documents ADD COLUMN IF NOT EXISTS align_model_id UUID REFERENCES bim_models(model_id) ON DELETE SET NULL;
-- The raw 2 (drawing_point, world_point) pairs used to compute
-- align_transform — kept alongside the derived transform for audit and so
-- the calibration UI can preload/re-edit an existing alignment's points
-- instead of forcing a from-scratch re-pick.
ALTER TABLE bim_documents ADD COLUMN IF NOT EXISTS align_control_points JSONB;
ALTER TABLE bim_documents ADD COLUMN IF NOT EXISTS align_created_by TEXT;
ALTER TABLE bim_documents ADD COLUMN IF NOT EXISTS align_created_by_guid UUID;
ALTER TABLE bim_documents ADD COLUMN IF NOT EXISTS align_created_at TIMESTAMPTZ;

-- Per-project (stream_id) document-workflow role grants — ISO 19650 RBAC.
-- Soft reference to bcf_users.guid, no FK: bcf_users is created by
-- bcf-server's own init_bcf_schema() (a separate process, `python
-- bcf_server.py`, not sequenced before this app's init_schema() — see
-- bcf-server's docker-compose depends_on: bim-normalizer, not the reverse).
-- A user may hold more than one role on the same project, hence role is
-- part of the primary key rather than a single-valued column.
-- stream_id = '*' is a reserved sentinel meaning "all projects, including
-- ones ingested later" — db/roles.py's get_user_roles() always unions it in
-- alongside whatever project-specific grants exist, so every role check
-- downstream (require_role, /my-roles) respects it automatically with no
-- special-casing. Granted/revoked from the admin panel the same way as any
-- other row, just with stream_id='*' instead of a real Speckle project id.
CREATE TABLE IF NOT EXISTS bim_document_roles (
    user_guid   UUID NOT NULL,
    stream_id   TEXT NOT NULL,
    role        TEXT NOT NULL CHECK (role IN ('author', 'reviewer', 'approver')),
    granted_by  UUID,
    granted_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (user_guid, stream_id, role)
);
CREATE INDEX IF NOT EXISTS idx_doc_roles_stream ON bim_document_roles(stream_id);
CREATE INDEX IF NOT EXISTS idx_doc_roles_user   ON bim_document_roles(user_guid);

-- Per-branch ("model") WIP/Shared/Published/Archived status, mirroring
-- bim_documents' workflow but for whole Speckle models rather than files.
-- Keyed by (stream_id, branch_name), not model_id, for the same reason as
-- bim_documents: model_id is minted fresh per ingested commit and would
-- orphan the status on every re-ingest, while a branch's name is stable.
CREATE TABLE IF NOT EXISTS bim_model_status (
    stream_id    TEXT NOT NULL,
    branch_name  TEXT NOT NULL,
    status       TEXT NOT NULL DEFAULT 'WIP',
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (stream_id, branch_name)
);

-- In-app notification feed for document-workflow events (moved to Shared,
-- reviewed, approved, verified, suitability_set, revised — see
-- notifications.py's dispatch, fired via job_registry.fire_and_forget right
-- after each routers/documents.py record_event call). user_guid is a soft
-- reference to bcf_users.guid, same cross-process reasoning as
-- bim_document_roles. doc_id cascades on delete, same as
-- bim_document_events. message is precomputed at insert time (not
-- reconstructed from event_type on read) purely to keep the read path a
-- single flat SELECT with no joins.
CREATE TABLE IF NOT EXISTS bim_notifications (
    id          BIGSERIAL PRIMARY KEY,
    user_guid   UUID NOT NULL,
    stream_id   TEXT NOT NULL,
    doc_id      UUID REFERENCES bim_documents(doc_id) ON DELETE CASCADE,
    event_type  TEXT NOT NULL,
    message     TEXT NOT NULL,
    read_at     TIMESTAMPTZ,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_bim_notifications_unread ON bim_notifications(user_guid) WHERE read_at IS NULL;
-- topic_guid is a soft reference to bcf_topics.guid, same cross-process/
-- cross-schema-init-order reasoning as user_guid above (bcf_topics is
-- created by bcf_server's own bcf/db_schema.py, a separate process that may
-- not have run yet when this schema initializes) — used by BCF issue
-- "assigned to" notifications (see notifications/dispatch.py's
-- notify_bcf_assignment, fired from bcf/topics.py).
ALTER TABLE bim_notifications ADD COLUMN IF NOT EXISTS topic_guid UUID;

-- Rendered-thumbnail cache for routers/documents.py's /thumbnail route.
-- Keyed by nc_fileid (stable across renames/moves, like bim_documents' own
-- key) with etag as a staleness check — bump_revision() gives a document a
-- new etag on every re-upload, so a stale cached thumbnail is simply a cache
-- miss on next request, never served. One row per file (upsert on nc_fileid,
-- not one row per etag ever seen) so this table can't grow unboundedly as
-- documents get revised. Covers every /thumbnail source (Nextcloud's own
-- preview proxy, and the DXF/DWG/PDF fallback renderers), not just the
-- custom-rendered ones, since even the proxy path pays a Nextcloud round
-- trip this cache skips entirely on a hit.
CREATE TABLE IF NOT EXISTS bim_document_thumbnails (
    nc_fileid     BIGINT PRIMARY KEY,
    etag          TEXT NOT NULL,
    content_type  TEXT NOT NULL,
    content       BYTEA NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
"""


def init_schema() -> None:
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute(SCHEMA_SQL)
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        release_conn(conn)
