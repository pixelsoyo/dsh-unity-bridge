# dsh-unity-bridge — DSH ⇄ Unity 桥接插件

一个**纯配置**的 DSH bundle 插件：给当前 profile 插入一个 `@deepseek-ai/dsh-mcp-client` 实例，
把 Unity 编辑器接进 DSH。装上之后模型可以调用 34 个 `mcp__unity__*` 工具
（读写场景层级、增删改 GameObject / 组件、材质、预制体、场景、Play Mode、跑测试、
看 Console、执行菜单项等），所有操作都发生在**你正在运行的 Unity 编辑器**里。

> **English summary** — A configuration-only DSH bundle that plugs the Unity Editor
> into DeepSeek Harness through the [`mcp-unity`](https://github.com/CoderGamester/mcp-unity)
> bridge already installed in your project. It adds one `@deepseek-ai/dsh-mcp-client`
> entry (stdio) and exposes 34 `mcp__unity__*` tools. Nothing is bundled: the launcher
> locates your Unity project, loads the MCP server that ships inside that project's own
> `com.gamelovers.mcp-unity` copy (so the protocol always matches your editor — Unity
> 2022.3 and newer, Unity 6 included), and reuses the per-project bridge token without
> copying it. Install: DSH → Settings → Plugins → install from the npm package
> `dsh-unity-bridge` (or a local checkout). Requires DSH 0.2.x and mcp-unity ≥ 1.5.0.
> MIT licensed. The model can modify and save your scenes — read the security notes below.

[功能特性](#功能特性) · [工作原理](#工作原理) · [三步上手](#三步上手) · [安装](#安装) · [常见问题](#常见问题) · [排错](#排错) · [发布（维护者）](#发布维护者)

- 当前版本：`0.2.0`（npm 包名 `dsh-unity-bridge`，MIT）
- 目标宿主：DSH 0.2.x（含 rc；`@deepseek-ai/dsh-mcp-client` 随宿主内置，插件不带任何 dsh 包）
- 目标 Unity：**Unity 2022.3 及以上，含 Unity 6 及后续版本**（不设上限；唯一前提是项目里装的是 `com.gamelovers.mcp-unity` 1.5.0+）
- 不含任何捆绑的 MCP server 副本，也不依赖任何 peer 版本范围
- 仓库：[github.com/pixelsoyo/dsh-unity-bridge](https://github.com/pixelsoyo/dsh-unity-bridge)（问题与 PR 走 Issues）

## 工作原理

```
DSH Agent ──MCP(stdio)──> dsh-unity-bridge ──ws://127.0.0.1:8090/McpUnity──> Unity 编辑器
                           server/entry.mjs      项目里的 mcp-unity 网桥（编辑器进程内）
```

插件只做三件事：在 profile 里插入一条 `@deepseek-ai/dsh-mcp-client`（stdio）配置；启动时由
`server/entry.mjs` 找到 Unity 项目、读项目自己的 `ProjectSettings/McpUnitySettings.json` 与
`Library/McpUnity/bridge-token`；再 `import` 该项目里 `com.gamelovers.mcp-unity` 自带的
`Server~/build/index.js`，由它通过 WebSocket 连编辑器内的网桥。所以：

- **不打包 server**：协议永远跟随你项目里实际安装的那份 mcp-unity；
- **不复制令牌**：令牌只在文件里，插件把路径和端口通过环境变量交给 server；
- **不改你的 Unity 项目**：插件侧只读设置与令牌，不往项目目录写任何东西。

## 三步上手

1. **Unity 侧**：项目里装 `com.gamelovers.mcp-unity` 1.5.0+用 Unity 打开一次（生成桥接令牌），
   并保持编辑器打开（`Tools > MCP Unity > Server Window` 显示运行中）。（https://github.com/CoderGamester/mcp-unity.git）
2. **DSH 侧**：设置 → 插件 → 从 npm 安装 `dsh-unity-bridge`（CLI 用法见[安装](#安装)），
   插件列表出现 **Unity 桥接** 即成功。
3. **验证**：新建会话对 Agent 说「看一下当前场景层级」，它调用
   `mcp__unity__get_scenes_hierarchy` 并返回真实节点树，就通了。

端口、多项目、超时与排错见下文。

## 功能特性

- **零配置接入**：装完即注册，不需要手写 `cordis.patch.yml`（要改行为再看[配置项](#配置项)）。
- **34 个 Unity 工具**：场景、GameObject、组件、材质、Prefab、菜单、测试、控制台日志。
- **自动定位项目**：显式路径 → settings 路径 → Unity 编辑器日志 → 文件系统扫描，多项目按
  「最近使用」排序（见[它怎么找到你的 Unity 项目](#它怎么找到你的-unity-项目)）。
- **握手挑正在跑的那个**：所有候选并发探测 `127.0.0.1` 与 `::1`，用项目自己的令牌完成
  WebSocket 握手，谁应答就用谁 —— 同时开着两个项目也不会连错。
- **不挑 Unity 版本**：加载项目里那份 mcp-unity server，Unity 2022.3 到 Unity 6（及以后）都跟得上。
- **令牌不落地**：只读文件路径做 `Basic` 握手，不复制、不打印。
- **三层超时**：DSH 工具 180 秒、桥接请求 170 秒、Unity 内部默认 10 秒依次收窄，慢操作不会
  被莫名截断（见[超时](#超时三个数字各管一段)）。
- **长跑不丢工具**：重连预算 1000 次（约 8 小时），Unity 重启后自动恢复。
- **中文文档 + 排错表**：日志里每条 `[unity-mcp]` 提示都能在[排错](#排错)里对上。

## 环境要求

| 组件 | 要求 |
| --- | --- |
| DeepSeek Harness | 0.2.x（含 rc）。桌面端是当前主要验证环境 |
| Unity | **2022.3 及以上，含 Unity 6**；上限取决于 mcp-unity 包本身 |
| mcp-unity（Unity 项目里） | `com.gamelovers.mcp-unity` **1.5.0+**（1.5.0 起才有令牌握手） |
| Node.js | 不用单独装：用 DSH 自带运行时（`process.execPath` + `ELECTRON_RUN_AS_NODE`） |
| 操作系统 | Windows 已实测；macOS / Linux 有对应日志路径回退，但未实测 |

## 为什么它不挑 Unity 版本（2022.3 及以上，Unity 6 及以后）

插件不打包 server，而是在启动时**加载你 Unity 项目里那份 `com.gamelovers.mcp-unity`
自带的 server**（`Library/PackageCache/com.gamelovers.mcp-unity@*/Server~`）。
桥接协议永远和你实际安装的 Unity 包版本一致，Unity 升级或换项目都不需要改插件。
同时也复用了包自己生成的 256 位桥接令牌，不复制、不硬编码密钥。

**这里没有版本上限**：插件代码里没有任何 Unity 版本判断，不认 `ProjectVersion.txt` 的版本号，
也不依赖某个固定路径布局 —— 只要那个项目能装上 `com.gamelovers.mcp-unity` 1.5.0+ 并跑起来，
插件就跟得上，Unity 6.x / 未来的 Unity 7 同理。真正的边界只有一条：**mcp-unity 这个包本身
支持到哪个 Unity 版本**（它的 `package.json` 里写的是 `"unity": "2022.3"` 起）。插件只在
`discovery.mjs` 里对 mcp-unity 的版本做一次 `< 1.5.0` 的检查（低版本没有令牌握手，必然 401），
这个检查跟 Unity 版本无关。

## 安装

前提两项：

1. Unity 项目里装了 `com.gamelovers.mcp-unity` 1.5.0+（Package Manager → Add package from git URL：
   `https://github.com/CoderGamester/mcp-unity.git`）；
2. **至少用 Unity 打开过该项目一次** —— 首次启动才会生成 `Library/McpUnity/bridge-token`。

然后 DSH 设置 → **插件** → 安装/添加插件，两种方式：

- 从 npm：填包名 `dsh-unity-bridge`（或固定版本 `dsh-unity-bridge@0.2.0`）；
- 从本地：把仓库 clone 到任意位置，在插件页选择那个目录（开发时用，装出来的是链接而不是拷贝）。

用 CLI 启动的 profile（`web`、`headless` 等）也可以命令行装：

```bash
dsh plugin --profile <profile> add dsh-unity-bridge
```

`desktop` profile 由桌面端持有，CLI 会拒绝管理它，请用上面的设置页安装。

装完后 HMR 会重新加载该 profile 的插件树，插件列表里出现 **Unity 桥接 / Unity bridge**
即成功；tool 列表里出现 `mcp__unity__*` 即可使用。

最后确认 Unity 编辑器是**打开状态**（Tools > MCP Unity > Server Window > Start Server
打开时那个窗口的端口即桥接端口，默认 8090）。

> 包名、显示名、工具前缀是三件不同的事，改哪个见「改名字」一节。

## 更新与卸载

- **更新**：设置 → 插件里重装新版本（CLI profile：`dsh plugin --profile <profile> add dsh-unity-bridge@<新版本>`）。
  HMR 会重载插件，Unity 连接随之重建；Unity 项目里什么都不用动。
- **卸载**：设置 → 插件里卸载（CLI：`dsh plugin --profile <profile> remove dsh-unity-bridge`）。
  只删 DSH 侧的这条配置，Unity 项目里的 `com.gamelovers.mcp-unity` 和桥接令牌都保留。

## 仓库结构

| 路径 | 作用 |
| --- | --- |
| `cordis.patch.yml` | 插件清单：往 profile 里插入一条 `@deepseek-ai/dsh-mcp-client`（stdio），`args` 指向 `server/entry.mjs` |
| `server/entry.mjs` | stdio 启动器：定位项目 → 读设置与令牌 → 设环境变量 → 加载项目里的 mcp-unity server |
| `server/discovery.mjs` | 项目发现（显式路径 / settings / Editor.log / 扫描）、锁文件定位、令牌与版本校验、`formatHost` |
| `server/probe.mjs` | 并发 WebSocket 握手探测，挑出真正在监听的项目 |
| `locale/*.json` | 插件页里的显示名与描述 |
| `test/run.mjs` | 单测（`npm test`） |
| `tools/asar.mjs` | 开发辅助：读 DSH 的 `app.asar`（不随包发布） |

## 工具一览（34 个）

| 分组 | 工具 |
| --- | --- |
| 场景 | `get_scene_info`、`get_scenes_hierarchy`、`create_scene`、`load_scene`、`save_scene`、`unload_scene`、`delete_scene` |
| GameObject | `get_gameobject`、`select_gameobject`、`update_gameobject`、`update_component`、`duplicate_gameobject`、`delete_gameobject`、`reparent_gameobject`、`move_gameobject`、`rotate_gameobject`、`scale_gameobject`、`set_transform`、`add_asset_to_scene` |
| 资产 | `create_prefab`、`create_material`、`assign_material`、`modify_material`、`get_material_info` |
| 编辑器 | `get_play_mode_status`、`set_play_mode_status`、`recompile_scripts`、`run_tests`、`execute_menu_item`、`add_package` |
| 日志 / 杂项 | `get_console_logs`、`send_console_log`、`show_unity_dashboard`、`batch_execute` |

## 安全边界（使用前请读）

装上这个插件等于**把一个能改你项目的执行者接进来**，边界如下：

| 项 | 行为 |
| --- | --- |
| 桥接令牌 | 只读取文件路径，值仅用于 `Basic` 握手头；**不复制、不打印**，日志里只有 `Library/McpUnity/bridge-token` 这个路径 |
| 网络 | 只连本机的 `127.0.0.1` / `[::1]`（未改 `Host` / `UNITY_HOST` 时），不向外发任何数据；Unity 侧 `AllowRemoteConnections: false` 是默认值 |
| 子进程环境 | 插件只额外加 4 个变量（`MCP_UNITY_PROJECT`、`MCP_UNITY_PROBE`、`ELECTRON_RUN_AS_NODE`、`UNITY_REQUEST_TIMEOUT`）；其余父进程环境**默认继承、按黑名单剔除**：名字里含 `KEY` / `PASSWORD` / `SECRET` / `TOKEN` 的变量与所有 `DSH_*` 不会传进去（mcp-client 的 `scrubbedParentEnv`）。这不是白名单，凭据形状不同的变量仍会继承 |
| 执行项目内代码 | 启动时会 `import` 项目里 `Library/PackageCache/com.gamelovers.mcp-unity@*/Server~/build/index.js`，那是在 **DSH 宿主 Node 进程里运行的第三方代码** —— 只对你信任的 Unity 项目启用本插件 |
| 写操作 | 模型可以增删改 GameObject/组件、创建/保存场景与预制体、切 Play Mode、跑测试 —— **会改并保存你的项目**，请在版本控制下使用 |
| 执行代码类工具 | `execute_menu_item` 可触发任意菜单逻辑；`add_package` 能安装会执行编辑器代码的包，默认被 Unity 侧 `AllowPackageInstallation: false` 关闭 |
| 无人值守 | Unity 没开时 server 仍会启动，工具调用会重连失败；但不会在后台改文件 |

两点补充：

- 同一个 profile 里不要再启用另一个也用 `serverName: unity` 的 bundle（例如旧版
  `dsh-controlunity`）：重名时后加载的那条起不来，工具前缀也会互相覆盖。
- Unity 没开时工具调用不会立刻失败：请求会进 mcp-unity 的命令队列，约 60 秒后报
  `Command expired after 60000ms in queue`（`CommandQueue` 的 `defaultTimeout: 60000`）。

## 它怎么找到你的 Unity 项目

按强度依次尝试，找不到可用桥接时才继续往下：

1. `MCP_UNITY_PROJECT` 显式指定的项目根目录（最可靠，多项目建议用它）
2. `MCP_UNITY_SETTINGS_PATH` 指向的 `ProjectSettings/McpUnitySettings.json` 所在项目
3. Unity 编辑器日志（`%LOCALAPPDATA%\Unity\Editor\Editor.log`）里最近一次 `-projectPath`
   —— 只是线索，如果那个项目没装 mcp-unity 会继续扫描
4. 文件系统扫描（`MCP_UNITY_SEARCH_ROOTS`，或默认的 `C:/D:/E:/F:/Unity*`、
   `%USERPROFILE%\Unity`、`Documents\Unity*`，最多 3 层、4000 个目录项）

候选项目按“最近使用”排序（token / settings / ProjectVersion 的修改时间），然后
**用项目自己的令牌 + `mcp-unity:` Basic 认证向 `ws://<host>:<port>/McpUnity` 发起一次
WebSocket 握手**，谁回应就用谁 —— 所以同时开着两个 Unity 项目也能挑中真正在跑的那个，
并顺手确认令牌有效。握手会自动区分 IPv4 `127.0.0.1` 与 IPv6 `::1`（Windows 上 Unity
常常只监听 `::1`，这是最常见的“端口是通的但连不上”原因）。

**所有候选都会探测，且并发进行**（每个候选同时试 `127.0.0.1` 与 `::1`，默认 8 路并发）：
不会因为候选多了而漏掉真正在跑的项目，也不会把启动拖成十几秒；全部无应答时才回退到
排序后的第一个候选。探测结果里的主机名会统一格式化后再交给 server —— IPv6 带方括号，
这也是 `UNITY_HOST` 即使不经过探测也仍然合法的原因。

## 配置项

都在 `cordis.patch.yml` 的 `env:` 里（改完重载插件生效）：

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `MCP_UNITY_PROJECT` | 空 = 自动 | 直接锁定项目根目录（含 `Assets` + `ProjectSettings` 的那层） |
| `MCP_UNITY_PROBE` | 开 | `0` 关闭握手探测（多项目时只按“最近使用”排序） |
| `MCP_UNITY_SEARCH_ROOTS` | 自动 | 扫描起点，`;` 或 `,` 分隔 |
| `MCP_UNITY_SCAN` | 关 | `1` 强制每次都做文件系统扫描 |
| `MCP_UNITY_SETTINGS_PATH` | 自动 | 直接指定项目的 `ProjectSettings/McpUnitySettings.json` |
| `MCP_UNITY_AUTH_TOKEN_PATH` | 自动 | 直接指定令牌文件（默认 `Library/McpUnity/bridge-token`） |
| `UNITY_PORT` | 项目设置 | 强制端口，必须和 Unity 实际监听的一致（见下节） |
| `UNITY_HOST` | 自动 | 强制地址；一般不用填，握手探测会自动区分 `127.0.0.1` / `[::1]` |
| `UNITY_REQUEST_TIMEOUT` | `170`（秒） | server 等 Unity 回一次响应的超时上限；不设时 mcp-unity 默认 `10` 秒，编译 / 跑测试这类慢操作会被截断（见「超时」一节） |

端口/主机默认读项目里的 `ProjectSettings/McpUnitySettings.json`。启动时插件会把最终端口写进
`UNITY_PORT`，把主机名经 `formatHost` 规范化后写进 `UNITY_HOST`（`localhost` 不写，沿用默认值），
保证 server 和探测结果一致；探测关闭时也一样格式化，所以 IPv6 不会漏方括号。

`env:` 里的空字符串表示“自动”。`MCP_UNITY_PROJECT: ''` 与删掉这一行等价。

## 端口（可以自定义）

端口是**Unity 编辑器在监听**，不是插件监听的，所以真正的开关在 Unity 侧：

| 做法 | 怎么改 | 效果 |
| --- | --- | --- |
| 推荐：改项目设置 | Unity → `Tools > MCP Unity > Server Window` 改 Port（写入 `ProjectSettings/McpUnitySettings.json`） | 插件下次启动自动读到新端口，插件本身不用动 |
| 强制：改插件 env | `cordis.patch.yml` 的 `env:` 里加 `UNITY_PORT: '8091'`，重载插件 | 覆盖项目设置；Unity 没在 8091 上监听就会连不上（日志会明确提示） |

要点：

- **在 Unity 里改端口，插件文件一个都不用动**：Connection Port 一变就会 `SaveSettings()` +
  `RestartServer()`（`McpUnityEditorWindow.cs:93-106`），新端口立刻写进
  `ProjectSettings/McpUnitySettings.json` 并重新监听；插件下次启动照读。
- **但要“重载插件”**：端口和令牌是 MCP server 进程启动时读一次并定格的，正在跑的那个进程
  不会自己跟。重载插件（或重启 DSH）重新拉起 server 就好，日志会显示
  `(port from McpUnitySettings.json)` 和新端口号。
- 令牌同理：Unity 里重新生成令牌后也要重载插件。运行中的插件会在日志里提示
  `... changed on disk; reload this plugin ...`（只提示，不自动重启）。
- **两边必须一致**。插件里的 `UNITY_PORT` 只是“我连这个端口”，它不会改变 Unity 的监听端口；
  真在 `env:` 里写死了它，才是唯一需要你手动同步的地方。
- 启动日志写明端口来源：`(port from McpUnitySettings.json)` 或 `(port from UNITY_PORT)`，
  一眼能看出是谁生效。若强制了端口但没人应答，日志会补一句 `nothing answered on the port
  you forced`，此时去 Server Window 把 Unity 改成同一个端口（或删掉 `UNITY_PORT`）。
- 端口是**按项目**的：两个项目可以各用 8090 / 8091 同时跑。插件只会连一个项目 —— 用
  `MCP_UNITY_PROJECT` 指定它，端口随之从该项目的设置里读，不必写 `UNITY_PORT`。
- 端口取值范围 1–65535，非法值会被忽略并回落到 8090。

## 超时（三个数字，各管一段）

一次 Unity 操作要过三道闸，任何一道太紧，慢操作（编译、进 Play Mode、跑测试）都会看起来像“卡死”：

| 闸门 | 默认 | 改在哪 | 管什么 |
| --- | --- | --- | --- |
| DSH 工具调用 | `toolCallTimeoutMs: 180000` | `cordis.patch.yml` | 模型等工具返回的总时间 |
| 插件 → server 单请求 | `UNITY_REQUEST_TIMEOUT: 170` | `cordis.patch.yml` 的 `env:`（本插件设的） | server 等 Unity 回一次响应 |
| Unity 侧请求超时 | `RequestTimeoutSeconds: 10` | `ProjectSettings/McpUnitySettings.json` | 编辑器内部等待（`run_tests` 等）的上限 |

从外到内应**依次变小**（或至少相等）：180s ≥ 170s ≥ 10s。

- `UNITY_REQUEST_TIMEOUT` 不设时，mcp-unity 默认只等 **10 秒**——编译与测试经常更久，
  于是工具先报 `Request timed out`，而 DSH 那边还在傻等。插件默认把它抬到 170 秒，
  给 DSH 留 10 秒收尾，避免两边同时超时后没人负责清理。
- **最后一道不会被插件改**：`RequestTimeoutSeconds` 是 Unity 项目设置，只能在
  `Tools > MCP Unity > Server Window` 里改（最小 10）。`run_tests` 跑长测试时，
  即使外层放宽了，Unity 内部仍会按这个值截断 —— 需要时把它调到 170，与插件对齐。
- 想让某个工具更快失败而不是干等：把 `toolCallTimeoutMs` 调小即可；它只影响 DSH 侧。

## 改名字（三个名字，改的地方不同）

| 名字 | 出现在哪 | 改哪里 |
| --- | --- | --- |
| **显示名** `Unity 桥接` | 设置 → 插件 列表的标题和描述 | `locale/zh.json` + `locale/en.json` 的 `meta.title` / `meta.description`（改完重载插件） |
| **包名** `dsh-unity-bridge` | 安装标识、`node_modules/<包名>` 目录名、npm 包名 | `package.json` 的 `name` —— **必须同步 `cordis.patch.yml` 的 `args` 路径** |
| **工具前缀** `mcp__unity__*` | 模型看到的工具名 | `cordis.patch.yml` 的 `serverName`（只能是 `[A-Za-z0-9_-]`，1–32 字符） |

只改**显示名**最简单，不涉及重装：

```jsonc
// locale/zh.json
{ "meta": { "title": "Unity 编辑器", "description": "……" } }
```

只改**工具前缀**也不用重装：`serverName: unity_editor` → 工具变成 `mcp__unity_editor__*`
（模型已记住旧名字的话要重载会话）。

改**包名**代价最大，要连带做四件事：

1. 改 `package.json` 的 `name`；
2. 改 `cordis.patch.yml` 的 `args[0]` 为 `node_modules/<新包名>/server/entry.mjs`
   —— 这两处不一致时日志会报 `Cannot find module ...\server\entry.mjs`；
3. 版本号按 major 递增，并重新 `npm publish`（旧的 npm 包名不会自动跟过来）；
4. 在 设置 → 插件 里卸掉旧的那条（profile 的 `node_modules` 里还留着旧目录），再按新名字重装。

仅在本机开发、不打算发布时，包名随便改都行；一旦发布过，改包名等于发一个**新包**。
命名风格上跟同 profile 里 `dsh-context`、`dsh-ops`、`dsh-orb` 一样用不带 scope 的 `dsh-*` 最省事
（scope 只在撞名时才值得用）。

## 版本变了怎么办

### DSH 升级

插件**不依赖任何 `@deepseek-ai/dsh-*` 的版本**：`@deepseek-ai/dsh-mcp-client` 是 Host
自己解析的模块，`cordis.patch.yml` 只是按名字插入一条配置。

| 情况 | 现象 | 处理 |
| --- | --- | --- |
| mcp-client 配置字段改名（如 `serverName`/`transport`） | 启用插件时直接报配置错误 | 改 `cordis.patch.yml` 里那几行，重载插件 |
| Host 不再以 profile 目录为子进程 cwd | 日志 `Cannot find module ...\dsh-unity-bridge\server\entry.mjs` | 把 `args` 改成安装目录下 `server/entry.mjs` 的绝对路径 |
| 插件列表里图标/名称丢失 | 显示成包名 | 检查 `package.json` 的 `exports` 仍包含 `./locale/*.json` 与 `./icon` |

### mcp-unity 升级

插件不打包 server，也不锁版本 —— 它启动时去项目里找 **Unity 自己解析出来的那份**：

1. 读 `Packages/packages-lock.json` 里 `com.gamelovers.mcp-unity` 的 `hash`（git 包，
   目录名是前 10 位）或 `version`（registry 包），直接定位
   `Library/PackageCache/com.gamelovers.mcp-unity@<hash>`；
2. 对不上才退回按修改时间挑最新的缓存副本，最后才看 `Packages/` 里的内嵌副本。

所以 `manifest.json` 换分支、换 commit、Unity 从 2022.3 升到 Unity 6 换版本号，
插件都会自动跟到新的一份（旧版本缓存留在 `Library/PackageCache` 里也不会被误选）。

| 情况 | 现象 | 处理 |
| --- | --- | --- |
| 升到 1.5.0 以上 | 正常，日志 `mcp-unity : 1.5.x` | 无需处理 |
| 版本低于 1.5.0 | 报 `the installed mcp-unity package is X, but the bridge token handshake needs 1.5.0 or newer` | Package Manager 里更新后重开项目 |
| `Server~` 目录名或入口变了 | `found the package but not its server entry` | 在 `server/discovery.mjs` 的 `findServerEntry` 候选列表加一行 |
| 新版改了环境变量契约 | 401 / 握手超时 / 找不到令牌 | 改 `server/entry.mjs` 里设置 `MCP_UNITY_*` / `UNITY_*` 的那几行 |

## 常见问题

**Q：工具调用报 `ECONNREFUSED` / 握手超时？**
Unity 编辑器没开，或项目没装 `com.gamelovers.mcp-unity`，或 Server Window 没 Start。网桥跑在
编辑器进程里 —— 调用任何 Unity 工具前先打开编辑器并加载项目。

**Q：8090 被别的程序占了？**
在 Unity 的 `Tools > MCP Unity > Server Window` 改端口（写入 `ProjectSettings/McpUnitySettings.json`），
插件下次启动自动读取；如果同时在插件 `env` 里写死了 `UNITY_PORT`，两边要改成同一个值。

**Q：怎么确认 Agent 真连上了 Unity？**
让它调用 `mcp__unity__get_scenes_hierarchy`；返回真实场景层级（`Main Camera` 之类）即连通。返回错误
就按[排错](#排错)查日志里的 `[unity-mcp]` 行。

**Q：和手动配置 `@deepseek-ai/dsh-mcp-client` 有什么区别？**
效果一样。本插件替你把那条配置写好，并自动处理项目定位、令牌、IPv6 与超时。注意不要同时保留一条
`serverName: unity` 的手动配置 —— 同名会冲突，二选一。

**Q：已经装了社区里的 `dsh-unity-mcp`，还能装这个吗？**
两个都用 `serverName: unity`（工具前缀 `mcp__unity__*`），同时启用会重名冲突。二者选一，不要并存。

**Q：Unity 没开的时候还能用别的工具吗？**
可以。server 会启动并注册工具；只是 Unity 相关调用会进 mcp-unity 的命令队列，约 60 秒后报
`Command expired after 60000ms in queue`（见[排错](#排错)）。

## 排错

日志在 `C:\Users\<你>\.dsh\logs\desktop-next.log`，插件的诊断都以 `[unity-mcp]` 开头：

```powershell
Select-String -Path "$env:USERPROFILE\.dsh\logs\desktop-next.log" -Pattern 'unity-mcp' -Tail 30
```

| 现象 | 原因 / 处理 |
| --- | --- |
| `no Unity project was found` | 项目没装 `com.gamelovers.mcp-unity`，或不在扫描范围内 → 用 `MCP_UNITY_PROJECT` 指定 |
| `MCP_UNITY_PROJECT points at ... is not an existing folder` | 锁定的路径拼错或盘符不在 → 改成项目根目录的绝对路径 |
| `MCP_UNITY_PROJECT points at ... is not a Unity project` | 指向的目录没有 `Assets` + `ProjectSettings` → 指到项目根，而不是子目录 |
| 工具调用 60 秒后报 `Command expired after 60000ms in queue` | Unity 没开、端口不对或 server 没 Start → 看 Server Window 状态，必要时重载插件 |
| 工具报 `Request timed out` | 慢操作撞上 10 秒默认超时 → 确认插件 env 里有 `UNITY_REQUEST_TIMEOUT`，并把 Unity 侧 Request Timeout 一起调大（见「超时」） |
| 用了几小时后 `mcp__unity__*` 全没了 | 重连预算耗尽（1000 次连续失败，约 8 小时）→ 重载插件或重启 DSH |
| `the bridge token is missing` | 该项目还没被 Unity 打开过（令牌在首次启动时生成）→ 用 Unity 打开一次项目 |
| `the settings file is missing` | mcp-unity < 1.5 → 升级包，或包未加载 |
| `could not load its dependencies` | `Server~` 里缺 `node_modules` → Tools > MCP Unity > Server Window > Start Server（它会跑 npm install） |
| 工具调用返回 `Not started - call start() first` | server 刚启动、Unity 连接还没建立（约 0.4 秒窗口）→ 重试一次即可 |
| 工具返回 `401` / 握手超时 | 项目换了、令牌过期 → 重载插件；或 Unity 侧 Server Window 里 Restart Server |
| `add_package` 被拒 | `McpUnitySettings.json` 里 `AllowPackageInstallation: false`，按需在 Unity 侧打开 |
| 装了插件但没有任何 `mcp__unity__*` | 启动失败 → 看日志末尾的 `[unity-mcp]` 行，通常是项目 / 令牌 / 依赖三者之一 |

注意：给 server 设置 `LOGGING=true` 会污染 MCP 的 stdout（server 的日志走 console.log），
不要开启；需要日志文件时用 `LOGGING_FILE=true`。

## 发布（维护者）

本包以 `dsh-unity-bridge@0.2.0` 发布，MIT。发布前跑一遍清单：

| 检查 | 命令 / 位置 |
| --- | --- |
| 单测全绿 | `npm test`（即 `node test/run.mjs`，当前 20 项；`npm pack` / `npm publish` 前会自动再跑一遍） |
| 打包内容正确 | `npm pack --dry-run`（应为 10 个文件、约 27 kB，含 `cordis.patch.yml`、`locale/`、`icon.svg`、`server/*.mjs`） |
| 从发布物装一遍 | `npm install <tarball>` 后用 `MCP_UNITY_PROJECT=<项目> node node_modules/dsh-unity-bridge/server/entry.mjs` 应打印 `[unity-mcp]` 诊断并连上项目（不依赖仓库目录） |
| 包名与 `args` 一致 | `package.json` 的 `name` 必须等于 `cordis.patch.yml` 里 `node_modules/<name>/server/entry.mjs` 中的 `<name>` |
| 版本号与文案 | `package.json`、`README.md`、`locale/*.json` 里不写死 DSH 补丁号，只写 `0.2.x` |
| 元数据 | `repository` / `homepage` / `bugs` / `author` 已指向 `github.com/pixelsoyo/dsh-unity-bridge`；发布前 `npm view dsh-unity-bridge` 应仍返回 404（名字空闲） |

```powershell
cd <本仓库目录>
npm test
npm pack --dry-run
git tag v0.2.0            # 先 git init / push 到公开仓库
npm login                 # 首次；账号开着 2FA 时会要 OTP
npm publish               # 未加 scope，默认 public
```

版本策略：

- **patch**（0.2.x）：文案、日志、排错提示、纯内部重构；
- **minor**（0.x.0）：新增环境变量或新行为（如 `UNITY_REQUEST_TIMEOUT`、并发探测、端口来源日志）；
- **major**：`cordis.patch.yml` 形状或字段改名、**包名变更**（装出来的目录名会变，必须重装）、
  最低 mcp-unity 版本抬升。

### 0.2.0 相对 0.1.0

- 新增默认 `UNITY_REQUEST_TIMEOUT: '170'`：编译 / Play Mode / 测试不再被 server 侧默认 10 秒截断
  （README「超时」一节讲清三层超时）。
- 握手探测改为**全部 ready 候选并发**（原来只探前 4 个、串行）：多项目不再漏选，启动也不拖十几秒。
- `MCP_UNITY_PROJECT` 指向无效路径时给出准确错误（不存在 / 不是 Unity 项目），不再谎报
  `no Unity project was found`。
- `UNITY_HOST` 统一经过 `formatHost`：关闭探测时 IPv6 地址也会带方括号，不会拼出非法的 `ws://::1:8090`。
- 重连预算 `maxAttempts` 20 → 1000（保留 30s 上限间隔，约 8 小时）：Unity 长时间关闭后工具不会
  再永久消失。
- `package.json` 补 `./package.json` 与 `./cordis.patch.yml` 导出；测试从 14 项增至 20 项
  （主机名格式化、显式项目分类、并发探测选择都有覆盖）。

本项目不捆绑 `com.gamelovers.mcp-unity`（其授权为 MIT，CoderGamester），运行时从用户项目里加载，
因此无需随包分发第三方代码。

## 自检 / 开发

```bash
node test/run.mjs          # 单测：日志解析、令牌校验、主机名格式化、项目分类、锁文件定位、server 入口、排序、并发探测选择
```

手动验证整条链路（不需要 DSH，也不需要 spawn）：

```bash
printf '%s\n' \
 '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"t","version":"0"}}}' \
 '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
 '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"get_scene_info","arguments":{}}}' \
 | node server/entry.mjs
```

应看到 `[unity-mcp]` 诊断（stderr）+ Unity 当前场景信息（stdout，JSON-RPC 响应）。
把 `tools/call` 换成 `tools/list` 可确认 34 个工具。

## 许可证

MIT，见 [LICENSE](LICENSE)。`com.gamelovers.mcp-unity` 由 CoderGamester 以 MIT 发布，本项目只调用它。

## 致谢

- [CoderGamester/mcp-unity](https://github.com/CoderGamester/mcp-unity)：Unity 侧网桥与 MCP server 的上游实现，本插件不打包、只加载。
- DeepSeek Harness：插件宿主，以及随宿主提供的 `@deepseek-ai/dsh-mcp-client`。
