import { parseDocument } from 'yaml'
import { z } from 'zod'

const repositoryUrl = z.string().url().refine((value) => ['https:', 'ssh:', 'git:'].includes(new URL(value).protocol), {
  message: 'Repository must use an https, ssh, or git URL.',
})

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

export function escapeHtml(value: string) {
  return value.replace(/[&<>'"]/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
  })[character]!)
}
