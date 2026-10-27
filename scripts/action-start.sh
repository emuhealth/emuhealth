#!/usr/bin/env bash
# Starts emuhealth in the background for the GitHub Action (action.yml), waits until it is ready, and exports
# EMUHEALTH_<SERVICE>_URL for each service plus a `urls` JSON output.
set -euo pipefail

command="${EMUHEALTH_COMMAND:-}"
[ -n "$command" ] || command="npx --yes emuhealth@${EMUHEALTH_VERSION:-latest}"
args=(start --service "$EMUHEALTH_SERVICES" --port "${EMUHEALTH_PORT:-4000}")
[ -n "${EMUHEALTH_CONFIG:-}" ] && args+=(--config "$EMUHEALTH_CONFIG")

log="${RUNNER_TEMP:-/tmp}/emuhealth.log"
# shellcheck disable=SC2086
nohup $command "${args[@]}" > "$log" 2>&1 &
pid=$!

deadline=$((SECONDS + ${EMUHEALTH_TIMEOUT:-120}))
until grep -q "Ready\." "$log" 2>/dev/null; do
  if ! kill -0 "$pid" 2>/dev/null || [ "$SECONDS" -ge "$deadline" ]; then
    echo "emuhealth did not start:"
    cat "$log"
    exit 1
  fi
  sleep 1
done
cat "$log"

# Banner lines look like "  fhir  http://localhost:4100".
json="{"
while read -r name url; do
  var="EMUHEALTH_$(echo "$name" | tr '[:lower:]-' '[:upper:]_')_URL"
  echo "$var=$url" >> "${GITHUB_ENV:-/dev/null}"
  echo "$var=$url"
  json="$json\"$name\":\"$url\","
done < <(grep -E '^  [a-z0-9-]+  https?://' "$log" | awk '{print $1, $2}')
json="${json%,}}"
echo "urls=$json" >> "${GITHUB_OUTPUT:-/dev/null}"
echo "EMUHEALTH_PID=$pid" >> "${GITHUB_ENV:-/dev/null}"
