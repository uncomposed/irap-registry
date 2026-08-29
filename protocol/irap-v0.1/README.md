# Idea Rendering Attestation Protocol (IRAP) v0.1

IRAP is a small protocol for publishing **evolving ideas** in Git and allowing independently published artifacts to be **attributably verified as renderings of an exact state of an idea**.

The core sentence is:

> **Artifact X was judged against Git state Y by verifier Z under verification policy P.**

There is no freestanding property called “verified.” Verification is an attributable act.

## The five concepts

1. **Idea** — a durable intellectual identity whose source evolves in Git.
2. **State** — an exact Git commit.
3. **Rendering** — any independently published artifact claiming a relationship to that state.
4. **Attestation** — a signed verifier judgment about that rendering against that state.
5. **Verification policy** — rules inside the idea state specifying which attestations count as recognized verification.

A song, essay, game, simulation, protest, source-code implementation, PDF, wargame result, critique, video, or anything else is simply a **rendering**. IRAP does not impose media types.

## Why Git

Git already provides immutable commit identities, branches, diffs, history, decentralized transport, mirroring, and collaboration. IRAP depends on Git, not GitHub. GitHub, GitLab, Codeberg, Forgejo, or a self-hosted Git endpoint can all be mirrors.

Every attestation targets a **full commit object ID** and records whether the repository uses SHA-1 or SHA-256 object format.

## Repository layout

```text
my-idea/
├── README.md
├── SPEC.yaml                 # optional idea-specific structured definition
└── .idea/
    ├── manifest.yaml
    ├── verifiers.yaml
    └── verification-policy.yaml
```

The verifier list is Git content because **who is empowered to sign off on the idea is itself part of the state of the idea**.

## Human and AI verifiers

IRAP's social requirement is that an intentional judging agent—a “mind”—takes responsibility for the verification judgment. The protocol cannot prove mentality.

Operationally, an idea's verifier registry decides whose attestations can be recognized. Humans and AI systems can both be registered. AI entries should identify the system, operator/custodian, and verification procedure where feasible.

This separates three things:

- **identity** — who signed;
- **recognition** — whether that identity was eligible under the historical idea state;
- **credibility** — how much a reader trusts the verifier and their work.

## Verification work

The signed attestation is intentionally small. Supporting work is optional and can be anything: calculations, notes, citations, model transcripts, code, tests, counterexamples, or a separate report. Evidence is linked by URI and digest.

This makes verification analogous to signing off on an engineering drawing: the signature is the accountable conclusion; the calculations and review package can be inspected when needed.

## Signing

YAML is the human-editable format, but raw YAML is never signed because semantically equivalent YAML can serialize differently.

For signatures:

1. parse the attestation;
2. remove `signature`;
3. convert to I-JSON-compatible JSON without changing values;
4. canonicalize with RFC 8785 JCS;
5. sign UTF-8 canonical bytes with Ed25519;
6. encode signature as unpadded base64url.

## Recognition

A valid signature is not automatically a recognized verification.

Example:

```json
{
  "signature_valid": true,
  "recognized": false,
  "reason": "verifier not eligible under target commit policy"
}
```

That is a valid, open attestation. It is simply not recognized by the idea's governance at that historical state.

Multiple recognized verifiers may disagree. Software should show that disagreement rather than manufacture a single metaphysical truth value.

## ActivityPub

ActivityPub is an optional distribution layer. It can announce new canonical commits, rendering submissions, attestations, and recognized-verification notices. It is not the trust model.

If federation disappears, the Git state, rendering manifest, signed attestation, and evidence remain valid.

## Product rendering

A website implementing this protocol is itself a rendering of IRAP. See `product-render/PRODUCT.md` for a coding-model-ready implementation brief and `product-render/ACCEPTANCE.md` for completion tests.

## Design rule

Before adding a new object type, ask whether the thing can remain ordinary Git content, a rendering, evidence, or an attestation.

Keep the protocol small.
