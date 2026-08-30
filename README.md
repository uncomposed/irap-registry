# IRAP Publisher

A deployable Idea Rendering Attestation Protocol registry: exact Git-state importing, external rendering registration, attributable Ed25519 verification, historical-policy recognition, and optional ActivityPub distribution.

The product distinguishes IRAP authority from federation transport. Git commits and signed attestations remain authoritative; ActivityPub announces ideas and carries follower relationships.

The recovered source package is preserved verbatim in [`protocol/irap-v0.1`](./protocol/irap-v0.1). Its normative [`SPEC.yaml`](./SPEC.yaml), original [`product.md`](./product.md), and original [`acceptance.md`](./acceptance.md) are also available at the repository root. The canonical idea history now lives separately at [`uncomposed/irap-protocol`](https://github.com/uncomposed/irap-protocol). The implemented v0.4 boundary is documented in [`IMPLEMENTATION.md`](./IMPLEMENTATION.md), [`IMPLEMENTATION_ACCEPTANCE.md`](./IMPLEMENTATION_ACCEPTANCE.md), and [`DEPLOYMENT.md`](./DEPLOYMENT.md).

Cole's non-normative convention for publishing his own ideas—including an idea
explorer as one ordinary rendering of every idea—is recorded in
[`PERSONAL_IDEA_PUBLISHING.md`](./PERSONAL_IDEA_PUBLISHING.md). It does not add
requirements to IRAP or to other publishers.

## Local development

Install dependencies, then run the server and web client in separate terminals:

```sh
npm install
npm run dev:server
```

```sh
npm run dev:web
```

The web client is at `http://127.0.0.1:5173`; it proxies API and federation paths to the service at `http://127.0.0.1:8787`. The development administrator token is `development-only-change-me` and must never be used in production.

The live interface includes separate workflows for publishing an idea, freezing a rendering against a branch/tag/commit, and inspecting/signing/publishing an attestation without giving the server a verifier private key.

## Verify

```sh
npm test
npm run build
npm audit
```

## Production

Copy `.env.example` to `.env`, set a permanent HTTPS `PUBLIC_ORIGIN` and strong `ADMIN_TOKEN`, then follow [`DEPLOYMENT.md`](./DEPLOYMENT.md).

```sh
docker compose build
docker compose up -d
```

The version-controlled VPS workflow performs the complete local gate and read-only server discovery before it transfers anything:

```sh
./deploy-vps.sh preflight
./deploy-vps.sh upload
```

The first upload creates a protected remote `.env` template and stops. After it is configured, rerunning `upload` starts the loopback-only container. The script deliberately leaves live Caddy changes and public DNS/HTTPS verification for an inspected deployment step.

## Operator commands

Run these inside the production container with `docker compose exec irap`:

```sh
npm run cli -- sync
npm run cli -- verify-all
npm run cli -- backup
npm run cli -- publish-reference
npm run cli -- publish-bundle --repository REPOSITORY_URL --revision FULL_COMMIT --dry-run
```

`sync` advances current canonical refs while preserving historical rendering targets. `verify-all` recomputes derived results without rewriting raw signed records. `backup` uses SQLite's online backup API and writes beneath `/app/data`. `publish-reference` idempotently publishes the canonical IRAP state and this deployment's immutable rendering manifest.

`publish-bundle` is the generic operator path for Git-pinned idea repositories. It
separates the bundle source commit from the exact idea state, verifies every rendering
declaration and artifact, compares the proposal with durable state, and defaults to a
non-mutating dry-run. `--apply` is required to publish. Run it inside the production
container so the administrator token never leaves the VPS. See
[`PUBLICATION_BUNDLES.md`](./PUBLICATION_BUNDLES.md).

Each build creates a deployment manifest containing the exact implementation and protocol commits plus SHA-256 digests for the rendered site assets. On startup, the service preserves that snapshot beneath the identity-bearing data volume and serves it from `/artifacts/<implementation-commit>/` even after later releases.

## Provenance

The original `irap-v0.1.zip` later appeared in the workspace after initially being unavailable through conversation retrieval. It is committed unchanged, extracted verbatim under `protocol/`, and used as the normative source. The earlier reconstruction has been superseded. Archive SHA-256: `8533aac137edf58482e1bdc08b4a43d96e1ea4f98d497df09267af406e838499`.
