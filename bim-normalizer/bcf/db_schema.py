from db.connection import get_conn, release_conn

SCHEMA_SQL = """
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS bcf_topics (
    guid             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    model_id         UUID REFERENCES bim_models(model_id) ON DELETE SET NULL,
    stream_id        TEXT NOT NULL,
    title            TEXT NOT NULL,
    description      TEXT,
    topic_type       TEXT,
    topic_status     TEXT,
    priority         TEXT,
    stage            TEXT,
    labels           TEXT[] DEFAULT '{}',
    creation_author  TEXT NOT NULL,
    creation_date    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    modified_author  TEXT,
    modified_date    TIMESTAMPTZ,
    due_date         TIMESTAMPTZ,
    assigned_to      TEXT,
    "index"          INTEGER
);
CREATE INDEX IF NOT EXISTS idx_bcf_topics_model  ON bcf_topics(model_id);
CREATE INDEX IF NOT EXISTS idx_bcf_topics_stream ON bcf_topics(stream_id);
CREATE INDEX IF NOT EXISTS idx_bcf_topics_status ON bcf_topics(topic_status);

CREATE TABLE IF NOT EXISTS bcf_related_topics (
    topic_guid          UUID NOT NULL REFERENCES bcf_topics(guid) ON DELETE CASCADE,
    related_topic_guid  UUID NOT NULL REFERENCES bcf_topics(guid) ON DELETE CASCADE,
    PRIMARY KEY (topic_guid, related_topic_guid)
);

CREATE TABLE IF NOT EXISTS bcf_document_references (
    guid           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    topic_guid     UUID NOT NULL REFERENCES bcf_topics(guid) ON DELETE CASCADE,
    document_guid  UUID,
    url            TEXT,
    description    TEXT
);
CREATE INDEX IF NOT EXISTS idx_bcf_docref_topic ON bcf_document_references(topic_guid);

CREATE TABLE IF NOT EXISTS bcf_viewpoints (
    guid                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    topic_guid           UUID NOT NULL REFERENCES bcf_topics(guid) ON DELETE CASCADE,
    "index"              INTEGER,
    is_orthogonal        BOOLEAN NOT NULL DEFAULT FALSE,
    camera_view_point    JSONB,
    camera_direction     JSONB,
    camera_up_vector     JSONB,
    field_of_view        DOUBLE PRECISION,
    view_to_world_scale  DOUBLE PRECISION,
    clipping_planes      JSONB DEFAULT '[]',
    default_visibility   BOOLEAN DEFAULT TRUE,
    snapshot_format      TEXT,
    snapshot_data        BYTEA,
    created_at           TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_bcf_vp_topic ON bcf_viewpoints(topic_guid);

CREATE TABLE IF NOT EXISTS bcf_viewpoint_components (
    id                  BIGSERIAL PRIMARY KEY,
    viewpoint_guid      UUID NOT NULL REFERENCES bcf_viewpoints(guid) ON DELETE CASCADE,
    ifc_guid            TEXT NOT NULL,
    originating_system  TEXT,
    authoring_tool_id   TEXT,
    component_type      TEXT NOT NULL CHECK (component_type IN ('selection', 'visibility_exception', 'coloring')),
    color               TEXT,
    UNIQUE (viewpoint_guid, ifc_guid, component_type)
);
CREATE INDEX IF NOT EXISTS idx_bcf_vpc_vp      ON bcf_viewpoint_components(viewpoint_guid);
CREATE INDEX IF NOT EXISTS idx_bcf_vpc_ifcguid ON bcf_viewpoint_components(ifc_guid);

CREATE TABLE IF NOT EXISTS bcf_comments (
    guid             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    topic_guid       UUID NOT NULL REFERENCES bcf_topics(guid) ON DELETE CASCADE,
    viewpoint_guid   UUID REFERENCES bcf_viewpoints(guid) ON DELETE SET NULL,
    comment          TEXT NOT NULL,
    author           TEXT NOT NULL,
    date             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    modified_author  TEXT,
    modified_date    TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_bcf_comments_topic ON bcf_comments(topic_guid);

CREATE TABLE IF NOT EXISTS bcf_extensions (
    model_id    UUID NOT NULL REFERENCES bim_models(model_id) ON DELETE CASCADE,
    kind        TEXT NOT NULL CHECK (kind IN ('topic_type', 'topic_status', 'priority', 'topic_label', 'stage')),
    value       TEXT NOT NULL,
    sort_order  INTEGER DEFAULT 0,
    PRIMARY KEY (model_id, kind, value)
);

-- Tracks Speckle comment <-> BCF topic sync independently of bcf_topics
-- rows, so the record survives topic deletion: once a Speckle comment has
-- been pulled, it must never be pulled again even if its topic is later
-- deleted by the user. Also used to mark comments WE created via push as
-- already-pulled, preventing a push -> pull -> push ping-pong loop.
CREATE TABLE IF NOT EXISTS bcf_speckle_sync (
    model_id            UUID NOT NULL REFERENCES bim_models(model_id) ON DELETE CASCADE,
    speckle_comment_id  TEXT NOT NULL,
    topic_guid          UUID REFERENCES bcf_topics(guid) ON DELETE SET NULL,
    direction           TEXT NOT NULL CHECK (direction IN ('pulled', 'pushed')),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (model_id, speckle_comment_id, direction)
);
CREATE INDEX IF NOT EXISTS idx_bcf_sync_model ON bcf_speckle_sync(model_id);

-- Tracks which individual bcf_comments (BCF-side replies) have already been
-- relayed to/from a Speckle comment's replies, at the per-comment level —
-- bcf_speckle_sync only tracks the top-level topic<->thread mapping. Without
-- this, every sync pass would re-relay every existing reply as a new
-- duplicate, since pushToSpeckle has no other way to know which ones it
-- (or a prior pull) already handled.
CREATE TABLE IF NOT EXISTS bcf_comment_push_sync (
    comment_guid      UUID PRIMARY KEY REFERENCES bcf_comments(guid) ON DELETE CASCADE,
    speckle_reply_id  TEXT NOT NULL,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Real per-person BCF login accounts, replacing the earlier fake-identity
-- OAuth shim. UNIQUE on email already provides an index, so no extra
-- CREATE INDEX needed.
CREATE TABLE IF NOT EXISTS bcf_users (
    guid           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email          TEXT NOT NULL UNIQUE,
    name           TEXT NOT NULL,
    password_hash  TEXT NOT NULL,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ISO 19650 contractual-container separation: a user's employer/company.
-- Nullable and additive on purpose — NULL means "unscoped", which is both
-- the default for every existing account and the intended behaviour for a
-- coordinating role (e.g. Lead Appointed Party) that needs to see every
-- org's WIP, not just one. See bim_documents.org_id (db/models.py) for the
-- document-side half of this; a real FK is safe here (unlike that soft
-- reference) since both tables are created by this same schema-init.
CREATE TABLE IF NOT EXISTS bcf_organizations (
    org_id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name        TEXT NOT NULL UNIQUE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE bcf_users ADD COLUMN IF NOT EXISTS org_id UUID REFERENCES bcf_organizations(org_id) ON DELETE SET NULL;

-- Per-user opt-out for the email half of notifications/dispatch.py's
-- notify_document_event / notify_bcf_assignment (the in-app bell/
-- bcf_notifications row is unaffected either way). Defaults to TRUE so
-- existing behaviour — everyone gets emailed — doesn't change for accounts
-- that never touch the new admin toggle.
ALTER TABLE bcf_users ADD COLUMN IF NOT EXISTS notify_email BOOLEAN NOT NULL DEFAULT TRUE;

-- Self-service "forgot password" (routers/auth.py's /auth/forgot-password
-- and /auth/reset-password), replacing the admin-only reset that was the
-- sole recovery path before (see bcf/admin.py's reset-password route).
-- Stores a SHA-256 hash of the emailed token, not the token itself — same
-- reasoning as password_hash: a DB dump/backup shouldn't hand out live
-- credentials. One active token per user (a fresh request overwrites the
-- previous one, which is the desired "old link stops working" behaviour).
ALTER TABLE bcf_users ADD COLUMN IF NOT EXISTS reset_token_hash TEXT;
ALTER TABLE bcf_users ADD COLUMN IF NOT EXISTS reset_token_expires_at TIMESTAMPTZ;
"""

# One-time (per row, via ON CONFLICT DO NOTHING) backfill: topics created by
# the old label-only sync design before bcf_speckle_sync existed carry their
# tracking info as 'speckle-comment:<id>' / 'speckle-pushed:<id>' labels —
# migrate those into the persistent table so they aren't treated as
# never-synced (and duplicated again) on the first run after this fix.
# Safe to re-run on every startup.
BACKFILL_SYNC_SQL = """
INSERT INTO bcf_speckle_sync (model_id, speckle_comment_id, topic_guid, direction)
SELECT t.model_id, substring(label, 17), t.guid, 'pulled'
FROM bcf_topics t, unnest(t.labels) AS label
WHERE label LIKE 'speckle-comment:%' AND t.model_id IS NOT NULL
ON CONFLICT DO NOTHING;

INSERT INTO bcf_speckle_sync (model_id, speckle_comment_id, topic_guid, direction)
SELECT t.model_id, substring(label, 16), t.guid, 'pushed'
FROM bcf_topics t, unnest(t.labels) AS label
WHERE label LIKE 'speckle-pushed:%' AND t.model_id IS NOT NULL
ON CONFLICT DO NOTHING;

INSERT INTO bcf_speckle_sync (model_id, speckle_comment_id, topic_guid, direction)
SELECT t.model_id, substring(label, 16), t.guid, 'pulled'
FROM bcf_topics t, unnest(t.labels) AS label
WHERE label LIKE 'speckle-pushed:%' AND t.model_id IS NOT NULL
ON CONFLICT DO NOTHING;
"""


# Topics created before "index" started being populated on create (see
# bcf/topics.py's create_topic) have it NULL. BCF 3.0's server_assigned_id
# is derived from "index" and is a required string field, so a NULL would
# serialize as the literal string "None" — backfill once per project,
# oldest-first, so every row has a value. Safe to re-run: only touches rows
# still NULL.
#
# Numbers from each project's own existing MAX("index") (0 if the project
# has none yet) rather than from 1 — plain ROW_NUMBER() starting at 1 would
# collide with indices already assigned by create_topic/import_bcfzip to
# that same model_id, producing duplicate server_assigned_id values for
# BCF 3.0 clients.
BACKFILL_INDEX_SQL = """
WITH existing_max AS (
    SELECT model_id, COALESCE(MAX("index"), 0) AS max_index
    FROM bcf_topics
    WHERE "index" IS NOT NULL
    GROUP BY model_id
),
numbered AS (
    SELECT t.guid, t.model_id,
           ROW_NUMBER() OVER (PARTITION BY t.model_id ORDER BY t.creation_date) AS rn
    FROM bcf_topics t
    WHERE t."index" IS NULL
)
UPDATE bcf_topics t SET "index" = COALESCE(em.max_index, 0) + numbered.rn
FROM numbered
LEFT JOIN existing_max em ON em.model_id = numbered.model_id
WHERE t.guid = numbered.guid;
"""


def init_bcf_schema() -> None:
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute(SCHEMA_SQL)
            cur.execute(BACKFILL_SYNC_SQL)
            cur.execute(BACKFILL_INDEX_SQL)
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        release_conn(conn)
