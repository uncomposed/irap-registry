import type { Attestation, Rendering, VerificationPolicy, VerifierRegistry } from '../domain/types'

export const ideaState = {
  idea_id: 'https://proximitytoprogress.com/ideas/irap',
  repository: 'https://git.example.org/proximity/irap.git',
  git_commit: {
    algorithm: 'sha1' as const,
    value: '7f4d8a56e2b9c130af8972bb3b7c63aa4b871e0d',
  },
}

export const rendering: Rendering = {
  protocol_version: 'irap/0.1',
  id: 'https://renderings.example/irap-field-guide',
  title: 'A Field Guide to Attributable Verification',
  description:
    'An interactive explanation of how an idea becomes an exact state, a rendering, and an attributable judgment.',
  renders: ideaState,
  artifact: {
    uri: 'https://renderings.example/irap-field-guide/',
    media_type: 'text/html',
    sha256: '9295f8f178586e5a5e1f4d198748dd841f29ba76709f697c3553b5f9358f36aa',
  },
  creator: {
    id: 'https://studio.example/people/lena-ortiz',
    name: 'Lena Ortiz',
  },
  created_at: '2026-08-27T16:20:00Z',
}

export const verifierRegistry: VerifierRegistry = {
  protocol_version: 'irap/0.1',
  state: ideaState,
  verifiers: [
    {
      id: 'did:key:mira-chen',
      name: 'Mira Chen',
      kind: 'human',
      key: {
        id: 'did:key:mira-chen#primary',
        algorithm: 'ed25519',
        public_key: '11qYAYKxCrfVS/7TyWQHOg7hcvPapiMlrwIaaPcHURo=',
      },
      scopes: ['faithful_rendering'],
      provenance: 'Independent protocol editor',
    },
  ],
}

export const policy: VerificationPolicy = {
  protocol_version: 'irap/0.1',
  state: ideaState,
  rules: [
    {
      claim: 'faithful_rendering',
      eligible_verifiers: ['did:key:mira-chen'],
      minimum_passes: 1,
      recognized_failures_block: true,
    },
  ],
}

export const attestations: Attestation[] = [
  {
    protocol_version: 'irap/0.1',
    id: 'https://reviews.example/attestations/mira-2026-08-28',
    rendering: { id: rendering.id, sha256: rendering.artifact.sha256 },
    against: ideaState,
    verifier: { id: 'did:key:mira-chen', key_id: 'did:key:mira-chen#primary' },
    judgment: { claim: 'faithful_rendering', result: 'pass' },
    evidence: {
      uri: 'https://reviews.example/packages/irap-field-guide-mira',
      sha256: 'd82c9fdcf9786bcada26727d2dc09dfb3b595395335c90b1c67bb23012abc31f',
      summary: 'Compared all five protocol objects, three status boundaries, and the historical-policy lookup.',
    },
    signed_at: '2026-08-28T14:32:00Z',
    signature: {
      algorithm: 'ed25519',
      value: 'oLsoaLJH7Kyxexq9A2Aqd9GktIckj8SZq+jAqycZB9fhvUs9uCFCs+S0oqyEy5N90Chb5ZHDYP5csSUIoTTIBg==',
    },
  },
  {
    protocol_version: 'irap/0.1',
    id: 'https://reviews.example/attestations/review-bot-2026-08-28',
    rendering: { id: rendering.id, sha256: rendering.artifact.sha256 },
    against: ideaState,
    verifier: { id: 'did:key:review-bot', key_id: 'did:key:review-bot#run-1842' },
    judgment: { claim: 'faithful_rendering', result: 'pass' },
    evidence: {
      uri: 'https://reviews.example/packages/irap-field-guide-agent',
      sha256: '29f628e91f18c841253e25b7d06b0452f4d877ec8328f58edcc8628d423d3525',
      summary: 'Automated comparison found the rendering semantically complete; the signer is not policy-authorized.',
    },
    signed_at: '2026-08-28T15:11:00Z',
    signature: {
      algorithm: 'ed25519',
      value: '6fUSF7zbgg/5Hkj9ZieshHMM0UuXdEkdxJD5rHm/o3IEbiO0Lt+/4lP9B9//ZFcF6CP6da7ttVXuItNyMmQFAA==',
    },
  },
  {
    protocol_version: 'irap/0.1',
    id: 'https://reviews.example/attestations/mira-damaged-copy',
    rendering: { id: rendering.id, sha256: rendering.artifact.sha256 },
    against: ideaState,
    verifier: { id: 'did:key:mira-chen', key_id: 'did:key:mira-chen#primary' },
    judgment: { claim: 'faithful_rendering', result: 'pass' },
    evidence: {
      uri: 'https://reviews.example/packages/damaged-copy',
      sha256: '742d2cae28a773209012b710cbb9da94f9bd944325f84be53f94a91e7661e840',
      summary: 'This record was altered after signing to demonstrate a failed cryptographic check.',
    },
    signed_at: '2026-08-28T16:04:00Z',
    signature: {
      algorithm: 'ed25519',
      value: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==',
    },
  },
]
