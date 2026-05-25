/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import React, { useCallback, useEffect, useState } from 'react'
import { PageContent, PageHeader, PageLayout, PageTitle } from '@/components/PageLayout'
import { useApi } from '@/hooks/useApi'
import { handleApiError } from '@/lib/error-handling'
import { RunnerOpsTable, SharedRunnerSummary } from '@/components/admin/RunnerOpsTable'
import { AddSharedRunnerDialog } from '@/components/admin/AddSharedRunnerDialog'
import { ScaleDownDialog } from '@/components/admin/ScaleDownDialog'

const RunnerOps: React.FC = () => {
  const { apiClient } = useApi() as any
  const [runners, setRunners] = useState<SharedRunnerSummary[]>([])
  const [loading, setLoading] = useState(false)
  const [scaleDownTarget, setScaleDownTarget] = useState<SharedRunnerSummary | null>(null)

  const fetchRunners = useCallback(async () => {
    setLoading(true)
    try {
      const res = await apiClient.axiosInstance.get('/admin/runner-ops/shared')
      setRunners(res.data?.runners ?? [])
    } catch (e) {
      handleApiError(e, 'Failed to load runners')
    } finally {
      setLoading(false)
    }
  }, [apiClient])

  useEffect(() => { fetchRunners() }, [fetchRunners])

  return (
    <PageLayout>
      <PageHeader size="full">
        <PageTitle>Runner Ops</PageTitle>
        <AddSharedRunnerDialog onCompleted={fetchRunners} />
      </PageHeader>
      <PageContent size="full">
        <RunnerOpsTable
          runners={runners}
          loading={loading}
          onScaleDown={(r) => setScaleDownTarget(r)}
          inProgressId={scaleDownTarget?.id ?? null}
        />
      </PageContent>
      <ScaleDownDialog
        runner={scaleDownTarget}
        open={!!scaleDownTarget}
        onOpenChange={(o) => { if (!o) setScaleDownTarget(null) }}
        onCompleted={() => { setScaleDownTarget(null); fetchRunners() }}
      />
    </PageLayout>
  )
}

export default RunnerOps
