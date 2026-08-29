# IRAP Verification Explorer

## Product statement

The first product is a public, read-only web resolver for the Idea Rendering Attestation Protocol. It makes the protocol's trust boundary legible: an artifact does not simply receive a “verified” badge. The interface answers five linked questions:

1. What idea is being rendered?
2. Which exact Git state does the rendering claim to represent?
3. Who made the rendering and where is the content-addressed artifact?
4. Who signed each judgment, and what evidence supports it?
5. Did that signer satisfy the verification policy in that exact historical state?

This web product is itself a rendering of IRAP and displays the Git commit it implements.

## Initial audience and job

The initial audience is an idea author, rendering creator, verifier, or skeptical reader who has been given a rendering or attestation URL. Their job is to inspect the relationship without trusting a forge, the product operator, or a context-free badge.

## v0.1 scope

The initial implementation is a static client-side application suitable for Caddy on the supplied Ubuntu VPS. It ships with a cryptographically real reference record and a small protocol library that can later sit behind URL import and repository resolution.

The first slice must:

- present Idea → exact Git State → Rendering → Attestation → historical Policy as distinct layers;
- show the full Git object ID and object format;
- show artifact and evidence hashes;
- verify Ed25519 signatures over RFC 8785 canonical JSON in the browser;
- distinguish recognized, valid-but-unrecognized, and invalid attestations;
- show the policy threshold and which historical policy produced the result;
- expose the normative specification and acceptance criteria;
- disclose the implementation commit;
- build to static files without a server-side runtime.

## Explicit non-goals

- GitHub-specific identity or APIs
- ActivityPub federation
- key custody or signing in the browser
- mutating idea repositories
- crawling arbitrary repositories from the client
- treating an AI/human type label as a trust score
- collapsing signature validity and policy recognition into one badge

## Information architecture

### Explorer

The default screen shows a selected rendering, its exact state anchor, the applicable recognition policy, and every attestation. Selecting an attestation reveals signature, evidence, eligibility, and failure details.

### Protocol

A concise in-product presentation of the five protocol objects and the core recognition algorithm. The complete `SPEC.yaml` remains downloadable/inspectable.

### Acceptance

The product exposes the behavioral boundary used to decide whether the v0.1 implementation is complete.

## Trust computation

The user interface never supplies trust conclusions directly. It renders the result of the domain evaluator. The evaluator consumes a rendering, attestations, the verifier registry from the attested state, and the policy from the attested state. Its output includes separate booleans for cryptographic validity and policy recognition plus human-readable reasons.

## VPS target

The production artifact is `dist/`, served by Caddy as a static single-page application. A future deployment should use a dedicated subdomain and `/srv/www/<app>/`, validate the live Caddy configuration before activation, retain rollback, and verify the public title plus a known application marker after upload. Deployment is intentionally not performed by the initial local build.

## Next increments

1. Paste or upload IRAP YAML objects and evaluate them locally.
2. Resolve a repository transport and full Git commit through a small read-only service.
3. Fetch `.idea/` policy files at that exact commit.
4. Add a rendering directory/index without making the index authoritative.
5. Announce canonical updates and attestations over optional ActivityPub transport.
