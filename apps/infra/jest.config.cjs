module.exports = {
  testEnvironment: 'node',
  // No tsconfig lives in apps/infra, so ts-jest would default to module=commonjs
  // (no top-level await) and an old target. Pin ESM + a modern target inline so
  // the ESM-mock test pattern (`await import(...)`) and typed mocks compile.
  transform: {
    '^.+\\.tsx?$': [
      'ts-jest',
      {
        useESM: true,
        tsconfig: {
          module: 'esnext',
          target: 'es2022',
          moduleResolution: 'bundler',
          esModuleInterop: true,
        },
      },
    ],
  },
  extensionsToTreatAsEsm: ['.ts'],
  moduleNameMapper: { '^(\\.{1,2}/.*)\\.js$': '$1' },
  testMatch: ['<rootDir>/lib/**/*.test.ts', '<rootDir>/scripts/**/*.test.ts'],
}
