#!/bin/bash
# Runs once, on the first start of an empty volume. Each service owns one database and
# logs in with its own role, so a leaked Keycloak password cannot read the app's data.
set -euo pipefail
for service in keycloak openfga medinfo; do
  var="$(echo "$service" | tr '[:lower:]' '[:upper:]')_DB_PASSWORD"
  psql -v ON_ERROR_STOP=1 --username postgres \
    -v role="$service" -v password="${!var}" <<'SQL'
CREATE ROLE :"role" LOGIN PASSWORD :'password';
CREATE DATABASE :"role" OWNER :"role";
REVOKE ALL ON DATABASE :"role" FROM PUBLIC;
SQL
done
# The tests' own database: npm run check creates and deletes rows here, never in the app's.
psql -v ON_ERROR_STOP=1 --username postgres <<'SQL'
CREATE DATABASE medinfo_test OWNER medinfo;
REVOKE ALL ON DATABASE medinfo_test FROM PUBLIC;
SQL
# Lesson 20. pgvector for the label index. Only the owner of the server may install an extension,
# so it is done here, not by the app's migrations. npm run rag:setup does the same on an older volume.
for db in medinfo medinfo_test; do
  psql -v ON_ERROR_STOP=1 --username postgres --dbname "$db" -c "CREATE EXTENSION IF NOT EXISTS vector;"
done
