// src/actionSchema.mjs —— bossclaw_app_action 的动作级参数校验（P0 优化，2026-10-11）
// ---------------------------------------------------------------------------
// 背景：原实现里 `bossclaw_app_action` 是单个工具挂 70+ 个白名单动作，入参 schema 只有
// { action: enum, params: { type:'object', additionalProperties:true } } —— 参数名写错、
// 类型写错、必填缺失都拦不住，要穿透到应用渲染层（controlRuntime.ts）才报错，来回昂贵
// 且错误信息对 agent 不友好。本模块按工具描述里已公开的动作参数口径，为每个动作声明：
//   required: { 字段: 类型 } —— 缺失或类型不对即在 MCP 层拦截，不打扰应用；
//   optional: { 字段: 类型 } —— 出现则校验类型，不出现不管；
//   oneOf:    [字段...]      —— 至少提供其一（如 pendingApprove 的 id|ids）。
// 类型取值：'string' | 'number' | 'boolean' | 'object' | 'array' | 'any'，
// 或 { enum: [...] }、{ anyOf: [类型...] }。
// 设计边界：只校验「文档已明确的字段口径」，未声明的额外字段放行（渲染层仍是唯一权威，
// 前向兼容新版本动作参数）；不做任何业务/安全判定，不改 SAFETY_LIMITS，不绕过渲染层校验。

const S = 'string';
const N = 'number';
const B = 'boolean';
const O = 'object';
const A = 'array';
const ANY = 'any';
const strOrObj = { anyOf: [S, O] };

export const ACTION_PARAM_SPECS = {
  // 界面
  navigate: { required: { route: { enum: ['home', 'workbench', 'resume', 'directions', 'tasks', 'schedule', 'stats', 'assistant', 'openclaw', 'autochat', 'settings'] } } },
  setTheme: { required: { theme: { enum: ['light', 'dark'] } } },
  setSidebarCollapsed: { required: { collapsed: B } },
  setAutoAssist: { required: { enabled: B } },
  pauseDelivery: { optional: { minutes: N } },
  resumeDelivery: {},
  // 配置
  patchConfig: { required: { patch: O } },
  setPlatform: {
    required: { platform: { enum: ['boss', 'liepin', 'zhaopin', 'job51'] } },
    optional: { enabled: B, dailyTarget: N, priority: N },
  },
  backupNow: {},
  restoreBackup: {},
  addLog: { required: { msg: S }, optional: { level: S } },
  clearLogs: {},
  engineStatus: {},
  // 业务数据
  dataSetResume: { required: { text: S }, optional: { fileName: S, file: S } },
  dataSetProfile: { required: { profile: strOrObj } },
  dataSetDirectionPlan: { required: { plan: { anyOf: [O, A] } } },
  dataSetGreetings: { required: { items: A } },
  dataSetGreetingPrompt: { required: { prompt: S } },
  dataSetCommunicationInfo: { required: { info: strOrObj } },
  dataPendingAdd: { required: { item: O } },
  dataPendingUpdate: { required: { id: S, patch: O } },
  dataTaskRunUpdate: { required: { id: S, patch: O } },
  dataAddChatLog: { required: { entry: O } },
  scheduleAdd: { required: { entry: O } },
  scheduleUpdate: { required: { id: S, patch: O } },
  scheduleRemove: { required: { id: S } },
  scheduleToggle: { required: { id: S }, optional: { enabled: B } },
  // AI 按需生成
  aiAnalyzeJob: { required: { job: strOrObj }, optional: { resumeText: S, customGreetingPrompt: S } },
  aiTailorResume: { required: { job: strOrObj }, optional: { greetingInstructions: S } },
  // agent 代答（经 app_action 直调时同样校验）
  agentTasks: { optional: { waitMs: N, includeMessages: B, limit: N } },
  agentSubmit: { required: { id: S, content: S } },
  agentCancel: { required: { id: S }, optional: { reason: S } },
  // 浏览器只读探索
  browserSearch: { required: { query: S }, optional: { city: S, page: N, pageSize: N } },
  browserOpenJob: { required: { url: S }, optional: { tabId: { anyOf: [S, N] } } },
  browserReadPage: { optional: { tabId: { anyOf: [S, N] } } },
  browserReadJob: { required: { encryptJobId: S } },
  browserDomDump: { optional: { tabId: { anyOf: [S, N] } } },
  // 投递
  deliverySetMode: { required: { mode: { enum: ['auto', 'review'] } } },
  deliveryDraft: { required: { greeting: S } },
  deliverySendNow: { optional: { greeting: S } },
  // 通用 UI 接管
  uiSnapshot: { optional: { scope: { enum: ['app', 'webview'] }, selector: S, limit: N } },
  uiClick: { oneOf: ['selector', 'label'], optional: { scope: { enum: ['app', 'webview'] }, selector: S, label: S, index: N } },
  uiType: { required: { value: S }, oneOf: ['selector', 'into'], optional: { scope: { enum: ['app', 'webview'] }, selector: S, into: S, clear: B } },
  uiSubmit: { optional: { scope: { enum: ['app', 'webview'] }, selector: S } },
  uiScroll: { optional: { scope: { enum: ['app', 'webview'] }, selector: S, dy: N, to: { enum: ['top', 'bottom'] } } },
  uiWait: { optional: { ms: N, selector: S, timeoutMs: N } },
  // 自动沟通引擎
  autochatStart: { optional: { platforms: A, maxCount: N } },
  autochatStop: {},
  autochatStep: { optional: { id: S } },
  autochatStatus: {},
  // 完整数据读取
  appDataFull: { optional: { sections: A, maxPending: N, maxLogs: N } },
  // 队列与任务
  pendingApprove: { oneOf: ['id', 'ids'], optional: { id: S, ids: A } },
  pendingReject: { oneOf: ['id', 'ids'], optional: { id: S, ids: A } },
  pendingRerank: {},
  pendingPromote: { optional: { ids: A } },
  pendingRemove: { required: { id: S } },
  taskStage: { required: { id: S, direct: S } },
  // 模块级控制
  profileRebuild: {},
  greetingsAppend: { required: { items: A } },
  resumeTailor: { required: { job: strOrObj }, optional: { saveTo: { enum: ['none', 'greetings', 'resume'] } } },
  directionPlanRebuild: {},
  directionItem: { required: { id: S, patch: O } },
  tasksGenerate: {},
  // 数据统计导出（只读）
  statsExport: { optional: { range: { enum: ['7d', '30d', 'all'] }, kind: { enum: ['summary', 'detail', 'report'] } } },
  // 主进程动作（无参数）
  focusWindow: {},
  minimize: {},
  maximize: {},
  windowState: {},
  reloadRenderer: {},
  openDevTools: {},
  screenshot: {},
};

function typeName(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

function checkType(field, value, spec, errors) {
  if (spec === ANY) return;
  if (spec && typeof spec === 'object' && Array.isArray(spec.enum)) {
    if (!spec.enum.includes(value)) errors.push(`参数 ${field} 取值不合法：${JSON.stringify(value)}（可选：${spec.enum.join(' / ')}）`);
    return;
  }
  if (spec && typeof spec === 'object' && Array.isArray(spec.anyOf)) {
    const okType = spec.anyOf.some((t) => {
      const tmp = [];
      checkType(field, value, t, tmp);
      return tmp.length === 0;
    });
    if (!okType) errors.push(`参数 ${field} 类型不对：期望 ${spec.anyOf.join(' / ')}，实际 ${typeName(value)}`);
    return;
  }
  const actual = typeName(value);
  const okType =
    (spec === S && actual === 'string') ||
    (spec === N && actual === 'number' && Number.isFinite(value)) ||
    (spec === B && actual === 'boolean') ||
    (spec === O && actual === 'object') ||
    (spec === A && actual === 'array');
  if (!okType) errors.push(`参数 ${field} 类型不对：期望 ${spec}，实际 ${actual}`);
}

/**
 * 校验某个动作的 params。返回 { ok: true } 或 { ok: false, errors: string[] }。
 * 没有声明 spec 的动作（理论上不存在，ACTIONS 与本表一一对应）放行并标注，
 * 避免新动作上线时被 MCP 层误杀——真正的权威仍是渲染层白名单。
 */
export function validateActionParams(action, params) {
  const spec = ACTION_PARAM_SPECS[action];
  if (!spec) return { ok: true, unspecified: true };
  if (params != null && (typeof params !== 'object' || Array.isArray(params))) {
    return { ok: false, errors: [`params 必须是对象，实际 ${typeName(params)}`] };
  }
  const p = params || {};
  const errors = [];
  for (const [field, t] of Object.entries(spec.required || {})) {
    if (p[field] === undefined || p[field] === null) {
      errors.push(`缺少必填参数 ${field}`);
    } else {
      checkType(field, p[field], t, errors);
    }
  }
  for (const [field, t] of Object.entries(spec.optional || {})) {
    if (p[field] !== undefined && p[field] !== null) checkType(field, p[field], t, errors);
  }
  if (Array.isArray(spec.oneOf) && spec.oneOf.length) {
    if (!spec.oneOf.some((f) => p[f] !== undefined && p[f] !== null)) {
      errors.push(`参数 ${spec.oneOf.join(' / ')} 至少提供其一`);
    }
  }
  // 数值范围（与应用侧口径对齐：waitMs 0-55000；setPlatform 的 dailyTarget 不得突破 150 硬上限——
  // 渲染层也会封顶，这里提前拦下是为了让 agent 明确知道自己的数值被拒而不是被静默改小）
  if (action === 'agentTasks' && p.waitMs != null && (p.waitMs < 0 || p.waitMs > 55_000)) {
    errors.push(`参数 waitMs 超出范围 0-55000：${p.waitMs}`);
  }
  if (action === 'setPlatform' && p.dailyTarget != null && (p.dailyTarget < 0 || p.dailyTarget > 150)) {
    errors.push(`参数 dailyTarget 超出范围 0-150（应用硬上限）：${p.dailyTarget}`);
  }
  if (action === 'deliveryDraft' && typeof p.greeting === 'string' && !p.greeting.trim()) {
    errors.push('参数 greeting 不能为空字符串（招呼语非空是应用安全不变量）');
  }
  return errors.length ? { ok: false, errors } : { ok: true };
}
