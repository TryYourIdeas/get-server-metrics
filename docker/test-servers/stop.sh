#!/usr/bin/env bash
# Usage: docker/test-servers/stop.sh
# Stops every container of this project (the six test agents, the MQTT broker, Postgres, and the event-monitor/dashboard containers) and the
# event monitor / dashboard started by run-with-monitor.sh. Nothing is removed: data volumes and
# containers are kept, so `docker compose start` or run.sh brings everything back.
# To also remove the test agent containers and their volume use: docker/test-servers/run.sh down
# No environment variables are needed.
set -euo pipefail

root="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$root"

docker/test-servers/run-with-monitor.sh stop
# --profile '*' also covers the optional services (event-monitor, dashboard) that are behind the "apps" profile
docker compose --profile '*' -f docker-compose.yml -f docker-compose.test-servers.yml stop
