import { describe, expect, it } from 'vitest'
import type { AttestationRow, IdeaStateRow } from '../server/database'
import { aggregateRecognition } from '../server/registry-verification'

function state(policyYaml: string): IdeaStateRow {
  return {
    id: 'state', idea_id: 'idea', repository: 'https://git.example/idea.git', object_format: 'sha1', commit_value: 'a'.repeat(40),
    source_revision: 'refs/heads/main', manifest_yaml: 'spec_version: "0.1"', verifiers_yaml: 'spec_version: "0.1"\nverifiers: []', policy_yaml: policyYaml, resolved_at: '2026-08-29T00:00:00Z',
  }
}

function attestation(id: string, verifier: string, result: AttestationRow['result']): AttestationRow {
  return {
    id, attestation_uri: `https://attestations.example/${id}`, rendering_id: 'rendering', target_commit: 'a'.repeat(40), verifier_uri: verifier,
    verifier_key_id: `${verifier}#key`, claim: 'faithful_rendering', result, note: null, issued_at: '2026-08-29T00:00:00Z',
    raw_attestation_json: '{}', signature_valid: 1, recognition_status: 'recognized', recognition_reasons_json: '[]', created_at: '2026-08-29T00:00:00Z',
  }
}

describe('policy-driven aggregate recognition', () => {
  it('counts distinct verifier identities for threshold rules', () => {
    const historical = state('spec_version: "0.1"\nclaims:\n  faithful_rendering:\n    recognition:\n      rule:\n        type: threshold\n        count: 2\n        result: pass\n')
    const duplicate = [attestation('1', 'alice', 'pass'), attestation('2', 'alice', 'pass')]
    expect(aggregateRecognition(historical, duplicate).faithful_rendering).toMatchObject({ recognized: false, qualifying_verifier_ids: ['alice'] })
    expect(aggregateRecognition(historical, [...duplicate, attestation('3', 'bob', 'pass')]).faithful_rendering).toMatchObject({ recognized: true, qualifying_verifier_ids: ['alice', 'bob'] })
  })

  it('requires one specified-result verifier from every all-groups group', () => {
    const historical = state('spec_version: "0.1"\nclaims:\n  faithful_rendering:\n    recognition:\n      rule:\n        type: all_groups\n        groups:\n          - [alice, bob]\n          - [carol, dan]\n        result: fail\n')
    expect(aggregateRecognition(historical, [attestation('1', 'bob', 'fail')]).faithful_rendering).toMatchObject({ recognized: false })
    expect(aggregateRecognition(historical, [attestation('1', 'bob', 'fail'), attestation('2', 'carol', 'fail')]).faithful_rendering).toMatchObject({ recognized: true })
  })
})
