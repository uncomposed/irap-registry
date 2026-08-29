# Product Rendering Brief: IRAP Registry v0.1

## Mission

Build the smallest useful web product that renders IRAP v0.1.

The application is **not** an idea editor, Git forge, social network, rendering generator, AI-writing tool, or media host.

It does exactly six things:

1. imports and displays canonical idea state from Git;
2. resolves moving refs to immutable commits;
3. accepts arbitrary external renderings targeting exact commits;
4. accepts and verifies attributable signed attestations;
5. evaluates recognition using the verifier policy from the exact historical commit;
6. displays renderings, verifier identities, evidence, disagreement, and historical state clearly.

The product MUST display the exact IRAP specification Git commit that it implements.

## Recommended stack

- Python 3.12+ / FastAPI, or equivalent small typed backend.
- PostgreSQL 16+ production; SQLite allowed for development/tests.
- Server-rendered HTML with progressive enhancement preferred for MVP.
- Installed Git CLI invoked with argument arrays; never shell-string concatenation.
- Mature Ed25519 crypto library.
- RFC 8785 JCS library.
- Safe YAML parser.
- Caddy or equivalent TLS reverse proxy.

Forge-specific APIs may improve UX but MUST be optional.

## Git security boundary

Repository contents are hostile input.

- Use bare clone/fetch cache.
- Do not run hooks.
- Do not recurse submodules.
- Do not execute repository code.
- Read files with `git show <commit>:<path>`.
- Apply network, object-count, and size limits.
- Validate repository URL protocols.
- Support SHA-1 and SHA-256 object formats; fail explicitly if a chosen Git library cannot.

Suggested cache:

```text
/var/lib/irap/git/<sha256(repository-url)>/
```

## Minimal database

### Idea cache

```text
id
idea_uri UNIQUE
name
primary_repository
object_format            sha1 | sha256
canonical_ref
last_resolved_commit
last_synced_at
```

Semantic authority remains Git; these are indexes/cache.

### Rendering

```text
id
rendering_uri UNIQUE
idea_uri
repository_url
object_format
target_commit            full immutable object id
artifact_uri
artifact_digest          sha256:...
creator_uri
title NULL
description NULL
submitted_at
raw_manifest_json
status                    active | withdrawn | unreachable
```

Do not add a media-type taxonomy.

### Attestation

```text
id
attestation_uri UNIQUE
rendering_id
target_commit
verifier_uri
verifier_key_id
claim
result                    pass | fail | abstain | indeterminate
note NULL
issued_at
raw_attestation_json
signature_valid BOOLEAN
recognition_status        recognized | unrecognized | invalid | indeterminate
recognition_reasons_json
created_at
```

Raw signed objects remain authoritative.

## Reader UX

An idea page shows:

- idea name and durable ID;
- current canonical branch;
- exact current commit ID;
- repository and mirrors;
- canonical README/spec content;
- renderings targeting current and historical commits;
- historical verifier registry and policy when viewing an old commit.

A rendering page shows:

- creator;
- external artifact link;
- artifact digest;
- exact idea commit rendered;
- whether that commit is current or historical;
- all attestations, including disagreement;
- signature validity separately from recognition;
- verifier identity and provenance;
- evidence links.

A UI may use a compact “Verified” badge only when it also makes the verifier identity, claim, and exact commit immediately inspectable. Accessible text must not reduce this to a bare boolean.

## Submission flow

Creator submits:

- artifact URI;
- artifact digest, or asks registry to compute when safe;
- idea;
- target ref/branch/commit;
- creator URI;
- optional title and description.

Server:

1. fetches repository;
2. resolves target to exact full commit ID;
3. reads `.idea/manifest.yaml` at that commit;
4. confirms idea ID;
5. freezes target commit in rendering manifest;
6. validates/obtains artifact digest;
7. stores submission;
8. returns stable registry URL.

If artifact is too large or unsafe to fetch, accept submitter digest but label digest as not independently fetched until checked.

## Review/signing flow

Verifier opens rendering and sees:

- exact target commit;
- idea content at that commit;
- verifier policy at that commit;
- artifact URI and digest status;
- supported claim names.

Verifier selects:

- claim;
- pass/fail/abstain/indeterminate;
- optional note;
- zero or more evidence URI+digest records.

Before signing, UI MUST display:

- verifier identity;
- verifier key ID;
- artifact digest;
- target Git commit;
- judgment;
- exact canonical unsigned JSON signing payload.

Preferred production signing is client-side or external signer. Server MUST NOT require possession of verifier private keys. A dev-only server key may exist behind an explicit unsafe-development flag.

## Pure verification service

Implement a deterministic function:

```python
verify_attestation(attestation, rendering, git_resolver) -> VerificationResult
```

It MUST:

1. schema/structure validate;
2. compare rendering IDs and artifact digests;
3. resolve exact Git commit;
4. read historical manifest;
5. confirm idea ID;
6. read historical verifier registry;
7. read historical verification policy;
8. resolve verifier key;
9. remove signature;
10. validate I-JSON constraints;
11. JCS canonicalize;
12. Ed25519 verify;
13. evaluate recognition policy;
14. return cryptographic validity and recognition independently.

## Recognition rules v0.1

Only implement:

```yaml
rule:
  type: any_one_pass
```

```yaml
rule:
  type: threshold
  count: 2
  result: pass
```

```yaml
rule:
  type: all_groups
  groups:
    - [https://a.example, https://b.example]
    - [https://c.example, https://d.example]
  result: pass
```

Do not implement arbitrary executable policy expressions.

## Minimum routes

Human HTML:

```text
/
/ideas/{slug}
/ideas/{slug}/commits/{oid}
/renderings/{id}
/attestations/{id}
/submit
/review/{rendering-id}
/about
```

JSON API:

```text
GET  /api/v1/ideas
GET  /api/v1/ideas/{id}
GET  /api/v1/ideas/{id}/states/{oid}
POST /api/v1/renderings
GET  /api/v1/renderings/{id}
POST /api/v1/attestations
GET  /api/v1/attestations/{id}
POST /api/v1/attestations/verify
```

## SSRF and content security

Git and artifact URLs are attacker controlled.

MUST:

- reject loopback, private, link-local, and metadata-service IPs by default;
- re-resolve DNS after redirects;
- cap redirects;
- cap download sizes;
- set connect/read timeouts;
- allow only configured URL schemes;
- send no ambient credentials;
- sanitize rendered Markdown/HTML;
- isolate uploaded/user content on another origin if uploads are later supported.

## Authentication

Local product accounts may be used for submission/review workflow.

A logged-in account is not automatically a verifier.

Verifier authority comes from:

1. identity in historical Git verifier registry;
2. signature from registered key;
3. claim recognition policy at that exact commit.

## Sync

Provide commands/endpoints for:

```text
irap sync
irap verify-all
irap import <git-url>
```

`sync` updates current canonical refs but never rewrites historical rendering targets.

`verify-all` can re-run validation but must preserve raw historical objects/results for audit.

## ActivityPub extension

Not required for MVP. Add only after core acceptance tests pass.

When added:

- optionally expose one actor per substantial idea;
- federate notices about canonical updates, renderings, and attestations;
- link every federated notice to canonical HTTPS registry page;
- do not use likes/boosts/replies as verification;
- do not let ActivityPub identity replace registered verifier signing keys.

Use existing ActivityStreams types such as `Note` or `Article` plus links unless a demonstrated interoperability need requires an extension vocabulary.

## Explicit non-features

Do not build in v0.1:

- AI rendering generation;
- WYSIWYG idea editing;
- Git hosting;
- pull-request UI;
- Fediverse timeline;
- DMs;
- comments/voting;
- recommendations/ranking;
- media transcoding;
- different schemas for songs, videos, PDFs, protests, games, or wargames;
- blockchain or tokens.

## Demo fixture

Create a test idea repo with two commits.

Commit A:
- Alice eligible verifier.
- Agent eligible verifier.
- any-one-pass policy.

Commit B:
- Alice removed or policy changed.

Create renderings/attestations demonstrating:

1. recognized pass at A;
2. valid signature by ineligible verifier at A;
3. invalid signature;
4. fail result;
5. disagreement;
6. rendering targeting A after main moves to B;
7. new verifier membership in B does not affect A.

## Definition of done

The product works when a developer can:

1. import an idea Git repository;
2. submit an arbitrary external artifact targeting `main`;
3. see `main` frozen to a full commit;
4. create or upload a signed attestation;
5. see signature validity;
6. see recognition evaluated from historical policy;
7. advance `main`;
8. see the old rendering remain bound to the old commit;
9. change verifier policy in the new commit;
10. demonstrate that old and new attestations are evaluated under their respective historical policies.

At that point the core product is complete.
