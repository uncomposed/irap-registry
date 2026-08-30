# Publication bundles

A publication bundle is a Git-pinned instruction set for publishing one exact idea
state and one or more rendering declarations. It removes administrator-token entry
from the browser workflow without moving that token off the registry server.

## Typed identities

Publication uses two independent Git identities:

1. **Bundle source commit:** identifies the publication instructions and rendering
   declaration files.
2. **Idea state commit:** identifies the historical idea manifest, verifier registry,
   verification policy, and human-readable specification that every rendering targets.

The bundle source may advance to add declarations without moving the idea state. Both
identities must be full Git object IDs; branches and tags are rejected at the CLI
boundary.

## Repository contract

The default bundle path is `.idea/publication.yaml`:

```yaml
publication_version: "1"

idea:
  slug: spoken-margins
  summary: >
    A model for preserving orientation, thought, and provenance when written or
    transcript-backed material becomes a listening experience.
  specification_path: public/idea.yaml
  state:
    repository: https://github.com/uncomposed/spoken-margins-idea.git
    object_format: sha1
    commit: "6cc8c664feea02c98649e39eed94a55257543813"

renderings:
  - path: renderings/explorer-v0.1.yaml
  - path: renderings/testflight-0.1-21.yaml
```

Each listed file must be an IRAP 0.1 rendering document. Its idea ID, repository,
object format, and commit must exactly match `idea.state`. Paths are repository-relative,
bounded, and cannot traverse out of the repository.

## Operator workflow

Run commands inside the production container so `ADMIN_TOKEN` remains in the VPS
environment.

Dry-run:

```sh
docker compose exec -T irap npm run cli -- publish-bundle \
  --repository https://github.com/uncomposed/spoken-margins-idea.git \
  --revision 6af9d8155bdda8260d000383713a78ab17fb4f75 \
  --object-format sha1 \
  --dry-run
```

Apply the exact reviewed plan:

```sh
docker compose exec -T irap npm run cli -- publish-bundle \
  --repository https://github.com/uncomposed/spoken-margins-idea.git \
  --revision 6af9d8155bdda8260d000383713a78ab17fb4f75 \
  --object-format sha1 \
  --apply
```

`--dry-run` is the default when neither action flag is supplied. `--apply` must be
explicit. `--path` may select another safe repository-relative bundle file.

## Evidence and failure behavior

Before reporting a plan, the command:

- fetches the exact bundle commit into the hookless, size-bounded Git cache;
- resolves the exact idea state and historical verifier/policy files;
- reads the specification from that state commit;
- requires the specification's idea ID and name to match the historical manifest;
- parses every declaration without executing repository content;
- requires every rendering to bind to the same idea ID and state;
- fetches each artifact through the registry's SSRF and size boundaries;
- reports verified, mismatching, or unavailable artifact evidence;
- compares proposed records with current durable database records.

A digest mismatch, reused slug/identity conflict, reused rendering URI with different
content, moving bundle revision, unsafe path, or target-state mismatch refuses apply.
An unavailable artifact is reported as an explicit warning and remains unverified.

Applying a clean plan creates only records marked `create`. Repeating the same bundle
reports `existing` and creates no duplicate records or ActivityPub activities. If a
network failure interrupts a multi-record apply, rerunning the same full commit safely
completes the remaining records.

Signed attestations remain a separate step. They are signed outside the server and may
be submitted to the public attestation endpoint; the registry administrator token and
verifier private key never share a trust boundary.
