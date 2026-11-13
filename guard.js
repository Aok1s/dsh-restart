/**
 * dsh-restart/guard —— 看门狗（独立 entry）。
 *
 * 两个职责：
 *
 *   1. 主功能（index.js）这次没加载起来时，把「插件加载失败」这条消息投进原来的会话，
 *      而不是让应用默默回到一个没人解释的状态。
 *
 *   2. 注册一个兜底工具 restart_recover：插件改坏 → app 照样起得来 → 我们在这里
 *      把文件修好 → 用这个工具再重启一次，让修好的主功能重新加载。
 *      没有它的话，主功能坏掉时会话里根本没有 restart_now 可用，只能手动重启。
 *
 * 为什么单独一个 entry：index.js 被改坏时（少个括号、拼错导出名），
 * 那个 entry 会加载失败，但本文件是另一个 entry，仍然会被加载。
 * 第三方插件加载失败只 warn、不影响启动，所以这时 app 是好的，
 * 看门狗有机会把失败原因（含预检报出的文件和行）送回去。
 *
 * 判定「主功能活着」靠 ready.json，而且必须比对 pid：
 * 主功能每次加载都写一份（带写它的进程 pid），上一次启动留下的那份是陈的，
 * 不能当成「这次主功能正常」。
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
  readReady,
  writeHandoff,
} from './lib/store.mjs';
import { buildGuardFailureText } from './lib/message.mjs';
import { deliverPrompt, sleep } from './lib/deliver.mjs';
import { runPreflight } from './lib/preflight.mjs';
import { spawnRelauncher } from './lib/spawn.mjs';

/** 稳定 loader 标识。 */
export const name = 'dsh-restart-guard';

/** 插件根目录（本文件所在目录）。 */
const PACKAGE_ROOT = dirname(fileURLToPath(import.meta.url));

/** 等主功能多久；超过就由本看门狗接手。 */
const WAIT_MS = 45000;

/** 插件版本：从 package.json 读，兜底写进交接单。 */
function readPluginVersion() {
  try {
    const parsed = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8'));
    return typeof parsed?.version === 'string' ? parsed.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/**
 * 读「本次进程」写的就绪标记。
 * ready.pid 是写它的 node 进程 pid，而看门狗和主功能跑在同一个后端进程里，
 * 所以只有 pid 等于 process.pid 才说明主功能这次真的加载过。
 */
function readyOfThisProcess() {
  const ready = readReady();
  if (ready === null || ready.pid !== process.pid) return null;
  return ready;
}

/**
 * 投递失败结论：写回交接单（标记为已被看门狗消费）+ 写日志。
 */
async function reportFailure(ctx, handoff, reason) {
  log('guard: 接管投递，原因=' + reason);
  const text = buildGuardFailureText(handoff, reason);
  const result = await deliverPrompt(ctx, handoff, text, String(handoff.id) + '-guard');
  if (result.ok) {
    patchHandoff({
      phase: 'consumed',
      deliveredAt: Date.now(),
      delivery: { ok: true, by: 'guard', reason, at: Date.now() },
    });
    log('guard: 失败结论已投进会话 ' + handoff.sessionId);
    return;
  }
  // 投不进去就别把交接单标成已消费：留着，下次启动再试一次（还受 10 分钟有效期约束）。
  log('guard: 投递失败 -> ' + String(result.error));
  patchHandoff({ guardError: String(result.error), guardTriedAt: Date.now() });
}

/** 主流程：只在「有未消费的交接单」时才动作。 */
async function watchdog(ctx) {
  const first = readHandoff();
  if (first === null || first.phase !== 'launching') return;
  log('guard: 发现待消费交接单 ' + first.id + '，开始等主功能');

  let handoff = first;
  let hook = readyOfThisProcess()?.hook ?? null;
  for (let waited = 0; waited <= WAIT_MS; waited += 500) {
    handoff = readHandoff();
    // 主功能已经投递完（phase 变 consumed）或交接单被作废：收工。
    if (handoff === null || handoff.phase !== 'launching') {
      log('guard: 交接单已被处理（phase=' + String(handoff?.phase) + '），看门狗收工');
      return;
    }
    hook = readyOfThisProcess()?.hook ?? null;
    if (hook?.state === 'done') {
      log('guard: 主功能已投递，收工');
      return;
    }
    if (hook?.state === 'failed') break;
    await sleep(500);
  }

  const featureLoaded = readyOfThisProcess() !== null;
  let reason;
  if (hook?.state === 'failed') {
    reason = '主功能加载了，但投递失败：' + String(hook.error ?? '未知错误');
  } else if (!featureLoaded) {
    reason = '主功能 entry 没有加载（没有本次进程的就绪标记，多半是 index.js 语法或导出错误）';
  } else {
    reason = '主功能加载了，但 ' + Math.round(WAIT_MS / 1000) + ' 秒内没有完成投递';
  }
  await reportFailure(ctx, handoff, reason);
}

/* -------------------------------------------------------------------------- */
/* 兜底工具：主功能坏掉时唯一还能用的重启入口                                    */
/* -------------------------------------------------------------------------- */

const RECOVER_PARAMETERS = {
  type: 'object',
  properties: {
    note: {
      type: 'string',
      description: '重启后要干什么：一句话写清要验收/检查什么，会原样写进交接单。',
    },
    expectedTools: {
      type: 'array',
      items: { type: 'string' },
      description: '重启后应该出现在工具表里的工具名。',
    },
    expectedVersion: {
      type: 'string',
      description: '重启后应该加载的插件版本号（可选）。',
    },
  },
  required: ['note'],
  additionalProperties: false,
};

const RECOVER_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    ok: { type: 'boolean' },
    handoffId: { type: 'string' },
    attempt: { type: 'number' },
    preflightOk: { type: 'boolean' },
    dataPath: { type: 'string' },
    note: { type: 'string' },
  },
  required: ['ok'],
  additionalProperties: true,
};

function renderRecover(args, value) {
  const parts = [
    value.ok === true ? '兜底重启已发起' : '兜底重启没有发起',
    '交接单 ' + String(value.handoffId ?? '-'),
    '预检 ' + (value.preflightOk === true ? '通过' : '未通过'),
  ];
  if (typeof value.note === 'string' && value.note !== '') parts.push(value.note);
  return [{ type: 'text', text: parts.join(' | ') }];
}

function sessionIdOf(exec) {
  const id = exec?.agent?.session?.id;
  return typeof id === 'string' && id !== '' ? id : null;
}

function registerRecoverTool(ctx) {
  ctx.tools.register({
    name: 'restart_recover',
    description:
      '兜底重启（看门狗提供）：主功能 dsh-restart 这次没加载起来、会话里没有 restart_schedule/restart_now 时用这个。' +
      '它会先跑一遍语法预检——文件还有错就直接报错、不重启；预检通过才写交接单并重启。' +
      '重启后由启动钩子把消息投回本会话。',
    parameters: RECOVER_PARAMETERS,
    output: { schema: RECOVER_OUTPUT_SCHEMA, render: renderRecover },
    async execute(args, exec) {
      const sessionId = sessionIdOf(exec);
      if (sessionId === null) throw new Error('restart_recover 必须由会话里的 agent 调用（拿不到 sessionId）');
      const note = typeof args?.note === 'string' ? args.note.trim() : '';
      if (note === '') throw new Error('restart_recover 需要 note：说清重启后要验收什么');

      const preflight = runPreflight(PACKAGE_ROOT, process.execPath);
      if (preflight.ok !== true) {
        const first = Array.isArray(preflight.failures) && preflight.failures.length > 0 ? preflight.failures[0] : null;
        throw new Error(
          '预检没通过，先修文件再重启：' + (first === null ? '未知错误' : String(first.file) + ' -> ' + String(String(first.output).split('\n')[0])),
        );
      }

      const now = Date.now();
      const previous = readHandoff();
      const expectedTools = Array.isArray(args?.expectedTools) ? args.expectedTools.filter((item) => typeof item === 'string' && item !== '') : [];
      const expectedVersion = typeof args?.expectedVersion === 'string' ? args.expectedVersion.trim() : '';
      const handoff = {
        v: 1,
        plugin: PLUGIN_NAME,
        pluginVersion: readPluginVersion(),
        id: randomUUID(),
        attempt: 1,
        maxAttempts: MAX_ATTEMPTS,
        createdAt: now,
        updatedAt: now,
        expiresAt: now + HANDOFF_TTL_MS,
        sessionId,
        cwd: process.cwd(),
        note,
        expectedTools,
        expectedVersion,
        message: '',
        phase: 'launching',
        launchedAt: now,
        appExe: process.execPath,
        mainPid: process.ppid,
        pluginRoot: PACKAGE_ROOT,
        logPath: join(DATA_DIR, 'relaunch.log'),
        preflight,
        preflightAt: now,
        recoveredBy: 'guard',
      };
      if (previous !== null) handoff.previousId = String(previous.id ?? '');
      writeHandoff(handoff);
      log('guard: 兜底重启 ' + handoff.id + ' session=' + sessionId + '（主功能这次没加载起来）');

      const launched = spawnRelauncher(PACKAGE_ROOT);
      if (!launched.ok) {
        patchHandoff({ launchError: launched.error, failedAt: Date.now() });
        return { ok: false, handoffId: handoff.id, attempt: 1, preflightOk: true, dataPath: DATA_DIR, note: '交接单已落盘，但起重启助手失败：' + String(launched.error) };
      }
      log('guard: 已起重启助手（cmd pid=' + String(launched.pid) + '），约 3 秒后本进程会被杀掉');
      return {
        ok: true,
        handoffId: handoff.id,
        attempt: 1,
        preflightOk: true,
        dataPath: DATA_DIR,
        note: '兜底重启已发起：预检通过、交接单已落盘。本轮对话马上中断，重启后我会回到这个会话。',
      };
    },
  });
}

/** 入口。 */
export function apply(ctx) {
  if (isSafeMode()) {
    log('guard: 安全模式生效，看门狗不启用');
    if (ctx?.logger?.warn) ctx.logger.warn(PLUGIN_NAME + ': 安全模式生效，看门狗与兜底工具都不启用');
    return;
  }
  if (ctx?.logger?.info) ctx.logger.info(PLUGIN_NAME + ': guard half loaded');

  ctx.inject(['tools'], (scoped) => {
    try {
      registerRecoverTool(scoped);
      log('guard: 已注册兜底工具 restart_recover');
    } catch (error) {
      log('guard: 注册兜底工具失败 -> ' + String(error?.stack ?? error));
    }
  });

  ctx.inject(['sessionController'], (scoped) => {
    void watchdog(scoped).catch((error) => log('guard: watchdog 崩了 -> ' + String(error?.stack ?? error)));
  });
}
