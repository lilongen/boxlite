/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

export default {
  displayName: 'boxlite',
  preset: '../../jest.preset.js',
  testEnvironment: 'node',
  transform: {
    '^.+\\.[tj]s$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.spec.json' }],
  },
  // uuid ships ESM-only (`export ...`) under dist-node; jest ignores node_modules
  // by default, so let ts-jest transpile it instead of choking on the export.
  transformIgnorePatterns: ['/node_modules/(?!uuid/)'],
  moduleFileExtensions: ['ts', 'js', 'html'],
  coverageDirectory: '../../coverage/apps/boxlite',
}
