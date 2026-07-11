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
