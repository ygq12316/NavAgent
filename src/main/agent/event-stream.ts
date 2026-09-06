/**
 * 通用事件流原语（对齐 pi 的 EventStream）：
 * 生产者 push 事件、消费者 async 迭代；isComplete 判定终态事件并兑现 result()。
 */
export class EventStream<T, R = T> implements AsyncIterable<T> {
  private queue: T[] = []
  private waiting: ((value: IteratorResult<T>) => void)[] = []
  private finished = false
  private finalResultPromise: Promise<R>
  private resolveFinalResult!: (result: R) => void
  private isComplete: (event: T) => boolean
  private extractResult: (event: T) => R

  constructor(isComplete: (event: T) => boolean, extractResult: (event: T) => R) {
    this.isComplete = isComplete
    this.extractResult = extractResult
    this.finalResultPromise = new Promise((resolve) => {
      this.resolveFinalResult = resolve
    })
  }

  push(event: T): void {
    if (this.finished) return
    if (this.isComplete(event)) {
      this.finished = true
      this.resolveFinalResult(this.extractResult(event))
    }
    const waiter = this.waiting.shift()
    if (waiter) waiter({ value: event, done: false })
    else this.queue.push(event)
  }

  end(result?: R): void {
    this.finished = true
    if (result !== undefined) this.resolveFinalResult(result)
    while (this.waiting.length > 0) {
      const waiter = this.waiting.shift()!
      waiter({ value: undefined as unknown as T, done: true })
    }
  }

  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    while (true) {
      if (this.queue.length > 0) {
        yield this.queue.shift()!
      } else if (this.finished) {
        return
      } else {
        const result = await new Promise<IteratorResult<T>>((resolve) => this.waiting.push(resolve))
        if (result.done) return
        yield result.value
      }
    }
  }

  result(): Promise<R> {
    return this.finalResultPromise
  }
}

/** 引擎事件流：agent_end 是终态，result() 兑现本次新增消息数组 */
export class AgentEventStream extends EventStream<import('@shared/types').AgentEvent, import('@shared/types').AgentMessage[]> {
  constructor() {
    super(
      (event) => event.type === 'agent_end',
      (event) => (event.type === 'agent_end' ? event.messages : [])
    )
  }
}
