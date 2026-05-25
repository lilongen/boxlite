/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import React, { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import { useApi } from '@/hooks/useApi'
import { useRunnerOpsJob } from '@/hooks/useRunnerOpsJob'
import type { SharedRunnerSummary } from './RunnerOpsTable'

export interface ScaleDownDialogProps {
  runner: SharedRunnerSummary | null
  open: boolean
  onOpenChange: (open: boolean) => void
  onCompleted?: () => void
}

export const ScaleDownDialog: React.FC<ScaleDownDialogProps> = ({ runner, open, onOpenChange, onCompleted }) => {
  const { apiClient } = useApi() as any
  const [restartStopped, setRestartStopped] = useState(false)
  const [jobId, setJobId] = useState<string | null>(null)
  const { job, status, lines } = useRunnerOpsJob(jobId)

  const submit = async () => {
    if (!runner) return
    try {
      const res = await apiClient.axiosInstance.post(`/admin/runner-ops/${runner.id}/scale-down`, { restartStopped })
      setJobId(res.data.id)
    } catch (e: any) {
      toast.error(`Failed to start: ${e?.response?.data?.message ?? e?.message ?? 'unknown'}`)
    }
  }

  useEffect(() => {
    if (status === 'SUCCESS') { toast.success(`Scaled down ${runner?.name ?? 'runner'}`); onCompleted?.() }
    if (status === 'FAILED') toast.error(`Scale-down failed: ${job?.error?.message ?? 'unknown'}`)
  }, [status, job?.error?.message, runner?.name, onCompleted])

  return (
    <Dialog open={open} onOpenChange={(o) => { onOpenChange(o); if (!o) setJobId(null) }}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Scale down {runner?.name}</DialogTitle>
          <DialogDescription>
            All running sandboxes will be backed up, archived, and restarted on peer SHARED runners.
            After migration, the runner row is deleted and the EC2 instance is terminated.
          </DialogDescription>
        </DialogHeader>

        {!jobId && (
          <div className="grid gap-3 py-2">
            <div className="flex items-center gap-2">
              <Checkbox id="restartStopped" checked={restartStopped} onCheckedChange={(v) => setRestartStopped(!!v)} />
              <Label htmlFor="restartStopped">Also migrate STOPPED sandboxes (default: archive only)</Label>
            </div>
          </div>
        )}

        {jobId && (
          <div className="py-2">
            <div className="text-sm mb-2">Status: <span className="font-semibold">{status ?? 'pending…'}</span></div>
            <pre className="bg-muted text-xs p-2 rounded max-h-80 overflow-auto">{lines.join('\n')}</pre>
          </div>
        )}

        <DialogFooter>
          {!jobId && (
            <>
              <DialogClose asChild><Button variant="secondary">Cancel</Button></DialogClose>
              <Button variant="destructive" onClick={submit}>Scale down</Button>
            </>
          )}
          {jobId && (status === 'SUCCESS' || status === 'FAILED') && (
            <DialogClose asChild><Button>Close</Button></DialogClose>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
