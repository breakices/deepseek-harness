/**
 * AR 接线②: 会话事件流云端复制。
 *
 * 注册为 dsh session-telemetry seam 的 backend(mode FULL)—— SessionTelemetryCoordinator
 * 已包办 firehose 订阅、replay-from-firstLiveSeq、HMR 扫描、**per-session seq 水位**
 * (handoffCursor, at-most-once 有序)、脱敏、shutdown drain。本 backend 只实现:
 * 非阻塞 emit() 入队 + 异步 POST loop + shutdown flush。
 *
 * ledger channel 的 record 里 attributes['session.id']/['event.seq'] + body(=event.data)
 * 就是要上传的会话事件。数据一律上云(最终方案),云端为产品真相。
 * @module @knevo/dsh-ar-telemetry
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import {
  SessionTelemetryBackend,
  SessionTelemetryCoordinator,
  type SessionTelemetryRecord,
  type SessionTelemetrySharingStatus,
} from '@deepseek-ai/dsh-session-telemetry'

export interface Config {
  /** agent_telemetry 摄取端点,如 http://localhost:8000/api/agent/v1/trace/events */
  endpoint: string
  /** 设备 token(Bearer),同 llm 通道 */
  token: string
}

export const Config: z<Config> = z.object({
  endpoint: z.string().required(),
  token: z.string().required(),
})

/** 单批上限,与服务端 store.MAX_EVENTS_PER_REQUEST 对齐(超了整批 413)。 */
const MAX_BATCH = 200
/** 队列硬上限:云端不可达时不能无限吃设备内存;超了丢最旧的。 */
const MAX_QUEUE = 5000
const MAX_RETRY = 3
const RETRY_BASE_MS = 500

/** 把 ledger record 映射成 agent_telemetry 约定的事件行。 */
function toEvent(r: SessionTelemetryRecord): Record<string, unknown> {
  return {
    session_id: r.attributes['session.id'],
    seq: r.attributes['event.seq'],
    type: r.attributes['event.type'],
    time: r.time,
    data: r.body,
  }
}

export class ArTelemetryBackend extends SessionTelemetryBackend {
  static inject = ['sessions']
  override readonly sharing: SessionTelemetrySharingStatus = 'full'

  private readonly endpoint: string
  private readonly token: string
  private readonly queue: SessionTelemetryRecord[] = []
  private draining = false

  constructor(ctx: Context, config: Config) {
    super(ctx)
    this.endpoint = config.endpoint
    this.token = config.token
    // mode FULL: 捕获每个会话事件, 附带 seq 水位
    new SessionTelemetryCoordinator(ctx, this, 'live')
  }

  /** 非阻塞入队 —— 在 session/event 热路径上同步调用。 */
  emit(record: SessionTelemetryRecord): void {
    if (record.channel !== 'ledger') return // 只上传会话事件, ops 运维记录跳过
    this.queue.push(record)
    void this.drain()
  }

  private async drain(): Promise<void> {
    if (this.draining) return
    this.draining = true
    try {
      while (this.queue.length > 0) {
        // 服务端单次上限 500 条(agent_telemetry/store.py MAX_EVENTS_PER_REQUEST);
        // 超了整批 413,所以这里切片而不是一次性 splice 全部。
        const batch = this.queue.splice(0, MAX_BATCH)
        const events = batch.map(toEvent)
        if (!(await this.post(events))) {
          // 送不出去就还回队头,保住顺序;队列有硬上限,超了丢**最旧**的
          // ——轨迹是补充信息,不能为了它把设备内存吃光。
          this.queue.unshift(...batch)
          if (this.queue.length > MAX_QUEUE) this.queue.splice(0, this.queue.length - MAX_QUEUE)
          return   // 本轮退出;下一次 emit 再试(避免在这里空转烧 CPU)
        }
      }
    } finally {
      this.draining = false
    }
  }

  /**
   * 送一批,带有限重试。返回 true=已投递(或**服务端明确拒绝**,重试也没用)。
   *
   * 原实现是 `catch {}` 直接丢批 —— 云端轨迹因此是有损的,既不能当回看真相,
   * 也不能当计费争议的证据。这里区分两类失败:
   *   • 网络/5xx/429 → 退避重试(次数有限,失败后回队列等下次)
   *   • 4xx(除 429)→ 服务端明确拒绝(如批过大、会话不属于本账户),重试无意义,丢弃
   */
  private async post(events: readonly Record<string, unknown>[], attempt = 0): Promise<boolean> {
    try {
      const res = await fetch(this.endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${this.token}` },
        body: JSON.stringify({ events }),
      })
      if (res.ok) return true
      if (res.status >= 400 && res.status < 500 && res.status !== 429) return true  // 明确拒绝
    } catch {
      // 网络不可达 —— 落到下面的退避
    }
    if (attempt >= MAX_RETRY) return false
    await new Promise((r) => setTimeout(r, RETRY_BASE_MS * 2 ** attempt))
    return this.post(events, attempt + 1)
  }

  async shutdown(): Promise<void> {
    await this.drain()
  }
}

export default ArTelemetryBackend
