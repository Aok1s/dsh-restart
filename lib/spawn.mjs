/**
 * dsh-restart/lib/spawn —— 起「能活过本次 app 生命」的重启助手。
 *
 * 两个要点（踩过坑，别改回去）：
 *   1. 必须离开当前进程树：后端直接 spawn 出来的子进程会被 taskkill /T 连带杀掉。
 *      所以先落一个一次性 .cmd，里面用 `start "" /B` 拉助手，cmd 自己立刻退出，
 *      助手的父进程于是变成一个死掉的 cmd —— 杀树杀不到它。
 *   2. 助手要能跑：app 的 exe 在这里是 Electron，只有带着 ELECTRON_RUN_AS_NODE=1
 *      才会当 node 解释器跑（继承自后端环境，正好）。
 *
 * 主功能（index.js）和看门狗（guard.js）都要用，所以单独抽出来：
 * 主功能坏掉时，看门狗还能用同一条路把应用重启起来。
 */
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_DIR, log } from './store.mjs';

/**
 * @param {string} pluginRoot 插件根目录（relaunch.mjs 所在的那一层）
 * @returns {{ ok: boolean, cmdPath?: string, pid?: number, error?: string }}
 */
export function spawnRelauncher(pluginRoot) {
  const helper = join(pluginRoot, 'lib', 'relaunch.mjs');
  const cmdPath = join(DATA_DIR, 'relaunch.cmd');
  const quote = (value) => '"' + String(value).replace(/"/g, '') + '"';
  const commandLine = [
    'start "" /B',
    quote(process.execPath),
    quote(helper),
    quote(process.execPath),
    String(process.ppid),
    quote(pluginRoot),
  ].join(' ');
  const body = ['@echo off', commandLine, ''].join('\r\n');
  try {
    writeFileSync(cmdPath, body, 'utf8');
  } catch (error) {
    return { ok: false, error: '写重启脚本失败：' + String(error?.message ?? error) };
  }
  // cmd 只认 ANSI 代码页，路径里有中文就会被吃；这里提前发现、写进日志。
  if (/[^\x00-\x7F]/.test(cmdPath + helper + process.execPath)) {
    log('relaunch: 警告：重启脚本路径含非 ASCII 字符，cmd 可能解析不了');
  }
  try {
    const child = spawn('cmd.exe', ['/c', cmdPath], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env: process.env,
    });
    child.unref();
    return { ok: true, cmdPath, pid: child.pid };
  } catch (error) {
    return { ok: false, error: '起重启助手失败：' + String(error?.message ?? error) };
  }
}
