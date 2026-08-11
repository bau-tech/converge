# Testing auth-gated routes

A full backend review found a number of mutating REST routes reachable with
**zero** authentication — anyone who knew (or guessed) a `model_id`/`stream_id`
could delete a model, upload arbitrary IFC content, overwrite Speckle
credentials, or trigger a full re-ingest. All were fixed by adding
`Depends(require_login)` / `Depends(require_role(*ANY_PROJECT_ROLE))` /
a manual `require_project_role(...)` check (`dashboard_auth/dependencies.py`).

This is a regression checklist, not a one-time verification — re-run it
after touching any of these routers, since a route missing its `Depends(...)`
is easy to introduce by copy-pasting a sibling route and forgetting the
auth parameter (exactly how these gaps happened the first time).

This repo has no `tests/`/`test_*.py` for auth — verification is manual,
following the same convention as the other `testing-*.md` files.

## Every route below should return `401` with **no session cookie** at all

```bash
base="http://<host>:<port>"

curl -s -o /dev/null -w '%{http_code}\n' -X DELETE "$base/models/00000000-0000-0000-0000-000000000000"
curl -s -o /dev/null -w '%{http_code}\n' -X POST "$base/projects/<stream_id>/models/upload-ifc" -F "file=@test.ifc"
curl -s -o /dev/null -w '%{http_code}\n' -X POST "$base/auto-sync/servers" -H "Content-Type: application/json" -d '{"server_url":"http://x","token":"x"}'
curl -s -o /dev/null -w '%{http_code}\n' -X POST "$base/models/00000000-0000-0000-0000-000000000000/overrides" -H "Content-Type: application/json" -d '[]'
curl -s -o /dev/null -w '%{http_code}\n' -X DELETE "$base/models/00000000-0000-0000-0000-000000000000/overrides/00000000-0000-0000-0000-000000000000"
curl -s -o /dev/null -w '%{http_code}\n' -X POST "$base/models/00000000-0000-0000-0000-000000000000/overrides/apply"
curl -s -o /dev/null -w '%{http_code}\n' -X POST "$base/classification/reload"
curl -s -o /dev/null -w '%{http_code}\n' -X POST "$base/models/00000000-0000-0000-0000-000000000000/filter-publish" -H "Content-Type: application/json" -d '{}'
curl -s -o /dev/null -w '%{http_code}\n' -X POST "$base/ingest" -H "Content-Type: application/json" -d '{"stream_id":"x","commit_id":"y"}'
curl -s -o /dev/null -w '%{http_code}\n' -X POST "$base/share" -H "Content-Type: application/json" -d '{"payload":{}}'
curl -s -o /dev/null -w '%{http_code}\n' "$base/share"
curl -s -o /dev/null -w '%{http_code}\n' -X DELETE "$base/share/share01"
curl -s -o /dev/null -w '%{http_code}\n' -X PUT "$base/dashboard-layout/x" -H "Content-Type: application/json" -d '{"payload":{}}'
```

Every one of these must print `401`. If any prints `200`/`404`/`422`
instead, the route's `Depends(require_login)` (or the manual
`require_project_role(...)` check inside the handler body) has regressed.

## The one deliberate exception

```bash
curl -s -o /dev/null -w '%{http_code}\n' "$base/share/nonexistent"
```

Must print `404`, **not** `401` — `GET /share/{id}` is intentionally
public: a `share_id` *is* the access credential for anonymous `/shareXXX`
visitors (see `.env.example`'s `VITE_SHARE_LINK_MODE`), same as every other
capability-token-style share link in this app. If this ever starts
returning `401`, anonymous share links are broken, not "more secure."

## With a real session but no project role

Log in as a `bcf_users` account with **no** `bim_document_roles` grant for
the target `stream_id` (and no `stream_id='*'` blanket grant), then repeat
the model/override/ingest/filter-publish/dashboard-layout calls above with
a valid session cookie. These should now return `403`, not `200` — confirms
the role check itself (not just "is logged in") is actually enforced.

## `bcf-server`'s `/admin` panel — `is_admin`, not just a valid login

Separate from the routes above (a different service, its own session
system — see `bcf/admin.py`). A `bcf_users` row with a correct password but
`is_admin = FALSE` must still be refused:

```bash
curl -s -X POST "http://<bcf-server-host>:8004/admin/login" \
  -d "email=<non-admin-email>&password=<correct-password>" -w '\n%{http_code}\n'
```

Must return `403` with `"This account does not have admin access."` in the
body — not a `302` redirect into the panel. Then confirm the actual
`BCF_ADMIN_EMAIL` account (or any account promoted via
`PATCH /admin/api/users/{guid}/admin`) *can* log in and reach `/admin/api/*`.
See `db_schema.py`'s `is_admin` column comment and `.env.example`'s
`BCF_ADMIN_EMAIL` note for why an unseeded deployment can lock everyone out
of `/admin` entirely — that's expected, not a bug, but worth confirming
once per fresh deployment.
