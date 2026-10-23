# Computer Usage Event Monitor

Standalone Node.js service for the computer-usage system. It subscribes to agent MQTT topics, validates incoming messages, runs database migrations, stores readings and events in PostgreSQL, and applies retention. The Nuxt viewer is a separate workspace and does not connect to MQTT.

## Run

From the project root:

```bash
npm install
cp event-monitor/.env.example event-monitor/.env
npm --workspace computer-usage-event-monitor run start
```

Set the event monitor's database URL and MQTT app credentials in `event-monitor/.env`. The monitor listens on `127.0.0.1:3100` by default. Set the viewer's `EVENT_MONITOR_URL` to that address.

For a monitor on a different machine, set `EVENT_MONITOR_HOST` to a private-network address, configure the viewer's `EVENT_MONITOR_URL`, and set the same strong `EVENT_MONITOR_TOKEN` in both apps. The monitor refuses non-loopback binding without a token.

## HTTP endpoints

- `GET /health` reports MQTT connectivity and the stale-host interval.
- `GET /stream` relays incoming readings/events over Server-Sent Events.
- `POST /hosts/:host/check` publishes a check-now request to the agent.
- `DELETE /hosts/:host/logs` deletes the selected host's stored samples and events.

The monitor shares the database schema and repository code with the viewer workspace so both apps use the same data model. Database migrations, all writes, and retention are owned by this service.
