import { UnrecoverableError } from '@taskforcesh/bullmq-pro'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { processAction } from '../action'

const mocks = vi.hoisted(() => {
  const executionStep = { id: 'exec-step-id', isFailed: false, status: 'success' }
  const execution = {
    id: 'execution-id',
    $relatedQuery: vi.fn(() => ({
      insertAndFetch: vi.fn(() => executionStep),
    })),
  }
  const step = {
    id: 'step-id',
    appKey: 'webhook',
    parameters: {},
    key: 'new-submission',
    config: {},
    getApp: vi.fn(() => ({ key: 'webhook' })),
    getActionCommand: vi.fn(() => ({
      run: vi.fn(),
      preprocessVariable: undefined,
    })),
    getNextStep: vi.fn(() => null),
    $relatedQuery: vi.fn(() => null),
  }
  const flow = {
    id: 'flow-id',
    config: null as { isKillswitched?: boolean } | null,
    user: { email: 'test@example.com' },
    steps: [],
  }

  return {
    step,
    flow,
    execution,
    executionStep,
    globalVariable: vi.fn(() => ({
      step: { parameters: {} },
      actionOutput: { data: null, error: null },
      execution: { id: 'execution-id' },
      app: { key: 'webhook' },
    })),
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
        withGraphJoined: vi.fn(() => ({
          withGraphFetched: vi.fn(() => ({
            throwIfNotFound: vi.fn(() => mocks.flow),
          })),
        })),
      })),
    })),
  },
}))

vi.mock('@/models/execution', () => ({
  default: {
    query: vi.fn(() => ({
      findById: vi.fn(() => ({
        throwIfNotFound: vi.fn(() => mocks.execution),
      })),
    })),
  },
}))

vi.mock('@/models/execution-step', () => ({
  default: {
    query: vi.fn(() => ({
      where: vi.fn(() => []),
    })),
  },
}))

vi.mock('@/helpers/compute-for-each-parameters', () => ({
  getStepContext: vi.fn(() => ({
    forEachStepPosition: -1,
    stepPositions: [],
    isForEachStep: false,
    isLastStep: false,
  })),
}))

vi.mock('@/helpers/compute-parameters', () => ({
  default: vi.fn(() => ({})),
}))

vi.mock('@/helpers/global-variable', () => ({
  default: mocks.globalVariable,
}))

vi.mock('@/helpers/logger', () => ({
  default: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}))

vi.mock('@/services/helpers/get-for-each-metadata', () => ({
  default: vi.fn(),
}))

vi.mock('@/queues/action', () => ({
  enqueueActionJob: vi.fn(),
}))

const OPTIONS = {
  flowId: 'flow-id',
  stepId: 'step-id',
  executionId: 'execution-id',
}

describe('processAction', () => {
  beforeEach(() => {
    mocks.flow.config = null
    mocks.executionStep.isFailed = false
    mocks.executionStep.status = 'success'
  })

  describe('pipe killswitch', () => {
    it('sets executionError to UnrecoverableError when flow.config.isKillswitched is true', async () => {
      mocks.flow.config = { isKillswitched: true }
      mocks.executionStep.isFailed = true
      mocks.executionStep.status = 'failure'

      const result = await processAction(OPTIONS)

      expect(result.executionError).toBeInstanceOf(UnrecoverableError)
    })

    it('does not set executionError when flow.config.isKillswitched is false', async () => {
      mocks.flow.config = { isKillswitched: false }

      const result = await processAction(OPTIONS)

      expect(result.executionError).toBeNull()
    })

    it('does not set executionError when flow has no config', async () => {
      mocks.flow.config = null

      const result = await processAction(OPTIONS)

      expect(result.executionError).toBeNull()
    })
  })
})
