export class DownloadSemaphore {
  private activeCount = 0;
  private readonly waitQueue: Array<() => void> = [];

  constructor(private readonly maxConcurrent: number) {}

  get active(): number {
    return this.activeCount;
  }

  get waiting(): number {
    return this.waitQueue.length;
  }

  async acquire(): Promise<void> {
    if (this.activeCount < this.maxConcurrent) {
      this.activeCount += 1;
      return;
    }

    await new Promise<void>((resolve) => {
      this.waitQueue.push(() => {
        this.activeCount += 1;
        resolve();
      });
    });
  }

  release(): void {
    this.activeCount -= 1;
    const next = this.waitQueue.shift();

    if (next) {
      next();
    }
  }
}
