import { canonicalize, unsignedAttestation } from './canonicalize'
import type {
  Attestation,
  AttestationEvaluation,
  Rendering,
  RenderingEvaluation,
  StateReference,
  VerificationPolicy,
  VerifierRegistry,
} from './types'

const encoder = new TextEncoder()

function fromBase64(value: string) {
  const binary = atob(value)
  return Uint8Array.from(binary, (character) => character.charCodeAt(0))
}

export function sameState(left: StateReference, right: StateReference) {
  return (
    left.idea_id === right.idea_id &&
    left.repository === right.repository &&
    left.git_commit.algorithm === right.git_commit.algorithm &&
    left.git_commit.value === right.git_commit.value
  )
}

export function isFullGitObjectId(state: StateReference) {
  const expectedLength = state.git_commit.algorithm === 'sha1' ? 40 : 64
  return state.git_commit.value.length === expectedLength && /^[0-9a-f]+$/.test(state.git_commit.value)
}

export async function verifyEd25519(attestation: Attestation, publicKey: string) {
  try {
    const key = await crypto.subtle.importKey('raw', fromBase64(publicKey), 'Ed25519', false, ['verify'])
    return await crypto.subtle.verify(
      'Ed25519',
      key,
      fromBase64(attestation.signature.value),
      encoder.encode(canonicalize(unsignedAttestation(attestation))),
    )
  } catch {
    return false
  }
}

export async function evaluateAttestation(
  rendering: Rendering,
  attestation: Attestation,
  registry: VerifierRegistry,
  policy: VerificationPolicy,
): Promise<AttestationEvaluation> {
  const reasons: string[] = []
  const verifier = registry.verifiers.find((entry) => entry.id === attestation.verifier.id)
  const rule = policy.rules.find((entry) => entry.claim === attestation.judgment.claim)

  if (!isFullGitObjectId(attestation.against)) reasons.push('The target is not a full Git object ID.')
  if (!sameState(rendering.renders, attestation.against)) reasons.push('The attestation targets a different Git state.')
  if (!sameState(registry.state, attestation.against) || !sameState(policy.state, attestation.against)) {
    reasons.push('The verifier registry or policy is not from the attested historical state.')
  }
  if (attestation.rendering.id !== rendering.id || attestation.rendering.sha256 !== rendering.artifact.sha256) {
    reasons.push('The signed rendering reference does not match this artifact.')
  }
  if (attestation.signature.algorithm !== 'ed25519') reasons.push('The signature algorithm is not supported by IRAP 0.1.')
  if (!verifier) reasons.push('The signer is absent from the historical verifier registry.')
  if (verifier && verifier.key.id !== attestation.verifier.key_id) reasons.push('The signing key does not match the registered key ID.')
  if (!rule) reasons.push('The historical policy has no rule for this claim.')

  const signatureValid = verifier
    ? await verifyEd25519(attestation, verifier.key.public_key)
    : await verifyEd25519(attestation, attestation.verifier.id === 'did:key:review-bot' ? UNRECOGNIZED_PUBLIC_KEY : '')

  if (!signatureValid) reasons.push('The Ed25519 signature does not verify over the canonical payload.')

  const eligible = Boolean(
    verifier &&
      rule &&
      verifier.scopes.includes(attestation.judgment.claim) &&
      rule.eligible_verifiers.includes(verifier.id),
  )
  const recognized = signatureValid && eligible && reasons.length === 0

  let status: AttestationEvaluation['status'] = 'valid-unrecognized'
  if (!signatureValid || reasons.some((reason) => !reason.includes('absent from'))) status = 'invalid'
  else if (recognized) status = attestation.judgment.result === 'pass' ? 'recognized-pass' : 'recognized-fail'

  return { attestation, signatureValid, recognized, status, reasons, verifier }
}

export async function evaluateRendering(
  rendering: Rendering,
  attestations: Attestation[],
  registry: VerifierRegistry,
  policy: VerificationPolicy,
): Promise<RenderingEvaluation> {
  const evaluations = await Promise.all(
    attestations.map((attestation) => evaluateAttestation(rendering, attestation, registry, policy)),
  )
  const claim = attestations[0]?.judgment.claim
  const rule = policy.rules.find((entry) => entry.claim === claim)
  const recognizedPasses = new Set(
    evaluations
      .filter((item) => item.status === 'recognized-pass')
      .map((item) => item.attestation.verifier.id),
  ).size
  const hasBlockingFailure = Boolean(
    rule?.recognized_failures_block && evaluations.some((item) => item.status === 'recognized-fail'),
  )

  return {
    recognized: Boolean(rule && recognizedPasses >= rule.minimum_passes && !hasBlockingFailure),
    passes: recognizedPasses,
    threshold: rule?.minimum_passes ?? 0,
    evaluations,
  }
}

// RFC 8032 test-vector key used only to validate the deliberately unrecognized demo signature.
export const UNRECOGNIZED_PUBLIC_KEY = 'PUAXw+hDiVqStwqnTRt+vJyYLM8uxJaMwM1V8Sr0Zgw='
