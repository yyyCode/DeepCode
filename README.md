<p align="center">
  <img src="site/logo-mark.png" width="72" alt="DeepCode">
</p>

<h1 align="center">DeepCode</h1>

<p align="center">
  终端里的 agentic 编码助手。<br>
  给它一句自然语言，它会读文件、改文件、跑命令 —— 每个会写盘或执行命令的动作，<br>
  都会先停下来，等你按一次 <code>y</code>。
</p>

<p align="center">
  <img alt="Node ≥ 20" src="https://img.shields.io/badge/node-%E2%89%A520-339933?logo=nodedotjs&logoColor=white">
  <img alt="运行时依赖 0" src="https://img.shields.io/badge/runtime_deps-0-blue">
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-5.7-3178C6?logo=typescript&logoColor=white">
</p>

<p align="center">
  <a href="#快速开始">快速开始</a> ·
  <a href="site/index.html">官网</a> ·
  <a href="site/docs.html">技术文档</a> ·
  <a href="CHANGELOG.md">变更记录</a>
</p>

TypeScript 从零编写，零运行时依赖。引擎在每个调用点抛出事件，所有插件（**包括内建工具**）把自己的 hook 注册成中间件，按 `prepend > user > append > builtin > core` 串成一条链。

主要能力：

- **读写代码**：`Read` / `Write` / `Edit` / `Bash` / `Glob` / `Grep`，外加子代理、技能、记忆与计划模式。
- **先问再做**：写盘与执行命令前打印预览，等一个答案；非交互环境默认拒绝。
- **上下文管理**：五层压缩、系统提示静态前缀缓存、跨会话记忆。
- **可扩展**：内建 mod 与第三方插件走同一套接口。

## 快速开始

需要 **Node ≥ 20** 与 **pnpm**。

```bash
git clone https://github.com/yyyCode/DeepCode && cd DeepCode
pnpm install
npm link          # 把 deepcode 挂到全局（撤掉用 npm rm -g deepcode）
```

写一把 key 到用户级配置：

```bash
mkdir -p ~/.deepcode && cat > ~/.deepcode/config.json <<'EOF'
{ "apiKey": "sk-ant-..." }
EOF
```

没有全局命令也行：`node /path/to/DeepCode/bin/deepcode.mjs "..."`。

然后进你的项目：

```bash
cd /你的项目
deepcode "跑一下测试，把失败的那条修掉"   # 一次性，跑完退出
deepcode                                   # 不带参数 = 交互式 REPL
```

> 别写成 `pnpm --dir /path/to/DeepCode dev "..."`。pnpm 会把 cwd 设成包目录，模型会在 DeepCode 仓库里改文件。

## 用法

### 命令行

| 参数 | 作用 |
| --- | --- |
| `deepcode "..."` | 执行一句提示词，跑完退出 |
| `deepcode` | 交互式 REPL |
| `deepcode web` | 本地网页界面；默认随机端口、自动开浏览器 |
| `--resume` | 接上当前目录最近一次会话 |
| `--resume=<id>` | 接上指定 id 的会话 |
| `--settings=<路径>` | 追加一层权限设置 |
| `-h, --help` | 帮助 |
| `-V, --version` | 版本 |

只认这几组开关，其余 `argv` 一律拼成一句提示词 —— 所以 `--resume` 指定 id 必须用等号形态，`deepcode --resume "继续修"` 里的那句话是提示词。

管理命令：

```bash
deepcode config list                  # 生效的配置项、值、来源
deepcode config set model <名字>      # 只允许改 model，写入用户级配置
deepcode plugin list                  # 已装 / 已启用 / 跳过的插件
deepcode plugin add <名字> --from=<目录>
deepcode plugin remove <名字>
```

### 网页界面

`deepcode web [--port=<n>] [--no-open]` 在本机起一个单栏聊天界面：流式正文、工具卡片、
权限卡（允许一次 / 本次会话总是允许 / 拒绝）、停止按钮。只绑 `127.0.0.1`，终端会打印
一条带 token 的地址（token 只在这次进程里有效）；刷新页面按事件回放重建时间线。
关掉浏览器不会停服务，后台那一轮仍会跑完 —— 停服务用 `Ctrl-C` 或 `/exit`。

### 会话内

| 输入 | 效果 |
| --- | --- |
| `/help` | 可用命令与工具 |
| `/tools` | 模型这一轮真能用的工具，以及没进清单的原因 |
| `/diff` | 本会话改动 + 工作区未提交 |
| `/clear` | 清空上下文（磁盘上的转录保留） |
| `/compact [说明]` | 手动压缩上下文 |
| `/context` | 上下文账本：各段 token、压缩阈值、五层压缩做了什么 |
| `/permissions [forget]` | 生效的权限规则与来源 |
| `/memory [名字]` | 项目记忆 |
| `/plan [off]` | 进入 / 退出只读计划模式 |
| `/config` | 生效配置与来源 |
| `/telemetry` | 遥测开关与落盘位置 |
| `/exit` | 退出（`Ctrl-D` 也行） |
| `Ctrl-C` | 掐断当前回合；空闲时退出，同一回合连按两次强制退出 |

### 确认与放行

会写盘或执行命令的工具（`Write` / `Edit` / `Bash`）先打印预览，再等一个答案：

- `y` —— 放行这一次；
- `a` —— 本次会话内放行这一类（`Bash` 只记住这一条命令，退出即失效）；
- 其他任何输入（包括直接回车）—— **拒绝**。

只读的 `Read` / `Glob` / `Grep` 不询问。非 TTY（管道、CI）下**默认拒绝**，所以拿它写脚本只能做只读的活。没有 `--yes`，也没有自动放行开关。

### 计划模式

多文件或方向不确定的任务，先让它出方案：

```
你：给配置系统加一层校验，先别改代码，说说你打算怎么做
你：/plan            ← 也可以手动进
```

计划模式里只有只读工具。模型调用 `ExitPlanMode` 交上计划后，你按 `y` 才开始执行；按别的就留在计划模式继续改。计划落盘在 `<工作目录>/.deepcode/plans/`。

## 配置

| 来源 | 路径 |
| --- | --- |
| 用户级 | `~/.deepcode/config.json`（Windows：`C:\Users\<你>\.deepcode\config.json`） |
| 项目级 | `<工作目录>/.deepcode/config.json` |

**优先级：环境变量 > 项目级 > 用户级。** 两层都有时按字段合并，不是整体替换。

字段：`apiKey` / `model` / `baseUrl` / `provider` / `debug`。字段名写错会直接报错，不静默退回默认值。

换兼容端点只需改这几个字段，`baseUrl` 要**自带版本段**（请求路径直接拼 `${baseUrl}/chat/completions`）：

```json
{ "apiKey": "sk-...", "model": "deepseek-v4-flash", "baseUrl": "https://api.deepseek.com/anthropic" }
```

```json
{ "provider": "openai", "apiKey": "sk-...", "model": "deepseek-chat", "baseUrl": "https://api.deepseek.com/v1" }
```

常用环境变量：

| 变量 | 作用 |
| --- | --- |
| `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` | API key，前者优先 |
| `DEEPCODE_MODEL` / `ANTHROPIC_MODEL` | 模型 id，前者优先 |
| `ANTHROPIC_BASE_URL` | API 端点 |
| `DEEPCODE_PROVIDER` | `anthropic` / `openai` |
| `DEEPCODE_DEBUG` | 打开调试轨迹（走 stderr） |

排查「配置没生效」：先看环境变量 —— 它优先级最高，机器上残留的 `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN` 会顶掉配置文件（顶掉时启动会打一行说明）。**Windows 上删了环境变量，已开着的终端不会变**，要把终端程序整个退出再打开。

## 权限与沙箱

`config.json` 管连接，权限在另一套 `.deepcode/settings.json` 里。来源从低到高：`user` → `project` → `local` → `flag`（`--settings=`）→ `policy`（托管）。

```json
{
  "permissions": {
    "allow": ["Read"],
    "ask": ["Bash"],
    "deny": ["Bash(git push:*)", "WebSearch"]
  }
}
```

- **`deny` > `ask` > `allow`**，与规则写在哪一层、数组里排第几无关。
- `Bash(git push:*)` 按**空白 token 边界**做前缀匹配；`Read(~/.ssh/**)` 按**绝对路径**做 glob（`*` 单段、`**` 跨段）。
- 前缀匹配不懂 shell 语法：`true && git push origin main` 拦不住 —— deny 是给手滑和误操作加的一道闸，不是对抗手段。

`Bash` 另有一道可选的路径沙箱，**默认关**：

```json
{ "sandbox": { "enabled": true, "paths": { "deny": ["~/.ssh/**", "/etc/**"] } } }
```

它在真正 `spawn` 之前判定，任何 `allow` 规则都绕不过；但它是命令文本分析，不是 OS 隔离，也只盖 `Bash`。详见[技术文档 § 权限](site/docs.html#permissions)。

## 会话与记忆

会话落盘在**用户级**目录，不进项目目录：

```
~/.deepcode/projects/<工作目录>/sessions/<id>.jsonl     # 权限 0600
```

`--resume` 只认当前目录自己的会话；找不到时以退出码 1 收场。转录里是代码与文件内容，删掉 `.jsonl` 就等于删掉那次会话。

跨会话记忆一条一个文件，索引每轮注入系统提示，正文按需召回：

```
~/.deepcode/projects/<工作目录>/memory/<名字>.md
~/.deepcode/projects/<工作目录>/memory/MEMORY.md
```

## 扩展

- **子代理与技能**：放在 `.deepcode/` 或 `~/.deepcode/` 下的 `agents/`、`skills/`，也可以随插件提供。`Explore` 并发派只读子代理，`Task` 串行。
- **插件**：`~/.deepcode/plugins/<名字>/` 自动装载。`plugin add` 装进来的要在**用户级** `settings.json` 里写 `plugins.enable` 才启用，项目级写同一名字不算数。
- **MCP（stdio）**：在**用户级** `~/.deepcode/settings.json` 里配本地 server，工具以 `mcp__<server>__<tool>` 进清单，每次调用默认问你；`/mcp` 看连接状态。

  ```json
  {
    "mcpServers": {
      "fs": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "."] }
    }
  }
  ```

  只认用户级：仓库里克隆下来的 `settings.json` 不会替你启动进程。配置改动下个会话生效。
- **遥测**：默认关。在用户级 `settings.json` 写 `{ "telemetry": { "enabled": true } }` 后，只写本地 `~/.deepcode/telemetry.jsonl`，没有网络上报。
- **大结果外置**：单个工具结果超过 50 000 字符时原文落盘，消息里只留预览与路径，可用 `Read` 的 `offset` / `limit` 读回。

## 已知限制

- **沙箱不是 OS 隔离**：它是策略层的命令文本分析，且只盖 `Bash`，`x=/etc/passwd; rm $x` 这类绕得过去。
- **没有路径围栏**：工具能碰到你进程权限内的任何路径，不限工作目录。别在装着重要东西的机器上放它乱跑。
- **子代理不继承指令文件**：`AGENTS.md` / `CLAUDE.md` 一个字都不进它的系统提示，要它守的规矩得写进 agent 文件或 `prompt`。
- **中断只杀外壳**：Windows 上 `Bash` 经 `cmd.exe` 起命令，`Ctrl-C` 掐的是这层外壳，孙进程可能残留。
- **没有整屏 TUI、语法高亮或后台工作**：终端界面是逐行的纯文本流，网页界面也是单栏聊天
  （`deepcode web`，没有 diff 视图与文件树）；子代理同步交回结果。
- **MCP 只有 stdio**：不做 HTTP/SSE、不热更新工具清单、server 崩了不自动重连；MCP 工具一律按会写处理（同一轮串行），也不信 server 自报的 `readOnlyHint`。

完整清单（每条代价、每个默认值、设计文档指路）：[`site/已知限制.md`](site/已知限制.md)。

## 开发

```bash
pnpm typecheck   # 类型检查
pnpm lint        # 依赖边界 + 工作流硬化
pnpm test        # 测试（全桩，无需密钥）
pnpm dev         # 直接跑 tsx（cwd 是本仓库）
```

CI 在 [GitHub Actions](.github/workflows/ci.yml) 上跑同样三条，Node 20 与 22。

## 文档

- [官网](site/index.html) —— 设计与演示
- [技术文档](site/docs.html) —— 架构、决策、权限、路线图、限制
- [项目简介](site/项目简介.md) —— 一页纸讲完是什么、凭什么信它
- [已知限制](site/已知限制.md) —— 做不到什么、哪些数是猜的
- [变更记录](CHANGELOG.md) —— 逐阶段的范围 / 出口标准 / 偏差
- [设计文档](docs/superpowers/specs/) · [实施计划](docs/superpowers/plans/)
