/**
 * 落盘层：交接文件、就绪标记、日志。
 *
 * 这个插件的生死线是「重启前把该写的都写到盘上」。所以这里所有写操作都是
 * 同步写 + fsync + rename，宁可慢一点也不留半截文件：
 *
 *   handoff.json  —— 交接单。重启前写下（谁、哪个会话、回来要说什么、第几次），
 *                    重启后由新进程读它来决定「该往哪里投什么话」。
 *   ready.json    —— 就绪标记。主功能加载成功时写；看门狗靠它判断
 *                    「主功能是不是活着」。
 *   relaunch.log  —— 重启助手的过程日志，出问题就翻这里。
 *   safe.flag     —— 安全模式开关（文件形式）。存在就彻底不干活。
 *
 * 路径都以 DSH_HOME 为根：默认 C:\Users\<用户>\.dsh\restart。
 */
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeSync, appendFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** 插件名：同时用作日志前缀。 */
export const PLUGIN_NAME = 'dsh-restart';

/** DSH 数据根目录：宿主会把它设进环境变量，没设就退回 ~/.dsh。 */
export const DSH_HOME = typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME.trim() !== ''
  ? process.env.DSH_HOME.trim()
  : join(homedir(), '.dsh');

/** 插件的全部状态都放这一个目录里，卸载时删掉即可。 */
export const DATA_DIR = join(DSH_HOME, 'restart');

/** 交接单。 */
export const HANDOFF_PATH = join(DATA_DIR, 'handoff.json');

/** 就绪标记（主功能活着）。 */
export const READY_PATH = join(DATA_DIR, 'ready.json');

/** 重启助手的过程日志。 */
export const LOG_PATH = join(DATA_DIR, 'relaunch.log');

/** 安全模式开关：文件存在 = 插件完全不干活。 */
export const SAFE_FLAG_PATH = join(DATA_DIR, 'safe.flag');

/** 同一条交接单（同一次重启链）最多允许重启几次。第 3 次直接拒绝。 */
export const MAX_ATTEMPTS = 2;

/** 交接单有效期：超过 10 分钟就作废，避免几天前的一张单子把 app 再重启一遍。 */
export const HANDOFF_TTL_MS = 10 * 60 * 1000;

/** 建目录：所有写操作前都先保证目录在。 */
export function ensureDataDir() {
  mkdirSync(DATA_DIR, { recursive: true });
}

/**
 * 原子写一个文本文件：写临时文件 → fsync → rename 覆盖。
 *
 * 直接写目标文件的话，正好在「打开但还没写完」时被 taskkill，留下的是
 * 半截 JSON；重启后的钩子读它会解析失败，等于这次交接丢了。
 * fsync 是必须的：rename 只保证目录项换掉，不保证数据已经从页缓存下盘。
 */
function writeAtomicSync(path, text) {
  ensureDataDir();
  const tmp = path + '.' + process.pid + '.tmp';
  const fd = openSync(tmp, 'w');
  try {
    writeSync(fd, text, null, 'utf8');
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
}

/** 读一个 JSON 文件；不存在、读不动、坏了都返回 null（调用方按「没有」处理）。 */
export function readJsonSync(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

/** 原子写 JSON。 */
export function writeJsonSync(path, value) {
  writeAtomicSync(path, JSON.stringify(value, null, 2));
}

/** 读交接单。 */
export function readHandoff() {
  const value = readJsonSync(HANDOFF_PATH);
  return value !== null && typeof value === 'object' ? value : null;
}

/** 写交接单（整份覆盖）。 */
export function writeHandoff(handoff) {
  writeJsonSync(HANDOFF_PATH, handoff);
}

/**
 * 读 → 改 → 写。文件不在了就返回 null。
 * 注意：这个「读改写」没有跨进程锁，但所有写者都来自同一个 app 里的先后步骤，
 * 真正可能撞车的两个写者（feature 与 guard）用 phase 字段互相避让。
 */
export function patchHandoff(patch) {
  const current = readHandoff();
  if (current === null) return null;
  const next = { ...current, ...patch, updatedAt: Date.now() };
  writeHandoff(next);
  return next;
}

/** 读就绪标记。 */
export function readReady() {
  const value = readJsonSync(READY_PATH);
  return value !== null && typeof value === 'object' ? value : null;
}

/** 写就绪标记。 */
export function writeReady(ready) {
  writeJsonSync(READY_PATH, ready);
}

/** 追加一行日志（带时间戳）。日志本身出错不许影响主流程。 */
export function log(line) {
  const stamp = new Date().toISOString();
  try {
    ensureDataDir();
    appendFileSync(LOG_PATH, '[' + stamp + '] ' + line + '\n', 'utf8');
  } catch {
    /* 日志写不进去就算了，不能因为它把重启流程弄挂 */
  }
}

/**
 * 安全模式判断。
 *
 * 两条路子，任一命中就完全不动插件（工具不注册、钩子不投递、看门狗不报信）：
 *   1. 环境变量 DSH_RESTART_SAFE=1（或 true/yes/on）
 *   2. 数据目录里存在 safe.flag 文件
 *
 * 为什么需要它：插件代码被改坏时，最怕的是「连报信的都坏了」。
 * 安全模式下 app 走的就是「没有这个插件」的路径，一定能起来。
 */
export function isSafeMode() {
  const raw = String(process.env.DSH_RESTART_SAFE ?? '').trim().toLowerCase();
  if (raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on') return true;
  return existsSync(SAFE_FLAG_PATH);
}
