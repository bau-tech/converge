#!/bin/bash
# Runs automatically, exactly once, right after Nextcloud's auto-install
# completes (docker-entrypoint-hooks.d/post-installation — same mechanism as
# install-groupfolders.sh/install-previewgenerator.sh). Only fires on a
# brand-new instance with COLLABORA_ENABLED=true set at that time — an
# already-provisioned Nextcloud (existing volumes) needs the same commands
# run by hand once instead, since these hooks never re-run on an existing
# install:
#
#   docker exec nextcloud php occ app:install richdocuments
#   docker exec nextcloud php occ config:app:set richdocuments wopi_url --value="http://collabora:9980"
#   docker exec nextcloud php occ config:app:set richdocuments disable_certificate_verification --value="yes"
#   docker exec nextcloud php occ richdocuments:setup
#   docker exec nextcloud php occ config:app:set richdocuments public_wopi_url --value="<COLLABORA_PUBLIC_URL, if set>"
#
# richdocuments ("Nextcloud Office", formerly "Collabora Online") is the WOPI
# HOST app — it's what bim-normalizer's edit-session route calls via the OCS
# Direct Editing API (nextcloud/client.py's open_direct_editing()).
#
# wopi_url vs public_wopi_url — these are NOT interchangeable, despite both
# defaulting to look like "the Collabora URL". wopi_url is used for every
# server-to-server WOPI call (convert-to, get-thumbnail, extract-link-targets
# — see richdocuments' RemoteService.php) and must always be the internal
# Docker hostname; it works with zero public exposure of Collabora at all,
# so previews/thumbnails need nothing beyond COLLABORA_ENABLED=true. Only the
# actual in-browser editing iframe needs a real, browser-reachable origin —
# that's public_wopi_url, sourced from COLLABORA_PUBLIC_URL. Pointing
# wopi_url itself at a public/proxied URL was tried in production and broke
# convert-to with an unresolved reverse-proxy-layer 403 (see the plan doc's
# "Word/Excel thumbnail previews" section) — do not put COLLABORA_PUBLIC_URL
# in wopi_url's place, only in public_wopi_url's.
#
# `richdocuments:setup` fetches the WOPI discovery XML from the collabora
# container and registers richdocuments as a Direct Editing provider —
# without it, GET .../directEditing/info won't list docx/xlsx/etc. as
# editable. It also auto-derives/overwrites public_wopi_url from wopi_url as
# a side effect, so public_wopi_url MUST be (re-)set after setup runs, never
# before — ordering matters here. Requires the collabora container to
# already be reachable — see docker-compose.collabora.yml.
set -e

if [ "${COLLABORA_ENABLED:-}" != "true" ]; then
    exit 0
fi

if ! php occ app:list | grep -q '  - richdocuments:'; then
    php occ app:install richdocuments
fi
php occ config:app:set richdocuments wopi_url --value="http://collabora:9980"
php occ config:app:set richdocuments disable_certificate_verification --value="yes"
php occ richdocuments:setup

if [ -n "${COLLABORA_PUBLIC_URL:-}" ]; then
    php occ config:app:set richdocuments public_wopi_url --value="${COLLABORA_PUBLIC_URL}"
fi
