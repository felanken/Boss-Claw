// test/p0-optimizations.mjs —— P0 优化专项测试（2026-10-11）
// 覆盖：动作级参数校验 / 结构化错误分类 / 发送幂等去重 / 协议层校验拦截。
// 用法：node test/p0-optimizations.mjs（不需要应用在运行）
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { validateActionParams, ACTION_PARAM_SPECS } from '../src/actionSchema.mjs';
import { classifyError, RISK_CODES } from '../src/errors.mjs';
import { IdempotencyStore, idempotencyKey } from '../src/idempotency.mjs';
import { controlTools } from '../src/tools/control.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.resolve(__dirname, '..', 'bin', 'bossclaw-mcp.mjs');

let failures = 0;
function record(name, pass, detail) {
  console.log(`${pass ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!pass) failures += 1;
}

// ---- 1) 参数校验 ----
record('校验：navigate 缺 route 被拦', !validateActionParams('navigate', {}).ok);
record('校验：navigate route 枚举外被拦', !validateActionParams('navigate', { route: 'nope' }).ok);
record('校验：navigate 合法通过', validateActionParams('navigate', { route: 'workbench' }).ok);
record('校验：setPlatform dailyTarget 超 150 被拦', !validateActionParams('setPlatform', { platform: 'boss', dailyTarget: 999 }).ok);
record('校验：setPlatform 合法通过', validateActionParams('setPlatform', { platform: 'liepin', dailyTarget: 20 }).ok);
record('校验：deliveryDraft 空打招呼语被拦', !validateActionParams('deliveryDraft', { greeting: '   ' }).ok);
record('校验：pendingApprove id/ids 至少其一', !validateActionParams('pendingApprove', {}).ok && validateActionParams('pendingApprove', { ids: ['a'] }).ok);
record('校验：uiClick 需 selector 或 label', !validateActionParams('uiClick', {}).ok && validateActionParams('uiClick', { label: '发送' }).ok);
record('校验：patchConfig patch 类型错误被拦', !validateActionParams('patchConfig', { patch: 'x' }).ok);
record('校验：agentTasks waitMs 超范围被拦', !validateActionParams('agentTasks', { waitMs: 999999 }).ok);
record('校验：无参数动作空 params 通过', validateActionParams('screenshot', {}).ok && validateActionParams('backupNow').ok);
// spec 覆盖率：control.mjs 的 ACTIONS 全部应在 spec 表中（从工具 enum 反推）
const appAction = controlTools.find((t) => t.name === 'bossclaw_app_action');
const enumValues = appAction.inputSchema.properties.action.enum || [];
const missing = enumValues.filter((a) => !ACTION_PARAM_SPECS[a]);
record('校验：spec 覆盖全部动作', missing.length === 0, missing.length ? `缺失 ${missing.join(',')}` : `${enumValues.length} 个动作全覆盖`);

// ---- 2) 结构化错误分类 ----
const c32 = classifyError('投递失败 code 32 账户已被限制');
record('错误：code 32 -> banned/不可重试/需人工', !!c32 && c32.code === 32 && c32.retryable === false && c32.requireHuman === true);
const c35 = classifyError('需要安全验证（滑块）请人工完成');
record('错误：滑块文案 -> 35/challenge', !!c35 && c35.code === 35 && c35.requireHuman === true);
const c1006 = classifyError('请求过于频繁');
record('错误：限速 -> 1006/可重试/不需人工', !!c1006 && c1006.code === 1006 && c1006.retryable === true && c1006.requireHuman === false);
const cBridge = classifyError('应用内控制桥未开启。请用 bossclaw_app_start 启动');
record('错误：桥未开启 -> bridge_unavailable', !!cBridge && cBridge.category === 'bridge_unavailable');
record('错误：普通失败不臆测', classifyError('页面结构变化') === null);
record('错误：RISK_CODES 与应用口径项数', Object.keys(RISK_CODES).length === 10);

// ---- 3) 幂等去重 ----
{
  const store = new IdempotencyStore(60_000);
  let calls = 0;
  const fn = async () => { calls += 1; return { text: 'sent', data: {}, isError: false }; };
  const k = idempotencyKey('bossclaw_app_action:deliverySendNow', { greeting: '您好' });
  const r1 = await store.run(k, fn);
  const r2 = await store.run(k, fn);
  record('幂等：同参数第二次不重复执行', calls === 1 && r2.data?.deduplicated === true, `实际执行 ${calls} 次`);
  const k2 = idempotencyKey('bossclaw_app_action:deliverySendNow', { greeting: '另一条' });
  await store.run(k2, fn);
  record('幂等：不同参数正常执行', calls === 2);
  let failCalls = 0;
  const failFn = async () => { failCalls += 1; return { text: 'err', data: {}, isError: true }; };
  const kf = idempotencyKey('bossclaw_app_action:deliverySendNow', { greeting: '会失败' });
  await store.run(kf, failFn);
  await store.run(kf, failFn);
  record('幂等：失败结果不缓存、可重试', failCalls === 2);
  const kx = idempotencyKey('s', { a: 1 }, 'my-key');
  record('幂等：显式 key 优先', kx.includes(':key:my-key'));
}

// ---- 4) 协议层：参数错误在 MCP 层拦截（不依赖控制桥） ----
{
  const child = spawn(process.execPath, [BIN], { stdio: ['pipe', 'pipe', 'pipe'] });
  let buffer = '';
  const pending = new Map();
  child.stdout.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    let idx;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      const msg = JSON.parse(line);
      pending.get(msg.id)?.(msg);
      pending.delete(msg.id);
    }
  });
  let seq = 0;
  const rpc = (method, params) => new Promise((resolve) => {
    seq += 1;
    pending.set(seq, resolve);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: seq, method, params })}\n`);
  });
  await rpc('initialize', { protocolVersion: '2025-06-18' });
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
  const bad = await rpc('tools/call', { name: 'bossclaw_app_action', arguments: { action: 'navigate', params: {} } });
  const badText = bad.result?.content?.[0]?.text || '';
  record('协议：navigate 缺参在 MCP 层返回 invalid_params', bad.result?.isError === true && badText.includes('invalid_params'), badText.slice(0, 60));
  const bad2 = await rpc('tools/call', { name: 'bossclaw_app_action', arguments: { action: 'setPlatform', params: { platform: 'boss', dailyTarget: 999 } } });
  record('协议：dailyTarget 超限被拦', bad2.result?.isError === true && (bad2.result?.content?.[0]?.text || '').includes('150'));
  child.kill();
}

console.log(`\n汇总：${failures === 0 ? '全部通过' : `${failures} 项失败`}`);
process.exitCode = failures === 0 ? 0 : 1;
