/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { ApiContext } from '@/contexts/ApiContext'
import { useCurrentUser } from '../useCurrentUser'
import React from 'react'

function withApi(getAuthenticatedUser: () => Promise<unknown>) {
  const mockUserApi = { getAuthenticatedUser }
  // Mock ApiClient type with userApi property
  const value = { userApi: mockUserApi } as any
  return ({ children }: { children: React.ReactNode }) => (
    <ApiContext.Provider value={value}>{children}</ApiContext.Provider>
  )
}

describe('useCurrentUser', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('reports isPlatformAdmin=true when role is admin', async () => {
    const fn = vi.fn().mockResolvedValue({ data: { id: 'u', name: 'a', email: 'a@b', role: 'admin' } })
    const { result } = renderHook(() => useCurrentUser(), { wrapper: withApi(fn) })
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.isPlatformAdmin).toBe(true)
  })

  it('reports isPlatformAdmin=false when role is user', async () => {
    const fn = vi.fn().mockResolvedValue({ data: { id: 'u', name: 'a', email: 'a@b', role: 'user' } })
    const { result } = renderHook(() => useCurrentUser(), { wrapper: withApi(fn) })
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.isPlatformAdmin).toBe(false)
  })

  it('reports loading=true before response', () => {
    const fn = vi.fn(() => new Promise(() => {})) // never resolves
    const { result } = renderHook(() => useCurrentUser(), { wrapper: withApi(fn) })
    expect(result.current.loading).toBe(true)
  })

  it('handles fetch error gracefully', async () => {
    const testError = new Error('API error')
    const fn = vi.fn().mockRejectedValue(testError)
    const { result } = renderHook(() => useCurrentUser(), { wrapper: withApi(fn) })
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.error).toBe(testError)
    expect(result.current.user).toBeNull()
    expect(result.current.isPlatformAdmin).toBe(false)
  })
})
