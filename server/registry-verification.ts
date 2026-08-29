import { createPublicKey, verify as verifySignature } from 'node:crypto'
import { parse } from 'yaml'
import type { AttestationRow, IdeaStateRow, RenderingRow } from './database.js'
import type { AttestationDocument, RenderingDocument } from './irap.js'

type RegistryKey = { id?: unknown; algorithm?: unknown; public_key_base64?: unknown; public_key_multibase?: unknown }
type RegistryVerifier = { id?: unknown; keys?: unknown }
type RegistryDocument = { spec_version?: unknown; verifiers?: unknown }
type RecognitionRule = { type?: unknown; count?: unknown; result?: unknown; groups?: unknown }
type ClaimPolicy = { recognition?: { eligible_verifiers?: { ids?: unknown }; rule?: RecognitionRule } }
type PolicyDocument = { spec_version?: unknown; claims?: Record<string, ClaimPolicy> }

export type VerificationResult = {
  signature_valid: boolean
  recognized: boolean
  recognition_status: 'recognized' | 'unrecognized' | 'invalid' | 'indeterminate'
  recognition_reasons: string[]
  policy_commit: string
  claim: string
  result: 'pass' | 'fail' | 'abstain' | 'indeterminate'
  verifier_id: string
  canonical_unsigned_json: string
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('JCS does not permit non-finite numbers.')
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record).filter((key) => record[key] !== undefined).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(record[key])}`).join(',')}}`
  }
  throw new TypeError(`JCS cannot encode ${typeof value}.`)
}

function decodeBase58(value: string) {
  const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
  let number = 0n
  for (const character of value) {
    const index = alphabet.indexOf(character)
    if (index < 0) throw new Error('Invalid base58 public key.')
    number = number * 58n + BigInt(index)
  }
  let hex = number.toString(16)
  if (hex.length % 2) hex = `0${hex}`
  const bytes = hex ? Buffer.from(hex, 'hex') : Buffer.alloc(0)
  let leading = 0
  while (value[leading] === '1') leading += 1
  return Buffer.concat([Buffer.alloc(leading), bytes])
}

function rawPublicKey(key: RegistryKey) {
  let bytes: Buffer
  if (typeof key.public_key_base64 === 'string') bytes = Buffer.from(key.public_key_base64, 'base64')
  else if (typeof key.public_key_multibase === 'string' && key.public_key_multibase.startsWith('z')) {
    bytes = decodeBase58(key.public_key_multibase.slice(1))
    if (bytes.length === 34 && bytes[0] === 0xed && bytes[1] === 0x01) bytes = bytes.subarray(2)
  } else throw new Error('Historical verifier key has no supported public-key encoding.')
  if (bytes.length !== 32) throw new Error('Historical Ed25519 public key must contain 32 raw bytes.')
  return bytes
}

function publicKeyObject(key: RegistryKey) {
  const prefix = Buffer.from('302a300506032b6570032100', 'hex')
  return createPublicKey({ key: Buffer.concat([prefix, rawPublicKey(key)]), format: 'der', type: 'spki' })
}

function historicalDocuments(state: IdeaStateRow) {
  const registry = parse(state.verifiers_yaml) as RegistryDocument
  const policy = parse(state.policy_yaml) as PolicyDocument
  if (registry?.spec_version !== '0.1' || !Array.isArray(registry.verifiers)) throw new Error('Historical verifier registry is not IRAP 0.1.')
  if (policy?.spec_version !== '0.1' || !policy.claims || typeof policy.claims !== 'object') throw new Error('Historical verification policy is not IRAP 0.1.')
  return { registry, policy }
}

function verifierKey(registry: RegistryDocument, verifierId: string, keyId: string) {
  const verifier = (registry.verifiers as RegistryVerifier[]).find((entry) => entry?.id === verifierId)
  if (!verifier || !Array.isArray(verifier.keys)) return { verifier: undefined, key: undefined }
  const key = (verifier.keys as RegistryKey[]).find((entry) => entry?.id === keyId && String(entry.algorithm).toLowerCase() === 'ed25519')
  return { verifier, key }
}

export function evaluateAttestation(
  document: AttestationDocument,
  rendering: RenderingRow,
  renderingDocument: RenderingDocument,
  state: IdeaStateRow,
): VerificationResult {
  const received = document.attestation
  const rendered = renderingDocument.rendering
  const reasons: string[] = []
  const { registry, policy } = historicalDocuments(state)
  const claimPolicy = policy.claims?.[received.judgment.claim]
  const eligibleIds = claimPolicy?.recognition?.eligible_verifiers?.ids
  const eligible = Array.isArray(eligibleIds) && eligibleIds.includes(received.verifier.id)

  if (received.rendering.id !== rendering.rendering_uri) reasons.push('Attestation rendering ID does not match the stored rendering.')
  if (received.rendering.artifact_digest !== rendering.artifact_digest) reasons.push('Attestation artifact digest does not match the stored rendering.')
  if (received.against.idea_id !== rendering.idea_id || received.against.idea_id !== rendered.renders.idea_id) reasons.push('Attestation idea ID does not match the rendering.')
  if (received.against.git.repository !== state.repository || received.against.git.repository !== rendered.renders.git.repository) reasons.push('Attestation repository does not match the historical state.')
  if (received.against.git.object_format !== state.object_format || received.against.git.object_format !== rendered.renders.git.object_format) reasons.push('Attestation Git object format does not match the historical state.')
  if (received.against.git.commit !== state.commit_value || received.against.git.commit !== rendered.renders.git.commit) reasons.push('Attestation commit does not match the historical state.')
  if (!claimPolicy?.recognition?.rule) reasons.push('Historical policy does not define the attested claim.')

  const { verifier, key } = verifierKey(registry, received.verifier.id, received.verifier.key_id)
  const unsigned = { ...document, attestation: { ...received, signature: undefined } }
  const canonicalUnsignedJson = canonicalize(unsigned)
  let signatureValid = false
  if (!verifier) reasons.push('Verifier is absent from the historical registry; its signature cannot be resolved locally.')
  else if (!key) reasons.push('Verifier key ID is absent or is not Ed25519 in the historical registry.')
  else {
    try {
      signatureValid = verifySignature(null, Buffer.from(canonicalUnsignedJson), publicKeyObject(key), Buffer.from(received.signature.value, 'base64url'))
    } catch {
      signatureValid = false
    }
    if (!signatureValid) reasons.push('Ed25519 signature does not verify over the RFC 8785 canonical payload.')
  }
  if (signatureValid && !eligible) reasons.push('Valid signer is not eligible for this claim under the historical policy.')

  const bindingInvalid = reasons.some((reason) => reason.includes('does not match') || reason.includes('does not define'))
  const recognized = signatureValid && eligible && !bindingInvalid
  const recognitionStatus = recognized ? 'recognized' : bindingInvalid || (key && !signatureValid) ? 'invalid' : signatureValid ? 'unrecognized' : 'indeterminate'
  return {
    signature_valid: signatureValid,
    recognized,
    recognition_status: recognitionStatus,
    recognition_reasons: reasons,
    policy_commit: state.commit_value,
    claim: received.judgment.claim,
    result: received.judgment.result,
    verifier_id: received.verifier.id,
    canonical_unsigned_json: canonicalUnsignedJson,
  }
}

export function aggregateRecognition(state: IdeaStateRow, rows: AttestationRow[]) {
  const { policy } = historicalDocuments(state)
  const output: Record<string, unknown> = {}
  for (const [claim, claimPolicy] of Object.entries(policy.claims ?? {})) {
    const rule = claimPolicy.recognition?.rule
    const recognizedRows = rows.filter((row) => row.claim === claim && row.signature_valid === 1 && row.recognition_status === 'recognized')
    const idsFor = (result: string) => [...new Set(recognizedRows.filter((row) => row.result === result).map((row) => row.verifier_uri))]
    let recognized = false
    let qualifyingVerifierIds: string[] = []
    if (rule?.type === 'any_one_pass') {
      qualifyingVerifierIds = idsFor('pass')
      recognized = qualifyingVerifierIds.length > 0
    } else if (rule?.type === 'threshold' && Number.isInteger(rule.count) && typeof rule.result === 'string') {
      qualifyingVerifierIds = idsFor(rule.result)
      recognized = qualifyingVerifierIds.length >= Number(rule.count)
    } else if (rule?.type === 'all_groups' && Array.isArray(rule.groups) && typeof rule.result === 'string') {
      qualifyingVerifierIds = idsFor(rule.result)
      recognized = (rule.groups as unknown[]).every((group) => Array.isArray(group) && group.some((id) => qualifyingVerifierIds.includes(String(id))))
    }
    output[claim] = {
      recognized,
      rule: rule ?? null,
      qualifying_verifier_ids: qualifyingVerifierIds,
      disagreement: new Set(recognizedRows.map((row) => row.result)).size > 1,
      attestation_count: rows.filter((row) => row.claim === claim).length,
    }
  }
  return output
}
