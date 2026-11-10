import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['lib/**/*.test.ts'],
    // the read-DB contract test calls every query function against a full DB
    testTimeout: 120000,
  },
})
