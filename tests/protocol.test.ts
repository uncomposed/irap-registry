import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { load } from 'js-yaml'
import { canonicalize } from '../src/domain/canonicalize'
import { evaluateAttestation, evaluateRendering, isFullGitObjectId } from '../src/domain/verification'
import { attestations, ideaState, policy, rendering, verifierRegistry } from '../src/data/demo'
import type { Attestation } from '../src/domain/types'

describe('IRAP protocol package', () => {
  it('parses the normative YAML and contains all six typed objects', () => {
    const spec = load(readFileSync(resolve('SPEC.yaml'), 'utf8')) as Record<string, unknown>
    const model = spec.object_model as Record<string, unknown>
    expect(Object.keys(model)).toEqual([
      'idea',
      'state',
      'rendering',
      'attestation',
      'verifier_registry',
      'verification_policy',
    ])
  })

  it('requires full Git object IDs', () => {
    expect(isFullGitObjectId(ideaState)).toBe(true)
    expect(isFullGitObjectId({ ...ideaState, git_commit: { algorithm: 'sha1', value: '7f4d8a5' } })).toBe(false)
    expect(isFullGitObjectId({ ...ideaState, git_commit: { algorithm: 'sha256', value: 'a'.repeat(64) } })).toBe(true)
  })
})

describe('canonical signed projection', () => {
  it('is invariant to object key insertion order', () => {
    const left = { z: 3, nested: { beta: true, alpha: 'one' }, a: [2, 1] }
    const right = { a: [2, 1], nested: { alpha: 'one', beta: true }, z: 3 }
    expect(canonicalize(left)).toBe(canonicalize(right))
    expect(canonicalize(left)).toBe('{"a":[2,1],"nested":{"alpha":"one","beta":true},"z":3}')
  })
})

describe('historical verification evaluation', () => {
  it('distinguishes recognized, valid-unrecognized, and invalid records', async () => {
    const result = await evaluateRendering(rendering, attestations, verifierRegistry, policy)
    expect(result.recognized).toBe(true)
    expect(result.passes).toBe(1)
    expect(result.evaluations.map((entry) => entry.status)).toEqual([
      'recognized-pass',
      'valid-unrecognized',
      'invalid',
    ])
  })

  it('invalidates a signed payload when its evidence is altered', async () => {
    const altered: Attestation = {
      ...attestations[0],
      evidence: { ...attestations[0].evidence, summary: 'Altered after signing.' },
    }
    const result = await evaluateAttestation(rendering, altered, verifierRegistry, policy)
    expect(result.signatureValid).toBe(false)
    expect(result.status).toBe('invalid')
  })

  it('rejects a current policy substituted for the historical policy', async () => {
    const currentPolicy = {
      ...policy,
      state: {
        ...ideaState,
        git_commit: { algorithm: 'sha1' as const, value: 'a'.repeat(40) },
      },
    }
    const result = await evaluateAttestation(rendering, attestations[0], verifierRegistry, currentPolicy)
    expect(result.status).toBe('invalid')
    expect(result.reasons.join(' ')).toContain('historical state')
  })

  it('rejects an artifact swapped beneath a valid signature', async () => {
    const swapped = {
      ...rendering,
      artifact: { ...rendering.artifact, sha256: 'b'.repeat(64) },
    }
    const result = await evaluateAttestation(swapped, attestations[0], verifierRegistry, policy)
    expect(result.status).toBe('invalid')
    expect(result.reasons.join(' ')).toContain('artifact')
  })
})
