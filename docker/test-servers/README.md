# Testing the agent on different servers

`docker-compose.test-servers.yml` starts the agent in six throwaway containers (Debian 12, Ubuntu 24.04, Fedora 41, Alpine 3.20, Debian + Node 24, and one forced to raise a disk alert), plus the event monitor and the dashboard, and `run.sh` checks that the data arrives at the broker, is saved in Postgres and is listed by the dashboard.

Step-by-step instructions, expected output and troubleshooting are in [HOW-TO-RUN.md](HOW-TO-RUN.md). In short:

```bash
export APP_PASSWORD='<choose>' TEST_AGENT_PASSWORD='<choose>'
docker/test-servers/run.sh          # then open http://localhost:3000
docker/test-servers/run.sh down     # clean up
```

| File | Purpose |
|---|---|
| `run.sh` | `up`, `verify` and `down` for the whole test stack. |
| `run-with-monitor.sh` | Same, but runs the event monitor and dashboard on your machine with npm. |
| `Dockerfile` | The agent on a given Linux distribution (build args `BASE_IMAGE`, `NODE_IMAGE`, `PKG_MANAGER`). |
| `Dockerfile.event-monitor`, `Dockerfile.dashboard` | The event monitor and the dashboard as images. |
