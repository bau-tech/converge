#!/bin/bash
# Only runs against a fresh pgdata volume (docker-entrypoint-initdb.d
# convention) — on an existing deployment, run the CREATE USER/DATABASE
# statements below by hand once via `docker exec -it speckle-postgres psql ...`.
set -e
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_USER" <<-EOSQL
    CREATE USER ${NEXTCLOUD_DB_USER:-nextcloud} WITH PASSWORD '${NEXTCLOUD_DB_PASS}';
    CREATE DATABASE nextcloud OWNER ${NEXTCLOUD_DB_USER:-nextcloud};
EOSQL
