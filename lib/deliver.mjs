/**
 * 往一个已有会话投一条用户消息，并让它自动跑一轮。
 *
 * 用的就是宿主自己的 sessionController.prompt()：它内部会 resolveAgent
 * （冷会话自动 resume）、构造 user/message、再 followup 起 driver。
 * 所以这里不需要手改 session 文件，也不存在「排队等下次输入」的降级问题。
 *
 * 为什么带 requestId：宿主按 requestId 去重（hasPromptRequest）。万一同一条
 * 交接被投了两次，第二次会被认成重复请求直接返回 accepted，不会重复跑一轮。
 */
const RETRY_TIMES = 12;
const RETRY_INTERVAL_MS = 5000;

/** 等一会儿。 */
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * @param ctx        - 已经 inject 了 sessionController 的上下文
 * @param handoff    - 交接单（至少要 sessionId、id）
 * @param text       - 要投的话
 * @param requestId  - 去重用的请求 id
 * @returns {{ ok: boolean, error?: string }}
 */
export async function deliverPrompt(ctx, handoff, text, requestId) {
  const controller = ctx?.sessionController;
  if (typeof controller?.prompt !== 'function') return { ok: false, error: 'sessionController.prompt 不可用' };
  const request = {
    sessionId: handoff.sessionId,
    requestId,
    content: [{ type: 'text', text }],
    mode: 'followup',
  };
  let lastError = '';
  for (let attempt = 0; attempt < RETRY_TIMES; attempt += 1) {
    // prompt 的第二个参数是必需的 signal：启动早期宿主还没完全就绪时，
    // 它可能会在真正投递前就抛错，重试把这段时间熬过去。
    const abort = new AbortController();
    try {
      const ack = await controller.prompt(request, abort.signal);
      if (ack?.accepted === true) return { ok: true };
      lastError = 'prompt 未被接受：' + JSON.stringify(ack);
    } catch (error) {
      lastError = String(error?.message ?? error);
    }
    if (attempt < RETRY_TIMES - 1) await sleep(RETRY_INTERVAL_MS);
  }
  return { ok: false, error: lastError };
}
