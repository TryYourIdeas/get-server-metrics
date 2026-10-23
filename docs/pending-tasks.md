# Pending tasks

## 1. Downsampling for the 7d chart
- **Description:** Return bucketed averages instead of every raw sample for long ranges.
- **Value:** Smaller responses and faster charts.
- **Consequence of not doing it:** The 7d range returns ~10,000 points (each with its disks) per request and refresh.

## 2. Per-disk history selection
- **Description:** Let the user choose which disk the history chart shows.
- **Value:** History for every disk, not only the first.
- **Consequence of not doing it:** Only the first disk's history is charted (all disks still appear in the live gauges and in the database).

## 3. Running the app itself in Docker
- **Description:** Containerize the Nuxt app with host mounts so it sees host disks.
- **Value:** One-command deployment.
- **Consequence of not doing it:** The app runs on the host via `npm run dev`; only Postgres is containerized.

## 4. Hardening from the final review
- **Description:** (a) show a visible error on the dashboard when `/api/metrics/history` fails instead of the empty-state text; (b) add a `pool.on('error')` listener, end the pool on shutdown and set pg connection/statement timeouts; (c) time-bound the agent's collection and the app's ingest step and log skipped heartbeats/threshold checks above debug level so a hung one is visible in production; (d) include the failing step (collect/publish/ingest) in error logs; (e) store a missing CPU reading as NULL/skip the tick instead of 0%; (f) anchor chart x-axes to the selected range and break lines across gaps; (g) resolve the migrations folder independent of the working directory for `.output` runs.
- **Value:** Failures become visible and the charts stop suggesting data that does not exist.
- **Consequence of not doing it:** A database outage looks like "not enough data yet", a hung collector silently stops sampling, a missing CPU reading is stored as 0%, and gaps/short histories are drawn misleadingly.

## 5. Central threshold configuration
- **Description:** Edit alert thresholds (per host or fleet-wide) from the dashboard or app config and push them to agents over MQTT, with safe defaults on the agent if the app is down.
- **Value:** Tune alerting for the whole fleet in one place.
- **Consequence of not doing it:** Changing a threshold means editing that machine's agent config and restarting it.

## 6. TLS for the MQTT broker
- **Description:** Enable TLS on Mosquitto with certificates and make agents and the app verify it.
- **Value:** Safe use over untrusted networks and the internet.
- **Consequence of not doing it:** Credentials and readings travel unencrypted, so the broker must stay on a trusted LAN/VPN.

## 7. Viewer-driven fast live mode
- **Description:** While a browser has a host open, have the app send `check` requests every few seconds so charts move faster than the 5-minute heartbeat; stop when the last viewer leaves.
- **Value:** Near-real-time charts when someone is watching.
- **Consequence of not doing it:** Between heartbeats the dashboard only changes on events or when Check now is clicked.

## 8. Agent reports broker-side rejections
- **Description:** Use MQTT 5 (reason codes on publish acknowledgements) so an agent learns when the broker drops its messages for ACL reasons; today it only warns at startup if `MQTT_USERNAME` differs from `HOST_ID`.
- **Value:** A misconfigured agent fails loudly instead of silently showing no data.
- **Consequence of not doing it:** Other ACL or credential mix-ups still look like "connected but nothing arrives".
