/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { useRunnerOpsJob } from '../useRunnerOpsJob'
import { ApiContext } from '@/contexts/ApiContext'
import React from 'react'

vi.useFakeTimers()

function withApi(getJob: (id: string) => Promise<any>) {
  // Mock ApiClient with axiosInstance that has a get method
  const mockAxiosInstance = {
    get: async (url: string) => {
      const match = url.match(/\/api\/admin\/runner-ops\/jobs\/(.+)$/)
      if (match) {
        const jobId = match[1]
        const data = await getJob(jobId)
        return { data }
      }
      throw new Error(`unexpected url: ${url}`)
    },
  }

  const value = {
    axiosInstance: mockAxiosInstance,
  } as any

  return ({ children }: { children: React.ReactNode }) => (
    <ApiContext.Provider value={value}>{children}</ApiContext.Provider>
  )
}

describe('useRunnerOpsJob', () => {
  afterEach(() => {
    vi.clearAllTimers()
  })

  it('polls until SUCCESS and stops', async () => {
    let n = 0
    const get = vi.fn(async () => ({
      id: 'j',
      kind: 'add-shared',
      status: n++ < 2 ? 'RUNNING' : 'SUCCESS',
      startedAt: '2025-05-25T00:00:00Z',
      lines: ['line1'],
    }))

    const { result } = renderHook(() => useRunnerOpsJob('j'), { wrapper: withApi(get) })

    // Initial call should happen immediately
    await waitFor(() => expect(result.current.status).toBe('RUNNING'))

    // Advance timer and wait for next poll
    await act(async () => {
      vi.advanceTimersByTime(2000)
    })
    await waitFor(() => expect(result.current.status).toBe('RUNNING'))

    // Advance timer again - should reach SUCCESS and stop polling
    await act(async () => {
      vi.advanceTimersByTime(2000)
    })
    await waitFor(() => expect(result.current.status).toBe('SUCCESS'))

    // Verify we made exactly 3 calls (initial + 2 polls)
    expect(get).toHaveBeenCalledTimes(3)
  })

  it('stops on unmount', async () => {
    const get = vi.fn(async () => ({
      id: 'j',
      kind: 'add-shared',
      status: 'RUNNING',
      startedAt: '2025-05-25T00:00:00Z',
      lines: [],
    }))

    const { unmount } = renderHook(() => useRunnerOpsJob('j'), { wrapper: withApi(get) })

    // Wait for initial call
    await waitFor(() => expect(get).toHaveBeenCalledTimes(1))

    unmount()

    // Advance timers by a large amount - no more calls should happen
    await act(async () => {
      vi.advanceTimersByTime(10_000)
    })

    expect(get).toHaveBeenCalledTimes(1) // only the initial call
  })

  it('returns null job when jobId is null', () => {
    const get = vi.fn()
    const { result } = renderHook(() => useRunnerOpsJob(null), { wrapper: withApi(get) })

    expect(result.current.job).toBeNull()
    expect(result.current.status).toBeUndefined()
    expect(get).not.toHaveBeenCalled()
  })

  it('exposes job data correctly', async () => {
    const jobData = {
      id: 'job-123',
      kind: 'add-shared' as const,
      status: 'SUCCESS' as const,
      startedAt: '2025-05-25T00:00:00Z',
      finishedAt: '2025-05-25T00:05:00Z',
      currentStage: 3,
      totalStages: 3,
      lines: ['setup', 'running', 'done'],
      exitCode: 0,
      result: { runnerId: 'r-123' },
    }

    const get = vi.fn(async () => jobData)
    const { result } = renderHook(() => useRunnerOpsJob('job-123'), { wrapper: withApi(get) })

    await waitFor(() => expect(result.current.status).toBe('SUCCESS'))

    expect(result.current.job).toEqual(jobData)
    expect(result.current.lines).toEqual(['setup', 'running', 'done'])
    expect(result.current.result).toEqual({ runnerId: 'r-123' })
    expect(result.current.error).toBeNull()
    expect(result.current.loading).toBe(false)
  })

  it('handles fetch errors gracefully', async () => {
    const testError = new Error('Network error')
    const get = vi.fn(async () => {
      throw testError
    })

    const { result } = renderHook(() => useRunnerOpsJob('j'), { wrapper: withApi(get) })

    await waitFor(() => expect(result.current.loading).toBe(false))

    expect(result.current.error).toBe(testError)
    expect(result.current.job).toBeNull()
    expect(result.current.status).toBeUndefined()
  })

  it('stops polling on FAILED status', async () => {
    let n = 0
    const get = vi.fn(async () => ({
      id: 'j',
      kind: 'scale-down',
      status: n++ < 1 ? 'RUNNING' : 'FAILED',
      startedAt: '2025-05-25T00:00:00Z',
      lines: ['error occurred'],
      error: { message: 'scale-down failed', stage: 1 },
    }))

    const { result } = renderHook(() => useRunnerOpsJob('j'), { wrapper: withApi(get) })

    await waitFor(() => expect(result.current.status).toBe('RUNNING'))

    await act(async () => {
      vi.advanceTimersByTime(2000)
    })
    await waitFor(() => expect(result.current.status).toBe('FAILED'))

    // Advance further - should not poll again
    await act(async () => {
      vi.advanceTimersByTime(10_000)
    })

    expect(get).toHaveBeenCalledTimes(2)
  })

  it('returns empty lines array when no lines', async () => {
    const get = vi.fn(async () => ({
      id: 'j',
      kind: 'add-shared',
      status: 'SUCCESS',
      startedAt: '2025-05-25T00:00:00Z',
      lines: [],
    }))

    const { result } = renderHook(() => useRunnerOpsJob('j'), { wrapper: withApi(get) })

    await waitFor(() => expect(result.current.status).toBe('SUCCESS'))

    expect(result.current.lines).toEqual([])
  })
})
