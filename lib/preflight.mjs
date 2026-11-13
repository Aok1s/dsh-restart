/**
 * 重启前预检：把插件自己的每个 js 当语法检查跑一遍。
 *
 * 为什么在重启前做：插件被改坏一个字符时，最糟的情况是 app 起不来、谁也
 * 不知道发生了什么。预检把「坏在哪一行」提前写进交接单，重启后看门狗
 * 就能把确切位置报进会话，而不是让人对着一个没反应的黑窗口猜。
 *
 * 检查方式：用 app 自己的 Electron 二进制 + ELECTRON_RUN_AS_NODE=1 跑
 * `--check <file>`。这样校验用的 node 版本和真跑插件的版本一致，
 * 不需要在 PATH 里另找一个 node。
 *
 * 一个实现细节：子进程的 stdout/stderr 不接管道，而是落到临时文件再读回来。
 * 理由有两个——(1) 输出可能有几千行，读管道容易卡；(2) 某些受限环境（沙箱、
 * 某些安全软件）会直接拒绝「创建管道」的 spawn，用文件句柄就没这个问题。
 */
import { spawnSync } from 'node:child_process';
import { closeSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';

/** 收集插件目录下所有 js（跳过 node_modules / .git / 数据目录）。 */
export function listPluginJsFiles(pluginRoot) {
  const found = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (/\.(?:mjs|cjs|js)$/i.test(entry.name)) {
        found.push(full);
      }
    }
  };
  walk(pluginRoot);
  return found.sort();
}

/** 跑一次 `--check`，把子进程输出经临时文件收回来。 */
function checkOne(nodeExe, file) {
  const scratch = mkdtempSync(join(tmpdir(), 'dsh-restart-check-'));
  const outPath = join(scratch, 'out.txt');
  const fd = openSync(outPath, 'w');
  try {
    const result = spawnSync(nodeExe, ['--check', file], {
      windowsHide: true,
      timeout: 20000,
      // 不接管道：stdout/stderr 都写进同一个文件句柄。
      stdio: ['ignore', fd, fd],
      // 这个 exe 是 Electron：不带这个变量就会去开窗口，而不是当 node 用。
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    });
    let text = '';
    try {
      text = readFileSync(outPath, 'utf8');
    } catch {
      text = '';
    }
    text = text.trim();
    if (result.error !== undefined && text === '') text = String(result.error?.message ?? result.error);
    return { code: typeof result.status === 'number' ? result.status : null, output: text, signal: result.signal ?? null };
  } finally {
    try {
      closeSync(fd);
    } catch {
      /* 已经关了就算了 */
    }
    try {
      rmSync(scratch, { recursive: true, force: true });
    } catch {
      /* 临时文件删不掉不影响结论 */
    }
  }
}

/**
 * 逐个文件语法检查。
 *
 * @param pluginRoot - 插件根目录
 * @param nodeExe    - 用来跑的二进制（正常就是 app 自己的 exe）
 * @returns {{ ok: boolean, checked: string[], failures: {file: string, code: number|null, output: string}[], at: number }}
 *          失败时 failures 里每个元素都带着「文件 + 头几行报错」，足够定位到行。
 */
export function runPreflight(pluginRoot, nodeExe) {
  const files = listPluginJsFiles(pluginRoot);
  const failures = [];
  for (const file of files) {
    const result = checkOne(nodeExe, file);
    // code 为 null 也可能是「跑不起来」——只有 output 为空时才当通过，
    // 免得「检查器本身崩了」被误报成「代码没问题」。
    const passed = result.code === 0 || (result.code === null && result.output === '');
    if (!passed) {
      failures.push({
        file: relative(pluginRoot, file),
        code: result.code,
        output: String(result.output).split('\n').slice(0, 5).join('\n'),
      });
    }
  }
  return {
    ok: failures.length === 0,
    checked: files.map((file) => relative(pluginRoot, file)),
    failures,
    at: Date.now(),
  };
}
