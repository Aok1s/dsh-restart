# dsh-restart

让 agent 在会话里自己重启 DSH 桌面端，并且**重启完自己回来接着干活**。

你改完插件、装完新工具之后，只要在会话里说一句「改好了，重启验收」，agent 就会：

1. 把「重启后要回到哪个会话、要检查什么、期望哪个版本」写进磁盘上的交接单（fsync 落盘）；
2. 起一个脱离进程树的助手进程：杀掉旧的 DSH，用干净环境重新拉起；
3. 新进程启动时发现这张没消费的交接单，把「重启完成，请检查 X」投回原会话，并且**真的起一轮对话**；
4. agent 自己接上那一轮，查工具在不在、版本对不对、改动点实测一次，然后给你结论。

以前这一步是「关窗口、开窗口、找到那个会话、自己说一句『好了你查一下』」。现在一句话。

## 目录

- [安装](#安装)
- [三个工具](#三个工具)
- [交接机制怎么工作](#交接机制怎么工作)
- [数据文件](#数据文件)
- [防呆：次数、有效期、熔断](#防呆次数有效期熔断)
- [失败与安全模式](#失败与安全模式)
- [已知限制](#已知限制)
- [卸载](#卸载)
- [排查](#排查)

## 安装

这个插件是 **宿主插件（host plugin）**，装在 DSH 的 profile 里，跟内置工具跑在同一个后端进程。

### 1. 放到磁盘上

把整个目录放到任意位置，例如 `G:\workplace\dsh-plugins\dsh-restart`。

### 2. 注册到 desktop profile

编辑 `C:\Users\<你>\.dsh\profiles\desktop\package.json`，两处都要加：

```json
{
  "dependencies": {
    "dsh-restart": "link:G:/workplace/dsh-plugins/dsh-restart"
  },
  "dsh": {
    "profile": {
      "bundles": ["...", "dsh-restart"]
    }
  }
}
```

> 不同版本的 profile 字段可能略有差异，关键是：**dependencies 里有它**，并且 **bundles 数组里有它**。

### 3. 建 junction（不想让 pnpm 动你的工作目录）

在 `C:\Users\<你>\.dsh\profiles\desktop\node_modules\` 下建一个目录联接：

```cmd
mklink /J dsh-restart G:\workplace\dsh-plugins\dsh-restart
```

> 不要用 `dsh plugin add`：它会转发给 pnpm，在网络不好或有大依赖时会卡到 120 秒超时。手改 profile + junction 是最稳的路子。

### 4. 重启一次 DSH

插件树是启动时一次性组装的，装完必须重启 app 才会加载（宿主没有第三方插件的热重载）。这一次手动重启，之后就交给 `restart_now` 了。

### 5. 自检

在会话里看工具表里有没有 `restart_schedule` / `restart_now`，再确认 `<DSH_HOME>/restart/ready.json` 里 `version` 和 `package.json` 一致。

## 三个工具

### `restart_schedule` —— 只登记，不重启

把交接信息写进 `handoff.json`，阶段 `scheduled`。适合「先把要验收的内容写清楚，等会儿再重启」，或者一次重启前先把几件事登记好。

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `note` | string | 是 | 重启后要干什么。写给重启后的自己看：检查哪个功能、看什么证据 |
| `expectedTools` | string[] | 否 | 重启后应该出现在工具表里的工具名 |
| `expectedVersion` | string | 否 | 期望加载的插件版本 |
| `message` | string | 否 | 完全自定义重启后投回来的那句话；不填则按模板生成 |

返回 `{ ok, handoffId, phase: "scheduled", attempt, expiresAt, preflightOk, dataPath }`。

### `restart_now` —— 真正重启

先跑一遍**语法预检**（对插件目录里每个 `.js/.mjs/.cjs` 跑 `node --check`），把结果写进交接单，再把阶段改成 `launching`，然后起助手杀进程。参数同上（`note` / `expectedTools` / `expectedVersion` / `message`）。

返回 `{ ok, handoffId, phase: "launching", attempt, preflightOk, launcher }` —— **这个返回值能不能到你手上取决于时机**：重启会掐断当前这一轮，工具返回后紧接着进程就没了。所以「重启后要做什么」必须全部在调用前写进 `note`。

注意：预检失败**不会拦重启**。插件写坏了你也该能把 app 重启回来（重启后由看门狗报告错误），而不是卡在「预检不通过所以永远重启不了」。

### `restart_recover` —— 兜底重启（看门狗提供）

由 `guard.js` 这个独立 entry 注册。当 `index.js` 被改坏、主功能没加载起来时，会话里没有 `restart_now`，这时用 `restart_recover`：

- 会先跑预检，**文件还有语法错误就直接报错、不重启**（免得把坏文件再带上一次）；
- 预检通过才写交接单并走同一条重启路径。

参数：`note`（必填）、`expectedTools`、`expectedVersion`。

## 交接机制怎么工作

```
会话: restart_schedule → 写 handoff.json (phase=scheduled)
会话: restart_now      → 预检 → 写 handoff.json (phase=launching)  ← 落盘必须先于重启
                        → spawn cmd /c start /B relaunch.mjs        ← 双跳，脱离进程树
                        → 本轮对话被中断（app 正在被杀）

助手 relaunch.mjs:
  1. 拿锁（relaunch.lock，最多排队 150 秒）
  2. 睡 2.5 秒，跑预检并把结果写回交接单
  3. taskkill /F /T /PID <Electron 主进程>
  4. 轮询等旧进程真的消失；没消失就**不启动**（否则单实例锁会让新窗口一闪就没）
  5. 剥掉 ELECTRON_RUN_AS_NODE 等注入变量，detached 启动 DSH
  6. 轮询 ready.json 直到新进程写好就绪标记（最长 120 秒）
  7. 退出，全过程写 relaunch.log

新进程:
  index.js  → 写 ready.json（带本次 pid）→ 读交接单
            → 过期就作废；phase 不是 launching 就不管
            → 是 launching：调 sessionController.prompt(mode=followup) 投回原会话
            → requestId = 交接单 id（天然幂等，投两次也只算一次）
            → 投递成功立刻把 phase 标成 consumed

  guard.js  → 45 秒内主功能没动静（或报了 failed）就接手，投「插件没起来 + 原因 + 预检报错」
```

几个关键点：

- **为什么用「另起一个进程」而不是 `app.relaunch()`**：宿主没有把「请重启」暴露给插件，而且插件跑在 backend 子进程里，backend 是 Electron 主进程的直接子进程 —— 在主进程里 `app.quit()` 会连同自己一起带走，没法保证「先干净退出、再干净启动」。所以只能外部助手杀树重启。
- **为什么是双跳**：助手如果是 backend 的直接子进程，`taskkill /T` 会按进程树把它一起杀掉（实测第一次就这么挂了，app 停在关闭状态）。中间垫一个 `cmd /c start /B`，cmd 立刻退出，助手的父进程变成一个已死的 cmd，就杀不到它了。
- **为什么判定「起来了」看 `ready.json` 而不是窗口标题**：这台机器上 `Get-Process` 的 `MainWindowTitle` 对本 app 全是空（窗口 HWND 归主进程但 API 拿不到），靠它判定只会永远判失败。`ready.json` 是插件自己写的，能同时证明「进程起来了」和「插件加载了」，比窗口更贴题。
- **为什么投递不需要降级方案**：宿主有现成 API —— `sessionController.prompt({ sessionId, requestId, content, mode: 'followup' })` 会 `resume` 冷会话、投一条用户消息并**自动起一轮**。所以这里是「重启后真的继续对话」，不是「打开会话留一条排队消息」。如果将来宿主改了这个接口，投递会失败，看门狗会投「投递失败」并把交接单留着（不标 consumed），那时可以退化成手工会话恢复。

## 数据文件

全部在 `<DSH_HOME>/restart/`（`DSH_HOME` 默认 `C:\Users\<你>\.dsh`）：

| 文件 | 作用 |
| --- | --- |
| `handoff.json` | 交接单。谁、哪个会话、回来要说什么、第几次、预检结果、阶段 |
| `ready.json` | 就绪标记。主功能加载成功时写，带本次进程 pid，看门狗靠它判断「这次真的加载了吗」 |
| `relaunch.log` | 助手 + 钩子 + 看门狗的全过程日志。出问题先看这个 |
| `launches.json` | 真正重启的时间戳（熔断用） |
| `relaunch.lock` | 助手互斥锁（防两个助手同时杀进程） |
| `safe.flag` | 存在即安全模式 |

删掉整个目录 = 清空全部状态（含熔断计数）。**注意手删 `handoff.json` 可以重置 attempt 计数**，这是故意的后门：卡在「最多 2 次」时你有办法出来。

## 防呆：次数、有效期、熔断

| 保护 | 值 | 行为 |
| --- | --- | --- |
| 同一条重启链最多几次 | 2 | 第 3 次 `restart_now` 直接抛错 |
| 交接单有效期 | 10 分钟 | 过期后钩子不投递，直接把单子标成 consumed（理由 `expired`） |
| 全局重启频率 | 10 分钟内 3 次 | 第 4 次抛错，指着日志让你先看 |
| 看门狗等主功能 | 45 秒 | 超时按「没加载」处理 |
| 助手抢锁 | 最多等 150 秒 | 比就绪等待（120 秒）长，前面那个助手在等就绪时自己排队 |
| 启动后等就绪 | 120 秒 | 超时写 `launchError`，不假装成功 |

另外两条硬约束：

- **旧进程没死绝不启动新进程**。单实例锁会让第二个实例把窗口交给第一个然后自己退出，看着像「重启成功」其实什么都没有。所以助手必须确认旧 pid 消失才继续。
- **交接单先落盘再重启**。`open → write → fsync → close → rename` 原子写；不然正好在写到一半被杀，新进程读到半截 JSON，这次交接就丢了。

## 失败与安全模式

### 安全模式

两种开关，任一成立插件就**完全不干活**（不注册工具、不投递、不重启）：

1. 环境变量 `DSH_RESTART_SAFE=1`（也认 `true` / `yes` / `on`）
2. 文件 `<DSH_HOME>/restart/safe.flag` 存在

用途：插件自己改崩了、或者你想让 app 先安静地起来看看情况。它会安静到连日志都不写（除了 feature 侧一行），但 app 一定能起来。

> **`--safe` 启动参数说明（如实写）**：Electron 主进程启动 backend 时不会把命令行参数透传给 host 进程，插件里读不到 `--safe`。所以这一版真正可用的开关是环境变量和 `safe.flag` 文件，`--safe` 没有实现。这是接口限制，不是漏做。

### 各种失败长什么样

| 情况 | 表现 |
| --- | --- |
| `index.js` 语法错误 | app 照样起（第三方插件加载失败只 warn）；会话里收到「【重启自检 · 插件没起来】」+ 预检报出的文件、行号、SyntaxError 原文；兜底工具 `restart_recover` 可用 |
| `index.js` 导出名写错 / import 失败 | 同上（预检只能查语法，加载错误由看门狗的「没有就绪标记」判定扛住，消息里会说明是「多半是语法或导出错误」） |
| 预检不通过 | `restart_now` 返回 `preflightOk: false` 但**仍然重启**；回来后由看门狗报错 |
| 助手杀不掉旧进程 | 日志写「旧进程还在（taskkill 失败），取消启动」，**不会**起第二个实例；app 停留在关闭状态，需要手动开 |
| 新进程起来但插件没加载 | 助手 120 秒后写 `launchError`；看门狗按「主功能 entry 没有加载」报告 |
| 投递失败（接口变了 / 会话被删） | 交接单**不**标 consumed，写 `hookError`；下次启动再试（仍受 10 分钟约束）；日志里有错误原文 |
| 重启期间你手动打字 | 你打的那一轮会被杀进程中断；重启后钩子只在**空闲**时起新一轮，不会和你的输入抢同一个会话 |
| 两个助手同时被拉起 | 第二个在 `relaunch.lock` 上排队（最多 150 秒），不会出现两把刀 |

## 已知限制

- **仅 Windows**：依赖 `taskkill`、`cmd /c start`、junction 那套路径习惯。
- **会打断当前这一轮**：这是重启的物理事实，不是 bug。所有「重启后要做的事」必须写在 `note` 里。
- **重启期间 app 会关一会儿**（实测 3～10 秒），不是无缝切换。
- **插件改动需要真重启才能生效**：宿主没有第三方插件的热重载入口（`recomposeProfile` 只被导出、仓内没有调用方），所以本插件就是干这个的。
- **不改宿主本体**：全程只碰 profile、`<DSH_HOME>/restart` 和进程；`G:\dsh\resources\app.asar` 是只读的。
- 非 ASCII 路径会在日志里留一条警告（`cmd` 对 UTF-8 路径的处理不稳），这种环境下请把插件放在纯 ASCII 路径里。

## 卸载

1. 从 profile 的 `dependencies` 和 `dsh.profile.bundles` 里删掉 `dsh-restart`；
2. 删掉 `node_modules\dsh-restart` 这个 junction；
3. 重启 DSH；
4. 想清干净就连 `<DSH_HOME>/restart` 一起删。

## 排查

```text
先看 <DSH_HOME>/restart/relaunch.log      ← 助手做了什么、卡在哪一步
再看 <DSH_HOME>/restart/handoff.json      ← phase / attempt / preflight / delivery
再看 <DSH_HOME>/restart/ready.json        ← 主功能这次有没有加载（pid 要等于当前后端进程）
```

常见判断：

- 日志里有 `helper start` 但没有 `旧进程已退出`：助手被连带杀掉了，或者 taskkill 被拒。
- `ready.json` 的 pid 和当前进程不一致：那是上一次启动的陈文件，不能说明这次加载成功（看门狗内部就是按 pid 比的）。
- `handoff.json` 停在 `launching` 且很旧：交接单过期了，下次启动会被标成 consumed（`delivery.reason = "expired"`）。
- 一直报「10 分钟内已经真正重启过 3 次」：删 `launches.json` 复位。

## License

MIT © Aok1s
