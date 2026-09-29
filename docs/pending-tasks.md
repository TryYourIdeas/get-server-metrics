# Pending tasks

## 1. Data retention / pruning
- **Description:** Delete or aggregate samples older than a configurable age.
- **Value:** Keeps the database size bounded.
- **Consequence of not doing it:** `samples` grows ~1,440 rows/day plus disk rows; disk use and the 7d query slowly increase without limit.

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
