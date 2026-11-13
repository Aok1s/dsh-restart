/**
 * dsh-restart —— 主功能（feature entry）。
 *
 * 要解决的问题：装/改插件后必须手动重启 DSH 桌面端才生效，而重启会把当前这一轮
 * 模型对话直接打断——「重启前想做的事」和「重启后想做的事」没法放在同一轮里。
 *
 * 这个 entry 干三件事：
 *
 *   1. 注册两个工具
 *        restart_schedule  只登记、不重启：把「重启后要回来干什么」写进交接单；
 *        restart_now       真正重启：写交接单 → 起一个脱离进程树的助手去杀进程、重开 app。
 *
 *   2. 启动钩子
 *        新进程起来后读交接单：如果有一张「上次重启留下的、还没消费的」单子，
 *        就把一条消息投回原来那个会话，让 agent 自己接着跑验收那一轮。
 *        （投递用的是宿主自己的 sessionController.prompt，冷会话会被自动 resume，
 *          一条用户消息投进去就会起一轮，不需要手改 session 文件。）
 *
 *   3. 就绪标记
 *        每次加载都写 ready.json，看门狗（guard.js）靠它区分
 *        「主功能正常」和「主功能根本没加载」。
 *
 * 边界：本文件里的任何失败都不许拦住 app 启动。第三方插件 entry 加载失败只 warn，
 * 所以这里反而要保证「出错就早点退出」，别抛出未处理的异常。
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DATA_DIR,
  HANDOFF_TTL_MS,
  MAX_ATTEMPTS,
  PLUGIN_NAME,
  isSafeMode,
  log,
  patchHandoff,
  readHandoff,
  readJsonSync,
  readReady,
  writeHandoff,
  writeJsonSync,
  writeReady,
} from './lib/store.mjs';
import { buildDeliveryText } from './lib/message.mjs';
import { deliverPrompt, sleep } from './lib/deliver.mjs';
import { runPreflight } from './lib/preflight.mjs';
import { spawnRelauncher } from './lib/spawn.mjs';

/** 稳定 loader 标识。 */
export const name = 'dsh-restart';

/** 插件根目录（本文件所在目录）。 */
const PACKAGE_ROOT = dirname(fileURLToPath(import.meta.url));

/** 插件版本：从 package.json 读，报结论时用得上。 */
function readPluginVersion() {
  try {
    const parsed = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8'));
    return typeof parsed?.version === 'string' ? parsed.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

const VERSION = readPluginVersion();

/** 防连环重启：10 分钟窗口内最多真正重启几次（跨交接单也计数，防止「重启→检查→再重启」的死循环）。 */
const LAUNCH_WINDOW_MS = 10 * 60 * 1000;
const MAX_LAUNCHES_PER_WINDOW = 3;

/** 读最近这个时间窗内真正发生过几次重启。 */
function recentLaunches() {
  const raw = readJsonSync(join(DATA_DIR, 'launches.json'));
  const times = Array.isArray(raw?.times) ? raw.times : [];
  return times.filter((value) => typeof value === 'number' && Date.now() - value < LAUNCH_WINDOW_MS);
}

/** 记一次重启（在写交接单之后、起助手之前调用）。 */
function recordLaunch(now) {
  writeJsonSync(join(DATA_DIR, 'launches.json'), { times: [...recentLaunches(), now] });
}

/** 从工具执行上下文里拿「调用方属于哪个会话」。 */
function sessionIdOf(exec) {
  const id = exec?.agent?.session?.id;
  return typeof id === 'string' && id !== '' ? id : null;
}

/** 把工具参数整理成统一形状（缺省即空串/空数组，不信任模型给的形状）。 */
function normalizeArgs(args) {
  const note = typeof args?.note === 'string' ? args.note.trim() : '';
  const expectedTools = Array.isArray(args?.expectedTools)
    ? args.expectedTools.filter((item) => typeof item === 'string' && item.trim() !== '').map((item) => item.trim())
    : [];
  const expectedVersion = typeof args?.expectedVersion === 'string' ? args.expectedVersion.trim() : '';
  const message = typeof args?.message === 'string' ? args.message.trim() : '';
  return { note, expectedTools, expectedVersion, message };
}

/** 更新就绪标记里的 hook 状态（看门狗靠它判断投递有没有完成）。 */
function patchReady(patch) {
  const current = readReady();
  const next = {
    pid: process.pid,
    at: Date.now(),
    version: VERSION,
    ...(current !== null && typeof current === 'object' ? current : {}),
    ...patch,
    updatedAt: Date.now(),
  };
  writeReady(next);
  return next;
}

/* -------------------------------------------------------------------------- */
/* 重启助手                                                                     */
/* -------------------------------------------------------------------------- */


/* -------------------------------------------------------------------------- */
/* 启动钩子                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * 启动后：如果有一张「重启留下的、还没消费的」交接单，把消息投回去。
 *
 * 只处理 phase === 'launching' 的单子：
 *   scheduled —— 只登记过、没真重启（app 可能是被手动重启的），不该凭空投一轮；
 *   launching —— 真重启了，正在等这次投递；
 *   consumed  —— 已经投过，绝不重复投。
 */
async function runStartupHook(ctx) {
  writeReady({ pid: process.pid, at: Date.now(), version: VERSION, hook: { state: 'pending', at: Date.now() } });

  const handoff = readHandoff();
  if (handoff === null) {
    patchReady({ hook: { state: 'skipped', reason: 'no-handoff', at: Date.now() } });
    return;
  }
  if (handoff.phase !== 'launching') {
    patchReady({ hook: { state: 'skipped', reason: 'phase-' + String(handoff.phase), handoffId: handoff.id, at: Date.now() } });
    return;
  }
  // 超过 10 分钟的单子作废：可能是几天前没消费掉的，绝不能拿它再投一轮。
  if (Date.now() > Number(handoff.expiresAt ?? 0)) {
    writeHandoff({ ...handoff, phase: 'consumed', delivery: { ok: false, reason: 'expired', at: Date.now() } });
    patchReady({ hook: { state: 'skipped', reason: 'expired', handoffId: handoff.id, at: Date.now() } });
    log('hook: 交接单 ' + handoff.id + ' 已过期，作废');
    return;
  }

  patchReady({ hook: { state: 'delivering', handoffId: handoff.id, at: Date.now() } });
  const text = buildDeliveryText(handoff);
  const result = await deliverPrompt(ctx, handoff, text, handoff.id);
  if (result.ok) {
    writeHandoff({
      ...handoff,
      phase: 'consumed',
      deliveredAt: Date.now(),
      delivery: { ok: true, by: 'feature', at: Date.now() },
    });
    patchReady({ hook: { state: 'done', handoffId: handoff.id, delivered: true, at: Date.now() } });
    log('hook: 已把验收消息投进会话 ' + handoff.sessionId + '（交接单 ' + handoff.id + '）');
    return;
  }
  // 投不进去：不标 consumed，留给看门狗接手（它会带错误原因再试一次）。
  patchReady({ hook: { state: 'failed', handoffId: handoff.id, error: result.error, at: Date.now() } });
  log('hook: 投递失败 -> ' + String(result.error));
}

/* -------------------------------------------------------------------------- */
/* 工具                                                                         */
/* -------------------------------------------------------------------------- */

/** 两个工具共用的参数表。 */
const PARAMETERS = {
  type: 'object',
  properties: {
    note: {
      type: 'string',
      description: '重启后回来要做什么（写给重启后的自己看：检查哪个功能、看什么证据）。',
    },
    expectedTools: {
      type: 'array',
      items: { type: 'string' },
      description: '期望在重启后加载的工具名，例如 ["restart_now", "restart_schedule"]。',
    },
    expectedVersion: {
      type: 'string',
      description: '期望的插件版本，例如 "0.1.0"。',
    },
    message: {
      type: 'string',
      description: '可选：完全自定义重启后投回来的那句话；不填则自动生成。',
    },
  },
  required: ['note'],
  additionalProperties: false,
};

/** 工具返回值 schema（两个工具一样）。 */
const OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    ok: { type: 'boolean' },
    handoffId: { type: 'string' },
    phase: { type: 'string' },
    attempt: { type: 'integer' },
    expiresAt: { type: 'string' },
    preflightOk: { type: 'boolean' },
    dataPath: { type: 'string' },
    launcher: { type: 'string' },
    note: { type: 'string' },
  },
  required: ['ok'],
};

/** 把结构化结果渲染成给模型看的一段话。 */
function renderResult(args, value) {
  const parts = [];
  if (value?.ok === true) {
    parts.push('ok=true');
    parts.push('handoff=' + String(value.handoffId ?? ''));
    if (value.phase !== undefined) parts.push('phase=' + String(value.phase));
    if (value.attempt !== undefined) parts.push('attempt=' + String(value.attempt) + '/' + String(MAX_ATTEMPTS));
    if (value.expiresAt !== undefined) parts.push('expiresAt=' + String(value.expiresAt));
    if (value.preflightOk !== undefined) parts.push('preflight=' + (value.preflightOk ? '通过' : '未通过'));
    if (value.note !== undefined) parts.push(String(value.note));
  } else {
    parts.push('ok=false');
    parts.push(String(value?.note ?? '未完成'));
  }
  return [{ type: 'text', text: parts.join(' | ') }];
}

/** 注册两个工具。 */
function registerTools(ctx) {
  const tools = ctx.tools;

  // —— 动作一：只登记，不重启 ——
  tools.register({
    name: 'restart_schedule',
    description:
      '登记一次「待重启」：把重启后要回到哪个会话、要说什么、期望加载什么，写进交接单（落盘）。本工具不会重启 app。' +
      '典型用法：用户说「改好了，重启验收」→ 先 restart_schedule 写清检查目标 → 再 restart_now 真正重启。',
    parameters: PARAMETERS,
    output: { schema: OUTPUT_SCHEMA, render: renderResult },
    async execute(args, exec) {
      const sessionId = sessionIdOf(exec);
      if (sessionId === null) throw new Error('restart_schedule 必须由会话里的 agent 调用（拿不到 sessionId）');
      const { note, expectedTools, expectedVersion, message } = normalizeArgs(args);
      if (note === '' && message === '') throw new Error('restart_schedule 需要 note：写清重启后要检查什么');

      const now = Date.now();
      const previous = readHandoff();
      // 上一张单子还没被消费（正在等投递）：不要覆盖，否则那条消息就丢了。
      if (previous !== null && previous.phase === 'launching' && now < Number(previous.expiresAt ?? 0)) {
        return {
          ok: false,
          handoffId: String(previous.id ?? ''),
          phase: String(previous.phase),
          attempt: Number(previous.attempt ?? 0),
          note: '上一次重启的交接还没被消费（等地投递中），先不要覆盖它；稍后再试或直接看 relaunch.log。',
        };
      }
      const reuse = previous !== null
        && previous.sessionId === sessionId
        && previous.phase === 'scheduled'
        && now < Number(previous.expiresAt ?? 0);
      const handoff = {
        v: 1,
        plugin: PLUGIN_NAME,
        pluginVersion: VERSION,
        id: reuse ? String(previous.id) : randomUUID(),
        attempt: reuse ? Number(previous.attempt ?? 0) : 0,
        maxAttempts: MAX_ATTEMPTS,
        createdAt: reuse ? Number(previous.createdAt ?? now) : now,
        updatedAt: now,
        expiresAt: now + HANDOFF_TTL_MS,
        sessionId,
        cwd: process.cwd(),
        note,
        expectedTools,
        expectedVersion,
        message,
        phase: 'scheduled',
        appExe: process.execPath,
        mainPid: process.ppid,
        pluginRoot: PACKAGE_ROOT,
        preflight: usePreflightSafe(),
      };
      writeHandoff(handoff);
      log('schedule: ' + handoff.id + ' session=' + sessionId + ' note=' + JSON.stringify(note));
      return {
        ok: true,
        handoffId: handoff.id,
        phase: handoff.phase,
        attempt: handoff.attempt,
        expiresAt: new Date(handoff.expiresAt).toISOString(),
        preflightOk: handoff.preflight?.ok === true,
        dataPath: DATA_DIR,
        note: '已登记。真正重启请调用 restart_now。',
      };
    },
  });

  // —— 动作二：写交接单 + 真重启 ——
  tools.register({
    name: 'restart_now',
    description:
      '真正重启 DSH 桌面端：先把交接单落盘（会话 id、重启后要说的话、期望工具/版本、第几次、预检结果），' +
      '再起一个脱离进程树的助手杀进程并重开 app。调用后本轮对话会被中断，重启后由启动钩子把消息投回本会话，' +
      'agent 自己接着跑验收。同一个交接链最多重启 2 次。',
    parameters: PARAMETERS,
    output: { schema: OUTPUT_SCHEMA, render: renderResult },
    async execute(args, exec) {
      const sessionId = sessionIdOf(exec);
      if (sessionId === null) throw new Error('restart_now 必须由会话里的 agent 调用（拿不到 sessionId）');
      const { note, expectedTools, expectedVersion, message } = normalizeArgs(args);
      const previous = readHandoff();
      const now = Date.now();
      const chainAlive = previous !== null
        && previous.sessionId === sessionId
        && previous.phase !== 'consumed'
        && now < Number(previous.expiresAt ?? 0);
      const attempt = (chainAlive ? Number(previous.attempt ?? 0) : 0) + 1;
      if (attempt > MAX_ATTEMPTS) {
        throw new Error(
          '重启次数已用完：同一次交接最多重启 ' + MAX_ATTEMPTS + ' 次（防重启死循环）。'
          + '如果刚重启过，先看 relaunch.log 找原因；确认要再来一次就先把交接单删掉：' + join(DATA_DIR, 'handoff.json'),
        );
      }

      // 跨交接单的硬上限：就算每张单子都是新链，也不许在 10 分钟里反复重启。
      if (recentLaunches().length >= MAX_LAUNCHES_PER_WINDOW) {
        throw new Error(
          '10 分钟内已经真正重启过 ' + MAX_LAUNCHES_PER_WINDOW + ' 次，先停下来看日志：' + join(DATA_DIR, 'relaunch.log'),
        );
      }

      const preflight = usePreflightSafe();
      const handoff = {
        v: 1,
        plugin: PLUGIN_NAME,
        pluginVersion: VERSION,
        id: randomUUID(),
        attempt,
        maxAttempts: MAX_ATTEMPTS,
        createdAt: now,
        updatedAt: now,
        expiresAt: now + HANDOFF_TTL_MS,
        sessionId,
        cwd: process.cwd(),
        note: note !== '' ? note : String(previous?.note ?? ''),
        expectedTools: expectedTools.length > 0 ? expectedTools : (Array.isArray(previous?.expectedTools) ? previous.expectedTools : []),
        expectedVersion: expectedVersion !== '' ? expectedVersion : String(previous?.expectedVersion ?? ''),
        message: message !== '' ? message : String(previous?.message ?? ''),
        phase: 'launching',
        launchedAt: now,
        appExe: process.execPath,
        mainPid: process.ppid,
        pluginRoot: PACKAGE_ROOT,
        logPath: join(DATA_DIR, 'relaunch.log'),
        preflight,
        preflightAt: now,
      };
      // 先落盘，再动手：重启会把这一轮直接掐断，没落盘的信息就永远丢了。
      writeHandoff(handoff);
      recordLaunch(now);
      log('restart: ' + handoff.id + ' attempt=' + attempt + ' session=' + sessionId + ' preflight=' + (preflight.ok ? 'ok' : 'fail'));

      const launched = spawnRelauncher(PACKAGE_ROOT);
      if (!launched.ok) {
        patchHandoff({ launchError: launched.error, failedAt: Date.now() });
        return { ok: false, handoffId: handoff.id, attempt, phase: 'launching', note: '交接单已落盘，但起重启助手失败：' + String(launched.error) };
      }
      log('restart: 已起重启助手（cmd pid=' + String(launched.pid) + '），约 3 秒后本进程会被杀掉');

      return {
        ok: true,
        handoffId: handoff.id,
        phase: handoff.phase,
        attempt,
        expiresAt: new Date(handoff.expiresAt).toISOString(),
        preflightOk: preflight.ok,
        launcher: String(launched.pid ?? ''),
        note: '交接单已落盘，重启助手已启动。本轮对话马上会被中断；重启完成后我会回到这个会话继续验收，不需要你再说话。',
      };
    },
  });
}

/**
 * 跑预检并把结果拿回来；预检自己崩了也照样返回一张「未通过」的单子，
 * 不让它拦住重启（重启还是要发生，只是回来要报「坏在哪」）。
 */
function usePreflightSafe() {
  try {
    return runPreflight(PACKAGE_ROOT, process.execPath);
  } catch (error) {
    return { ok: false, checked: [], failures: [{ file: '(preflight)', code: null, output: String(error?.message ?? error) }], at: Date.now() };
  }
}

/* -------------------------------------------------------------------------- */
/* 入口                                                                         */
/* -------------------------------------------------------------------------- */

/** 插件入口：安全模式下完全不动。 */
export function apply(ctx) {
  if (isSafeMode()) {
    log('feature: 安全模式（DSH_RESTART_SAFE / safe.flag）生效，插件不启用');
    if (ctx?.logger?.warn) ctx.logger.warn(PLUGIN_NAME + ': 安全模式生效，工具与启动钩子都不启用');
    return;
  }

  if (ctx?.logger?.info) ctx.logger.info(PLUGIN_NAME + ': feature half loaded (v' + VERSION + ')');

  // 工具：早注册，用户一有需求就能看到。
  ctx.inject(['tools'], (scoped) => {
    try {
      registerTools(scoped);
      log('feature: 已注册 restart_schedule / restart_now（v' + VERSION + ' · 验收标记 mark-0.1.1）');
    } catch (error) {
      log('feature: 注册工具失败 -> ' + String(error?.stack ?? error));
      if (ctx?.logger?.warn) ctx.logger.warn(PLUGIN_NAME + ': 注册工具失败：' + String(error?.message ?? error));
    }
  });

  // 启动钩子：等 sessionController 可用（它内部会 resume 冷会话、起一轮）。
  ctx.inject(['sessionController'], (scoped) => {
    void (async () => {
      // 稍等一下，让会话持久化与模型选择先就绪；投递本身还有重试兜底。
      await sleep(800);
      await runStartupHook(scoped);
    })().catch((error) => {
      log('hook: 启动钩子异常 -> ' + String(error?.stack ?? error));
      patchReady({ hook: { state: 'failed', error: String(error?.message ?? error), at: Date.now() } });
    });
  });
}
