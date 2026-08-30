# Personal idea publishing convention

This document records Cole Miller's preferred way to publish ideas through an
IRAP registry. It is a personal convention, not an IRAP requirement. Other
publishers may register ideas and renderings without following it.

## The convention

Every idea Cole publishes should have:

1. A canonical Git repository containing the idea's structured model and its
   history.
2. A human-facing idea explorer registered as one rendering of an exact commit
   of that repository.

An idea may also have any number of other renderings: an application, website,
simulation, essay, TestFlight build, video, or another interpretation. Those
renderings are optional. The explorer is not a new protocol object or a special
class in IRAP; it is an ordinary rendering with a consistent purpose and
presentation.

## Preferred public surfaces

For an idea with slug `{slug}`, use these locations when practical:

- Registry entry: `https://ideas.proximitytoprogress.com/ideas/{slug}`
- Idea explorer: `https://proximitytoprogress.com/ideas/{slug}/`
- Canonical source: a public Git repository pinned by the registry to an exact
  commit
- Product home, when one exists: a stable branded domain such as
  `https://{product}.proximitytoprogress.com/`
- Product access, when separate from its home: the relevant application,
  TestFlight, App Store, or other distribution URL

The registry is the index and provenance surface. The explorer is the
human-readable rendering of the model. A branded product surface is a more
interpretive realization of the idea and may also provide its About, privacy,
support, and distribution links.

## Canonical repository

The repository should make the authoritative idea state easy for a person or
agent to identify. Prefer:

- one canonical YAML model;
- an `.idea/manifest.yaml` with the stable idea identity;
- an `.idea/publication.yaml` that pins the exact idea commit and lists the
  rendering declarations to publish;
- acceptance, omission, and falsification checks;
- rendering declarations under `renderings/`; and
- a README that distinguishes the idea from any particular implementation.

The YAML model is authoritative for the modeled idea. The explorer should read
or be generated from that model rather than maintain a second, hand-written
version of the idea.

## Explorer rendering

The explorer should make the modeled idea understandable without requiring a
visitor to read raw YAML. It should also make the underlying model and source
available for inspection.

Publish it through the normal IRAP rendering mechanism:

- bind it to the exact idea repository and full commit;
- publish an immutable artifact manifest and SHA-256 digest;
- give it an explicit title such as `{Idea name} Idea Explorer`;
- put the confirmed human destination in `live_uri` in the artifact manifest;
  and
- register its rendering declaration in the idea's publication bundle.

`live_uri` is a convention for the human destination inside Cole's artifact
manifests. It does not add a required field to the IRAP rendering schema. A
planned URL should not be presented as live; once deployed, publish a new
immutable manifest containing the confirmed URL.

## Additional renderings

Applications and other interpretations remain separate renderings of the same
idea state. Register a separate rendering when it gives someone a materially
different way to encounter or use the idea, or when a public milestone needs
its own immutable evidence.

Routine builds do not need to become separate top-level registry entries. A
new build is worth registering when the interpretation, public experience, or
auditable milestone has materially changed.

Use titles and descriptions that make the relationship apparent without
requiring additional protocol fields, for example:

- `Spoken Margins Idea Explorer v0.1`
- `Spoken Margins Flight 0.1 (21)`
- `AI Pacing Specification Lens`
- `Lunar Transport Architecture Trade Screen v0.1`

## Publication workflow

For each idea:

1. Identify and test the canonical YAML model.
2. Freeze the intended idea state to a full Git commit.
3. Build and deploy the explorer from that state.
4. Create an immutable explorer artifact manifest with its confirmed
   `live_uri` and digest.
5. Add the explorer rendering declaration, plus any optional rendering
   declarations, to `.idea/publication.yaml`.
6. Dry-run the publication bundle and inspect the proposed idea state,
   rendering targets, artifact digests, and human destinations.
7. Apply the exact reviewed bundle commit.
8. Verify that the registry opens the explorer, source repository, and each
   optional rendering directly.

## Agent handoff

Agents working in one of Cole's idea repositories should follow this boundary:

> Treat this repository as the canonical history of the idea, not as the only
> permissible implementation. Preserve one authoritative YAML model. Create a
> human-facing explorer from that model and register the explorer as an ordinary
> rendering of an exact Git commit. Other applications and media are optional,
> independent renderings. Do not impose this personal explorer convention on
> other IRAP publishers or change the IRAP schema to encode it.

Before publishing, an agent should be able to answer:

- Which repository and exact commit define the idea?
- Which YAML file is authoritative?
- Where is the explorer, and does it render that exact state?
- Does its immutable artifact manifest contain the confirmed human URL?
- Which other renderings are being registered, and why are they materially
  distinct?
- Can a registry visitor reach the explorer and source without navigating
  through raw JSON?

