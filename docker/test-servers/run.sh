#!/usr/bin/env bash
# Usage: APP_PASSWORD=<broker password of the "app" user> docker/test-servers/run.sh [up|verify|down]
#   up      create the broker users for the test agents, build and start the agent containers
#   verify  wait for every agent to report a heartbeat (and the alert agent an event) through the broker
#   down    stop and remove the test containers (and their volume)
# With no argument it runs up then verify.
set -euo pipefail

root="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$root"

HOSTS=(test-debian12 test-ubuntu2404 test-fedora test-alpine test-node24 test-alert)
ALERT_HOST=test-alert
TEST_AGENT_PASSWORD="${TEST_AGENT_PASSWORD:-test-agents-pw}"
export TEST_AGENT_PASSWORD
WAIT_SECONDS="${WAIT_SECONDS:-45}"
compose=(docker compose -f docker-compose.yml -f docker-compose.test-servers.yml)

up() {
  for h in "${HOSTS[@]}"; do docker/mosquitto/add-user.sh "$h" "$TEST_AGENT_PASSWORD" >/dev/null; done
  "${compose[@]}" up -d --build mosquitto
  "${compose[@]}" restart mosquitto # pick up the new passwd entries
  "${compose[@]}" up -d --build
}

verify() {
  : "${APP_PASSWORD:?set APP_PASSWORD to the broker password of the 'app' user}"
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
  if [ "$failed" -ne 0 ]; then echo "Logs: ${compose[*]} logs <service>"; exit 1; fi
}

down() { "${compose[@]}" rm -sf $(printf 'agent-%s ' debian12 ubuntu2404 fedora alpine node24 alert) && docker volume rm -f computer-usage_testdata >/dev/null || true; }

case "${1:-all}" in
  up) up ;;
  verify) verify ;;
  down) down ;;
  all) up; verify ;;
  *) echo "usage: $0 [up|verify|down]" >&2; exit 1 ;;
esac
