import { describe, expect, it } from 'vitest'
import { diskSeries } from '../app/utils/series'

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
