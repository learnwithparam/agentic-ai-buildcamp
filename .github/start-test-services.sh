#!/usr/bin/env bash
# Lesson 11. The session and permission tests run against the real services, started from the
# same compose file as the workshop, with throwaway secrets. Keycloak is not needed: the auth test
# signs its own tokens. Both workflows call this before npm run check, the sync once for all tags.
set -euo pipefail
umask 077
settings=.env
for name in POSTGRES_PASSWORD KEYCLOAK_DB_PASSWORD OPENFGA_DB_PASSWORD MEDINFO_DB_PASSWORD KEYCLOAK_ADMIN_PASSWORD FGA_API_TOKEN; do
  value="$(openssl rand -hex 24)"
  echo "::add-mask::$value"
  echo "$name=$value" >> "$settings"
done
medinfo="$(grep '^MEDINFO_DB_PASSWORD=' "$settings" | cut -d= -f2)"
echo "TEST_DATABASE_URL=postgresql://medinfo:$medinfo@localhost:5442/medinfo_test" >> "$settings"
docker compose --env-file "$settings" -f infra/docker-compose.yml up -d --wait postgres openfga
