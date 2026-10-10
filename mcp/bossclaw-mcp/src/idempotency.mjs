// src/idempotency.mjs —— 发送类动作的 MCP 层幂等去重（P0 优化，2026-10-11）
// ---------------------------------------------------------------------------
// 背景：deliverySendNow 是真实发送动作。MCP 客户端在「请求其实已执行、但响应超时」时
// 往往会自动重试一次，原实现没有任何防护，全靠应用内任务锁兜底。本模块在 MCP 边界
// 再加一层（纵深防御，不替代应用侧不变量）：
//   · 键：调用方显式传的 idempotencyKey 优先；否则用「工具+动作+参数」的稳定哈希。
//   · 在途重复：直接复用在途 Promise 的结果，不再向应用发第二次请求；
//   · 已成功：TTL 内返回缓存结果并标注 deduplicated:true，不再重复发送；
//   · 失败不缓存：失败（含风控）不落缓存，后续重试语义不变——是否可重试由结构化错误决定。
// 只作用于发送类动作集合 SEND_SCOPE，普通读写动作不经过这里。
import { createHash } from 'node:crypto';

export const DEFAULT_TTL_MS = 10 * 60 * 1000;
const MAX_ENTRIES = 200;

/** 需要幂等保护的「工具:动作」集合 */
export const SEND_SCOPE = new Set(['bossclaw_app_action:deliverySendNow', 'bossclaw_agent_send:deliverySendNow']);

function stableStringify(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'undefined';
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  const keys = Object.keys(v).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(v[k])}`).join(',')}}`;
}

export function idempotencyKey(scope, payload, explicitKey) {
  if (explicitKey && String(explicitKey).trim()) return `${scope}:key:${String(explicitKey).trim()}`;
  const hash = createHash('sha256').update(stableStringify(payload ?? {})).digest('hex').slice(0, 32);
  return `${scope}:hash:${hash}`;
}

export class IdempotencyStore {
  constructor(ttlMs = DEFAULT_TTL_MS) {
    this.ttlMs = ttlMs;
    /** Map<key, { promise: Promise, settled: boolean, result: any, at: number }> */
    this.entries = new Map();
  }

  prune(now = Date.now()) {
    for (const [k, e] of this.entries) {
      if (e.settled && now - e.at > this.ttlMs) this.entries.delete(k);
    }
    while (this.entries.size > MAX_ENTRIES) {
      const first = this.entries.keys().next().value;
      this.entries.delete(first);
    }
  }

  /**
   * 以 key 执行 fn（异步、返回工具结果对象）。重复调用命中在途/已成功缓存时，
   * 返回同一结果并在其 data 上标注 deduplicated:true（不修改原始文本语义，只加一行标注）。
   */
  async run(key, fn) {
    this.prune();
    const hit = this.entries.get(key);
    if (hit) {
      const result = await hit.promise;
      if (result && !result.isError) return markDedup(result, hit.settled ? 'cached' : 'inflight');
      // 失败结果不去重：删掉后按新请求执行
      this.entries.delete(key);
    }
    const promise = (async () => fn())();
    const entry = { promise, settled: false, result: null, at: Date.now() };
    this.entries.set(key, entry);
    try {
      const result = await promise;
      entry.result = result;
      entry.settled = true;
      entry.at = Date.now();
      if (!result || result.isError) this.entries.delete(key);
      return result;
    } catch (e) {
      this.entries.delete(key);
      throw e;
    }
  }
}

function markDedup(result, via) {
  const data = result.data && typeof result.data === 'object' ? { ...result.data, deduplicated: true, dedupVia: via } : { deduplicated: true, dedupVia: via };
  return {
    ...result,
    text: `${result.text}\n\n（MCP 幂等层：本次调用与先前请求参数一致，已去重，未重复执行发送。via=${via}）`,
    data,
  };
}

/** 进程内单例（MCP 服务单进程，状态随服务生命周期） */
export const sendIdempotency = new IdempotencyStore();
