#!/usr/bin/env bash
# Usage: docker/mosquitto/add-user.sh <username> <password>
# Adds or updates a broker user. For agents the username must equal the agent's HOST_ID.
# Uses `docker cp` instead of a bind mount so it also works where Docker cannot mount this folder.
set -euo pipefail
[ $# -eq 2 ] || { echo "usage: $0 <username> <password>" >&2; exit 1; }
dir="$(cd "$(dirname "$0")" && pwd)"
flags=(-b)
[ -s "$dir/passwd" ] || flags=(-c -b) # first user: create the file
cid=$(docker create eclipse-mosquitto:2 mosquitto_passwd "${flags[@]}" /tmp/passwd "$1" "$2")
trap 'docker rm -f "$cid" >/dev/null' EXIT
if [ -s "$dir/passwd" ]; then docker cp "$dir/passwd" "$cid:/tmp/passwd"; fi
docker start -a "$cid" >/dev/null
docker cp "$cid:/tmp/passwd" "$dir/passwd"
chmod 0644 "$dir/passwd"
echo "user '$1' saved in $dir/passwd; restart the broker: docker compose restart mosquitto"
