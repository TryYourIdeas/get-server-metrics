# Pending tasks

## 2. Downsampling for the 7d chart
- **Description:** Return bucketed averages instead of every raw sample for long ranges.
- **Value:** Smaller responses and faster charts.
- **Consequence of not doing it:** The 7d range returns ~10,000 points (each with its disks) per request and refresh.

## 3. Per-disk history selection
- **Description:** Let the user choose which disk the history chart shows.
- **Value:** History for every disk, not only the first.
- **Consequence of not doing it:** Only the first disk's history is charted (all disks still appear in the live gauges and in the database).

## 4. Multiple machines
- **Description:** Agents on other computers push samples to a central database; dashboard filters by host.
- **Value:** Monitor a fleet from one place.
- **Consequence of not doing it:** Only the machine running the app is monitored.

## 5. Alerting / thresholds
- **Description:** Notify when CPU, memory or disk usage stays above a threshold.
- **Value:** Problems are noticed without watching the dashboard.
- **Consequence of not doing it:** Issues are only visible by opening the dashboard or querying the database.

## 6. Running the app itself in Docker
- **Description:** Containerize the Nuxt app with host mounts so it sees host disks.
- **Value:** One-command deployment.
- **Consequence of not doing it:** The app runs on the host via `npm run dev`; only Postgres is containerized.

## 7. Sampling stops while the app is down
- **Description:** Consider a separate collector process (rejected for now, see ADR 0006).
- **Value:** Continuous data even when the UI restarts.
- **Consequence of not doing it:** Gaps in history whenever the app is stopped.

## 8. Hardening from the final review
- **Description:** (a) show a visible error on the dashboard when `/api/metrics/history` fails instead of the empty-state text; (b) add a `pool.on('error')` listener, end the pool on shutdown and set pg connection/statement timeouts; (c) time-bound `collect`/`save` and log skipped ticks above debug level so a hung tick is visible in production; (d) include the failing step (`collect`/`save`) in tick error logs; (e) make `/api/metrics/current` return the sampler's last reading, because dashboard refreshes reset systeminformation's CPU measurement window; (f) store a missing CPU reading as NULL/skip the tick instead of 0%; (g) anchor chart x-axes to the selected range and break lines across gaps; (h) resolve the migrations folder independent of the working directory for `.output` runs.
- **Value:** Failures become visible and the charts stop suggesting data that does not exist.
- **Consequence of not doing it:** A database outage looks like "not enough data yet", a hung collector silently stops sampling, stored CPU can be noisy while the dashboard is open, and gaps/short histories are drawn misleadingly.
