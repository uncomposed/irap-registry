# IRAP v0.1 acceptance criteria

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
- **A15 — Static deployment:** `npm run build` creates a self-contained `dist/` that works with a Caddy SPA fallback and relative assets. Catches an undeclared server dependency.
- **A16 — Responsive and keyboard usable:** core content works at 360 px and desktop widths, interactive controls have visible focus, and no status is encoded by color alone. Catches a visually polished but inaccessible explorer.

## Quality gate

Run:

```sh
npm test
npm run build
```

Stopping rule: do not call v0.1 complete if any automated test or production build fails, or if the three trust states cannot be demonstrated from one reference rendering.

## Omission and falsification checks

- Change one signed evidence summary without resigning: the signature must fail.
- Move an otherwise valid registry to a different commit: the attestation must fail.
- Add a valid signature from a non-eligible signer: it must remain visible but not count.
- Remove the only recognized pass: the rendering must no longer meet threshold.
- Reorder keys before canonicalization: the canonical payload must remain byte-identical.
