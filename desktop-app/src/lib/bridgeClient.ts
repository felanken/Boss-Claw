// 与 OpenClaw 本地桥接（Node）通信的渲染端客户端。
// 桥接为可选模块：PDF 在渲染进程内用纯 JS 解析；DOCX 走桥接（mammoth 在 Node 侧）。
const BRIDGE_PORT = 18765;
// 桥接 token 不再写死在源码里（旧固定值已随仓库公开）。桥服务首启时在本机生成随机
// token 并写入 ~/.bossclaw/bridge-token.json；用户在 OpenClaw 页粘贴一次后存 localStorage，
// 这里与该页共用同一个 key，并经请求头传递（不进 URL/日志）。
export const BRIDGE_TOKEN_STORAGE_KEY = 'bossclaw:bridgeToken';
export function getBridgeToken(): string {
  try {
    return localStorage.getItem(BRIDGE_TOKEN_STORAGE_KEY) || '';
  } catch {
    return '';
  }
}
const BASE = `http://127.0.0.1:${BRIDGE_PORT}`;

export interface BridgeResumeResult {
  ok: boolean;
  text?: string;
  method?: string;
  error?: string;
}

export async function bridgeParseResume(dataUrl: string, name: string): Promise<BridgeResumeResult> {
  // P21：超时 + 失败兜底，与 bridgeStatus 保持一致，桥未启动时返回 {ok:false} 而非抛未处理异常
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000);
    try {
      const res = await fetch(`${BASE}/resume-text`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-bossclaw-token': getBridgeToken() },
        body: JSON.stringify({ dataUrl, name }),
        signal: ctrl.signal,
      });
      const data = await res.json();
      return data as BridgeResumeResult;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return { ok: false, method: 'bridge', error: '本地桥接不可用或超时，请启动 OpenClaw 桥接服务' };
  }
}

export async function bridgeStatus(): Promise<{ ok: boolean; [k: string]: unknown }> {
  try {
    // P30：超时兜底——桥端口若被占用但进程不响应（半开连接），无超时的 fetch 会永久 pending，
    // App 15s 心跳会逐次堆积挂起请求（内存/句柄泄漏、后台卡死）。3s 超时后按「未连接」处理。
    const res = await fetch(`${BASE}/status`, { headers: { 'x-bossclaw-token': getBridgeToken() }, signal: AbortSignal.timeout(3000) });
    return res.json();
  } catch {
    return { ok: false };
  }
}
