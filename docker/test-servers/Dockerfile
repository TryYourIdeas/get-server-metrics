# Throwaway image that runs the agent on a given Linux distribution, to check it works on different servers.
#
# The agent shells out to OS tools (via systeminformation), so the final stage is the distribution under
# test. Node itself is copied in from an official node image of the matching libc (glibc or musl), and the
# dependencies are installed there, so the distribution only needs the system packages the agent reads from.
ARG NODE_IMAGE=node:22-bookworm-slim
ARG BASE_IMAGE=debian:12-slim

FROM ${NODE_IMAGE} AS build
WORKDIR /app
COPY agent/package.json agent/package-lock.json ./
RUN npm ci
COPY agent/tsconfig.json ./
COPY agent/src ./src

FROM ${BASE_IMAGE}
# apt | dnf | apk
ARG PKG_MANAGER=apt
RUN case "$PKG_MANAGER" in \
      apt) apt-get update \
           && apt-get install -y --no-install-recommends ca-certificates procps util-linux \
           && rm -rf /var/lib/apt/lists/* ;; \
      dnf) dnf install -y procps-ng util-linux && dnf clean all ;; \
      apk) apk add --no-cache libstdc++ procps util-linux ;; \
      *) echo "unknown PKG_MANAGER $PKG_MANAGER" >&2; exit 1 ;; \
    esac
COPY --from=build /usr/local/bin/node /usr/local/bin/node
COPY --from=build /app /app
WORKDIR /app
# Runs as root on purpose: this image is only for local compatibility tests, never deployed.
CMD ["node", "--import", "tsx", "src/cli.ts"]
