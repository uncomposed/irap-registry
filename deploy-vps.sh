#!/usr/bin/env bash
set -Eeuo pipefail

mode="${1:-preflight}"
vps_host="${IRAP_VPS_HOST:-root@72.60.117.194}"
remote_root="${IRAP_REMOTE_ROOT:-/srv/irap-publisher}"
project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [[ "$mode" != "preflight" && "$mode" != "upload" ]]; then
  echo "Usage: ./deploy-vps.sh [preflight|upload]" >&2
  exit 2
fi

cd "$project_root"
for command in git npm docker ssh rsync; do
  command -v "$command" >/dev/null || { echo "Missing required command: $command" >&2; exit 1; }
done

if [[ -n "$(git status --porcelain)" ]]; then
  echo "Refusing deployment from a dirty Git worktree." >&2
  exit 1
fi

release_commit="$(git rev-parse HEAD)"
release_dir="$remote_root/releases/$release_commit"
export IRAP_IMPLEMENTATION_COMMIT="$release_commit"

echo "Running local release gates for $release_commit"
npm test
npm run build
npm audit --audit-level=high
docker compose config --quiet
docker compose build

echo "Inspecting the VPS without changing it"
ssh "$vps_host" "set -eu; systemctl is-active caddy; systemctl is-active docker; docker ps --format 'table {{.Names}}\t{{.Image}}\t{{.Ports}}'; test -r /etc/caddy/Caddyfile; grep -n 'ideas.proximitytoprogress.com' /etc/caddy/Caddyfile || true"

if [[ "$mode" == "preflight" ]]; then
  echo "Preflight complete. Run ./deploy-vps.sh upload when ready to transfer this exact commit."
  exit 0
fi

echo "Uploading the exact release to $vps_host:$release_dir"
ssh "$vps_host" "set -eu; install -d -m 0755 '$remote_root/releases' '$release_dir'; install -d -m 0700 '$remote_root/shared'"
rsync -az --delete \
  --exclude='.git/' \
  --exclude='.env' \
  --exclude='data/' \
  --exclude='dist/' \
  --exclude='server-dist/' \
  --exclude='node_modules/' \
  --exclude='release/' \
  ./ "$vps_host:$release_dir/"

ssh "$vps_host" "set -eu; printf '%s\n' '$release_commit' > '$release_dir/RELEASE_COMMIT'; if test ! -f '$remote_root/shared/.env'; then cp '$release_dir/.env.example' '$remote_root/shared/.env'; chmod 0600 '$remote_root/shared/.env'; echo 'Created the production environment template at $remote_root/shared/.env.'; echo 'Edit it, then rerun ./deploy-vps.sh upload.'; exit 20; fi; ln -sfn '$remote_root/shared/.env' '$release_dir/.env'; ln -sfn '$release_dir' '$remote_root/current'; cd '$remote_root/current'; IRAP_IMPLEMENTATION_COMMIT='$release_commit' docker compose up -d --build; for attempt in 1 2 3 4 5 6 7 8 9 10; do curl -fsS http://127.0.0.1:8787/api/health && exit 0; sleep 2; done; docker compose logs --tail=80; exit 1"

echo "Container health passed on loopback. Caddy has not been modified."
echo "Inspect /etc/caddy/Caddyfile, merge Caddyfile.example, validate, reload, and run the public checks in DEPLOYMENT.md."
