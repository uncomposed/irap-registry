/**
 * RFC 8785-compatible canonical JSON for the protocol's JSON-compatible data.
 * JSON.stringify supplies ECMAScript number/string serialization; object keys
 * are recursively sorted by UTF-16 code units as required by JCS.
 */
export function canonicalize(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value)
  }

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('JCS does not permit non-finite numbers')
    return JSON.stringify(value)
  }

  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(',')}]`
  }

  if (typeof value === 'object') {
    const record = value as Record<string, unknown>
    const entries = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalize(record[key])}`)
    return `{${entries.join(',')}}`
  }

  throw new TypeError(`JCS cannot encode ${typeof value}`)
}

export function unsignedAttestation<T extends { signature: unknown }>({ signature: _signature, ...payload }: T) {
  return payload
}
