/**
 * 投递文本拼装。
 *
 * 两段话，两个来源：
 *   buildDeliveryText      —— 主功能重启后投给会话的「验收通知」；
 *   buildGuardFailureText  —— 主功能没起来时，看门狗代它投的「失败通知」。
 *
 * 文本要写得让「未来的自己」一看就知道该干什么：检查什么、期望什么、
 * 拿什么当证据、报告给谁、不要再重启一遍。
 */

/** 预检结果写成一行人话。 */
function describePreflight(preflight) {
  if (preflight === null || typeof preflight !== 'object') return '没有预检记录（重启前没来得及跑）';
  if (preflight.ok === true) return '通过（' + (preflight.checked?.length ?? 0) + ' 个 js 文件）';
  const lines = (preflight.failures ?? []).map((failure) => failure.file + ': ' + String(failure.output ?? '').split('\n')[0]);
  return '未通过 —— ' + (lines.length > 0 ? lines.join(' | ') : '未知原因');
}

/** 时间戳转成本地可读时间。 */
function stampOf(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return '未知';
  return new Date(ms).toLocaleString('zh-CN', { hour12: false });
}

/**
 * 重启成功后投回会话的那条消息。
 *
 * @param handoff - 交接单
 */
export function buildDeliveryText(handoff) {
  const note = typeof handoff.note === 'string' && handoff.note.trim() !== '' ? handoff.note.trim() : '（没写具体检查目标，按期望工具与版本核对即可）';
  const tools = Array.isArray(handoff.expectedTools) && handoff.expectedTools.length > 0
    ? handoff.expectedTools.join('、')
    : '（没指定）';
  const version = typeof handoff.expectedVersion === 'string' && handoff.expectedVersion.trim() !== ''
    ? handoff.expectedVersion.trim()
    : '（没指定）';
  return [
    '【重启完成 · 第 ' + handoff.attempt + ' 次】DSH 已经被 dsh-restart 重启，并回到了这个会话。',
    '',
    '要验收的：' + note,
    '期望工具：' + tools,
    '期望版本：' + version,
    '插件预检：' + describePreflight(handoff.preflight),
    '重启发起：' + stampOf(handoff.launchedAt) + '，交接单 ' + handoff.id,
    '',
    '请你自己跑这一轮验收（行动，不要只复述）：',
    '1. 工具列表里有没有上面那些工具——能被调用就说明插件真的加载了；',
    '2. 插件版本是不是期望值（可以读 package.json 或调用工具看返回）；',
    '3. 如果这次是改了某个功能来验收，按改动点实际试一次，拿到证据。',
    '然后把「加载成功/失败 + 证据 + 结论」报告给老大。这次不要再来一次重启。',
  ].join('\n');
}

/**
 * 主功能没起来时，看门狗代替它投的那条消息。
 *
 * @param handoff - 交接单
 * @param reason  - 为什么判定主功能没起来
 */
export function buildGuardFailureText(handoff, reason) {
  const failures = handoff?.preflight?.failures ?? [];
  const detail = failures.length > 0
    ? failures.map((failure) => '- ' + failure.file + '\n' + String(failure.output ?? '').split('\n').slice(0, 3).map((line) => '    ' + line).join('\n')).join('\n')
    : '（预检没有报出具体文件，可能是加载阶段的其他错误）';
  return [
    '【重启自检 · 插件没起来】应用已经从重启中回来了，但 dsh-restart 自己这次没有正常加载。',
    '',
    '判定依据：' + reason,
    '涉及会话：' + handoff.sessionId,
    '重启发起：' + stampOf(handoff.launchedAt) + '，交接单 ' + handoff.id,
    '',
    '预检报错：',
    detail,
    '',
    '应用本身还能用（第三方插件加载失败不会拦住启动），所以你现在能读到这条消息——这就是看门狗的作用。',
    '请把结论告诉老大：这次验收没有完成，坏在哪个文件哪一行；修好后再重启一次。',
    '过程日志：' + (handoff.logPath ?? ''),
  ].join('\n');
}
