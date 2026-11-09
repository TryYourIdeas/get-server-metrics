#!/usr/bin/env bash
# Usage: APP_PASSWORD=<pw> TEST_AGENT_PASSWORD=<pw> docker/test-servers/run.sh [up|verify|down]
#   up      create the broker users (app and the test agents), build and start the agent containers, the event
#           monitor (stores readings in Postgres) and the dashboard
#   verify  check that every agent reached the broker, that its readings were saved in the database
#           and that the dashboard lists it
#   down    stop and remove the test containers and their volume, and delete the test-* hosts' data
#           from the database
# With no argument it runs up then verify. The dashboard is at http://localhost:${DASHBOARD_PORT:-3000}.
# SKIP_APPS=1 leaves the event monitor and dashboard containers out (run-with-monitor.sh runs them on this
# machine instead); verify then skips the database and dashboard checks.
set -euo pipefail

root="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$root"

HOSTS=(test-debian12 test-ubuntu2404 test-fedora test-alpine test-node24 test-alert)
ALERT_HOST=test-alert
WAIT_SECONDS="${WAIT_SECONDS:-45}"
DASHBOARD_PORT="${DASHBOARD_PORT:-3000}"
export DASHBOARD_PORT
SKIP_APPS="${SKIP_APPS:-0}"
SERVICES=(agent-debian12 agent-ubuntu2404 agent-fedora agent-alpine agent-node24 agent-alert event-monitor dashboard)
compose=(docker compose -f docker-compose.yml -f docker-compose.test-servers.yml)

usage() {
  cat >&2 <<'MSG'
Both environment variables must be set (not needed for "down"):
  APP_PASSWORD         password of the broker user "app" (created by this script, used by verify to listen)
  TEST_AGENT_PASSWORD  password of the broker users of the test agents (test-debian12, test-alpine, ...)

Example:
  APP_PASSWORD=changeme TEST_AGENT_PASSWORD=changeme-too docker/test-servers/run.sh [up|verify|down]
MSG
}

require_env() {
  local missing=0 v
  for v in APP_PASSWORD TEST_AGENT_PASSWORD; do
    if [ -z "${!v:-}" ]; then echo "ERROR: $v is not set" >&2; missing=1; fi
  done
  if [ "$missing" -ne 0 ]; then usage; exit 1; fi
  export APP_PASSWORD TEST_AGENT_PASSWORD
}

[ "${1:-all}" = down ] || require_env

up() {
  docker/mosquitto/add-user.sh app "$APP_PASSWORD" >/dev/null
  for h in "${HOSTS[@]}"; do docker/mosquitto/add-user.sh "$h" "$TEST_AGENT_PASSWORD" >/dev/null; done
  "${compose[@]}" up -d --build mosquitto
  "${compose[@]}" restart mosquitto # pick up the new passwd entries
  if [ "$SKIP_APPS" = 1 ]; then
    "${compose[@]}" up -d --build
  else
    "${compose[@]}" --profile apps up -d --build
  fi
}

verify() {
  echo "Listening on the broker for up to ${WAIT_SECONDS}s..."
  capture="$(mktemp)"
  trap 'rm -f "$capture"' RETURN
  "${compose[@]}" exec -T mosquitto mosquitto_sub -h localhost -u app -P "$APP_PASSWORD" -v -W "$WAIT_SECONDS" \
    -t 'computer-usage/+/heartbeat' -t 'computer-usage/+/event' -t 'computer-usage/+/status' >"$capture" &
  listener=$!
  sleep 2
  # The alert agent publishes its event once, at startup, so restart it now that we are listening.
  "${compose[@]}" restart agent-alert >/dev/null
  wait "$listener" || true
  out=$(cat "$capture")
  failed=0
  for h in "${HOSTS[@]}"; do
    if ! grep -q "^computer-usage/$h/status .*\"online\"" <<<"$out"; then
      echo "FAIL  $h: never reported online"; failed=1; continue
    fi
    hb=$(grep "^computer-usage/$h/heartbeat " <<<"$out" | head -1 || true)
    if [[ -z "$hb" ]]; then echo "FAIL  $h: online but no heartbeat"; failed=1; continue; fi
    if ! grep -Eq '"memTotal":[1-9]' <<<"$hb"; then echo "FAIL  $h: heartbeat has no memory reading"; failed=1; continue; fi
    if ! grep -q '"disks":\[{' <<<"$hb"; then echo "FAIL  $h: heartbeat has no disk"; failed=1; continue; fi
    echo "ok    $h"
  done
  if ! grep -q "^computer-usage/$ALERT_HOST/event .*\"alert\"" <<<"$out"; then
    echo "FAIL  $ALERT_HOST: no alert event published"; failed=1
  else
    echo "ok    $ALERT_HOST published an alert event"
  fi

  if [ "$SKIP_APPS" != 1 ]; then
    echo "Checking the database..."
    psql_q() { "${compose[@]}" exec -T postgres psql -U postgres -d computer-usage -tAc "$1"; }
    sleep 3 # let the monitor finish storing the last messages
    for h in "${HOSTS[@]}"; do
      n=$(psql_q "select count(*) from samples where host_id = '$h'" 2>/dev/null || echo 0)
      d=$(psql_q "select count(*) from disk_samples ds join samples s on s.id = ds.sample_id where s.host_id = '$h'" 2>/dev/null || echo 0)
      if [ "${n:-0}" -ge 1 ] && [ "${d:-0}" -ge 1 ]; then echo "ok    $h: $n samples saved"; else echo "FAIL  $h: nothing saved in the database (samples=$n, disk rows=$d)"; failed=1; fi
    done
    e=$(psql_q "select count(*) from events where host_id = '$ALERT_HOST' and state = 'alert'" 2>/dev/null || echo 0)
    if [ "${e:-0}" -ge 1 ]; then echo "ok    $ALERT_HOST: alert event saved"; else echo "FAIL  $ALERT_HOST: alert event not saved in the database"; failed=1; fi

    echo "Checking the dashboard..."
    hosts_json=$(curl -fsS --max-time 10 "http://localhost:$DASHBOARD_PORT/api/hosts" 2>/dev/null || true)
    if [[ -z "$hosts_json" ]]; then
      echo "FAIL  dashboard: no answer from http://localhost:$DASHBOARD_PORT/api/hosts"; failed=1
    else
      grep -q '"brokerConnected":true' <<<"$hosts_json" || { echo "FAIL  dashboard: event monitor is not connected to the broker"; failed=1; }
      for h in "${HOSTS[@]}"; do
        if grep -q "\"$h\"" <<<"$hosts_json"; then echo "ok    dashboard lists $h"; else echo "FAIL  dashboard does not list $h"; failed=1; fi
      done
    fi

    echo "Checking threshold changes..."
    wait_for() { # <sql returning a count> <seconds>: true once the count is at least 1
      local end=$((SECONDS + $2)) n
      while [ "$SECONDS" -lt "$end" ]; do
        n=$(psql_q "$1" 2>/dev/null || echo 0)
        [ "${n:-0}" -ge 1 ] && return 0
        sleep 2
      done
      return 1
    }
    api="http://localhost:$DASHBOARD_PORT/api/hosts/test-debian12/thresholds"
    json=(-H 'content-type: application/json')
    # 1. Lowering test-debian12's disk threshold to 1% through the dashboard makes its running agent raise an alert.
    if curl -fsS -X PUT "${json[@]}" -d '{"diskPercent":1}' "$api" >/dev/null 2>&1 \
       && wait_for "select count(*) from events where host_id = 'test-debian12' and kind = 'disk' and state = 'alert'" 30; then
      echo "ok    lowering test-debian12's disk threshold raised an alert"
    else echo "FAIL  test-debian12 did not raise a disk alert after its threshold was lowered"; failed=1; fi
    # 2. Removing the override sends the default back and the alert recovers.
    if curl -fsS -X DELETE "$api" >/dev/null 2>&1 \
       && wait_for "select count(*) from events where host_id = 'test-debian12' and kind = 'disk' and state = 'ok'" 30; then
      echo "ok    removing the override recovered the alert"
    else echo "FAIL  test-debian12's disk alert did not recover after the override was removed"; failed=1; fi
    cfg() { "${compose[@]}" exec -T mosquitto mosquitto_sub -h localhost -u app -P "$APP_PASSWORD" -t 'computer-usage/+/config' -v -W 3 2>/dev/null || true; }
    if cfg | grep -q '^computer-usage/test-debian12/config .*"diskPercent":90'; then
      echo "ok    the retained config for test-debian12 holds the default again"
    else echo "FAIL  the retained config for test-debian12 is missing or stale"; failed=1; fi
    # 3. An agent must not be able to write config topics (its own or another host's).
    forged='{"cpuPercent":5,"cpuConsecutive":3,"memoryPercent":90,"diskPercent":90}'
    for t in computer-usage/test-alpine/config computer-usage/test-debian12/config; do
      "${compose[@]}" exec -T mosquitto mosquitto_pub -h localhost -u test-alpine -P "$TEST_AGENT_PASSWORD" -t "$t" -r -m "$forged" >/dev/null 2>&1 || true
    done
    if cfg | grep -q '"cpuPercent":5[,}]'; then
      echo "FAIL  an agent was able to publish a config message (check docker/mosquitto/acl)"; failed=1
      for t in computer-usage/test-alpine/config computer-usage/test-debian12/config; do
        "${compose[@]}" exec -T mosquitto mosquitto_pub -h localhost -u app -P "$APP_PASSWORD" -t "$t" -r -n >/dev/null 2>&1 || true
      done
    else echo "ok    agents cannot publish config messages"; fi
  fi

  if [ "$failed" -ne 0 ]; then echo "Logs: ${compose[*]} logs <service>"; exit 1; fi
  if [ "$SKIP_APPS" != 1 ]; then echo; echo "All good. Open the dashboard: http://localhost:$DASHBOARD_PORT"; fi
}

down() {
  # Remove the data the test agents stored, so the dashboard does not keep showing dead test hosts.
  # (Postgres may not be running; then there is nothing to clean.)
  "${compose[@]}" exec -T postgres psql -U postgres -d computer-usage -c \
    "delete from samples where host_id like 'test-%'; delete from events where host_id like 'test-%'; delete from hosts where host_id like 'test-%'; delete from host_thresholds where host_id like 'test-%';" \
    >/dev/null 2>&1 || echo "note: could not clean test data from the database (is Postgres running?)"
  "${compose[@]}" --profile apps rm -sf "${SERVICES[@]}"
  # Compose names the volume <project>_testdata, and the project defaults to this folder's name.
  project="${COMPOSE_PROJECT_NAME:-$(basename "$root" | tr 'A-Z' 'a-z' | sed 's/[^a-z0-9_-]//g')}"
  docker volume rm -f "${project}_testdata" >/dev/null || true
}

case "${1:-all}" in
  up) up ;;
  verify) verify ;;
  down) down ;;
  all) up; verify ;;
  *) echo "usage: $0 [up|verify|down]" >&2; exit 1 ;;
esac
