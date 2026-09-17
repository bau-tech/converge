#!/bin/bash
# Runs automatically, exactly once, right after Nextcloud's auto-install
# completes (docker-entrypoint-hooks.d/post-installation — same mechanism as
# enable-local-webhooks.sh/install-richdocuments.sh/etc.). Only fires on a
# brand-new instance — an already-provisioned Nextcloud (existing volumes)
# needs the same commands run by hand once instead, since these hooks never
# re-run on an existing install:
#
#   docker exec nextcloud php occ config:system:set redis host --value=nextcloud-redis
#   docker exec nextcloud php occ config:system:set redis port --value=6379 --type=integer
#   docker exec nextcloud php occ config:system:set memcache.distributed --value='\OC\Memcache\Redis'
#   docker exec nextcloud php occ config:system:set memcache.locking --value='\OC\Memcache\Redis'
#   docker exec nextcloud php occ config:system:set maintenance_window_start --type=integer --value=2
#
# Without this, transactional file locking falls back to the database (the
# admin panel flags this directly) — under concurrent Collabora edits +
# webhook_listeners file events this adds avoidable Postgres contention (a
# deadlock already showed up in nextcloud.log on this deployment). Points at
# the nextcloud-redis service in docker-compose.yml, not speckle-redis-1
# (that one belongs to the separate Speckle-server compose stack). Also sets
# maintenance_window_start to 2 (02:00 UTC) so heavy daily background jobs
# (previews, webhook dispatch) run off-hours instead of at an arbitrary time
# that can overlap working hours. Confirmed live against this deployment
# (LXC 106, 2026-09-17).
set -e

php occ config:system:set redis host --value=nextcloud-redis
php occ config:system:set redis port --value=6379 --type=integer
php occ config:system:set memcache.distributed --value='\OC\Memcache\Redis'
php occ config:system:set memcache.locking --value='\OC\Memcache\Redis'
php occ config:system:set maintenance_window_start --type=integer --value=2
