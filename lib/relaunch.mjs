/**
 * 重启助手 —— 唯一真正会「动手」的地方。
 *
 * 为什么要单独起一个进程：
 *   重启 = 杀掉当前 app 的整个进程树。插件本身跑在 app 的 backend 子里，
 *   它要是自己去杀，命令还没落地自己就先没了。所以必须有一个「不在那棵树里」
 *   的进程来干这件事。
 *
 * 怎么脱离父进程树：
 *   后端 spawn 了 cmd（一次性），cmd 用 `start "" /B` 拉起本文件，cmd 立刻退出。
 *   于是本进程的父进程变成一个已经死掉的 cmd，taskkill /T 顺着活的父进程往下
 *   找孩子，永远找不到这里。
 *
 * 本文件的步骤（顺序即安全性）：
 *   1. 睡 2.5 秒，让触发重启的那次工具调用先返回、这一轮先收尾；
 *   2. 用 app 自己的 exe 跑预检，把结果写回交接单（坏在哪一行，重启后能报出来）；
 *   3. taskkill /F /T 杀掉旧的主进程（Electron main，backend / 渲染进程都是它的孩子）；
 *   4. 等旧进程真的消失，**没消失就绝不启动第二个实例**（单实例锁会让新窗口一闪就没）；
 *   5. 剥掉 ELECTRON_RUN_AS_NODE 等注入变量，用干净环境启动 app；
 *   6. 轮询新进程写的就绪标记，确认 app 真的活过来了（不能只看退出码 / 进程存在）；
 *   7. 把结果写回交接单与日志，然后退出。
 *
 * 参数：<appExe> <mainPid> <pluginRoot>
 * 环境：从 cmd 继承，带 ELECTRON_RUN_AS_NODE=1（所以本文件由 Electron 当 node 跑）。
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_DIR, log, patchHandoff, readReady } from './store.mjs';
import { runPreflight } from './preflight.mjs';

/** 等一会儿。 */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 命令行参数。 */
const appExeArg = process.argv[2];
const mainPidArg = process.argv[3];
const pluginRootArg = process.argv[4];

/** 并发锁：两次几乎同时的 restart_now 只允许一个助手干活。 */
const LOCK_PATH = join(DATA_DIR, 'relaunch.lock');

/**
 * 进程是否还活着（signal 0 只做存在性检查，不真发信号）。
 *
 * 注意 EPERM：它表示「进程在，只是没权限碰它」。把 EPERM 当成「已经死了」
 * 会让下一步误以为可以安全地开第二个实例 —— 实测在受限令牌下就会发生，
 * 结果是新实例被单实例锁顶回去、白重启一次。只有 ESRCH 才算真的没了。
 */
function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

/**
 * 抢锁。已有活着的助手在干活时**排队等它收工**，而不是立刻放弃。
 *
 * 为什么不能直接退出：实测出现过这种情况 —— 上一个助手还在等新进程的就绪标记
 * （最长要等 120 秒），这次兜底重启的助手一进来看到锁就退出了。结果看门狗记
 * 「已起重启助手」，实际什么也没发生，坏插件还跑在内存里。所以这里改成等，
 * 最多等 150 秒（比那 120 秒长一点），等到了就自己接管这次重启。
 */
async function acquireLock(timeoutMs = 150000) {
  const deadline = Date.now() + timeoutMs;
  let loggedWait = false;
  for (;;) {
    let holder = null;
    try {
      if (existsSync(LOCK_PATH)) {
        const stale = JSON.parse(readFileSync(LOCK_PATH, 'utf8'));
        const fresh = typeof stale?.at === 'number' && Date.now() - stale.at < 180000;
        if (fresh && alive(Number(stale.pid))) holder = stale;
      }
    } catch {
      /* 锁文件坏了就当没有 */
    }
    if (holder === null) break;
    if (!loggedWait) {
      log('relaunch: 已有助手在跑（pid=' + holder.pid + '），排队等它收工，最多 ' + Math.round(timeoutMs / 1000) + ' 秒');
      loggedWait = true;
    }
    if (Date.now() >= deadline) {
      log('relaunch: 等了 ' + Math.round(timeoutMs / 1000) + ' 秒锁还没放，放弃本次重启');
      return false;
    }
    await sleep(2000);
  }
  try {
    writeFileSync(LOCK_PATH, JSON.stringify({ pid: process.pid, at: Date.now() }), 'utf8');
  } catch {
    /* 抢不到锁文件也要继续，不能因为锁把重启卡住 */
  }
  return true;
}

/** 放锁（best effort）。 */
function releaseLock() {
  try {
    unlinkSync(LOCK_PATH);
  } catch {
    /* ignore */
  }
}

/**
 * 等新进程「活过来」。
 *
 * 判据用 ready.json，不用窗口标题：
 *   - 这台机器上窗口标题不可靠（实测 app 的 MainWindowTitle 全是空）,
 *     拿它当判据会把「正常启动」误判成「没起来」；
 *   - ready.json 是插件加载后自己写的，同时说明「进程起来了」和「插件活了」,
 *     正好是最想确认的那两件事。
 *
 * 另外全程盯着新进程活着没：它要是启动就崩，立刻判失败，不用干等到超时。
 */
async function waitForReady(newPid, launchAt, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ready = readReady();
    if (ready !== null && typeof ready === 'object') {
      const readyPid = Number(ready.pid ?? 0);
      const readyAt = Number(ready.at ?? 0);
      // pid 对上，或者标记比这次启动更新，都算新进程写的。
      if (readyPid === newPid || readyAt > launchAt) {
        return { ok: true, reason: '', readyPid, readyAt, hook: ready.hook ?? null };
      }
    }
    if (!alive(newPid)) {
      return { ok: false, reason: '新进程启动后很快退出了（没等到就绪标记）', readyPid: 0, readyAt: 0, hook: null };
    }
    await sleep(1000);
  }
  return {
    ok: false,
    reason: '新进程还活着，但 ' + Math.round(timeoutMs / 1000) + ' 秒内没写就绪标记 —— 多半是插件没加载，看门狗会报告具体原因',
    readyPid: 0,
    readyAt: 0,
    hook: null,
  };
}

/** 真正做事的地方。 */
async function main() {
  const appExe = String(appExeArg ?? process.execPath);
  const mainPid = Number(mainPidArg);
  const pluginRoot = String(pluginRootArg ?? '');
  log('relaunch: helper start pid=' + process.pid + ' ppid=' + process.ppid + ' app=' + appExe + ' mainPid=' + mainPid);
  if (!Number.isInteger(mainPid) || mainPid <= 0 || pluginRoot === '') {
    log('relaunch: 参数不完整，放弃');
    return;
  }

  // 1. 给这一轮一点时间收尾：工具结果写盘、turn 结束。
  await sleep(2500);

  // 2. 预检：坏文件要能被准确报出来。
  let preflight = null;
  try {
    preflight = runPreflight(pluginRoot, appExe);
    patchHandoff({ preflight, preflightAt: Date.now() });
    log('relaunch: preflight ok=' + preflight.ok + ' checked=' + preflight.checked.length);
    for (const failure of preflight.failures) log('relaunch: preflight failure ' + failure.file + ' -> ' + String(failure.output).split('\n')[0]);
  } catch (error) {
    log('relaunch: preflight 崩了 -> ' + String(error?.message ?? error));
  }

  // 3. 杀掉旧的主进程树。
  const kill = spawnSync('taskkill', ['/F', '/T', '/PID', String(mainPid)], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
  log('relaunch: taskkill status=' + String(kill.status) + ' out=' + String(kill.stdout ?? '').trim() + ' err=' + String(kill.stderr ?? '').trim());
  // 杀不掉就别开新的：两个实例抢同一份会话比不重启更糟。
  if (kill.status !== 0 && alive(mainPid)) {
    log('relaunch: 旧进程还在（taskkill 失败），取消启动');
    patchHandoff({ launchError: 'taskkill 失败，旧进程 ' + mainPid + ' 未被杀掉', failedAt: Date.now() });
    return;
  }

  // 4. 等旧进程彻底消失。没死就别启动第二个实例。
  let gone = false;
  for (let i = 0; i < 40; i += 1) {
    if (!alive(mainPid)) {
      gone = true;
      break;
    }
    await sleep(500);
  }
  if (!gone) {
    log('relaunch: 旧进程 ' + mainPid + ' 仍在，取消启动（否则新实例会被单实例锁顶回来）');
    patchHandoff({ launchError: '旧进程 ' + mainPid + ' 未被杀掉，未启动新实例', failedAt: Date.now() });
    return;
  }
  log('relaunch: 旧进程已退出');
  await sleep(800);

  // 5. 干净环境启动：把「让 Electron 当 node 跑」的注入变量全部剥掉。
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.DSH_DESKTOP_NODE_EXECUTABLE;
  delete env.ELECTRON_NO_ATTACH_CONSOLE;
  delete env.DSH_RESTART_HELPER;
  // 记下启动时刻：之后 ready.json 的时间只要比它新，就是新进程写的。
  const launchAt = Date.now();
  let child;
  try {
    child = spawn(appExe, [], {
      cwd: appExe.includes('\\') ? appExe.slice(0, appExe.lastIndexOf('\\')) : undefined,
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
      env,
    });
    child.unref();
  } catch (error) {
    log('relaunch: 启动失败 -> ' + String(error?.message ?? error));
    patchHandoff({ launchError: '启动 app 失败：' + String(error?.message ?? error), failedAt: Date.now() });
    return;
  }
  const newPid = Number(child.pid);
  log('relaunch: 新进程 pid=' + newPid);

  // 6. 等就绪标记，确认真的活过来了。
  const ready = await waitForReady(newPid, launchAt, 120000);
  log('relaunch: ready ok=' + ready.ok + ' readyPid=' + ready.readyPid + ' reason=' + JSON.stringify(ready.reason));
  patchHandoff({
    newPid,
    relaunchedAt: Date.now(),
    readyOk: ready.ok,
    readyPid: ready.readyPid,
    readyHook: ready.hook,
    ...(ready.ok ? {} : { launchError: ready.reason }),
  });
}

try {
  if (!(await acquireLock())) process.exit(0);
  await main();
} catch (error) {
  log('relaunch: 未捕获异常 -> ' + String(error?.stack ?? error));
  try {
    patchHandoff({ launchError: '重启助手异常：' + String(error?.message ?? error), failedAt: Date.now() });
  } catch {
    /* ignore */
  }
} finally {
  releaseLock();
  log('relaunch: helper exit');
}
