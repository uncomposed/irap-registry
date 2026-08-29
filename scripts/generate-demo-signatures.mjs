import { createPrivateKey, sign } from 'node:crypto'

const ideaState = {
  idea_id: 'https://proximitytoprogress.com/ideas/irap',
  repository: 'https://git.example.org/proximity/irap.git',
  git_commit: { algorithm: 'sha1', value: '7f4d8a56e2b9c130af8972bb3b7c63aa4b871e0d' },
}
const rendering = {
  id: 'https://renderings.example/irap-field-guide',
  sha256: '9295f8f178586e5a5e1f4d198748dd841f29ba76709f697c3553b5f9358f36aa',
}

function canonicalize(value) {
  if (value === null || ['boolean', 'number', 'string'].includes(typeof value)) return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(',')}}`
}

function keyFromSeed(seed) {
  const prefix = Buffer.from('302e020100300506032b657004220420', 'hex')
  return createPrivateKey({ key: Buffer.concat([prefix, Buffer.from(seed, 'hex')]), format: 'der', type: 'pkcs8' })
}

function signature(payload, seed) {
  return sign(null, Buffer.from(canonicalize(payload)), keyFromSeed(seed)).toString('base64')
}

const mira = {
  protocol_version: 'irap/0.1',
  id: 'https://reviews.example/attestations/mira-2026-08-28',
  rendering,
  against: ideaState,
  verifier: { id: 'did:key:mira-chen', key_id: 'did:key:mira-chen#primary' },
  judgment: { claim: 'faithful_rendering', result: 'pass' },
  evidence: {
    uri: 'https://reviews.example/packages/irap-field-guide-mira',
    sha256: 'd82c9fdcf9786bcada26727d2dc09dfb3b595395335c90b1c67bb23012abc31f',
    summary: 'Compared all five protocol objects, three status boundaries, and the historical-policy lookup.',
  },
  signed_at: '2026-08-28T14:32:00Z',
}

const bot = {
  protocol_version: 'irap/0.1',
  id: 'https://reviews.example/attestations/review-bot-2026-08-28',
  rendering,
  against: ideaState,
  verifier: { id: 'did:key:review-bot', key_id: 'did:key:review-bot#run-1842' },
  judgment: { claim: 'faithful_rendering', result: 'pass' },
  evidence: {
    uri: 'https://reviews.example/packages/irap-field-guide-agent',
    sha256: '29f628e91f18c841253e25b7d06b0452f4d877ec8328f58edcc8628d423d3525',
    summary: 'Automated comparison found the rendering semantically complete; the signer is not policy-authorized.',
  },
  signed_at: '2026-08-28T15:11:00Z',
}

console.log(JSON.stringify({
  mira: signature(mira, '9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60'),
  botPublicKey: Buffer.from('3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c', 'hex').toString('base64'),
  bot: signature(bot, '4ccd089b28ff96da9db6c346ec114e0f5b8a319f35aba624da8cf6ed4fb8a6fb'),
}, null, 2))
