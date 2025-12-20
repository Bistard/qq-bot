export class LockManager {
  private locks = new Map<string, Promise<void>>()

  async run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(key) ?? Promise.resolve()
    let release: () => void = () => {}
    const current = new Promise<void>((resolve) => {
      release = resolve
    })
    this.locks.set(key, previous.then(() => current))

    try {
      await previous
      const result = await task()
      return result
    } finally {
      ;(release as () => void)()
      if (this.locks.get(key) === current) {
        this.locks.delete(key)
      }
    }
  }
}
