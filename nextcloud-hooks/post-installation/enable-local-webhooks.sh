#!/bin/bash
# Runs automatically, exactly once, right after Nextcloud's auto-install
# completes (docker-entrypoint-hooks.d/post-installation — same mechanism as
# install-richdocuments.sh/install-groupfolders.sh/install-previewgenerator.sh).
# Only fires on a brand-new instance — an already-provisioned Nextcloud
# (existing volumes) needs the same command run by hand once instead, since
# these hooks never re-run on an existing install:
#
#   docker exec nextcloud php occ config:system:set allow_local_remote_servers --type=bool --value=true
#
# Without this, Nextcloud's outgoing HTTP client refuses to call
# bim-normalizer's own webhook callback (nextcloud/webhooks.py registers it,
# routers/nextcloud_webhook.py receives it) since "bim-normalizer" resolves
# to a same-Docker-network address and Nextcloud's SSRF protection treats
# that as an internal/private target by default. The failure is silent from
# the app's own perspective — Nextcloud just logs "Host \"bim-normalizer\"
# violates local access rules" and never retries — so a file edited directly
# in Nextcloud or through Collabora (both bypass bim-normalizer's own
# upload/revise calls entirely) never gets its bim_documents row refreshed
# via the near-real-time webhook path, silently falling back to
# nextcloud/reconcile.py's much slower daily full-tree sweep. Confirmed live
# against this deployment (LXC 106, 2026-09-09) — a fresh Nextcloud install's
# default has this unset, and richdocuments/webhook_listeners provisioning
# does not turn it on for you.
set -e

php occ config:system:set allow_local_remote_servers --type=bool --value=true
