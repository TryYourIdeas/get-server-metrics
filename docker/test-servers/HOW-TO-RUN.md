# How to run the multi-server agent tests

Starts the agent in six throwaway containers (Debian 12, Ubuntu 24.04, Fedora 41, Alpine 3.20, Debian + Node 24, and one forced to raise a disk alert) and checks that each one reaches the MQTT broker and reports CPU/memory/disk readings.

It only tests the agent. It does not need Node.js on your machine and does not touch the dashboard or event monitor.

## Requirements

- Linux or macOS with Docker and Docker Compose v2 (`docker compose version` must work).
- bash.
- Free ports **1883** (MQTT broker) and **5433** (Postgres). Check with `ss -ltn | grep -E ':(1883|5433)\b'` and `docker ps`.
- Internet access on the first run (pulls six base images).

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

The script first creates the broker user `app` (`docker/mosquitto/add-user.sh app "$APP_PASSWORD"`; `docker/mosquitto/passwd` is not in git, so each machine creates its own). The first run takes several minutes while images are built. The script also creates a broker user per test agent, starts the containers and listens on the broker for 45 seconds.

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
```

A `FAIL` line names the host and the reason (never came online, no heartbeat, no memory reading, no disk). The script exits non-zero if anything failed.

### 5. Clean up

```bash
docker/test-servers/run.sh down
```

Removes the test agent containers and their volume. The broker and Postgres keep running; stop them with `docker compose down`.

## Useful commands

```bash
docker/test-servers/run.sh up                 # build and start only
docker/test-servers/run.sh verify             # check again (needs both variables)
WAIT_SECONDS=90 docker/test-servers/run.sh verify   # listen longer

# logs of one agent (debug tracing is on)
docker compose -f docker-compose.yml -f docker-compose.test-servers.yml logs agent-alpine
```

Variables: `APP_PASSWORD` and `TEST_AGENT_PASSWORD` (both required except for `down`), `WAIT_SECONDS` (default `45`).

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `permission denied ... /var/run/docker.sock` | Run `sudo usermod -aG docker $USER`, then log out and back in. |
| `mounts denied ... is not shared from the host` | Docker Desktop file sharing, see step 1. |
| `error mounting ... mosquitto.conf ... not a directory`, or `docker/mosquitto/passwd` is a directory | A failed broker start made Docker create a directory in place of the file. Run `docker rm computer-usage-mqtt computer-usage-db`, remove the directory (`sudo rm -rf docker/mosquitto/passwd`) and re-run the test (step 3). |
| `port is already allocated` (1883 or 5433) | Another container or service uses the port (a local Mosquitto, for example). Stop it first. |
| `ERROR: ... is not set` | Export both variables (step 2) in the same shell. |
| `FAIL ... never reported online` | Wrong app/agent password, or the agent could not start. Check that agent's logs. |
| All hosts fail but the build worked | The broker may not have loaded the new users: `docker compose restart mosquitto`, then `run.sh verify`. |
| `FAIL ... no disk` | Normally never happens, each container mounts a volume on `/data`. Send the agent's logs to the project owner. |

## Notes

- The agent ignores overlay filesystems on purpose, which is what a container's own root disk is. That is why each test container mounts a volume on `/data`.
- Containers report the host machine's memory, not a container limit.
- The test containers run as root and exist only for local testing.
