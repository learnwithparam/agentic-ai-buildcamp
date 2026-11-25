#!/bin/bash
# Lesson 22. One database login per company for the insights agent. Runs on the first start of an
# empty volume, and again from npm run bi:setup on an older one, so every statement can run twice.
#
# What each login can do is set here, on the server, not in the app:
# - it signs in as itself, so current_user names its company for the whole session. The row rule on
#   bi.territory_rx reads current_user, and no SELECT can change it: set_config('role', ...) needs a
#   role it is a member of, and it is a member of none.
# - it cannot write (read-only by default), cannot run a query past 3 seconds, and holds at most 5
#   connections, so a model's bad query costs little.
# - it may connect to the app's two databases. What it may read there is granted by the app's own
#   migration 009: the one published table, nothing else.
set -euo pipefail
for tenant in pharma_a pharma_b; do
  var="BI_DB_PASSWORD_$(echo "$tenant" | tr '[:lower:]' '[:upper:]')"
  psql -v ON_ERROR_STOP=1 --username postgres \
    -v role="bi_$tenant" -v password="${!var}" <<'SQL'
SELECT format('CREATE ROLE %I', :'role') WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'role') \gexec
ALTER ROLE :"role" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 5 PASSWORD :'password';
ALTER ROLE :"role" SET default_transaction_read_only = on;
ALTER ROLE :"role" SET statement_timeout = '3s';
ALTER ROLE :"role" SET idle_in_transaction_session_timeout = '10s';
ALTER ROLE :"role" SET search_path = bi;
GRANT CONNECT ON DATABASE medinfo, medinfo_test TO :"role";
SQL
done
