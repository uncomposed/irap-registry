# IRAP Publisher v0.2 acceptance criteria

Each criterion includes observable evidence and a failure it is designed to catch.

## Protocol package

- **A01 — Normative definition:** `SPEC.yaml` parses as YAML and defines idea, state, rendering, attestation, verifier registry, and verification policy as distinct objects. Catches category collapse.
- **A02 — Forge independence:** the normative model requires Git repository identity plus commit, not GitHub. Catches infrastructure becoming identity.
- **A03 — Exact state:** SHA-1 identifiers require 40 lowercase hexadecimal characters and SHA-256 identifiers require 64. Catches ambiguous short hashes.
- **A04 — Stable signatures:** attestations are signed over an RFC 8785 canonical JSON projection with the signature member excluded. Catches YAML formatting changes invalidating signatures.

## Trust evaluation

- **A05 — Real signature validation:** the reference recognized attestation verifies with Ed25519; an altered record fails. Evidence: automated tests. Catches decorative trust badges.
- **A06 — Historical lookup:** an attestation is invalid if registry or policy state differs from its target state. Catches applying today's authority to yesterday's claim.
- **A07 — Artifact binding:** rendering ID and artifact digest in the signed attestation must match the displayed rendering. Catches swapping an artifact beneath a valid signature.
- **A08 — Open attestation:** a correctly signed assertion by an unlisted verifier remains “validly signed, not recognized,” not invalid. Catches governance being misrepresented as cryptography.
- **A09 — Recognition:** only eligible, scoped, valid signatures count toward the historical threshold. Distinct verifier IDs are counted once. Catches duplicate and out-of-scope approvals.
- **A10 — Blocking disagreement:** when policy says recognized failures block, a recognized failing attestation prevents rendering recognition. Catches hiding authorized disagreement.

## Product behavior

- **A11 — Five visible layers:** the interface separately displays Idea, Git state, Rendering, Attestation, and Policy. Catches visually flattening the model.
- **A12 — Status language:** the interface visibly distinguishes “recognized,” “validly signed · not recognized,” and “invalid signature.” Catches a misleading binary badge.
- **A13 — Evidence path:** each attestation detail shows signer, signed time, claim/result, evidence URI/digest, signature result, eligibility result, and reasons. Catches conclusions without an audit trail.
- **A14 — Exact implementation:** the footer shows the full Git commit used when building the application. Catches the implementation's own protocol claim being unverifiable.
- **A15 — Deployable application:** `npm run build` creates the web bundle and compiled server; Docker starts the service with durable state on a named volume. Catches an undeclared runtime dependency.
- **A16 — Responsive and keyboard usable:** core content works at 360 px and desktop widths, interactive controls have visible focus, and no status is encoded by color alone. Catches a visually polished but inaccessible explorer.

## Publishing and federation

- **A17 — Authorized publication:** publishing without the configured bearer token fails; a valid token creates one durable idea, object, and Create activity atomically. Catches unauthenticated or partially committed publication.
- **A18 — Discovery:** WebFinger resolves the configured `acct:` identifier to an ActivityPub actor with inbox, outbox, followers, shared inbox, and stable RSA public key. Catches an undiscoverable actor.
- **A19 — Public outbox:** a published idea appears as a public ActivityStreams `Document` wrapped in `Create`, addressed to Public and followers. Catches local-only publication masquerading as federation.
- **A20 — Signed transport:** outbound POSTs cover request-target, host, date, digest, and content-type with RSA-SHA256; tampering causes verification failure. Catches unauthenticated transport.
- **A21 — Inbox ownership:** the verified key owner must equal the activity actor. Replayed IDs are accepted idempotently but do not repeat side effects. Catches actor spoofing and replay duplication.
- **A22 — Follower lifecycle:** a valid Follow is persisted and receives an Accept; Undo Follow and actor Delete remove it. Catches an outbox with no social delivery graph.
- **A23 — Durable delivery:** outbound activities are queued uniquely per inbox, retried with bounded exponential backoff, and become terminal after eight failures. Catches fire-and-forget loss.
- **A24 — Network boundary:** remote actor resolution requires HTTPS in production and rejects credentials, redirects, oversized documents, and private/reserved targets. Catches obvious SSRF paths.
- **A25 — Stable identity:** actor RSA keys survive service restart and are stored with the same durable volume as federation state. Catches a new cryptographic identity on every deploy.
- **A26 — Deployment boundary:** the container drops Linux capabilities, runs as a non-root user, exposes only loopback through Compose, and relies on Caddy for public TLS. Catches accidental direct service exposure.
- **A27 — Historical Git proof:** production publication fetches the submitted full commit into a hookless bare cache, confirms the object format and exact commit, and reads the manifest, verifier registry, and policy from that commit. The public record exposes whether this proof occurred. Catches a repository URL and hash being treated as evidence without resolution.

## Quality gate

Run:

```sh
npm test
npm run build
```

Stopping rule: do not call v0.2 deployable if any automated test, server compilation, web build, container build, discovery endpoint, publication transaction, or signed-transport falsification test fails.

## Omission and falsification checks

- Change one signed evidence summary without resigning: the signature must fail.
- Move an otherwise valid registry to a different commit: the attestation must fail.
- Add a valid signature from a non-eligible signer: it must remain visible but not count.
- Remove the only recognized pass: the rendering must no longer meet threshold.
- Reorder keys before canonicalization: the canonical payload must remain byte-identical.
- Change the submitted name so it differs from the historical manifest: publication must fail.
