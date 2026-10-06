# computer-usage

System resources monitor: agents on one or more machines report CPU, memory and disk usage over MQTT (a heartbeat every 5 minutes plus threshold alerts), stored in Postgres (database `computer-usage`) and shown on a dashboard.

## Quick start

```bash
docker/mosquitto/add-user.sh app <password>       # broker user for the app
docker/mosquitto/add-user.sh local <password>     # broker user for this machine's agent (username = HOST_ID)
docker compose up -d        # Postgres 18 on localhost:5433, Mosquitto on localhost:1883
cp .env.example .env        # set MQTT_PASSWORD
npm install
npm run dev                 # http://localhost:3000
# in another terminal, start the agent for this machine:
cd ../lib/computer-usage-agent && cp .env.example .env && npm install && npm start
npm test
```

See `docs/user-guides/` (config, manual, features), `docs/pending-tasks.md`, and the design spec in `docs/superpowers/specs/`.
