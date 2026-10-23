/** FIFO buffer that keeps only the newest `limit` items, so a long outage cannot grow memory without bound. */
export function createBoundedQueue<T>(limit: number) {
  const items: T[] = []
  let dropped = 0
  return {
    push(item: T): void {
      items.push(item)
      while (items.length > limit) { items.shift(); dropped++ }
    },
    drain(): T[] { return items.splice(0, items.length) },
    get size() { return items.length },
    get dropped() { return dropped }
  }
}
