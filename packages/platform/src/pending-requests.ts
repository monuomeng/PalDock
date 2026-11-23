/** 请求 ID 分配与结果配对，IPC 客户端和执行器 JSON-RPC 客户端共用。 */
export class PendingRequests<T = unknown> {
  private readonly waiting = new Map<string, { resolve: (value: T) => void; reject: (error: Error) => void }>();
  private nextId = 0;

  /** 分配 ID 并登记；send 负责把请求写出去。 */
  add(send: (id: string) => void): Promise<T> {
    const id = String(++this.nextId);
    return new Promise<T>((resolve, reject) => {
      this.waiting.set(id, { resolve, reject });
      send(id);
    });
  }

  resolve(id: string, value: T): void {
    this.take(id)?.resolve(value);
  }

  reject(id: string, error: Error): void {
    this.take(id)?.reject(error);
  }

  rejectAll(error: Error): void {
    for (const waiter of this.waiting.values()) waiter.reject(error);
    this.waiting.clear();
  }

  private take(id: string) {
    const waiter = this.waiting.get(id);
    this.waiting.delete(id);
    return waiter;
  }
}
