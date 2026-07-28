#!/bin/bash
# Runs automatically, exactly once, right after Nextcloud's auto-install
# completes (docker-entrypoint-hooks.d/post-installation — confirmed present
# in the nextcloud:apache image via its own startup log: "Searching for hook
# scripts (*.sh) to run, located in the folder ..."). This removes the
# `occ app:install groupfolders` manual deploy step — the Documents feature
# needs this app for per-project group folders, so it must exist before
# bim-normalizer's first ensure_group_folder() call, and there's no reliable
# way to guarantee ordering if this were left as a manual step run whenever
# convenient after bring-up.
set -e
if ! php occ app:list | grep -q '  - groupfolders:'; then
    php occ app:install groupfolders
fi
