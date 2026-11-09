# How to run the multi-server agent tests

Starts the agent in six throwaway containers (Debian 12, Ubuntu 24.04, Fedora 41, Alpine 3.20, Debian + Node 24, and one forced to raise a disk alert) and follows their data all the way through:

1. each agent reaches the MQTT broker and reports CPU/memory/disk readings,
2. the **event monitor** (also started in a container) saves those readings in Postgres,
3. the **dashboard** (also a container) lists the hosts, so you can open it and see the graphs.

It does not need Node.js on your machine; everything runs in Docker. (If you prefer to run the event monitor and dashboard on your machine with npm instead, use `run-with-monitor.sh`, see the end of this guide.)

## Requirements

- Linux or macOS with Docker and Docker Compose v2 (`docker compose version` must work).
- bash.
- Free ports **1883** (MQTT broker), **5433** (Postgres) and **3000** (dashboard; set `DASHBOARD_PORT` to use another one). Check with `ss -ltn | grep -E ':(1883|3000|5433)\b'` and `docker ps`. Stop any dashboard started with `npm run dev`, and any event monitor you run yourself (`npm run monitor`) against the same broker: it uses the same MQTT client id as the test's monitor and the two would kick each other off.
- Internet access on the first run (pulls the base images and builds the dashboard, which takes a few minutes).

Run every command from the project root (the folder containing `docker-compose.yml`).

## Steps

### 1. Make sure Docker can see the project folder

Only for Docker Desktop with the project outside your home folder (e.g. under `/media/...` or `/mnt/...`): Settings → Resources → File sharing, add the folder, Apply & restart. Then check:

```bash
docker run --rm -v "$PWD/docker/mosquitto:/m" alpine ls /m
```

It must list `acl`, `mosquitto.conf` and `add-user.sh`.

### 2. Set the passwords

```bash
export APP_PASSWORD='<choose-a-password>'          # broker user "app", used by the test to listen
export TEST_AGENT_PASSWORD='<choose-a-password>'   # password for the test-* agents
```

Both are required: `run.sh` prints a help message and exits if either is missing (except for `down`).

### 3. Run the test

```bash
docker/test-servers/run.sh
```

The script first creates the broker user `app` (`docker/mosquitto/add-user.sh app "$APP_PASSWORD"`; `docker/mosquitto/passwd` is not in git, so each machine creates its own). The first run takes several minutes while images are built. The script also creates a broker user per test agent, starts the agents, the event monitor and the dashboard, listens on the broker for 45 seconds, and then checks the database and the dashboard.

### 4. Read the result

All good:

```
ok    test-debian12
ok    test-ubuntu2404
ok    test-fedora
ok    test-alpine
ok    test-node24
ok    test-alert
ok    test-alert published an alert event
Checking the database...
ok    test-debian12: 5 samples saved
...
ok    test-alert: alert event saved
Checking the dashboard...
ok    dashboard lists test-debian12
...
Checking threshold changes...
ok    lowering test-debian12's disk threshold raised an alert
ok    removing the override recovered the alert
ok    the retained config for test-debian12 holds the default again
ok    agents cannot publish config messages

All good. Open the dashboard: http://localhost:3000
```

A `FAIL` line names the host and the reason (never came online, no heartbeat, no memory reading, no disk, nothing saved in the database, not listed by the dashboard, a threshold change that did not reach the agent, or an agent that was able to publish a config message). The script exits non-zero if anything failed.

### 5. Look at the graphs

Open <http://localhost:3000>. The **All servers** view shows the six `test-*` hosts as cards, with live CPU, memory and disk readings (a new reading every 10 seconds). Pick a machine for its charts, and use **Triggers** to change thresholds. `test-alert` also shows a disk alert.

### 6. Clean up

```bash
docker/test-servers/run.sh down
```

Removes the test containers (agents, event monitor, dashboard) and their volume, and deletes the `test-*` hosts' samples and events from the database (other hosts' data is not touched). The broker and Postgres keep running; stop them with `docker compose down`. Skip `down` if you want to keep looking at the graphs.

## Useful commands

```bash
docker/test-servers/run.sh up                 # build and start only
docker/test-servers/run.sh verify             # check again (needs both variables)
WAIT_SECONDS=90 docker/test-servers/run.sh verify   # listen longer

# logs of one agent (debug tracing is on)
docker compose -f docker-compose.yml -f docker-compose.test-servers.yml logs agent-alpine
```

Variables: `APP_PASSWORD` and `TEST_AGENT_PASSWORD` (both required except for `down`), `WAIT_SECONDS` (default `45`), `DASHBOARD_PORT` (default `3000`) and `SKIP_APPS=1` (do not start the event monitor and dashboard containers; `verify` then skips the database and dashboard checks).

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `permission denied ... /var/run/docker.sock` | Run `sudo usermod -aG docker $USER`, then log out and back in. |
| `mounts denied ... is not shared from the host` | Docker Desktop file sharing, see step 1. |
| `error mounting ... mosquitto.conf ... not a directory`, or `docker/mosquitto/passwd` is a directory | A failed broker start made Docker create a directory in place of the file. Run `docker rm computer-usage-mqtt computer-usage-db`, remove the directory (`sudo rm -rf docker/mosquitto/passwd`) and re-run the test (step 3). |
| `port is already allocated` (1883 or 5433) | Another container or service uses the port (a local Mosquitto, for example). Stop it first. |
| `ERROR: ... is not set` | Export both variables (step 2) in the same shell. |
| `FAIL ... never reported online` | Wrong app/agent password, or the agent could not start. Check that agent's logs. |
| `FAIL ... nothing saved in the database` but the agents are `ok` | The event monitor is not storing data, usually because `APP_PASSWORD` differs from the one the `app` broker user was created with. Check `docker compose -f docker-compose.yml -f docker-compose.test-servers.yml logs event-monitor`. |
| `FAIL dashboard: no answer` | The dashboard is still starting or its port is taken. Check `logs dashboard` and run `run.sh verify` again. |
| `FAIL dashboard: event monitor is not connected to the broker` | Wrong `APP_PASSWORD`, or another monitor uses the same MQTT client id. |
| `port is already allocated`/`address already in use` right after a successful run, with two Docker engines installed | The test stack is already running on the other engine (check `docker context ls`; Docker Desktop and the native engine do not share containers). Run the commands against the engine that runs the stack, e.g. `DOCKER_CONTEXT=default docker/test-servers/run.sh verify`. |
| All hosts fail but the build worked | The broker may not have loaded the new users: `docker compose restart mosquitto`, then `run.sh verify`. |
| `FAIL ... no disk` | Normally never happens, each container mounts a volume on `/data`. Send the agent's logs to the project owner. |

## Notes

- The agent ignores overlay filesystems on purpose, which is what a container's own root disk is. That is why each test container mounts a volume on `/data`.
- Containers report the host machine's memory, not a container limit.
- The test containers run as root and exist only for local testing.
- The event monitor and dashboard talk to each other with a fixed test token (`test-monitor-token`) and Postgres uses the default `postgres`/`postgres` credentials from `docker-compose.yml`, so do not expose these ports beyond your own machine.

## Running the monitor and dashboard on your machine instead

`docker/test-servers/run-with-monitor.sh` does the same as `run.sh up` but runs the event monitor and the Nuxt dashboard (dev server) on your machine with npm (needs Node.js and `npm install` at the project root). It starts `run.sh` with `SKIP_APPS=1` so the container versions do not clash with it. Press Ctrl-C to stop them, and `run.sh down` to remove the containers.
