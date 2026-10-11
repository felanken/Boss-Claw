// src/tools/control.mjs —— 应用内控制工具组（依赖控制桥，需应用以 BOSSCLAW_CONTROL=1 运行）
// ---------------------------------------------------------------------------
// 这是「真正驱动运行中的应用」的通道：读实时状态（内存里的 store，不是 5 分钟前的快照）、
// 执行白名单动作。所有动作都必须经 electron/control-bridge.cjs + src/lib/controlRuntime.ts，
// 且**不绕过验证码 / 不改安全上限**；自动发送（deliverySendNow）仅在用户开启「全自动」
// （executionMode==='auto'）时对 agent 开放，且复用应用自带安全投递引擎——安全不变量仍在渲染层强制。
import { controlCall, getPath, ok, fail, truncate, PATHS, bridgeHint } from '../context.mjs';
import { obj, str, bool, enumStr, WRITE_LOCAL, READ_ONLY } from '../schema.mjs';
import { validateActionParams } from '../actionSchema.mjs';
import { classifyError, failStructured } from '../errors.mjs';
import { sendIdempotency, idempotencyKey, SEND_SCOPE } from '../idempotency.mjs';

/**
 * 密钥字段脱敏（P0 优化）：app_state 的 structuredContent 原先会把完整 state 原样回传，
 * 其中 settings.config.model.apiKey 是用户真实密钥明文——等于每次查状态都把密钥塞进
 * agent 上下文。此处在 MCP 边界统一脱敏：键名命中 apiKey/token/secret/password 的
 * 非空字符串一律替换为占位符；需要「是否已配置」看布尔语义即可，不需要真值。
 */
function redactSecrets(v) {
  if (Array.isArray(v)) return v.map(redactSecrets);
  if (v && typeof v === 'object') {
    const out = {};
    for (const [k, val] of Object.entries(v)) {
      if (/api[-_]?key|access[-_]?key|private[-_]?key|token|secret|password|passwd|credential|authorization|cookie|session/i.test(k) && typeof val === 'string' && val) {
        out[k] = '***redacted***';
      } else {
        out[k] = redactSecrets(val);
      }
    }
    return out;
  }
  return v;
}

/** 渲染层白名单动作（src/lib/controlRuntime.ts 为唯一权威实现） */
const RENDERER_ACTIONS = [
  'navigate',
  'setTheme',
  'setSidebarCollapsed',
  'setAutoAssist',
  'pauseDelivery',
  'resumeDelivery',
  'patchConfig',
  'setPlatform',
  'backupNow',
  'restoreBackup',
  'addLog',
  'clearLogs',
  'engineStatus',
  // 业务数据管理
  'dataSetResume',
  'dataSetProfile',
  'dataSetDirectionPlan',
  'dataSetGreetings',
  'dataSetGreetingPrompt',
  'dataSetCommunicationInfo',
  'dataPendingAdd',
  'dataPendingUpdate',
  'dataTaskRunUpdate',
  'dataAddChatLog',
  'scheduleAdd',
  'scheduleUpdate',
  'scheduleRemove',
  'scheduleToggle',
  // AI 按需生成（复用工作台定制提示词链路；未配置 API Key 时回退本地规则）
  'aiAnalyzeJob',
  'aiTailorResume',
  // 浏览器只读探索
  'browserSearch',
  'browserOpenJob',
  'browserReadPage',
  'browserReadJob',
  'browserDomDump',
  // 投递（半自动 / 跟随 executionMode 的全自动）
  'deliverySetMode',
  'deliveryDraft',
  'deliverySendNow',
  // A. 通用 UI 接管（app / webview）
  'uiSnapshot',
  'uiClick',
  'uiType',
  'uiSubmit',
  'uiScroll',
  'uiWait',
  // B. 自动沟通引擎接管
  'autochatStart',
  'autochatStop',
  'autochatStep',
  'autochatStatus',
  // C. 完整数据读取
  'appDataFull',
  // D. 队列与任务深度接管
  'pendingApprove',
  'pendingReject',
  'pendingRerank',
  'pendingPromote',
  'pendingRemove',
  'taskStage',
  // E. 模块级控制（简历中心 / 定制简历 / 投递方向 / 任务进度）
  'profileRebuild',
  'greetingsAppend',
  'resumeTailor',
  'directionPlanRebuild',
  'directionItem',
  'tasksGenerate',
  // F. 数据统计导出（只读：回传汇总 / 明细 / 报表文本，不落盘、不弹对话框）
  'statsExport',
  // G. agent 代答（应用未配置 API Key 时由外部 agent 接管 AI 生成）——
  //    常规用法请走专用工具 bossclaw_agent_tasks / bossclaw_agent_submit / bossclaw_agent_cancel；
  //    这里保留动作名是为了让「渲染层白名单唯一权威」与 MCP 侧清单保持一一对应（可被 app_action 直接调用）。
  'agentTasks',
  'agentSubmit',
  'agentCancel',
];

/** 主进程侧动作（electron/control-bridge.cjs） */
const MAIN_ACTIONS = ['focusWindow', 'minimize', 'maximize', 'windowState', 'reloadRenderer', 'openDevTools', 'screenshot'];

const ACTIONS = [...RENDERER_ACTIONS, ...MAIN_ACTIONS];

export const controlTools = [
  {
    name: 'bossclaw_app_state',
    title: '应用实时状态',
    description:
      '从运行中的应用读取**实时**状态（内存中的 Zustand store）：当前路由 / 主题 / 引擎开关 / 侧栏动作、完整 config、' +
      '岗位队列与统计、定时任务、自动沟通运行态、沟通日志尾部、agent 代答状态（agentAnswer：是否在线 / 队列 / 统计）。' +
      '支持点路径过滤以避免上下文膨胀。' +
      '需要应用以 BOSSCLAW_CONTROL=1 运行（bossclaw_app_start 默认开启）。',
    annotations: READ_ONLY,
    inputSchema: obj({
      path: str('点路径过滤，如 "settings.config.minScore" 或 "data.stats"；留空返回按段裁剪的概览'),
      full: bool('返回完整对象（数据量大，默认 false）', { default: false }),
      includeEngine: bool('额外实时探测两套隐身引擎状态（较慢，默认 false）', { default: false }),
    }),
    handler: async (args = {}) => {
      const res = await controlCall('GET', '/state', null, 10_000);
      if (!res.ok) return failStructured(`${res.error}\n\n${await bridgeHint()}`, { unavailable: !!res.unavailable });

      let engine = null;
      if (args.includeEngine) {
        const er = await controlCall('POST', '/action', { action: 'engineStatus', params: {} }, 20_000);
        engine = er.ok ? er.data?.next : { error: er.error };
      }

      const data = res.data?.state ?? res.data;
      if (args.path) {
        const picked = getPath(data, args.path);
        if (picked === undefined) return fail(`路径不存在：${args.path}（顶层键：${Object.keys(data || {}).join(', ')}）`);
        const safePicked = redactSecrets(picked);
        return ok(`${args.path} =\n\n${truncate(JSON.stringify(safePicked, null, 2), 30000)}`, { path: args.path, value: safePicked });
      }
      if (args.full) {
        const safeData = redactSecrets(data);
        return ok(truncate(JSON.stringify(safeData, null, 2), 60000), safeData);
      }

      const app = data?.app || {};
      const cfg = data?.settings?.config || {};
      const stats = data?.data?.stats || {};
      const pending = data?.data?.pendingCounts || {};
      const auto = data?.autochat || {};
      const aa = data?.agentAnswer || {};
      const lastSeen = aa.lastSeenAgoMs === null || aa.lastSeenAgoMs === undefined ? '从未' : `${Math.round(aa.lastSeenAgoMs / 1000)}s 前`;
      const lines = [
        `# 应用实时状态（bridge pid ${res.data?.pid ?? '-'}，${new Date(res.data?.at || Date.now()).toISOString()}）`,
        ``,
        `## 界面`,
        `- 路由：${app.activeRoute}｜主题：${app.theme}（effective ${app.effectiveTheme ?? '-'}）｜侧栏收起：${app.sidebarCollapsed}`,
        `- 引擎开关 autoAssist：${app.autoAssist}｜engineStatus：${app.engineStatus}｜bridgeStatus：${app.bridgeStatus}｜BOSS 登录：${app.bossLoggedIn}`,
        `- 当前动作：${app.currentAction?.text ?? '-'}（来源 ${app.currentAction?.source ?? '-'}）`,
        engine ? `- 引擎实测：${JSON.stringify(engine)}` : '',
        ``,
        `## 投递安全`,
        `- 执行模式：${cfg.executionMode}｜暂停：${app.pauseRemainMin > 0 ? `剩余 ${app.pauseRemainMin} 分钟` : '未暂停'}`,
        `- 每分钟上限 ${cfg.maxActionsPerMinute}｜最低分 ${cfg.minScore}｜岗位间隔 ${cfg.betweenJobsSeconds}s`,
        `- 平台：${Object.entries(cfg.platforms || {}).map(([k, v]) => `${k}${v?.enabled ? '✓' : '✗'}(目标${v?.dailyTarget})`).join('，')}`,
        ``,
        `## 队列与统计`,
        `- 岗位：${Object.entries(pending).map(([k, v]) => `${k}=${v}`).join('，') || '无'}`,
        `- 统计：${Object.entries(stats).map(([k, v]) => `${k}=${v}`).join('，') || '无'}`,
        `- 自动沟通：running=${auto.chatRunning}｜进度 ${auto.progress?.index ?? 0}/${auto.progress?.total ?? 0}｜当前 ${auto.activeChatId ?? '-'}`,
        `- 定时任务：${(data?.schedule?.entries || []).length} 条（启用 ${(data?.schedule?.entries || []).filter((e) => e.enabled).length}）`,
        ``,
        `## 素材`,
        `- 简历：${data?.data?.resume?.chars || 0} 字｜画像：${data?.data?.profile?.present ? '已生成' : '未生成'}｜招呼语 ${data?.data?.greetings?.length || 0} 条`,
        `- 日志 ${data?.data?.logs?.count ?? 0} 条｜沟通日志 ${data?.data?.chatLogs?.count ?? 0} 条`,
        ``,
        `## agent 代答（未配置 API Key 时由 agent 接管应用内 AI 生成）`,
        `- AI 密钥：${cfg.model?.apiKey ? '已配置（直连真模型，不走代答）' : '未配置'}`,
        `- agent 在线：${aa.online ? '是' : '否'}（心跳窗口 ${Math.round((aa.presenceWindowMs || 0) / 1000)}s，最近一次任务调用 ${lastSeen}）`,
        `- 队列：挂起 ${aa.pending ?? 0}｜已领取 ${aa.claimed ?? 0}｜已回填 ${aa.answered ?? 0}｜超时 ${aa.timeouts ?? 0}｜放弃 ${aa.cancelled ?? 0}｜无 agent 回落本地 ${aa.unavailable ?? 0}`,
        aa.lastEvent ? `- 最近事件：${aa.lastEvent}` : '',
        `- 提示：未配置密钥时要接管 AI，请循环调用 bossclaw_agent_tasks（建议 waitMs: 30000）；**没有心跳时应用直接走本地规则**。`,
        ``,
        `提示：需要细节用 path 参数取子路径（例如 path="settings.config"）。`,
      ].filter(Boolean);
      // P0 优化：默认模式下 structuredContent 只回与文本摘要同口径的精简对象，
      // 不再把完整 state（含简历全文/日志/密钥字段）原样塞进 agent 上下文。
      // 完整数据仍可经 full:true 或 path 取得（且已经过 redactSecrets 脱敏）。
      const summaryData = {
        mode: 'summary',
        pid: res.data?.pid ?? null,
        at: res.data?.at ?? null,
        app: {
          activeRoute: app.activeRoute,
          theme: app.theme,
          autoAssist: app.autoAssist,
          bossLoggedIn: app.bossLoggedIn,
          pauseRemainMin: app.pauseRemainMin ?? 0,
        },
        config: {
          executionMode: cfg.executionMode,
          maxActionsPerMinute: cfg.maxActionsPerMinute,
          minScore: cfg.minScore,
          betweenJobsSeconds: cfg.betweenJobsSeconds,
          hasApiKey: !!cfg.model?.apiKey,
          platforms: Object.fromEntries(
            Object.entries(cfg.platforms || {}).map(([k, v]) => [k, { enabled: !!v?.enabled, dailyTarget: v?.dailyTarget }])
          ),
        },
        pending,
        stats,
        autochat: { running: !!auto.chatRunning, index: auto.progress?.index ?? 0, total: auto.progress?.total ?? 0 },
        scheduleCount: (data?.schedule?.entries || []).length,
        agentAnswer: {
          online: !!aa.online,
          pending: aa.pending ?? 0,
          answered: aa.answered ?? 0,
          timeouts: aa.timeouts ?? 0,
        },
      };
      return ok(lines.join('\n'), summaryData);
    },
  },

  {
    name: 'bossclaw_app_action',
    title: '执行应用动作（白名单）',
    description:
      '对运行中的应用执行白名单动作。渲染层动作由 src/lib/controlRuntime.ts 强制校验，主进程动作由 control-bridge.cjs 处理。\n' +
      '**不绕过验证码 / 不修改安全上限 / 不抬高每日上限**。自动发送仅在用户已开启「全自动」（executionMode=\'auto\'）时对 agent 开放（deliverySendNow），此时仍复用应用自带安全投递引擎；review 模式下自动发送一律拒绝，只能 deliveryDraft 草拟+人工发送。\n' +
      '渲染层动作：\n' +
      '  - navigate: { route: "home"|"workbench"|"resume"|"directions"|"tasks"|"schedule"|"stats"|"assistant"|"openclaw"|"autochat"|"settings" }\n' +
      '  - setTheme: { theme: "light"|"dark" }｜setSidebarCollapsed: { collapsed: boolean }\n' +
      '  - setAutoAssist: { enabled: boolean }（= 标题栏「投递引擎」开关，仅切换开关，不会自行投递）\n' +
      '  - pauseDelivery: { minutes?: number }（默认 30，写 config.pausedUntil）｜resumeDelivery: {}\n' +
      '  - patchConfig: { patch: {...} }（仅允许修改已存在且非 model/pausedUntil/platforms 的字段）\n' +
      '  - setPlatform: { platform: "boss"|"liepin"|"zhaopin"|"job51", enabled?, dailyTarget?, priority? }\n' +
      '  - backupNow: {}｜restoreBackup: {}｜addLog: { level, msg }｜clearLogs: {}｜engineStatus: {}（只读探测两套隐身引擎）\n' +
      '  - 业务数据：dataSetResume{text,fileName?}｜dataSetProfile{profile}｜dataSetDirectionPlan{plan}｜dataSetGreetings{items}｜' +
      'dataSetGreetingPrompt{prompt}｜dataSetCommunicationInfo{info}｜dataPendingAdd{item}｜dataPendingUpdate{id,patch}｜' +
      'dataTaskRunUpdate{id,patch}｜dataAddChatLog{entry}｜scheduleAdd{entry}｜scheduleUpdate{id,patch}｜scheduleRemove{id}｜scheduleToggle{id,enabled}\n' +
      '  - AI 按需生成（复用工作台定制提示词链路；未配置 API Key 时若 agent 在线则转由 bossclaw_agent_* 代答，否则回落本地规则；较长耗时）：aiAnalyzeJob{job,resumeText?,customGreetingPrompt?}｜' +
      'aiTailorResume{job,greetingInstructions?}\n' +
      '  - agent 代答（常规用法请走专用工具 bossclaw_agent_tasks / bossclaw_agent_submit / bossclaw_agent_cancel）：' +
      'agentTasks{waitMs?,includeMessages?,limit?}｜agentSubmit{id,content}｜agentCancel{id,reason?}\n' +
      '  - 浏览器只读探索（webview 引擎可用）：browserSearch{query,city?,page?,pageSize?}｜browserOpenJob{url,tabId?}｜' +
      'browserReadPage{tabId?}｜browserReadJob{encryptJobId}｜browserDomDump{tabId?}\n' +
      '  - 投递：deliverySetMode（**已禁用**：执行模式受保护，只能由用户在应用设置页切换）｜deliveryDraft{greeting}（半自动，预填不发送）｜' +
      'deliverySendNow{greeting?}（仅 executionMode==\'auto\' 且复用安全引擎）\n' +
      '  - 通用 UI 接管（scope:"app" 操作应用界面 / "webview" 操作右栏 BOSS 页；禁止任意脚本与跳转）：uiSnapshot{scope?,selector?,limit?}｜' +
      'uiClick{scope?,selector?,label?,index?}｜uiType{scope?,selector?/into?,value,clear?}（contenteditable 聊天框请用 deliveryDraft）｜' +
      'uiSubmit{scope?,selector?}｜uiScroll{scope?,selector?,dy?,to?:top|bottom}｜uiWait{ms?|selector?,timeoutMs?}\n' +
      '  - 自动沟通引擎：autochatStart{platforms?,maxCount?}（受冷却/每日上限保护）｜autochatStop｜autochatStep{id?}（单步，含冷却/上限/招呼语守卫）｜autochatStatus\n' +
      '  - 完整数据读取：appDataFull{sections?,maxPending?,maxLogs?}（sections 见描述；不含 base64）\n' +
      '  - 队列与任务：pendingApprove{id|ids} / pendingReject{id|ids} / pendingRerank / pendingPromote{ids?}（只升 approved→approved_queue）/ pendingRemove{id} / taskStage{id,direct:next|prev|阶段}（不改 status 为 success）\n' +
      '  - 模块级（简历中心/定制简历/方向/任务）：profileRebuild{ }（重建职业画像）｜' +
      'resumeTailor{job, saveTo?:none|greetings|resume}（定制简历；saveTo 缺省 none 仅返回不落盘，resume 会追加定制章节到简历）｜' +
      'greetingsAppend{items}｜directionPlanRebuild{ }｜directionItem{id,patch{enabled?,priority?}}｜tasksGenerate{ }（按方向重建任务卡片，不投递；**保留 cr_ 采集任务**，与首页「新建任务」同口径）\n' +
      '  - 数据统计导出（**只读**，与统计页同源口径）：statsExport{range?:"7d"|"30d"|"all", kind?:"summary"|"detail"|"report"}\n' +
      '    （返回 filename 与 content 文本，不落盘、不弹保存对话框 —— 落盘必须由人工在应用内完成；detail 已剔除会话 token 与招呼语正文）\n' +
      '主进程动作：focusWindow / minimize / maximize / windowState / reloadRenderer / openDevTools / screenshot: {}',
    annotations: WRITE_LOCAL,
    inputSchema: obj(
      {
        action: enumStr('动作类型', ACTIONS),
        params: { type: 'object', description: '动作参数（见工具描述；MCP 层会按动作做必填/类型校验）', additionalProperties: true },
        idempotencyKey: str('幂等键（可选，仅对 deliverySendNow 生效）：显式传键时同一键+同一参数的重复调用在 10 分钟内只真正执行一次；未传键时同参数调用仅在途去重并保留 60 秒成功缓存'),
      },
      ['action']
    ),
    handler: async (args) => {
      if (!ACTIONS.includes(args.action)) return fail(`不支持的动作：${args.action}`);
      // P0-1: 动作级参数校验在 MCP 层先行拦截（必填/类型/枚举/范围），
      // 不再把写错的参数穿透到渲染层才报错。校验口径见 actionSchema.mjs。
      const rawParams = args.params || {};
      const { idempotencyKey: _topKey, ...paramsNoTop } = rawParams;
      const explicitKey = args.idempotencyKey || rawParams.idempotencyKey;
      const check = validateActionParams(args.action, paramsNoTop);
      if (!check.ok) {
        const structured = { category: 'invalid_params', retryable: false, requireHuman: false };
        return fail(
          `动作 ${args.action} 参数校验失败（已在 MCP 层拦截，未调用应用）：\n${check.errors.map((e) => `- ${e}`).join('\n')}\n\nstructured_error=${JSON.stringify(structured)}`,
          { error: structured, validationErrors: check.errors }
        );
      }
      const execute = async () => {
        // AI 动作（aiAnalyzeJob/aiTailorResume）含真实 LLM 调用（或 agent 代答往返），较长耗时；
        // agentTasks 是长轮询，超时按 waitMs 放宽。统一给宽超时。
        const waitMs = Math.min(Math.max(Number(paramsNoTop?.waitMs) || 0, 0), 55_000);
        const timeoutMs = args.action === 'agentTasks' ? waitMs + 20_000 : /^ai/.test(args.action) ? 200_000 : 90_000;
        const res = await controlCall('POST', '/action', { action: args.action, params: paramsNoTop }, timeoutMs);
        if (!res.ok) {
          // P0-3: 失败统一附结构化错误（风控码/retryable/requireHuman），见 errors.mjs。
          return failStructured(`动作 ${args.action} 失败：${res.error || '未知错误'}\n\n${await bridgeHint()}`, {
            unavailable: !!res.unavailable,
            detail: res.data,
          });
        }
        const payload = res.data || {};
        const known = new Set(['applied', 'message', 'previous', 'next', 'ok', 'image']);
        const extra = Object.fromEntries(Object.entries(payload).filter(([k]) => !known.has(k)));
        const lines = [
          `动作 ${args.action}：${payload.applied === false ? '❌ 未生效' : '✅ 已执行'}`,
          payload.message ? `说明：${payload.message}` : '',
          payload.previous !== undefined ? `原值：${JSON.stringify(payload.previous)}` : '',
          payload.next !== undefined ? `新值：${JSON.stringify(payload.next)}` : '',
          Object.keys(extra).length ? `\n${truncate(JSON.stringify(extra, null, 2), 4000)}` : '',
        ].filter(Boolean);
        // structuredContent 不重复携带图片 base64（否则响应体积翻倍，且部分客户端会拒绝超大结构化数据）；
        // 图片只通过 content 的 image 块传递，文件路径留在 next.file 里可复查。
        const { image, ...dataWithoutImage } = payload;
        const out = { text: lines.join('\n'), data: dataWithoutImage, isError: payload.applied === false };
        if (out.isError) {
          // 已执行但未生效（如被风控拦下）：同样附结构化错误，agent 据此决定停手交人工还是重试。
          const structured = classifyError(payload.message, payload);
          if (structured) {
            out.text = `${out.text}\n\nstructured_error=${JSON.stringify(structured)}`;
            out.data = { ...out.data, error: structured };
          }
        }
        if (image?.base64) {
          out.images = [{ base64: image.base64, mimeType: image.mimeType || 'image/png' }];
          out.text = `${out.text}\n\n（已附带应用截图，mimeType=${image.mimeType || 'image/png'}）`;
        }
        return out;
      };
      // P0-4: 发送类动作走 MCP 层幂等去重（显式键 10 分钟长窗口；同参数自动去重仅在途+60 秒）。
      const scope = `bossclaw_app_action:${args.action}`;
      if (SEND_SCOPE.has(scope)) {
        return sendIdempotency.run(idempotencyKey(scope, paramsNoTop, explicitKey), execute);
      }
      return execute();
    },
  },
];
