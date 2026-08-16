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
        const batch = this.queue.splice(0, this.queue.length)
        const events = batch.map(toEvent)
        try {
          await fetch(this.endpoint, {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${this.token}` },
            body: JSON.stringify({ events }),
          })
        } catch {
          // spike: 丢弃失败批。真实形态: 重试 + 用服务端回传水位补传(readFrom by seq)。
        }
      }
    } finally {
      this.draining = false
    }
  }

  async shutdown(): Promise<void> {
    await this.drain()
  }
}

export default ArTelemetryBackend
