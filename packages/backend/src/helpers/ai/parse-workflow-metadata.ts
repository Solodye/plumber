import { parse as parseYaml } from 'yaml'
import z from 'zod/v3'
import { fromZodError } from 'zod-validation-error'

import { BadUserInputError } from '@/errors/graphql-errors'

export type WorkflowData = ReturnType<typeof parseWorkflowMetadata>

// Converts a ZodError into a user-facing message with workflow-specific context.
// - invalid_union: the appKey/key combo didn't match any known app, so we report
//   which step (trigger or action at step N) is invalid.
// - custom: emitted by validateActionStepsRules (if-then, for-each, delay
//   ordering rules); those messages are already human-readable, so pass through.
// - fallback: fromZodError for anything else (e.g. missing fields, array length).
function formatWorkflowError(
  error: z.ZodError,
  workflowData?: WorkflowData,
): string {
  for (const issue of error.issues) {
    if (issue.code === z.ZodIssueCode.invalid_union) {
      const [field, index] = issue.path

      if (field === 'trigger' && workflowData) {
        return `Invalid trigger detected. Modify the prompt and try again.`
      }

      if (field === 'actions' && typeof index === 'number' && workflowData) {
        // actions[0] is step 2 (step 1 is the trigger), so offset by 2
        const stepNum = index + 2
        return `Invalid action detected at step ${stepNum}. Modify the prompt and try again.`
      }
    }

    if (issue.code === z.ZodIssueCode.custom && issue.message) {
      return issue.message
    }
  }

  return fromZodError(error).message
}

function parseWorkflowMetadata(text: string) {
  const match = text.match(/<!--\s*WORKFLOW_METADATA\s*([\s\S]*?)-->/)
  if (!match) {
    throw new BadUserInputError(
      'Unable to generate the workflow. Modify the prompt and try again.',
    )
  }

  let parsed: any
  try {
    parsed = parseYaml(match[1].trim())
  } catch {
    throw new BadUserInputError(
      'Unable to generate the workflow. Modify the prompt and try again.',
    )
  }

  if (
    !parsed?.steps ||
    !Array.isArray(parsed.steps) ||
    parsed.steps.length === 0
  ) {
    throw new BadUserInputError(
      'Unable to generate the workflow. Modify the prompt and try again.',
    )
  }

  const [firstStep, ...remainingSteps] = parsed.steps

  return {
    name: String(parsed.name ?? 'Build with AI').slice(0, 64),
    trigger: {
      type: 'trigger' as const,
      appKey: firstStep.appKey,
      key: firstStep.key,
      description: String(firstStep.description ?? ''),
    },
    actions: remainingSteps.map((step: any) => ({
      type: 'action' as const,
      appKey: step.appKey,
      key: step.key,
      description: String(step.description ?? ''),
      config: {
        stepName: String(step.description ?? step.key ?? '').slice(0, 64),
      },
    })),
  }
}

export { formatWorkflowError, parseWorkflowMetadata }
