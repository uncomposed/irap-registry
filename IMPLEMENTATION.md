# IRAP Publisher

## Product statement

IRAP Publisher is a single-node service for publishing ideas as exact Git states, inspecting renderings and attributable attestations, and distributing canonical publication events through ActivityPub.

It keeps three layers deliberately separate:

1. **Protocol:** Git states, renderings, Ed25519 attestations, verifier registries, and historical recognition policies.
2. **Publication:** durable local URLs, persistent objects, administrator-authorized creation, and audit state.
3. **Federation:** WebFinger discovery, an ActivityPub actor, signed inbox/outbox transport, followers, and retrying delivery.

Git and signed IRAP objects are authoritative. ActivityPub carries announcements and social relationships; it does not decide which rendering is faithful.

## Users and jobs

- An idea author publishes a YAML definition bound to a full Git commit.
- A reader resolves that exact state and inspects its specification.
- A verifier inspects why an attestation is cryptographically valid, policy-recognized, or neither.
- A Fediverse user follows the publisher and receives new idea announcements.
- An operator audits followers, received activities, delivery state, and the actor's stable key material.

## v0.2 implemented scope

### Publishing

- Administrator-token-protected creation of ideas.
- Full SHA-1 or SHA-256 Git object IDs; short hashes are rejected.
- Production publication fetches the submitted commit into a hookless bare cache, verifies the repository object format, and reads the historical manifest, verifier registry, and policy with `git show`.
- YAML parsing and bounded payload validation.
- SQLite persistence with WAL, foreign keys, and restricted file permissions.
- Public JSON API and ActivityStreams `Document` representation.
- Responsive directory, exact-state resolver, and publishing form.

### Federation

- RFC 7033 WebFinger for one `Application` actor.
- NodeInfo 2.1 discovery.
- ActivityPub actor, public outbox, followers collection, actor inbox, and shared inbox.
- Persistent RSA actor key generated on first boot.
- Legacy RSA-SHA256 HTTP request signing for current Fediverse compatibility.
- Digest, Date-window, request-target, host, and signed-header verification.
- Automatic Follow acceptance; Undo Follow and actor Delete removal.
- Persistent outbound queue with deduplication, backoff, and terminal failure state.
- Guarded remote actor resolution: HTTPS, no credentials, no redirects, bounded bodies, and private-address rejection.
- Global and route-specific request throttling.

### Verification explorer

- Real Ed25519 verification over RFC 8785 canonical JSON.
- Recognized, valid-but-unrecognized, and invalid states remain separate.
- Historical-policy and exact-artifact binding tests.

## Deployment topology

```text
Internet / Fediverse
        │ HTTPS
      Caddy
        │ loopback HTTP
  IRAP Fastify service
   ├── React application
   ├── REST publishing API
   ├── ActivityPub endpoints
   ├── delivery worker
   └── SQLite + actor key
```

The Docker container binds to `127.0.0.1:8787` on the VPS. Caddy owns public TLS. The named Docker volume is identity-bearing state: it contains publications, delivery history, and the actor's private key.

## Explicit boundaries

The current implementation is a deployable federation and canonical-publication MVP, not the complete IRAP registry described by the original product definition and not a general-purpose social network. It does not yet accept rendering or attestation submissions, evaluate recognition on the server, provide state-history endpoints, or expose moderation UI. It also omits multi-user accounts, public registration, media upload, comments/replies, likes, boosts, domain blocklists, RFC 9421 message signatures, and ActivityPub conformance-suite certification.

Production Git resolution is intentionally read-only and narrow: HTTPS only, no credentials, no redirects, no private/reserved targets, a hookless bare cache, no submodule traversal, a fetch timeout and pack-size ceiling, and `git show <commit>:<path>` for metadata. Development mode leaves this verification off by default so the interface can be explored offline; every API record exposes `git_verified` so the two states cannot be confused.

## Audit model

- Compare published API objects, ActivityStreams objects, SQLite rows, and outbox activities for the same idea.
- Tamper with a signed request body to falsify its digest/signature.
- Attempt short hashes, malformed YAML, duplicate slugs, and missing administrator tokens.
- Attempt remote actor URLs that resolve privately or redirect.
- Stop a recipient server and inspect retry/backoff state.
- Back up and restore the SQLite volume; the actor public key must remain unchanged.

## Next increments

1. Persistent rendering and attestation publication APIs using the existing verification engine.
2. Historical state and recognition endpoints from the original product definition.
3. Moderation controls, domain allow/block policy, and administrative audit UI.
4. RFC 9421 verification alongside the compatibility Signature header.
5. Interoperability testing against Mastodon, GoToSocial, Akkoma, and an ActivityPub test suite.
