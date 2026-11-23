/** 统一的时间来源：测试注入固定时钟，存储层只拿 ISO-8601 UTC 文本。 */
export class Clock {
  constructor(private readonly now: () => Date = () => new Date()) {}

  iso(): string {
    return this.now().toISOString();
  }

  isoAfter(ms: number): string {
    return new Date(this.now().getTime() + ms).toISOString();
  }
}
