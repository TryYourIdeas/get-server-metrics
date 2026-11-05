# Testing the agent on different servers

This starts the `agent` in six throwaway containers (Debian 12, Ubuntu 24.04, Fedora 41, Alpine 3.20, Debian + Node 24, and one that is forced to raise a disk alert) and checks that each one reaches the MQTT broker and reports CPU/memory/disk readings.

It only tests the agent. It does not need Node.js installed on your machine and does not touch the dashboard or event monitor.

## What you need

- Linux or macOS with **Docker** and **Docker Compose v2** (`docker compose version` must work).
- `bash`.
- Free ports **1883** (MQTT broker) and **5433** (Postgres). Stop anything else using them, for example an old Mosquitto or Postgres container: `docker ps` shows what is running.
- An internet connection for the first run (it pulls six base images).

## Steps

Run everything from the `computer-usage` folder.

### 1. Make sure Docker can see the project folder

Only if you use **Docker Desktop** and the project is outside your home folder (for example under `/media/...` or `/mnt/...`): open *Settings → Resources → File sharing*, add the folder that contains the project, click *Apply & restart*, then check:

```bash
docker run --rm -v "$PWD/docker/mosquitto:/m" alpine ls /m
```

It must list `acl`, `mosquitto.conf` and `add-user.sh` (and `passwd` once you have created it). If the folder looks empty, Docker cannot see the project and the broker will fail to start; move the project under your home folder instead.

### 2. Create the broker user for the test

The broker rejects anonymous connections. Create the `app` user, which the test uses to listen to the agents. Pick any password and remember it:

```bash
docker/mosquitto/add-user.sh app <choose-a-password>
```

(`docker/mosquitto/passwd` is not in git, so every machine creates its own. The `chmod`/`chown` warnings this prints are harmless.)

### 3. Run the test

```bash
APP_PASSWORD=<the-password-from-step-2> docker/test-servers/run.sh
```

The first run takes several minutes while images are built. The script then creates a broker user for each test agent, starts the containers and listens on the broker for 45 seconds.

### 4. Read the result

All good looks like this:

```
ok    test-debian12
ok    test-ubuntu2404
ok    test-fedora
ok    test-alpine
ok    test-node24
ok    test-alert
ok    test-alert published an alert event
```

A line starting with `FAIL` names the host and the reason (never came online, no heartbeat, no memory reading, no disk). The script exits with an error code if anything failed.

### 5. Clean up

```bash
docker/test-servers/run.sh down
```

This removes the test agent containers and their volume. The broker and Postgres from `docker-compose.yml` keep running; stop them with `docker compose down` if you do not need them.

## Useful commands

```bash
docker/test-servers/run.sh up        # build and start only
APP_PASSWORD=... docker/test-servers/run.sh verify   # check again
WAIT_SECONDS=90 APP_PASSWORD=... docker/test-servers/run.sh verify   # listen longer

# logs of one agent (debug tracing is on)
docker compose -f docker-compose.yml -f docker-compose.test-servers.yml logs agent-alpine
```

Optional variables: `TEST_AGENT_PASSWORD` (broker password for the `test-*` agents, default `test-agents-pw`) and `WAIT_SECONDS` (default 45).

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `permission denied ... /var/run/docker.sock` | Your user cannot use Docker. Run `sudo usermod -aG docker $USER`, then log out and back in. |
| `mounts denied ... is not shared from the host` | Docker Desktop file sharing, see step 1. |
| `error mounting ... mosquitto.conf ... not a directory` | A broker container left over from an earlier failed start. Run `docker rm computer-usage-mqtt computer-usage-db` and try again. |
| `port is already allocated` (1883 or 5433) | Another container or service uses the port. Stop it first. |
| `set APP_PASSWORD ...` | Run the script as shown in step 3, with `APP_PASSWORD=...` in front. |
| `FAIL ... never reported online` | Wrong `app` password, or the agent could not start. Check that agent's logs (command above). |
| All hosts fail but the build worked | The broker may not have loaded the new users. Run `docker compose restart mosquitto` and `run.sh verify`. |
| `FAIL ... no disk` | Normally never happens, because each container mounts a volume on `/data`. If it does, send the agent's logs to the project owner. |

## Notes

- The agent ignores `overlay` filesystems on purpose, which is what a container's own root disk is. That is why each test container mounts a volume on `/data`.
- Containers report the host machine's memory, not a container limit.
- The test containers run as root and exist only for local testing.
