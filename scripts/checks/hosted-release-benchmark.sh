#!/usr/bin/env bash
# Start an isolated loopback login and the built application for the hosted live gate.
set -euo pipefail
[[ "${GITHUB_ACTIONS:-}" == true && "${SHOPGATE_EVAL_TRIGGER:-}" == release ]]
[[ "${DATABASE_URL:-}" == *@127.0.0.1:35433/shopgate\?schema=public ]]
: "${DEEPSEEK_API_KEY:?release model credential missing}"
export BETTER_AUTH_URL=http://127.0.0.1:3000
export NEXT_PUBLIC_APP_URL="$BETTER_AUTH_URL"
export SHOPGATE_AUTH_TRUSTED_ORIGINS="$BETTER_AUTH_URL"
export SHOPGATE_AUTH_SECURE_COOKIES=0
export SHOPGATE_AUTH_ADMIN_EMAIL=release-check@shopgate.invalid
SHOPGATE_AUTH_ADMIN_PASSWORD="$(openssl rand -hex 24)Aa1!"
BETTER_AUTH_SECRET="$(openssl rand -hex 32)"
export SHOPGATE_AUTH_ADMIN_PASSWORD BETTER_AUTH_SECRET
export SHOPGATE_AUTH_MODE=local
export PI_AGENT_DISPATCH_MODE=worker
# This isolated job provisions the commerce API, database and cache only.
export SHOPGATE_MEMORY_ENABLED=0
export SHOPGATE_KNOWLEDGE_ENABLED=0
export SHOPGATE_GENERATED_SANDBOX=1
mkdir -p tmp
env -u DEEPSEEK_API_KEY npm run auth:bootstrap
node node_modules/next/dist/bin/next start --hostname 127.0.0.1 --port 3000 >tmp/release-web.log 2>&1 &
web_pid=$!
worker_pid=''
cleanup() {
  kill "$web_pid" 2>/dev/null || true
  if [[ -n "$worker_pid" ]]; then kill "$worker_pid" 2>/dev/null || true; fi
  wait "$web_pid" 2>/dev/null || true
  if [[ -n "$worker_pid" ]]; then wait "$worker_pid" 2>/dev/null || true; fi
}
trap cleanup EXIT
node --import tsx scripts/workers/generation-worker.ts >tmp/release-worker.log 2>&1 &
worker_pid=$!
for ((attempt=0; attempt<60; attempt++)); do
  kill -0 "$web_pid" "$worker_pid"
  if curl -fsS --max-time 2 "$BETTER_AUTH_URL/api/health" >/dev/null; then
    env -u DEEPSEEK_API_KEY npm "$@"
    exit 0
  fi
  sleep 2
done
echo 'Release web or worker did not become ready' >&2
exit 1
