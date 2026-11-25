/** 错误的简短说明（日志、原因字段用），截到 max 个字符。 */
export const errorText = (error: unknown, max = 300) => (error instanceof Error ? error.message : String(error)).slice(0, max);

/**
 * 把同一轮里收到的工作攒起来，在下一个微任务里逐个处理（按 key 去重，后到的覆盖先到的）。
 * 事件监听者都用它：不在产生事件的那个事务里写库，一项出错只记日志、不影响其余的。
 */
export class MicroBatch<T> {
  private readonly pending = new Map<string, T>();
  private queued = false;

  constructor(
    private readonly handle: (item: T) => void,
    private readonly log: (message: string) => void,
    private readonly label: string,
    private readonly keyOf: (item: T) => string = String,
  ) {}

  add(item: T): void {
    this.pending.set(this.keyOf(item), item);
    if (this.queued) return;
    this.queued = true;
    queueMicrotask(() => this.flush());
  }

  private flush(): void {
    this.queued = false;
    const items = [...this.pending.values()];
    this.pending.clear();
    for (const item of items) {
      try {
        this.handle(item);
      } catch (error) {
        this.log(`${this.label} ${this.keyOf(item)} failed: ${errorText(error)}`);
      }
    }
  }
}
