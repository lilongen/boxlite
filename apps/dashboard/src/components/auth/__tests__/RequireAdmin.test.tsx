/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { RequireAdmin } from '../RequireAdmin'

vi.mock('@/hooks/useCurrentUser', () => ({
  useCurrentUser: vi.fn(),
}))
import { useCurrentUser } from '@/hooks/useCurrentUser'

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/admin" element={<RequireAdmin><div>admin-content</div></RequireAdmin>} />
        <Route path="/dashboard/sandboxes" element={<div>sandboxes-page</div>} />
      </Routes>
    </MemoryRouter>
  )
}

describe('RequireAdmin', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('renders children when user is platform admin', () => {
    ;(useCurrentUser as any).mockReturnValue({ user: { role: 'admin' }, loading: false, isPlatformAdmin: true })
    renderAt('/admin')
    expect(screen.getByText('admin-content')).toBeInTheDocument()
  })

  it('redirects non-admin users to sandboxes', () => {
    ;(useCurrentUser as any).mockReturnValue({ user: { role: 'user' }, loading: false, isPlatformAdmin: false })
    renderAt('/admin')
    expect(screen.getByText('sandboxes-page')).toBeInTheDocument()
  })

  it('renders a spinner while loading', () => {
    ;(useCurrentUser as any).mockReturnValue({ user: null, loading: true, isPlatformAdmin: false })
    renderAt('/admin')
    expect(screen.getByRole('status', { hidden: true })).toBeInTheDocument()
    expect(screen.queryByText('admin-content')).not.toBeInTheDocument()
  })
})
