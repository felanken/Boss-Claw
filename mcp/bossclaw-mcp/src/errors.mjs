// src/errors.mjs —— 结构化错误分类（P0 优化，2026-10-11）
// ---------------------------------------------------------------------------
// 背景：原实现里工具失败只回一段文本。外部 agent 分不清两类性质完全不同的失败：
//   · 风控类（封禁/滑块/账户异常）：必须停下交人工，**重试会让情况更糟**；
//   · 瞬时类（限速/服务端异常/桥超时）：可以退避后重试。
// 本模块把应用侧已有的风控口径（desktop-app/src/lib/bossclaw/safety.ts 的 CODE_MAP，
// 此处逐项对齐、保持同一数值与同一 requireHuman/retryable 判定）搬到 MCP 边界：
// 凡工具失败，额外在返回的 data.error 里附结构化字段，并在文本尾部附一行机器可读 JSON。
// 本模块只做分类与标注，不改变任何动作是否执行、更不改变应用侧安全不变量。
import { fail } from './context.mjs';

/** 与应用 safety.ts CODE_MAP 对齐：code -> { severity, requireHuman, retryable, cooldownMs } */
export const RISK_CODES = {
  31: { severity: 'login', requireHuman: true, retryable: false, cooldownMs: 0 },
  32: { severity: 'banned', requireHuman: true, retryable: false, cooldownMs: 30 * 60 * 1000 * 4 },
  35: { severity: 'challenge', requireHuman: true, retryable: false, cooldownMs: 30 * 60 * 1000 },
  36: { severity: 'challenge', requireHuman: true, retryable: false, cooldownMs: 30 * 60 * 1000 * 2 },
  37: { severity: 'env', requireHuman: true, retryable: false, cooldownMs: 30 * 60 * 1000 },
  38: { severity: 'env', requireHuman: true, retryable: false, cooldownMs: 30 * 60 * 1000 },
  1006: { severity: 'rate_limited', requireHuman: false, retryable: true, cooldownMs: 10 * 60 * 1000 },
  5002: { severity: 'env', requireHuman: false, retryable: true, cooldownMs: 10 * 60 * 1000 },
  5003: { severity: 'env', requireHuman: false, retryable: true, cooldownMs: 10 * 60 * 1000 },
  5004: { severity: 'env', requireHuman: false, retryable: true, cooldownMs: 10 * 60 * 1000 },
};

/** 从数据对象里取显式数值 code 字段（评审定版：只认结构化字段，不扫自由文本关键词） */
function explicitCode(data) {
  if (!data || typeof data !== 'object') return null;
  for (const k of ['code', 'errorCode', 'riskCode', 'statusCode']) {
    const v = data[k];
    if (typeof v === 'number' && RISK_CODES[v]) return v;
    if (typeof v === 'string' && /^\d{2,4}$/.test(v) && RISK_CODES[Number(v)]) return Number(v);
  }
  if (data.error && typeof data.error === 'object') return explicitCode(data.error);
  return null;
}

/**
 * 从错误文本 / 返回数据里提取结构化错误。
 * @returns {{category:string, code?:number, severity?:string, retryable:boolean, requireHuman:boolean, cooldownMs?:number} | null}
 *   识别不出风控/瞬时信号时返回 null（普通失败，不臆测）。
 */
export function classifyError(text, data) {
  // 1) 风控分类只认显式 code：结构化数据字段，或文本中明确标注的「风控码/错误码/code = N」
  const fromData = explicitCode(data);
  if (fromData) return { category: 'risk', code: fromData, ...RISK_CODES[fromData] };
  const hay = String(text || '');
  const m = hay.match(/(?:风控码|错误码|code)\s*[=:]\s*(\d{2,4})/i);
  if (m && RISK_CODES[Number(m[1])]) {
    const code = Number(m[1]);
    return { category: 'risk', code, ...RISK_CODES[code] };
  }
  // 2) 桥层运行状态（非风控分类，保留原口径）
  if (/控制桥未开启|控制桥未就绪|控制桥记录已失效/.test(hay)) {
    return { category: 'bridge_unavailable', retryable: true, requireHuman: true };
  }
  if (/超时|timeout/i.test(hay)) {
    return { category: 'timeout', retryable: true, requireHuman: false };
  }
  return null;
}

/**
 * 构造带结构化错误的 fail 返回：文本尾部附一行 `structured_error={...}` 供 agent 解析，
 * 同时把同一对象放进 data.error（structuredContent 通道）。识别不出类别时行为与原 fail 一致。
 */
export function failStructured(text, data) {
  const structured = classifyError(text, data);
  const base = data && typeof data === 'object' ? data : {};
  if (!structured) return fail(text, base);
  return fail(`${text}\n\nstructured_error=${JSON.stringify(structured)}`, { ...base, error: structured });
}
