# agent

Reports this machine's CPU, memory and disk usage to the computer-usage app over MQTT. Run one agent on every machine you want to monitor, including the one that runs the app.

## Run

    cp .env.example .env     # set HOST_ID and the broker credentials
    npm install
    npm start

The agent publishes a heartbeat reading every `HEARTBEAT_INTERVAL_MS` (default 5 min) and an event when CPU, memory or a disk crosses its threshold (and when it recovers). It also answers "Check now" requests from the dashboard.

## Configuration

| Variable | Default | Description |
|---|---|---|
| `HOST_ID` | required | Name shown in the dashboard. Letters, digits, `_`, `.`, `-` (max 64). |
| `MQTT_URL` | `mqtt://localhost:1883` | Broker URL. |
| `MQTT_USERNAME` | `HOST_ID` | Must equal `HOST_ID`: the broker ACL only lets a user publish under its own host topic. |
| `MQTT_PASSWORD` | none | Password created with `docker/mosquitto/add-user.sh` in the app repo. |
| `HEARTBEAT_INTERVAL_MS` | `300000` | Milliseconds between heartbeat readings. |
| `CHECK_INTERVAL_MS` | `20000` | Milliseconds between threshold checks. |
| `CPU_THRESHOLD_PERCENT` / `CPU_CONSECUTIVE_CHECKS` | `90` / `3` | CPU alerts after this many consecutive checks at or above the threshold. |
| `MEMORY_THRESHOLD_PERCENT` | `90` | Memory alert threshold (used %). |
| `DISK_THRESHOLD_PERCENT` | `90` | Disk alert threshold (used %), per mount. |
| `QUEUE_LIMIT` | `1000` | Messages kept while the broker is unreachable (newest kept). |
| `NUXT_ADD_DEBUG_LOGS` | `false` | `true`/`1` enables tracing logs. |

## Consumers

The `Event monitor` and `dashboard` apps import `agent/protocol` (topics and payload validation). The protocol file has no dependencies on purpose.

## Test

    npm test      # uses an in-process broker, no Docker needed
