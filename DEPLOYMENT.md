# VPS deployment

The application is a single Docker service sized comfortably for the documented 2-vCPU/8-GB Hostinger VPS: the Fastify process serves the React build, IRAP registry API, ActivityPub endpoints, delivery worker, SQLite database, artifact verifier, and a read-only bare Git cache. Caddy remains the public TLS boundary.

## Preconditions

- Choose a stable public origin. ActivityPub object and actor IDs must not move after federation begins.
- Create the corresponding DNS record before starting federation.
- Inspect the live Caddyfile; do not assume the example matches current routing.
- Confirm a recent Hostinger backup.
- Run the VPS runbook's discovery commands. Its captured state can age; the live Caddyfile, Docker containers, Compose projects, port bindings, and DNS are authoritative.
- Confirm `ideas.proximitytoprogress.com` resolves to the VPS. Do not assume the optional wildcard record exists.

## Configure

On the VPS, copy the repository to a dedicated directory such as `/srv/irap-publisher`, then:

```sh
cp .env.example .env
```

Generate an administrator token without placing it in shell history:

```sh
sed -i '/^ADMIN_TOKEN=/d' .env
umask 077 && openssl rand -base64 36 > /tmp/irap-admin-token && printf 'ADMIN_TOKEN=' >> .env && tr -d '\n' < /tmp/irap-admin-token >> .env && printf '\n' >> .env && rm /tmp/irap-admin-token
```

Edit `PUBLIC_ORIGIN`, `ACTOR_NAME`, and `ACTOR_DISPLAY_NAME`. The reference registry uses `ACTOR_NAME=registry`, producing `@registry@ideas.proximitytoprogress.com`. The `.env` file must not be committed.

Leave `VERIFY_GIT_ON_PUBLISH=true` and `VERIFY_ARTIFACTS_ON_SUBMIT=true` in production. Git fetches default to 60 seconds/200 MiB. Artifact fetches default to 15 seconds/10 MiB, stream through the size boundary, reject redirects, and accept only public HTTPS targets. A fetch failure keeps the rendering but marks its digest unverified; a completed mismatch becomes a severe visible state.

## Versioned deployment workflow

From a clean local checkout:

```sh
./deploy-vps.sh preflight
```

This runs tests, both builds, dependency audit, Compose validation, and read-only discovery over SSH. It also creates one filtered release payload, verifies required source files inside it, and performs an uncached Docker build from that exact payload. The upload mode transfers the same staged bytes, preventing local and remote build contexts from diverging. Preflight does not change the VPS.

To transfer the exact committed release:

```sh
./deploy-vps.sh upload
```

Releases are uploaded beneath `/srv/irap-publisher/releases/<commit>` and `/srv/irap-publisher/current` points to the selected release. Runtime identity remains in the explicitly named `irap_data` Docker volume. The first upload creates `/srv/irap-publisher/shared/.env` with mode `0600` and stops before starting the service. Edit that file, then rerun the upload command.

## Validate on the VPS

```sh
cd /srv/irap-publisher/current
docker compose up -d --build
docker compose ps
curl -fsS http://127.0.0.1:8787/api/health
```

After a release starts, its deployment manifest and recursively hashed site assets are verified and retained beneath `/app/data/artifacts/<implementation-commit>`. This append-only snapshot remains available after future releases.

Inspect the live Caddy configuration, merge the `Caddyfile.example` site deliberately, then validate before reloading:

```sh
caddy validate --config /etc/caddy/Caddyfile && systemctl reload caddy
```

## Federation checks

Replace the host and actor name with the configured values:

```sh
curl -fsS 'https://ideas.proximitytoprogress.com/.well-known/webfinger?resource=acct%3Aregistry%40ideas.proximitytoprogress.com'
curl -fsS -H 'Accept: application/activity+json' 'https://ideas.proximitytoprogress.com/ap/actors/registry'
curl -fsS -H 'Accept: application/activity+json' 'https://ideas.proximitytoprogress.com/ap/actors/registry/outbox'
```

Then search for `@registry@ideas.proximitytoprogress.com` from a separate Fediverse server and follow it. Confirm the follower and delivery state through the authenticated `/api/admin/federation` endpoint.

Publish the canonical IRAP idea and this exact deployment rendering without exposing the administrator token outside the container:

```sh
docker compose exec irap npm run cli -- publish-reference
```

For any other Git-pinned idea, use the generic bundle workflow. Review the JSON dry-run
before using `--apply`; neither command prints the administrator token:

```sh
docker compose exec -T irap npm run cli -- publish-bundle \
  --repository https://github.com/uncomposed/spoken-margins-idea.git \
  --revision 6af9d8155bdda8260d000383713a78ab17fb4f75 \
  --dry-run
```

See [`PUBLICATION_BUNDLES.md`](./PUBLICATION_BUNDLES.md) for the contract, conflict
rules, and apply command.

The command is idempotent: an existing idea/rendering must match the pinned commits and deterministic rendering URI or it fails closed.

## Backup and rollback

The named volume `irap_data` contains the SQLite database, ActivityPub RSA private key, and Git cache. Losing the cache is recoverable; losing the database changes the actor's cryptographic identity and publication history.

Create a consistent backup with SQLite's online backup API:

```sh
cd /srv/irap-publisher/current
docker compose exec irap npm run cli -- backup
```

The command prints the backup path beneath `/app/data/backups`. Copy that file off the VPS and record its checksum. Never copy only the live main `.sqlite` file while WAL writes may be in flight.

Re-run all derived attestation results without rewriting raw signed records:

```sh
docker compose exec irap npm run cli -- verify-all
```

Resolve each idea's canonical ref and add new current states without touching historical rendering targets:

```sh
docker compose exec irap npm run cli -- sync
```

Application rollback is release-level: repoint `/srv/irap-publisher/current` to the previous committed release and run `docker compose up -d --build`. Database schema changes are additive and do not currently include a down migration; take an online backup before advancing versions.

## Current federation boundary

The service supports WebFinger, NodeInfo, an Application actor, public outbox and followers collection, RSA-SHA256 legacy HTTP signatures, signed inboxes, automatic Follow acceptance, Undo/Delete follower removal, public Create delivery, a durable retry queue, and guarded remote-actor resolution.

It deliberately does not yet claim full social-server compatibility: RFC 9421 message signatures, replies, likes, boosts, moderation UI, blocklists, multi-user accounts, media upload, and ActivityPub conformance-suite certification remain later work.
