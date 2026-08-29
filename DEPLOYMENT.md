# VPS deployment

The application is a single Docker service: the Fastify process serves the React build, public API, ActivityPub endpoints, delivery worker, SQLite database, and a read-only bare Git cache. Caddy remains the public TLS boundary.

## Preconditions

- Choose a stable public origin. ActivityPub object and actor IDs must not move after federation begins.
- Create the corresponding DNS record before starting federation.
- Inspect the live Caddyfile; do not assume the example matches current routing.
- Confirm a recent Hostinger backup.

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

Edit `PUBLIC_ORIGIN`, `ACTOR_NAME`, and `ACTOR_DISPLAY_NAME`. The `.env` file must not be committed.

Leave `VERIFY_GIT_ON_PUBLISH=true` in production. `GIT_TIMEOUT_MS` and `GIT_MAX_PACK_BYTES` bound each fetch; the defaults are 60 seconds and 200 MiB. The container includes Git, disables hooks and submodule traversal, and accepts only public HTTPS repository URLs.

## Validate locally on the VPS

```sh
docker compose build
docker compose up -d
docker compose ps
curl -fsS http://127.0.0.1:8787/api/health
```

Inspect the live Caddy configuration, merge the `Caddyfile.example` site deliberately, then validate before reloading:

```sh
caddy validate --config /etc/caddy/Caddyfile && systemctl reload caddy
```

## Federation checks

Replace the host and actor name with the configured values:

```sh
curl -fsS 'https://ideas.proximitytoprogress.com/.well-known/webfinger?resource=acct%3Aideas%40ideas.proximitytoprogress.com'
curl -fsS -H 'Accept: application/activity+json' 'https://ideas.proximitytoprogress.com/ap/actors/ideas'
curl -fsS -H 'Accept: application/activity+json' 'https://ideas.proximitytoprogress.com/ap/actors/ideas/outbox'
```

Then search for `@ideas@ideas.proximitytoprogress.com` from a separate Fediverse server and follow it. Confirm the follower and delivery state through the authenticated `/api/admin/federation` endpoint.

## Backup and rollback

The named volume `irap_data` contains the SQLite database, ActivityPub RSA private key, and Git cache. Losing the cache is recoverable; losing the database changes the actor's cryptographic identity and publication history.

Create a consistent backup with SQLite's online backup command inside a temporary container or stop the service briefly before copying the volume. Never copy only the main `.sqlite` file while WAL writes may be in flight.

Application rollback is image-level: retain the previous image tag, restore it in `compose.yaml`, and run `docker compose up -d`. Database schema v0.2 is additive and does not currently include a down migration.

## Current federation boundary

The service supports WebFinger, NodeInfo, an Application actor, public outbox and followers collection, RSA-SHA256 legacy HTTP signatures, signed inboxes, automatic Follow acceptance, Undo/Delete follower removal, public Create delivery, a durable retry queue, and guarded remote-actor resolution.

It deliberately does not yet claim full social-server compatibility: RFC 9421 message signatures, replies, likes, boosts, moderation UI, blocklists, multi-user accounts, media upload, and ActivityPub conformance-suite certification remain later work.
