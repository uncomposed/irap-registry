import { createHash, createSign, createVerify, timingSafeEqual } from 'node:crypto'

export type SignatureRequest = {
  method: string
  path: string
  headers: Record<string, string | string[] | undefined>
  body: string
}

export type ResolvedSigningKey = {
  id: string
  owner: string
  publicKeyPem: string
}

function digest(body: string) {
  return `SHA-256=${createHash('sha256').update(body).digest('base64')}`
}

function safeTextEqual(left: string, right: string) {
  const leftBuffer = Buffer.from(left)
  const rightBuffer = Buffer.from(right)
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer)
}

function signatureParameters(value: string) {
  const normalized = value.replace(/^Signature\s+/i, '')
  const result: Record<string, string> = {}
  for (const match of normalized.matchAll(/([a-zA-Z][a-zA-Z0-9_-]*)="([^"]*)"/g)) result[match[1]] = match[2]
  return result
}

function headerValue(headers: SignatureRequest['headers'], name: string) {
  const value = headers[name.toLowerCase()]
  return Array.isArray(value) ? value.join(', ') : value
}

export function createSignedPostHeaders(urlValue: string, body: string, keyId: string, privateKeyPem: string) {
  const url = new URL(urlValue)
  const date = new Date().toUTCString()
  const bodyDigest = digest(body)
  const contentType = 'application/activity+json'
  const signingString = [
    `(request-target): post ${url.pathname}${url.search}`,
    `host: ${url.host}`,
    `date: ${date}`,
    `digest: ${bodyDigest}`,
    `content-type: ${contentType}`,
  ].join('\n')
  const signer = createSign('RSA-SHA256')
  signer.update(signingString)
  signer.end()
  const signature = signer.sign(privateKeyPem, 'base64')
  return {
    host: url.host,
    date,
    digest: bodyDigest,
    'content-type': contentType,
    accept: 'application/activity+json, application/ld+json',
    signature: `keyId="${keyId}",algorithm="rsa-sha256",headers="(request-target) host date digest content-type",signature="${signature}"`,
  }
}

export async function verifySignedPost(
  request: SignatureRequest,
  resolveKey: (keyId: string) => Promise<ResolvedSigningKey>,
) {
  const signatureHeader = headerValue(request.headers, 'signature') ?? headerValue(request.headers, 'authorization')
  if (!signatureHeader) throw new Error('Missing HTTP Signature header.')
  const parameters = signatureParameters(signatureHeader)
  if (!parameters.keyId || !parameters.signature) throw new Error('Malformed HTTP Signature header.')
  if (parameters.algorithm && !['rsa-sha256', 'hs2019'].includes(parameters.algorithm.toLowerCase())) {
    throw new Error('Unsupported HTTP signature algorithm.')
  }

  const signedHeaders = (parameters.headers ?? '(request-target) host date').toLowerCase().split(/\s+/)
  for (const required of ['(request-target)', 'host', 'date', 'digest']) {
    if (!signedHeaders.includes(required)) throw new Error(`HTTP signature does not cover ${required}.`)
  }
  const dateHeader = headerValue(request.headers, 'date')
  if (!dateHeader || !Number.isFinite(Date.parse(dateHeader))) throw new Error('Missing or invalid Date header.')
  if (Math.abs(Date.now() - Date.parse(dateHeader)) > 15 * 60 * 1000) throw new Error('HTTP signature Date is outside the 15-minute acceptance window.')

  const receivedDigest = headerValue(request.headers, 'digest')
  const digestMatch = receivedDigest?.match(/^sha-256=([A-Za-z0-9+/]+={0,2})$/i)
  const normalizedDigest = digestMatch ? `SHA-256=${digestMatch[1]}` : ''
  if (!normalizedDigest || !safeTextEqual(normalizedDigest, digest(request.body))) throw new Error('Request digest does not match the body.')

  const signingString = signedHeaders.map((name) => {
    if (name === '(request-target)') return `(request-target): ${request.method.toLowerCase()} ${request.path}`
    const value = headerValue(request.headers, name)
    if (value === undefined) throw new Error(`Signed header is missing: ${name}.`)
    return `${name}: ${value}`
  }).join('\n')

  const key = await resolveKey(parameters.keyId)
  if (key.id !== parameters.keyId) throw new Error('Resolved public key does not match keyId.')
  const verifier = createVerify('RSA-SHA256')
  verifier.update(signingString)
  verifier.end()
  if (!verifier.verify(key.publicKeyPem, parameters.signature, 'base64')) throw new Error('HTTP signature verification failed.')
  return key
}
