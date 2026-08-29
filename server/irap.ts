import { parseDocument } from 'yaml'
import { z } from 'zod'

const repositoryUrl = z.string().url().refine((value) => ['https:', 'http:'].includes(new URL(value).protocol), {
  message: 'Repository must use an HTTP or HTTPS URL; production resolution requires HTTPS.',
})

const publicUrl = z.string().url().refine((value) => ['https:', 'http:'].includes(new URL(value).protocol), {
  message: 'URL must use HTTP or HTTPS.',
})
const sha256Digest = z.string().regex(/^sha256:[0-9a-f]{64}$/, 'Use sha256: followed by 64 lowercase hexadecimal characters.')
const objectFormat = z.enum(['sha1', 'sha256'])
const fullCommit = z.union([
  z.string().regex(/^[0-9a-f]{40}$/),
  z.string().regex(/^[0-9a-f]{64}$/),
])
const stateGit = z.object({ repository: repositoryUrl, object_format: objectFormat, commit: fullCommit })

export const ideaInputSchema = z.object({
  slug: z.string().min(2).max(64).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Use lowercase letters, numbers, and single hyphens.'),
  name: z.string().min(2).max(140),
  summary: z.string().min(12).max(1000),
  repository: repositoryUrl,
  git_commit: z.discriminatedUnion('algorithm', [
    z.object({ algorithm: z.literal('sha1'), value: z.string().regex(/^[0-9a-f]{40}$/) }),
    z.object({ algorithm: z.literal('sha256'), value: z.string().regex(/^[0-9a-f]{64}$/) }),
  ]),
  spec_yaml: z.string().min(20).max(512_000),
}).superRefine((input, context) => {
  const document = parseDocument(input.spec_yaml)
  if (document.errors.length) {
    context.addIssue({ code: 'custom', path: ['spec_yaml'], message: `Invalid YAML: ${document.errors[0].message}` })
  } else {
    const parsed = document.toJS({ maxAliasCount: 20 })
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      context.addIssue({ code: 'custom', path: ['spec_yaml'], message: 'The idea specification must be a YAML mapping.' })
    }
  }
})

export type IdeaInput = z.infer<typeof ideaInputSchema>

export const renderingSubmissionSchema = z.object({
  idea_slug: z.string().min(2).max(64).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  id: publicUrl.optional(),
  title: z.string().min(1).max(240).optional(),
  description: z.string().max(4000).optional(),
  artifact: z.object({ uri: publicUrl, digest: sha256Digest }),
  target: z.object({
    repository: repositoryUrl,
    object_format: objectFormat,
    revision: z.string().min(1).max(256),
  }),
  creator: z.object({ id: z.string().min(1).max(1000) }),
})

export const renderingDocumentSchema = z.object({
  irap_version: z.literal('0.1'),
  rendering: z.object({
    id: publicUrl,
    title: z.string().max(240).optional(),
    description: z.string().max(4000).optional(),
    artifact: z.object({ uri: publicUrl, digest: sha256Digest }),
    renders: z.object({ idea_id: z.string().min(1), git: stateGit }),
    creator: z.object({ id: z.string().min(1).max(1000) }),
  }),
})

export const attestationDocumentSchema = z.object({
  irap_version: z.literal('0.1'),
  attestation: z.object({
    id: publicUrl,
    rendering: z.object({ id: publicUrl, artifact_digest: sha256Digest }),
    against: z.object({ idea_id: z.string().min(1), git: stateGit }),
    verifier: z.object({ id: z.string().min(1).max(1000), key_id: z.string().min(1).max(1000) }),
    judgment: z.object({
      claim: z.string().min(1).max(200),
      result: z.enum(['pass', 'fail', 'abstain', 'indeterminate']),
      note: z.string().max(8000).optional(),
    }),
    evidence: z.array(z.object({
      uri: publicUrl,
      media_type: z.string().max(200).optional(),
      digest: sha256Digest.optional(),
    })).max(100).optional(),
    issued_at: z.iso.datetime({ offset: true }),
    signature: z.object({
      algorithm: z.literal('Ed25519'),
      canonicalization: z.literal('RFC8785-JCS'),
      value: z.string().regex(/^[A-Za-z0-9_-]+$/, 'Signature must be unpadded base64url.'),
    }),
  }),
})

export type RenderingSubmission = z.infer<typeof renderingSubmissionSchema>
export type RenderingDocument = z.infer<typeof renderingDocumentSchema>
export type AttestationDocument = z.infer<typeof attestationDocumentSchema>

export function escapeHtml(value: string) {
  return value.replace(/[&<>'"]/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
  })[character]!)
}
