# computer-usage

System resources monitor: agents on one or more machines report CPU, memory and disk usage over MQTT (a heartbeat every 5 minutes plus threshold alerts), stored in Postgres (database `computer-usage`) and shown on a dashboard.

## Quick start

```bash
docker/mosquitto/add-user.sh app <password>       # broker user for the app
docker/mosquitto/add-user.sh local <password>     # broker user for this machine's agent (username = HOST_ID)
docker compose up -d        # Postgres 18 on localhost:5433, Mosquitto on localhost:1883
npm install
cp event-monitor/.env.example event-monitor/.env # configure database and MQTT credentials
cp .env.example .env        # configure the viewer database URL and event monitor URL
npm run monitor             # in one terminal; Node.js MQTT ingestion service
npm run dev                 # in another terminal; Nuxt resource viewer at http://localhost:3000
# in another terminal, start the agent for this machine:
cd ../lib/computer-usage-agent && cp .env.example .env && npm install && npm start
npm test
```

The event monitor is a separate Node.js workspace that consumes MQTT, validates and stores readings/events, applies retention, and relays live updates. The Nuxt app only reads PostgreSQL and proxies monitor health, check-now requests, and the live stream. Start the event monitor before the viewer; it runs database migrations on startup.

See `docs/user-guides/` (config, manual, features), `docs/pending-tasks.md`, and the design spec in `docs/superpowers/specs/`.
