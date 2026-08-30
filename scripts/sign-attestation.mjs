import { sign } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'

function canonicalize(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('JCS does not permit non-finite numbers.')
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`
  if (typeof value === 'object') {
    return `{${Object.keys(value).filter((key) => value[key] !== undefined).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(',')}}`
  }
  throw new TypeError(`JCS cannot encode ${typeof value}.`)
}

const [inputPath, privateKeyPath, outputPath] = process.argv.slice(2)
if (!inputPath || !privateKeyPath) {
  throw new Error('Usage: node scripts/sign-attestation.mjs <unsigned.json> <ed25519-private.pem> [signed.json]')
}
const document = JSON.parse(await readFile(inputPath, 'utf8'))
if (!document?.attestation || typeof document.attestation !== 'object') throw new Error('Input does not contain an attestation object.')
const unsigned = { ...document, attestation: { ...document.attestation } }
delete unsigned.attestation.signature
const canonicalPayload = canonicalize(unsigned)
const signature = sign(null, Buffer.from(canonicalPayload), await readFile(privateKeyPath)).toString('base64url')
const signed = {
  ...unsigned,
  attestation: {
    ...unsigned.attestation,
    signature: { algorithm: 'Ed25519', canonicalization: 'RFC8785-JCS', value: signature },
  },
}
const output = `${JSON.stringify(signed, null, 2)}\n`
if (outputPath) await writeFile(outputPath, output, { mode: 0o600 })
else process.stdout.write(output)
