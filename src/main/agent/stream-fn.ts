import type { ProviderEvent } from '../providers/types'
import type { StreamFn } from './engine-types'

const MAX_RETRIES = 3

function isRetryableStatus(status: number | undefined): boolean {
  // 对齐 OpenAI/Anthropic SDK 策略：408/409/429/5xx；无状态码视为网络层失败
  if (status === undefined) return true
  return status === 408 || status === 409 || status === 429 || status >= 500
}

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => {
      cleanup()
      resolve()
    }, ms)
    const onAbort = (): void => {
      cleanup()
      const e = new Error('Aborted')
      e.name = 'AbortError'
      reject(e)
    }
    const cleanup = (): void => {
      clearTimeout(t)
      signal.removeEventListener('abort', onAbort)
    }
    if (signal.aborted) return onAbort()
    signal.addEventListener('abort', onAbort)
  })
}

/**
 * StreamFn 工厂：包装 provider 流并实现重试（对齐 pi 把重试放在 provider 层的设计）。
 * 契约：禁止 throw——失败一律编码为 done 终态事件；
 * 仅当"零内容失败"时重试（已输出的文本不会因重试而重复）。
 */
export function createStreamFn(deps: {
  getProvider: () => { stream(req: Parameters<StreamFn>[0]): AsyncIterable<ProviderEvent> }
  onRetry?: (info: { attempt: number; maxRetries: number; delayMs: number; reason: string }) => void
}): StreamFn {
  return async function* (req) {
    // 传输边界真值：请求组成体积（分类统计的对照基准；NAVAGENT_DEBUG_WIRE=1 开启）
    if (process.env.NAVAGENT_DEBUG_WIRE) {
      const toolsChars = JSON.stringify(req.tools ?? []).length
      const msgsChars = req.messages.reduce((s, m) => s + (typeof m.content === 'string' ? m.content.length : JSON.stringify(m.content).length), 0)
      const names = (req.tools ?? []).map((t) => t.name).join(',')
      console.error(
        `[wire] system=${(req.system ?? '').length}ch hasPlan=${(req.system ?? '').includes('计划模式')} tools=${(req.tools ?? []).length}个[${names}]/${toolsChars}ch msgs=${req.messages.length}条/${msgsChars}ch`
      )
    }
    let attempt = 0
    for (;;) {
      let gotContent = false
      let terminal: Extract<ProviderEvent, { type: 'done' }> | null = null
      try {
        for await (const ev of deps.getProvider().stream(req)) {
          if (ev.type === 'done') {
            terminal = ev
            break
          }
          gotContent = true
          yield ev
        }
        if (!terminal) terminal = { type: 'done', stopReason: 'stop' }
      } catch (err) {
        // 防御：provider 契约是不抛异常；网络层 fetch 失败仍可能从这里出现
        if (req.signal.aborted) terminal = { type: 'done', stopReason: 'aborted' }
        else
          terminal = {
            type: 'done',
            stopReason: 'error',
            errorMessage: err instanceof Error ? err.message : String(err)
          }
      }

      const retryable =
        terminal.stopReason === 'error' &&
        !gotContent &&
        attempt < MAX_RETRIES - 1 &&
        isRetryableStatus(terminal.status)
      if (!retryable) {
        yield terminal
        return
      }
      attempt++
      const delayMs = 1_000 * 2 ** (attempt - 1)
      deps.onRetry?.({
        attempt,
        maxRetries: MAX_RETRIES,
        delayMs,
        reason: terminal.errorMessage ?? '请求失败'
      })
      // abortableSleep 只会以 AbortError 拒绝：编码为终态事件而非抛出（禁止 throw 契约）
      try {
        await abortableSleep(delayMs, req.signal)
      } catch {
        yield { type: 'done', stopReason: 'aborted' }
        return
      }
    }
  }
}
