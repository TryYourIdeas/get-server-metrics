# event-monitor

Standalone Node.js service for the computer-usage system. It subscribes to agent MQTT topics, validates incoming messages, runs database migrations, stores readings and events in PostgreSQL, and applies retention. The `dashboard` app reads from PostgreSQL and uses this service for live updates, MQTT status, and check-now requests.

## Run

From the project root:

```bash
npm install
cp event-monitor/.env.example event-monitor/.env
npm run monitor
```

Set this app's database URL and MQTT app credentials in `event-monitor/.env`. The monitor listens on `127.0.0.1:3100` by default. Set the dashboard's `EVENT_MONITOR_URL` to that address.

For a monitor on a different machine, set `EVENT_MONITOR_HOST` to a private-network address, configure the dashboard's `EVENT_MONITOR_URL`, and set the same strong `EVENT_MONITOR_TOKEN` in both apps. The monitor refuses non-loopback binding without a token.

## HTTP endpoints

- `GET /health` reports MQTT connectivity and the stale-host interval.
- `GET /stream` relays incoming readings/events over Server-Sent Events.
- `POST /hosts/:host/check` publishes a check-now request to the agent.
- `DELETE /hosts/:host/logs` deletes the selected host's stored samples and events.

The monitor shares the database schema and repository code in the project's `shared/` folder so both apps use the same data model. Database migrations, all writes, and retention are owned by this service.
