#!/usr/bin/env bash
# Usage: APP_PASSWORD=<pw> TEST_AGENT_PASSWORD=<pw> docker/test-servers/run-with-monitor.sh [stop]
# Same as run.sh up (broker, Postgres, six test agents) and then also starts, on this machine:
#   - the event monitor (MQTT -> Postgres)         health: http://127.0.0.1:3100
#   - the dashboard (Nuxt dev server)              http://localhost:3000
# Stays in the foreground; press Ctrl-C to stop the monitor and dashboard (the containers keep running,
# stop them with: docker/test-servers/run.sh down). Needs Node.js and `npm install` done at the project root.
# "stop" stops a monitor/dashboard left running by a previous invocation.
set -euo pipefail

root="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$root"

MONITOR_PORT="${EVENT_MONITOR_PORT:-3100}"
DASHBOARD_PORT="${DASHBOARD_PORT:-3000}"
pidfile="$root/docker/test-servers/.run-with-monitor.pids"

usage() {
  cat >&2 <<'MSG'
Both environment variables must be set:
  APP_PASSWORD         password of the broker user "app" (used by the event monitor to read the agents' messages)
  TEST_AGENT_PASSWORD  password of the broker users of the test agents (test-debian12, test-alpine, ...)

Example:
  APP_PASSWORD=changeme TEST_AGENT_PASSWORD=changeme-too docker/test-servers/run-with-monitor.sh
MSG
}

stop_apps() {
  [ -f "$pidfile" ] || return 0
  while read -r pid; do
    # each app runs in its own process group (setsid), so kill the whole group
    kill -- "-$pid" 2>/dev/null || kill "$pid" 2>/dev/null || true
  done <"$pidfile"
  rm -f "$pidfile"
}

if [ "${1:-}" = stop ]; then stop_apps; echo "monitor and dashboard stopped"; exit 0; fi

missing=0
for v in APP_PASSWORD TEST_AGENT_PASSWORD; do
  if [ -z "${!v:-}" ]; then echo "ERROR: $v is not set" >&2; missing=1; fi
done
if [ "$missing" -ne 0 ]; then usage; exit 1; fi
export APP_PASSWORD TEST_AGENT_PASSWORD

for p in "$MONITOR_PORT" "$DASHBOARD_PORT"; do
  if ss -ltn 2>/dev/null | grep -qE "[:.]$p\b"; then
    echo "ERROR: port $p is already in use (a previous run? try: $0 stop)" >&2; exit 1
  fi
done

# SKIP_APPS=1: this script runs the monitor and dashboard on this machine, so run.sh must not start its
# containerized ones (same ports).
SKIP_APPS=1 docker/test-servers/run.sh up

logdir="$(mktemp -d -t run-with-monitor.XXXXXX)"
: >"$pidfile"
trap 'echo; echo "Stopping monitor and dashboard..."; stop_apps' EXIT INT TERM

start() { # name, env assignments..., command...
  local name="$1"; shift
  setsid env "$@" >"$logdir/$name.log" 2>&1 &
  echo $! >>"$pidfile"
}

start event-monitor \
  MQTT_URL=mqtt://localhost:1883 MQTT_USERNAME=app MQTT_PASSWORD="$APP_PASSWORD" \
  EVENT_MONITOR_HOST=127.0.0.1 EVENT_MONITOR_PORT="$MONITOR_PORT" \
  DATABASE_URL="${DATABASE_URL:-postgres://postgres:postgres@localhost:5433/computer-usage}" \
  NUXT_ADD_DEBUG_LOGS=true \
  npm run monitor

start dashboard \
  DATABASE_URL="${DATABASE_URL:-postgres://postgres:postgres@localhost:5433/computer-usage}" \
  EVENT_MONITOR_URL="http://127.0.0.1:$MONITOR_PORT" \
  PORT="$DASHBOARD_PORT" NITRO_PORT="$DASHBOARD_PORT" NUXT_ADD_DEBUG_LOGS=true \
  npm run dev

echo "Waiting for the event monitor and the dashboard (logs in $logdir)..."
for _ in $(seq 1 90); do
  if curl -fsS -o /dev/null "http://localhost:$DASHBOARD_PORT" 2>/dev/null; then ready=1; break; fi
  sleep 2
done
if [ "${ready:-0}" != 1 ]; then
  echo "ERROR: the dashboard did not come up; see $logdir/dashboard.log and $logdir/event-monitor.log" >&2; exit 1
fi

echo
echo "Dashboard:      http://localhost:$DASHBOARD_PORT"
echo "Event monitor:  http://127.0.0.1:$MONITOR_PORT"
echo "Logs:           $logdir/{event-monitor,dashboard}.log"
echo "The six test agents report every 10s. Press Ctrl-C to stop the monitor and dashboard."
wait
