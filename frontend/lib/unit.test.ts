import { describe, expect, it } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assertTs } from './queries/_helpers'
import { rangeSince } from './range'
import { normalizeBigInts, readCurrentVersion, dbPathFor, spillDirFor } from './db'

describe('assertTs', () => {
  it('accepts ISO dates and timestamps', () => {
    for (const v of ['2026-11-10', '2026-11-10 18:53:00', '2026-11-10T18:53:00.123Z', '2026-11-10T18:53:00+02:00']) {
      expect(assertTs(v)).toBe(v)
    }
  })
  it('rejects anything else', () => {
    for (const v of ["2026-11-10' OR 1=1 --", '2026-11-10;', 'now()', '']) {
      expect(() => assertTs(v)).toThrow()
    }
  })
})

describe('rangeSince', () => {
  // 00:30 UTC: a local-midnight implementation on a UTC+1 host would return the previous day.
  const now = new Date('2026-11-10T00:30:00.000Z')
  it('uses UTC boundaries', () => {
    expect(rangeSince('today', now)).toBe('2026-11-10T00:00:00.000Z')
    expect(rangeSince('7d', now)).toBe('2026-11-03T00:30:00.000Z')
    expect(rangeSince('30d', now)).toBe('2026-10-11T00:30:00.000Z')
    expect(rangeSince('all', now)).toBeNull()
  })
})

describe('normalizeBigInts', () => {
  it('converts safe BigInts to numbers and keeps big ones as strings, recursively', () => {
    const big = '1152921504606846976' // 2^60, beyond Number.MAX_SAFE_INTEGER
    const out = normalizeBigInts({ a: BigInt(5), b: [BigInt(big)], c: { d: new Date('2026-11-10T00:00:00Z') } })
    expect(out).toEqual({ a: 5, b: [big], c: { d: '2026-11-10T00:00:00.000Z' } })
  })
})

describe('read DB pointer', () => {
  it('reads the trimmed version from CURRENT', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aura-read-'))
    writeFileSync(join(dir, 'CURRENT'), 'v20261110T185300Z\n')
    expect(readCurrentVersion(dir)).toBe('v20261110T185300Z')
    expect(dbPathFor(dir, 'v20261110T185300Z')).toBe(join(dir, 'v20261110T185300Z', 'aura.duckdb'))
  })
  it('throws when nothing is published yet', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aura-read-'))
    expect(() => readCurrentVersion(dir)).toThrow('read DB not published yet')
    writeFileSync(join(dir, 'CURRENT'), '  \n')
    expect(() => readCurrentVersion(dir)).toThrow('read DB not published yet')
  })
  it('gives each version its own spill dir', () => {
    expect(spillDirFor('v1', '/tmp/aura-duckdb')).not.toBe(spillDirFor('v2', '/tmp/aura-duckdb'))
    expect(spillDirFor('v1', '/tmp/aura-duckdb')).toBe(join('/tmp/aura-duckdb', 'v1'))
  })
})
