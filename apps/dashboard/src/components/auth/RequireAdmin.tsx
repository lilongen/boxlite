/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import React, { ReactNode } from 'react'
import { Navigate } from 'react-router-dom'
import { useCurrentUser } from '@/hooks/useCurrentUser'
import { RoutePath } from '@/enums/RoutePath'

interface RequireAdminProps {
  children: ReactNode
}

export const RequireAdmin: React.FC<RequireAdminProps> = ({ children }) => {
  const { loading, isPlatformAdmin } = useCurrentUser()
  if (loading) {
    return <div role="status" aria-label="loading">Loading…</div>
  }
  if (!isPlatformAdmin) {
    return <Navigate to={RoutePath.SANDBOXES} replace />
  }
  return <>{children}</>
}
