/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { useEffect, useState } from 'react'
import { User } from '@boxlite-ai/api-client'
import { useApi } from './useApi'

export interface CurrentUserState {
  user: User | null
  loading: boolean
  isPlatformAdmin: boolean
  error: Error | null
  refetch: () => Promise<void>
}

export function useCurrentUser(): CurrentUserState {
  const { userApi } = useApi()
  const [user, setUser] = useState<User | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<Error | null>(null)

  const fetchUser = async () => {
    setLoading(true)
    setError(null)
    try {
      const response = await userApi.getAuthenticatedUser()
      setUser(response.data ?? null)
    } catch (e) {
      setError(e as Error)
      setUser(null)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchUser()
    // intentional one-shot on mount; consumers can call refetch on demand
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Check if user has admin role. Since SystemRole is not yet exported from api-client,
  // we use a string literal check for 'admin' as a fallback.
  const isPlatformAdmin = (user as any)?.role === 'admin'

  return { user, loading, isPlatformAdmin, error, refetch: fetchUser }
}
