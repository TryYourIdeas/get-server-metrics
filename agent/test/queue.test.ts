import { describe, expect, it } from 'vitest'
import { createBoundedQueue } from '../src/queue'

describe('createBoundedQueue', () => {
  it('drains items in order and empties itself', () => {
    const q = createBoundedQueue<number>(5)
    q.push(1); q.push(2)
    expect(q.drain()).toEqual([1, 2])
    expect(q.size).toBe(0)
  })
  it('keeps only the newest items beyond the limit and counts what it dropped', () => {
    const q = createBoundedQueue<number>(3)
    for (let i = 1; i <= 5; i++) q.push(i)
    expect(q.drain()).toEqual([3, 4, 5])
    expect(q.dropped).toBe(2)
  })
})
