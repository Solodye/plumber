import { UnrecoverableError } from '@taskforcesh/bullmq-pro'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { processTrigger } from '../trigger'

const mocks = vi.hoisted(() => {
  const executionStep = { id: 'exec-step-id', isFailed: false }
  const execution = {
    id: 'execution-id',
    $relatedQuery: vi.fn(() => ({
      insertAndFetch: vi.fn(() => executionStep),
    })),
  }

  return {
    step: {
      id: 'step-id',
      appKey: 'webhook',
      parameters: {},
      key: 'new-submission',
      config: {},
    },
    flow: {
      id: 'flow-id',
      config: null as { isKillswitched?: boolean } | null,
    },
    execution,
    shouldTriggerProceed: vi.fn(() => ({ shouldExecute: true })),
  }
})

vi.mock('@/models/step', () => ({
  default: {
    query: vi.fn(() => ({
      findById: vi.fn(() => ({
        throwIfNotFound: vi.fn(() => mocks.step),
      })),
    })),
  },
}))

vi.mock('@/models/flow', () => ({
  default: {
    query: vi.fn(() => ({
      findById: vi.fn(() => ({
        throwIfNotFound: vi.fn(() => mocks.flow),
      })),
    })),
  },
}))

vi.mock('@/services/helpers/should-trigger-proceed', () => ({
  shouldTriggerProceed: mocks.shouldTriggerProceed,
}))

vi.mock('@/models/execution', () => ({
  default: {
    query: vi.fn(() => ({
      insert: vi.fn(() => mocks.execution),
    })),
  },
}))

describe('processTrigger', () => {
  beforeEach(() => {
    mocks.flow.config = null
  })

  describe('pipe killswitch', () => {
    it('throws UnrecoverableError when flow.config.isKillswitched is true', async () => {
      mocks.flow.config = { isKillswitched: true }

      await expect(
        processTrigger({ flowId: 'flow-id', stepId: 'step-id' }),
      ).rejects.toThrow(UnrecoverableError)
    })

    it('does not throw when flow.config.isKillswitched is false', async () => {
      mocks.flow.config = { isKillswitched: false }

      await expect(
        processTrigger({ flowId: 'flow-id', stepId: 'step-id' }),
      ).resolves.toMatchObject({ shouldExecute: true })
    })

    it('does not throw when flow has no config', async () => {
      mocks.flow.config = null

      await expect(
        processTrigger({ flowId: 'flow-id', stepId: 'step-id' }),
      ).resolves.toMatchObject({ shouldExecute: true })
    })
  })
})
