#!/bin/bash
# Runs automatically, exactly once, right after Nextcloud's auto-install
# completes (docker-entrypoint-hooks.d/post-installation — same mechanism
# as install-groupfolders.sh). Only fires on a brand-new instance; an
# already-provisioned Nextcloud (existing volumes) needs this run by hand
# once via `docker exec nextcloud bash -c '...'`.
#
# Installs Preview Generator and points its pre-generated sizes at the
# 256x256 box routers/documents.py's thumbnail_document already requests
# (core/preview?x=256&y=256&a=1), plus a 1024 tier so a future higher-res
# thumbnail is served by downscaling a cached image instead of re-invoking
# imagick/ghostscript from scratch — that synchronous invocation on-request
# is what OOM-killed the 512m nextcloud container under concurrent PDF
# uploads (see docker-compose.yml's nextcloud mem_limit comment).
#
# previewgenerator queues newly-written files via an event listener but only
# processes the queue through Nextcloud's "cron" background-job mode (AJAX
# and webcron aren't supported) — that's what the docker-compose
# nextcloud-cron sidecar actually ticks every 5 minutes.
set -e
if ! php occ app:list | grep -q '  - previewgenerator:'; then
    php occ app:install previewgenerator
fi
php occ config:app:set --value="256" previewgenerator squareSizes
php occ config:app:set --value="256 1024" previewgenerator widthSizes
php occ config:app:set --value="256 1024" previewgenerator heightSizes
php occ background:cron
