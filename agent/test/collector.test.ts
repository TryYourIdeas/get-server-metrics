import { describe, expect, it } from 'vitest'
import { normalizeDisks, toMetrics } from '../src/collector'

const fs = (fsName: string, mount: string, size: number, used: number) => ({ fs: fsName, mount, size, used })

describe('normalizeDisks', () => {
  it('drops duplicate devices, snap/loop mounts and zero-size filesystems', () => {
    const out = normalizeDisks([
      fs('/dev/sda1', '/', 100, 40),
      fs('/dev/sda1', '/var/lib/docker/bind', 100, 40),
      fs('/dev/loop3', '/snap/core/1', 50, 50),
      fs('/dev/nvme0n1p1', '/boot/efi', 0, 0),
      fs('/dev/sdb1', '/data', 200, 10)
    ])
    expect(out).toEqual([
      { mount: '/', used: 40, total: 100 },
      { mount: '/data', used: 10, total: 200 }
    ])
  })
})

describe('normalizeDisks pseudo filesystems', () => {
  it('drops kernel/pseudo mounts like efivars', () => {
    const out = normalizeDisks([
      fs('efivarfs', '/sys/firmware/efi/efivars', 448512, 319488),
      fs('tmpfs', '/run/user/1000', 100, 1),
      fs('/dev/sda1', '/', 100, 40)
    ])
    expect(out).toEqual([{ mount: '/', used: 40, total: 100 }])
  })
})

describe('normalizeDisks removable and container mounts', () => {
  it('keeps removable disks mounted under /run/media', () => {
    const out = normalizeDisks([fs('/dev/sdb1', '/run/media/luis/USB', 100, 10)])
    expect(out).toEqual([{ mount: '/run/media/luis/USB', used: 10, total: 100 }])
  })
  it('drops overlay and other virtual filesystems by device name', () => {
    const out = normalizeDisks([
      fs('overlay', '/var/lib/docker/overlay2/abc/merged', 100, 10),
      fs('nsfs', '/run/docker/netns/x', 100, 1),
      fs('/dev/sda1', '/', 100, 40)
    ])
    expect(out).toEqual([{ mount: '/', used: 40, total: 100 }])
  })
})

describe('toMetrics', () => {
  it('maps values and rounds cpu to 1 decimal', () => {
    const m = toMetrics({ currentLoad: 12.345 }, { total: 1000, available: 400 }, [fs('/dev/sda1', '/', 100, 40)])
    expect(m).toEqual({ cpuPercent: 12.3, memUsed: 600, memTotal: 1000, disks: [{ mount: '/', used: 40, total: 100 }] })
  })
  it('never yields NaN/out-of-range cpu', () => {
    expect(toMetrics({ currentLoad: NaN }, { total: 1, available: 1 }, []).cpuPercent).toBe(0)
    expect(toMetrics({ currentLoad: 250 }, { total: 1, available: 1 }, []).cpuPercent).toBe(100)
  })
})
