# IRAP Registry v0.1 Acceptance Checklist

## Git identity
- [ ] Branch/ref is frozen to a full commit object ID on submission.
- [ ] Advancing a branch cannot mutate an existing rendering target.
- [ ] Historical policy files are loaded from the target commit.
- [ ] SHA-1 repositories work.
- [ ] SHA-256 repositories work or fail explicitly with a documented unsupported condition.
- [ ] Abbreviated hashes are rejected from signed objects.

## Rendering
- [ ] No media/type classification is required.
- [ ] Artifact URI and SHA-256 digest are bound to the rendering.
- [ ] Digest mismatch is a severe visible warning.
- [ ] Registry links to creator-hosted artifact rather than requiring rehosting.
- [ ] Exact idea commit is always visible.

## Attestation
- [ ] Attestation binds rendering ID, artifact digest, idea ID, repository, object format, and exact commit.
- [ ] Signature covers RFC 8785 JCS canonical JSON excluding the signature member.
- [ ] Valid Ed25519 signatures verify.
- [ ] Mutating one signed value causes failure.
- [ ] Equivalent YAML/JSON formatting does not change signature result after parsing/canonicalization.
- [ ] Evidence is optional and unstructured beyond URI/digest metadata.

## Recognition
- [ ] Eligible historical verifier can produce recognized result.
- [ ] Ineligible verifier can produce signature_valid=true, recognized=false.
- [ ] Invalid signature is never recognized.
- [ ] Later verifier membership changes do not retroactively alter old-policy eligibility.
- [ ] Conflicting attestations remain visible.
- [ ] Aggregate recognition is policy-driven, not UI-hardcoded.

## UI semantics
- [ ] Every Verified shorthand exposes who verified.
- [ ] Every verification exposes exact commit.
- [ ] UI says fidelity verification is not truth or endorsement.
- [ ] Historical target is clearly marked.
- [ ] Fail, abstain, and indeterminate attestations are not hidden.
- [ ] Valid but unrecognized attestations are not labeled invalid.

## Security
- [ ] Repository content is never executed.
- [ ] Hooks and submodule recursion are disabled.
- [ ] SSRF rejects local/private/link-local destinations.
- [ ] Redirect SSRF bypass is tested.
- [ ] Size and timeout limits exist for Git/artifact retrieval.
- [ ] Rendered markup is sanitized.
- [ ] Production server does not require verifier private keys.

## Self-reference
- [ ] Product states exact IRAP spec commit implemented.
- [ ] Product can itself be submitted as a rendering of that commit.
