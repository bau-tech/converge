# Testing the Documents feature (Nextcloud-backed)

Covers Phase 1 of the CDE document-management plan: a dedicated Nextcloud
service, real per-`bcf_users` Nextcloud accounts, per-project group folders,
and the full WIP → Shared → Published → Archived document workflow driven
entirely from the dashboard's own **Documents** panel — nobody, including an
admin, ever opens Nextcloud's own web UI.

Phase 2 (linking a document to a BCF topic or model element) has its backend
routes (`link-topic`/`link-element`) but no dedicated UI yet — that's the
next phase, not covered here.

Also covers in-browser document preview: PDF via the browser's native
renderer, IFC via `web-ifc` (WASM) rendered into a standalone Three.js
scene, DXF via `dxf-parser` + a plain canvas 2D renderer, `.docx` via
`docx-preview` (renders straight to HTML/CSS), and `.xlsx`/legacy `.xls` via
SheetJS's `xlsx` package (`sheet_to_html` per sheet, with a tab strip for
multi-sheet workbooks) — all client-side, no backend routes needed beyond
the existing `/download` endpoint. `.dwg` has no free/open library that
renders it directly (confirmed: LibreDWG isn't packaged in Debian at all),
so it's the one exception with a real backend route:
`GET .../documents/{doc_id}/preview.dxf` converts it to DXF server-side via
LibreDWG's `dwg2dxf` CLI (built from source in the Dockerfile — see
"Architecture recap" below) and feeds the result into the same DXF viewer.
Legacy binary `.doc` (pre-2007) has no comparable free parser and isn't
handled — same "no preview available" fallback as any other unsupported
format.

The PDF `<iframe>` uses `GET .../documents/{doc_id}/download?inline=true`,
not the plain `/download` URL — the endpoint always sent
`Content-Disposition: attachment` (forces a download, even inside an
`<iframe>`, regardless of browser). `job_registry.py`'s shared
`_content_disposition(filename, disposition="attachment")` now takes an
optional disposition; `?inline=true` is the only caller that passes
`"inline"` — the Download button/link and every other caller (IFC export,
etc.) are unaffected and still force a real download.

Also covers a read-only **Models** tab in the Documents panel
(`SpeckleModelsList.jsx`) — lists this project's Speckle branches/commits
directly from the Speckle server (same GraphQL query `App.jsx`'s own model
picker already uses, via the new shared `src/utils/speckleGraphQL.js`), with
a thumbnail per commit from Speckle's own preview-service
(`{serverUrl}/preview/{streamId}/commits/{commitId}?token=...` — confirmed
working directly against the server; the token has to be a query param
since a plain `<img>` can't send an `Authorization` header). No backend
route, no Nextcloud/bim_documents involvement at all — deliberately
read-only for now; `bim_documents` already has both a `model_id` soft-link
column and working `link-element`/`unlink-element` routes, so adding
document-to-model or document-to-element linking later is additive, not a
redesign. Deferred until real usage clarifies which granularity (whole
model vs. specific element) is actually wanted.

**Verify**: open Documents → **Models** tab → confirm branches/commits list
with real thumbnails (a broken-image icon is expected only for commits
Speckle hasn't generated a preview for yet, e.g. very recent ones).

## Architecture recap

```
DocumentsPanel.jsx (dashboard)
      │ fetch()
bim-normalizer  /projects/{stream_id}/documents/...
      │
db/documents.py (bim_documents, bim_document_events)
      │
nextcloud/client.py   WebDAV (upload/move/delete/versions) — service account
nextcloud/groupfolders.py   OCS Groupfolders API — project-{stream_id} folder + 4 status subfolders
nextcloud/provisioning.py   OCS Provisioning API — bcf_users → real Nextcloud accounts
dwg_convert.py   shells out to dwg2dxf (LibreDWG, built from source in Dockerfile) for .dwg preview only
      │
nextcloud container (docker-compose)
```

Documents are scoped by `stream_id` (the Speckle project id), not `model_id`
— `model_id` is minted fresh per ingested commit and would orphan documents
on every re-sync.

**Interim RBAC note:** this app has no per-project access grant of its own
yet (every `bcf_users` row already sees every project today). So every user
is added to every project's Nextcloud group — matching that existing
flat-access reality exactly, while still building the real per-project
group-folder infrastructure a future grant/revoke feature can plug into.

## Step 1 — Bring up the stack

This touches `docker-compose.yml` (new `nextcloud` service + `postgres`'s
mounted init script) and `.env` (new `NEXTCLOUD_*` vars, already populated
with generated secrets). Bring the stack up yourself per your usual workflow
— this doc assumes it's already running.

```bash
docker compose up -d
docker compose logs nextcloud --tail 50   # wait for "Initializing finished"
```

**First deploy only** — `pgdata` is an existing volume, so
`postgres-init/01-nextcloud-db.sh` won't auto-run (it only fires on a fresh
volume). Create the Nextcloud database by hand once:

```bash
docker exec -it speckle-postgres psql -U ${PG_USER:-speckle} -c \
  "CREATE USER nextcloud WITH PASSWORD '<NEXTCLOUD_DB_PASS from .env>'; CREATE DATABASE nextcloud OWNER nextcloud;"
```

The Groupfolders app installs itself automatically — `nextcloud-hooks/post-installation/install-groupfolders.sh`
is mounted into `/docker-entrypoint-hooks.d/post-installation`, which the
`nextcloud:apache` image runs exactly once, right after its own auto-install
completes (confirmed via that image's own startup log: "Searching for hook
scripts (*.sh) to run..."). No manual `occ app:install groupfolders` step —
this only matters if you're inspecting a deploy that predates the hook (or
debugging why it's missing):

```bash
docker exec nextcloud php occ app:list | grep groupfolders   # should already show it
```

Confirm Nextcloud itself is healthy without ever opening its web UI:

```bash
curl -f http://localhost:8005/status.php
```

## Step 2 — Verify real user provisioning

Create a `bcf_users` account via the admin panel (or `POST /bcf-bridge/users`)
and confirm a matching Nextcloud account appears — this is an admin-only
verification step, not part of the normal user workflow:

```bash
docker exec nextcloud php occ user:list
```

The new user should show up. If not, check `bim-normalizer` logs for
`Nextcloud provisioning failed` — user creation itself should still succeed
either way (provisioning is best-effort, see Troubleshooting).

## Step 3 — Verify the document workflow end to end

Open a project in the dashboard and click the **Documents** toolbar button
(file icon, next to Clash Detection). First open for a project auto-creates
its Nextcloud group + group folder + 4 status subfolders — confirm with:

```bash
docker exec nextcloud php occ group:list
docker exec nextcloud php occ files:scan --path="/admin/files/project-<stream_id>"
```

Then, from the dashboard:

1. **Upload** a file → lands in the WIP column.
2. **Drag it to Published** → should be rejected inline with an "Approve & Publish" button (the app-enforced approval gate — `move` returns `409` until `approved` is set).
3. Click **Approve & Publish** → moves to Published.
4. Open the document, click **New version**, upload a different file → revision badge increments and the "Approved" state clears (must be re-approved to stay Published — check by dragging it out and back to Published, it should ask for approval again).
5. Check **Version history** in the drawer → the pre-revision content should still be downloadable.
5b. Upload a `.pdf`, `.ifc`, `.dxf`, `.dwg`, `.docx`, and `.xlsx` file → each should show a **Preview** button in the drawer. PDF opens in an iframe (native browser renderer), IFC renders in 3D (drag to orbit, scroll to zoom), DXF and DWG both render in the same 2D viewer (drag to pan, scroll to zoom) — DWG converts server-side first (`dwg2dxf`), so expect a beat of loading time before it appears. DOCX renders as formatted HTML (headings/tables/images should look right). XLSX renders as a table, with a tab strip if the workbook has multiple sheets — click between tabs to confirm each sheet's data loads. Upload any other format (or legacy `.doc`) → no Preview button, just Download/New version (expected — no preview path exists for those). Confirm the DWG conversion directly:
    ```bash
    curl -f "http://localhost:8002/projects/<stream_id>/documents/<doc_id>/preview.dxf" | head -5
    ```
    should return real DXF text (starts with `0` / `SECTION` on its own lines), not an error.
6. **Delete** a document → disappears from the board; confirm it's gone from Nextcloud (`docker exec nextcloud php occ files:scan`) but the DB row survives as a soft-delete tombstone:
   ```sql
   SELECT doc_id, filename, deleted_at FROM bim_documents WHERE deleted_at IS NOT NULL;
   ```
7. Restart `bim-normalizer` mid-session, re-open Documents → the board should reload from the DB with no data loss (state lives in Postgres, not memory).

## Step 4 — Backfill pre-existing files (optional)

A background loop (`_document_sync_loop` in `main.py`, interval
`DOCUMENT_SYNC_SCAN_INTERVAL_S`, default hourly) already reconciles every
project with a group folder automatically — this is a drift-detector safety
net, not the primary sync path (every dashboard action indexes itself
immediately). To force it immediately instead of waiting for the interval,
or for a project that's never had its Documents panel opened yet:

```bash
curl -X POST http://localhost:8002/projects/<stream_id>/documents/backfill
curl http://localhost:8002/projects/<stream_id>/documents/backfill/<job_id>/status
```

## What "good" looks like

- Nextcloud's own web UI is never required for any of the above — every
  action listed happens from the dashboard, `occ` (deploy-time/admin
  verification only), or the OCS API bim-normalizer already calls.
- A document can't reach Published without `approved = true` — verified by
  the 409 in Step 3.2 and the automatic approval-reset on revise (Step 3.4).
- Re-ingesting a new commit on the same stream does **not** orphan any
  document (they're keyed by `stream_id`, confirm the Documents panel still
  shows everything after a re-ingest).

## Troubleshooting

**"Nextcloud provisioning failed: OCS ... returned non-JSON: `<!DOCTYPE html>`..."**
Two distinct causes produce this, both confirmed against a real deployment:

1. **Nextcloud's install never completed.** If `pgdata` already existed when
   the stack first came up, `postgres-init/01-nextcloud-db.sh` didn't run
   (see Step 1's caveat) — Nextcloud's auto-install then fails to connect to
   its database, and *every* request (including OCS calls) gets served the
   setup-wizard HTML instead. Confirm with:
   ```bash
   docker exec nextcloud curl -sf http://localhost/status.php   # look for "installed":false
   docker logs nextcloud | grep -i "error while trying to create admin"
   ```
   Fix: create the `nextcloud` Postgres role/database by hand (Step 1's manual
   step), then — since a failed install attempt already writes partial
   `dbtype`/`dbname` keys into `config.php`, which makes the container's
   entrypoint skip auto-install on a plain restart — finish the install
   directly instead of just restarting:
   ```bash
   docker exec nextcloud php occ maintenance:install \
     --database pgsql --database-host postgres --database-name nextcloud \
     --database-user "$NEXTCLOUD_DB_USER" --database-pass "$NEXTCLOUD_DB_PASS" \
     --admin-user "$NEXTCLOUD_ADMIN_USER" --admin-pass "$NEXTCLOUD_ADMIN_PASSWORD"
   ```
   **`occ maintenance:install` does not read `NEXTCLOUD_TRUSTED_DOMAINS`** the
   way the normal env-var-driven auto-install would — it sets
   `trusted_domains` to `['localhost']` only. bim-normalizer talks to
   Nextcloud via `http://nextcloud` (not `localhost`), so every OCS call
   fails with a `400` and a full HTML "untrusted domain" error page
   (confirmed by nginx/apache access logs still showing the request
   successfully Basic-Auth'd as `admin` — the auth succeeds, only the domain
   check fails) even though `docker exec nextcloud curl http://localhost/...`
   diagnostics work fine, since `localhost` *is* trusted. Fix once, right
   after running the manual install above:
   ```bash
   docker exec nextcloud php occ config:system:get trusted_domains   # confirm: only "localhost"
   docker exec nextcloud php occ config:system:set trusted_domains 1 --value=nextcloud
   ```
2. **The Groupfolders app's OCS-style calls need a different URL prefix.**
   Its `FolderController` extends `OCSController` (same `{"ocs":{...}}`
   response envelope) but registers its routes as plain `#[FrontpageRoute]`s,
   not `#[ApiRoute]`s — so `apps/groupfolders/folders` lives directly under
   the app path, with **no** `/ocs/v1.php/` or `/ocs/v2.php/` prefix, unlike
   the core Provisioning API's `cloud/users`/`cloud/groups` (which do use
   that prefix). `nextcloud/client.py`'s `_ocs_request()` takes a `base`
   param for this — `groupfolders.py` passes `base=""` for every
   `apps/groupfolders/...` call, `provisioning.py`'s `cloud/*` calls use the
   default. If you see this error specifically for a folder/group-access
   call (not `cloud/groups`/`cloud/users`), a future Groupfolders version may
   have changed its routing again — check
   `custom_apps/groupfolders/lib/Controller/FolderController.php`'s route
   attributes to confirm.

**"Nextcloud provisioning failed: OCS POST cloud/groups failed: 400 ...statuscode":102,"message":"group exists"..."**
A real bug in `nextcloud/client.py`'s `_ocs_request()` (fixed): it checked
`resp.status_code >= 400` *before* parsing the JSON body, but Nextcloud
returns **HTTP 400** (not 200) for "group/user already exists" — so the
generic HTTP-status error fired before the code ever reached the
`statuscode == 102` conflict-detection logic that was supposed to swallow
this exact case as a no-op. This wasn't a one-off: it fired on **every**
repeat call to `ensure_group()`/`ensure_user()` for any group/user that
already existed — i.e. every time an already-provisioned project's
Documents panel was reopened or uploaded to again, not just first use.
Fixed by parsing the JSON body first regardless of HTTP status, and only
falling back to the raw status code when the body genuinely isn't JSON
(the setup-wizard/untrusted-domain HTML cases above). If you see a similar
"non-conflict error for an obviously-idempotent operation" again, suspect
the same pattern: check whether Nextcloud is returning a real OCS envelope
under a 4xx HTTP status that the calling code special-cased incorrectly.

**Upload/move/delete returns 502 "Nextcloud ... failed"**
`bim-normalizer` couldn't reach Nextcloud or the WebDAV service account
lacks folder access. Check:
```bash
docker exec bim-normalizer curl -f http://nextcloud/status.php
```
and confirm `NEXTCLOUD_USER` (default `admin`) is a member of the project's
group — `docker exec nextcloud php occ group:list` — `ensure_group_folder()`
should have added it automatically the first time the project's Documents
panel opened; if it didn't, Nextcloud provisioning likely failed silently
earlier (see next item).

**A new `bcf_users` account has no matching Nextcloud account**
Provisioning is deliberately best-effort (a down/misconfigured Nextcloud
shouldn't block BCF user creation) — check `bim-normalizer` logs:
```bash
docker compose logs bim-normalizer --tail 100 | grep -i "nextcloud provisioning"
```
Common cause: `NEXTCLOUD_ADMIN_PASSWORD` in `.env` doesn't match what the
container auto-installed with (only matters if you changed it after first
boot — Nextcloud's admin password is set once, at first-boot auto-install,
and env var changes afterward don't retroactively change it).

**Thumbnails never load, always fall back to the file icon**
Expected for most CAD formats (DWG/IFC/RVT) — Nextcloud's preview generator
only covers images/PDF/Office. Confirm it's not a bug by uploading a PDF or
PNG and checking that one does get a thumbnail. Note this is a separate
concern from the drawer's **Preview** button (client-side, `web-ifc`/
`dxf-parser`) — an IFC file will never get a Nextcloud *thumbnail* on its
card, but its **Preview** button should still open a working 3D view.

**Preview button does nothing / IFC or DXF preview shows a blank/error screen**
Open the browser console. `IfcCanvas`/`DxfCanvas` fetch the raw file from
the existing `/download` endpoint and parse it entirely client-side — a
404/CORS error there means the download URL itself is wrong, not a viewer
bug. For IFC specifically, confirm `/wasm/web-ifc.wasm` is reachable
(`curl -f https://<dashboard>/wasm/web-ifc.wasm`) — it's a static asset
copied from `public/wasm/` at build time, not fetched from bim-normalizer.

**DWG preview fails with 502 "dwg2dxf is not installed on this server"**
The Dockerfile's LibreDWG build step didn't complete (this specific build
was never verified locally — first real test is your Docker build). Check:
```bash
docker exec bim-normalizer which dwg2dxf
docker compose logs bim-normalizer --tail 5   # confirm it's actually running the rebuilt image
```
If `dwg2dxf` is missing, rebuild `bim-normalizer` and watch the build logs
around the `LIBREDWG_VERSION` curl/configure/make step for the actual
failure — likely a network issue fetching the GitHub release tarball, or a
LibreDWG release tag that no longer exists (this project ships very
frequent nightly-style releases; if `LIBREDWG_VERSION` in the Dockerfile
404s, bump it to a current tag from
https://github.com/LibreDWG/libredwg/releases).

**DWG preview fails with 502 "Conversion produced no output"**
`dwg2dxf` ran but couldn't produce a DXF from this specific file — check
`bim-normalizer` logs for the captured stderr (in the error detail). Per
LibreDWG's own docs, some very advanced R2010+ objects aren't supported; a
DWG saved from a newer AutoCAD version in an older format (e.g. "Save As
R2013") is more likely to convert successfully than the latest format.

**Groupfolders isn't installed even though the stack came up fine**
Should only happen on a deploy from before `nextcloud-hooks/` existed, or if
the `nextcloud_config`/`nextcloud_html` volumes were already fully installed
before the hook was added (the hook only fires on a fresh install — see
Step 1). Install it by hand once:
```bash
docker exec nextcloud php occ app:install groupfolders
```
If that command itself fails, Nextcloud's first-boot auto-install may still
be running — wait for `docker compose logs nextcloud` to show
`Initializing finished` first.
