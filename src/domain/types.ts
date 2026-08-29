export type ObjectHash = {
  algorithm: 'sha1' | 'sha256'
  value: string
}

export type StateReference = {
  idea_id: string
  repository: string
  git_commit: ObjectHash
}

export type Rendering = {
  protocol_version: 'irap/0.1'
  id: string
  title: string
  description: string
  renders: StateReference
  artifact: {
    uri: string
    media_type: string
    sha256: string
  }
  creator: {
    id: string
    name: string
  }
  created_at: string
}

export type AttestationPayload = {
  protocol_version: 'irap/0.1'
  id: string
  rendering: {
    id: string
    sha256: string
  }
  against: StateReference
  verifier: {
    id: string
    key_id: string
  }
  judgment: {
    claim: string
    result: 'pass' | 'fail'
  }
  evidence: {
    uri: string
    sha256: string
    summary: string
  }
  signed_at: string
}

export type Attestation = AttestationPayload & {
  signature: {
    algorithm: 'ed25519'
    value: string
  }
}

export type Verifier = {
  id: string
  name: string
  kind: 'human' | 'ai' | 'organization'
  key: {
    id: string
    algorithm: 'ed25519'
    public_key: string
  }
  scopes: string[]
  provenance?: string
}

export type VerifierRegistry = {
  protocol_version: 'irap/0.1'
  state: StateReference
  verifiers: Verifier[]
}

export type VerificationRule = {
  claim: string
  eligible_verifiers: string[]
  minimum_passes: number
  recognized_failures_block: boolean
}

export type VerificationPolicy = {
  protocol_version: 'irap/0.1'
  state: StateReference
  rules: VerificationRule[]
}

export type AttestationStatus =
  | 'recognized-pass'
  | 'recognized-fail'
  | 'valid-unrecognized'
  | 'invalid'

export type AttestationEvaluation = {
  attestation: Attestation
  signatureValid: boolean
  recognized: boolean
  status: AttestationStatus
  reasons: string[]
  verifier?: Verifier
}

export type RenderingEvaluation = {
  recognized: boolean
  passes: number
  threshold: number
  evaluations: AttestationEvaluation[]
}
