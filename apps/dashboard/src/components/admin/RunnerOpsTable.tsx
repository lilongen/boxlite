/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import React from 'react'
import { Button } from '@/components/ui/button'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Badge } from '@/components/ui/badge'

// Local type stub — mirrors apps/api/src/admin/dto/runner-ops.dto.ts SharedRunnerSummaryDto.
// Replace with import from @boxlite-ai/api-client once api-client is regenerated.
export interface SharedRunnerSummary {
  id: string
  name: string
  regionId: string
  state: string
  availabilityScore: number
  cpu: number
  memoryGiB: number
  diskGiB: number
  currentStartedSandboxes: number
  currentCpuUsagePercentage: number
  currentMemoryUsagePercentage: number
  currentDiskUsagePercentage: number
  unschedulable: boolean
  draining: boolean
  lastChecked: string
}

export interface RunnerOpsTableProps {
  runners: SharedRunnerSummary[]
  onScaleDown: (runner: SharedRunnerSummary) => void
  loading?: boolean
  inProgressId?: string | null
}

export const RunnerOpsTable: React.FC<RunnerOpsTableProps> = ({ runners, onScaleDown, loading, inProgressId }) => {
  if (loading) return <div>Loading runners…</div>
  if (!runners.length) return <div className="text-muted-foreground">No shared runners.</div>
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Name</TableHead>
          <TableHead>Region</TableHead>
          <TableHead>State</TableHead>
          <TableHead className="text-right">Score</TableHead>
          <TableHead className="text-right">Sandboxes</TableHead>
          <TableHead className="text-right">CPU / Mem / Disk</TableHead>
          <TableHead>Actions</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {runners.map((r) => (
          <TableRow key={r.id}>
            <TableCell className="font-mono">{r.name}</TableCell>
            <TableCell>{r.regionId}</TableCell>
            <TableCell>
              <Badge variant={r.state === 'ready' ? 'default' : 'secondary'}>{r.state}</Badge>
              {r.draining && <Badge variant="destructive" className="ml-1">draining</Badge>}
              {r.unschedulable && <Badge variant="outline" className="ml-1">cordoned</Badge>}
            </TableCell>
            <TableCell className="text-right">{r.availabilityScore}</TableCell>
            <TableCell className="text-right">{r.currentStartedSandboxes}</TableCell>
            <TableCell className="text-right">
              {Math.round(r.currentCpuUsagePercentage)}% / {Math.round(r.currentMemoryUsagePercentage)}% / {Math.round(r.currentDiskUsagePercentage)}%
            </TableCell>
            <TableCell>
              <Button
                size="sm"
                variant="destructive"
                disabled={r.draining || inProgressId === r.id}
                onClick={() => onScaleDown(r)}
              >
                {inProgressId === r.id ? 'Scaling down…' : 'Scale down'}
              </Button>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}
