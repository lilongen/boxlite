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
  DialogTrigger,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useApi } from '@/hooks/useApi'
import { useRunnerOpsJob } from '@/hooks/useRunnerOpsJob'

export interface AddSharedRunnerDialogProps {
  onCompleted?: () => void
}

interface AddSharedRunnerRequest {
  name?: string
  regionId?: string
  instanceType?: string
}

export const AddSharedRunnerDialog: React.FC<AddSharedRunnerDialogProps> = ({ onCompleted }) => {
  const { apiClient } = useApi() as any
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [regionId, setRegionId] = useState('us')
  const [instanceType, setInstanceType] = useState('c8i.2xlarge')
  const [jobId, setJobId] = useState<string | null>(null)
  const { job, status, lines } = useRunnerOpsJob(jobId)

  const submit = async () => {
    try {
      const body: AddSharedRunnerRequest = {
        name: name || undefined,
        regionId: regionId || undefined,
        instanceType: instanceType || undefined,
      }
      const res = await apiClient.axiosInstance.post('/api/admin/runner-ops/add-shared', body)
      setJobId(res.data.id)
      toast.info('Add runner started')
    } catch (e: any) {
      toast.error(`Failed to start: ${e?.response?.data?.message ?? e?.message ?? 'unknown'}`)
    }
  }

  useEffect(() => {
    if (status === 'SUCCESS') { toast.success('Runner added'); onCompleted?.() }
    if (status === 'FAILED') toast.error(`Add failed: ${job?.error?.message ?? 'unknown'}`)
  }, [status, job?.error?.message, onCompleted])

  return (
    <Dialog open={open} onOpenChange={(o) => { setOpen(o); if (!o) { setJobId(null); setName('') } }}>
      <DialogTrigger asChild>
        <Button>+ Add runner</Button>
      </DialogTrigger>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Add a shared runner</DialogTitle>
          <DialogDescription>Provisions an EC2 instance and registers it as a SHARED runner.</DialogDescription>
        </DialogHeader>

        {!jobId && (
          <div className="grid gap-3 py-2">
            <div className="grid gap-1">
              <Label htmlFor="name">Name (optional)</Label>
              <Input id="name" value={name} onChange={(e) => setName(e.target.value)} placeholder="runner-shared-abc123" />
            </div>
            <div className="grid gap-1">
              <Label htmlFor="regionId">Region</Label>
              <Input id="regionId" value={regionId} onChange={(e) => setRegionId(e.target.value)} />
            </div>
            <div className="grid gap-1">
              <Label htmlFor="instanceType">EC2 instance type</Label>
              <Input id="instanceType" value={instanceType} onChange={(e) => setInstanceType(e.target.value)} />
            </div>
          </div>
        )}

        {jobId && (
          <div className="py-2">
            <div className="text-sm mb-2">Status: <span className="font-semibold">{status ?? 'pending…'}</span></div>
            <pre className="bg-muted text-xs p-2 rounded max-h-64 overflow-auto">{lines.join('\n')}</pre>
          </div>
        )}

        <DialogFooter>
          {!jobId && (
            <>
              <DialogClose asChild><Button variant="secondary">Cancel</Button></DialogClose>
              <Button onClick={submit}>Add runner</Button>
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
