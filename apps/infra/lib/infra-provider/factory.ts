// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

import type { IInfraProvider, InfraProviderConfig } from './types.js'
import { AwsInfraProvider } from './aws.js'
import { LocalProcessInfraProvider } from './local.js'

export function createInfraProvider(cfg: InfraProviderConfig): IInfraProvider {
  if (cfg.kind === 'local') return new LocalProcessInfraProvider(cfg)
  return new AwsInfraProvider(cfg)
}
