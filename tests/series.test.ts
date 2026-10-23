import { describe, expect, it } from 'vitest'
import { appendLive, axisLabel, diskSeries, formatBytes, latestLabel, withLive } from '../app/utils/series'

const p = (ts: string, disks: { mount: string; used: number; total: number }[]) => ({ ts, disks })

describe('diskSeries', () => {
  it('plots only the requested mount, even if disk order changes', () => {
    const out = diskSeries([
      p('t1', [{ mount: '/', used: 50, total: 100 }, { mount: '/usb', used: 1, total: 10 }]),
      p('t2', [{ mount: '/usb', used: 5, total: 10 }, { mount: '/', used: 60, total: 100 }])
    ], '/')
    expect(out).toEqual([{ ts: 't1', value: 50 }, { ts: 't2', value: 60 }])
  })
  it('skips samples that lack the mount and returns [] without a mount', () => {
    expect(diskSeries([p('t1', [])], '/')).toEqual([])
    expect(diskSeries([p('t1', [{ mount: '/', used: 1, total: 2 }])], undefined)).toEqual([])
  })
})

describe('appendLive', () => {
  it('appends and caps the buffer to the newest max points', () => {
    const buf = [{ ts: '2026-01-01T00:00:00Z' }, { ts: '2026-01-01T00:00:05Z' }]
    expect(appendLive(buf, { ts: '2026-01-01T00:00:10Z' }, 2).map(x => x.ts)).toEqual(['2026-01-01T00:00:05Z', '2026-01-01T00:00:10Z'])
  })
  it('ignores a point that is not newer than the last one', () => {
    const buf = [{ ts: '2026-01-01T00:00:05Z' }]
    expect(appendLive(buf, { ts: '2026-01-01T00:00:05Z' }, 5)).toBe(buf)
  })
})

describe('withLive', () => {
  it('adds only live points newer than the last stored sample', () => {
    const hist = [{ ts: '2026-01-01T00:00:00Z' }, { ts: '2026-01-01T00:01:00Z' }]
    const live = [{ ts: '2026-01-01T00:00:55Z' }, { ts: '2026-01-01T00:01:05Z' }]
    expect(withLive(hist, live).map(x => x.ts)).toEqual(['2026-01-01T00:00:00Z', '2026-01-01T00:01:00Z', '2026-01-01T00:01:05Z'])
  })
  it('returns the live points when there is no history', () => {
    expect(withLive([], [{ ts: 'a' }])).toEqual([{ ts: 'a' }])
  })
})

describe('formatBytes', () => {
  it('formats bytes as GB with one decimal', () => {
    expect(formatBytes(8 * 1024 ** 3)).toBe('8.0 GB')
    expect(formatBytes(33285996544)).toBe('31.0 GB')
  })
})

describe('axisLabel', () => {
  it('shows percent plus real size when a total is known', () => {
    expect(axisLabel(50, 32 * 1024 ** 3)).toBe('50% · 16.0 GB')
  })
  it('shows percent only without a total', () => {
    expect(axisLabel(100)).toBe('100%')
  })
})

describe('latestLabel', () => {
  it('shows used / total (percent) when a total is known', () => {
    expect(latestLabel(25, 32 * 1024 ** 3)).toBe('8.0 GB / 32.0 GB (25%)')
  })
  it('shows percent only without a total', () => {
    expect(latestLabel(12.4)).toBe('12%')
  })
})
