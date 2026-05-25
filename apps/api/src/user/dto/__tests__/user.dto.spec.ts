/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { User } from '../../user.entity'
import { SystemRole } from '../../enums/system-role.enum'
import { UserDto } from '../user.dto'

describe('UserDto.fromUser', () => {
  function makeUser(overrides: Partial<User> = {}): User {
    return {
      id: 'u-1',
      name: 'Operator',
      email: 'op@example.com',
      role: SystemRole.ADMIN,
      publicKeys: [],
      createdAt: new Date('2026-01-01T00:00:00Z'),
      ...overrides,
    } as User
  }

  it('exposes role for admin users', () => {
    const dto = UserDto.fromUser(makeUser({ role: SystemRole.ADMIN }))
    expect(dto.role).toBe(SystemRole.ADMIN)
  })

  it('exposes role for plain users', () => {
    const dto = UserDto.fromUser(makeUser({ role: SystemRole.USER }))
    expect(dto.role).toBe(SystemRole.USER)
  })
})
