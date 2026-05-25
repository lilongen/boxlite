/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { useEffect, useRef, useState } from 'react'
import { useApi } from './useApi'

// Local type stubs — these mirror apps/api/src/admin/dto/runner-ops.dto.ts.
// Replace with imports from @boxlite-ai/api-client once api-client is regenerated.
export type JobStatus = 'PENDING' | 'RUNNING' | 'SUCCESS' | 'FAILED' | 'CANCEL_REQUESTED' | 'STALE'

export interface JobErrorDto {
  message: string
  stage?: number
}

export interface Job {
  id: string
  kind: 'add-shared' | 'scale-down'
  status: JobStatus
  startedAt: string
  finishedAt?: string
  currentStage?: number
  totalStages?: number
  lines: string[]
  exitCode?: number
  result?: unknown
  error?: JobErrorDto
}

const POLL_MS = 2000
const TERMINAL: JobStatus[] = ['SUCCESS', 'FAILED', 'STALE']

export interface UseRunnerOpsJobState {
  job: Job | null
  status: JobStatus | undefined
  lines: string[]
  result: unknown
  error: Error | null
  loading: boolean
}

export function useRunnerOpsJob(jobId: string | null): UseRunnerOpsJobState {
  const apiClient = useApi() as any // ApiClient instance
  const [job, setJob] = useState<Job | null>(null)
  const [error, setError] = useState<Error | null>(null)
  const [loading, setLoading] = useState(false)
  const cancelled = useRef(false)

  useEffect(() => {
    cancelled.current = false
    if (!jobId) {
      setJob(null)
      return
    }

    setLoading(true)

    const tick = async () => {
      if (cancelled.current) return

      try {
        // Use the apiClient's axiosInstance to make authenticated requests
        const axiosInstance = apiClient.axiosInstance
        const res = await axiosInstance.get(`/api/admin/runner-ops/jobs/${jobId}`)

        if (cancelled.current) return

        const data = res.data as Job
        setJob(data)
        setError(null)
        setLoading(false)

        // Stop polling if terminal state reached
        if (data && !TERMINAL.includes(data.status)) {
          setTimeout(tick, POLL_MS)
        }
      } catch (e) {
        if (cancelled.current) return

        setError(e as Error)
        setLoading(false)
      }
    }

    tick()

    return () => {
      cancelled.current = true
    }
  }, [jobId, apiClient])

  return {
    job,
    status: job?.status,
    lines: job?.lines ?? [],
    result: job?.result,
    error,
    loading,
  }
}
