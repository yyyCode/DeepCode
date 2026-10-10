# DeepCode

一个终端里的 agentic 编码助手。给它一句自然语言，它会读文件、改文件、跑命令。

当前是**最小可用版本（MVP）**：能跑通「读 → 改 → 跑测试」的闭环。安全底线是每个会写盘或执行命令的动作，
都要你在终端上按一次 `y`。

## 快速开始

需要 **Node ≥ 20** 与 **pnpm**。

```bash
git clone https://github.com/yyyCode/DeepCode && cd DeepCode
pnpm install

# 把 deepcode 挂到全局，之后任意目录都能直接用（撤掉用 npm rm -g deepcode）
npm link

# 给它一把 key —— 三选一，写进用户级配置最省事
mkdir -p ~/.deepcode && cat > ~/.deepcode/config.json <<'EOF'
{ "apiKey": "sk-ant-..." }
EOF
```

跑起来：

```bash
cd /你的项目
deepcode "跑一下测试，把失败的那条修掉"    # 一次性，跑完退出
deepcode                                    # 不带参数 = 交互式 REPL
deepcode --help                             # 用法
deepcode --version                          # 版本号
```

不用全局命令也行，等价：

```bash
node /path/to/DeepCode/bin/deepcode.mjs "..."
```

除了 `--help` / `-h` 和 `--version` / `-V`，其余 `argv` 一律被拼成**一句提示词** ——
这个 CLI 的参数没有别的含义，所以不必记开关。

> ⚠️ 别写成 `pnpm --dir /path/to/DeepCode dev "..."`。pnpm 会把脚本的 cwd 设成**包目录**，
> 于是工作目录变成 DeepCode 仓库自己，模型会在错误的仓库里改文件。`bin/deepcode.mjs`
> 是在自己所在的位置解析 `tsx` 的，所以在哪都能跑，而工作目录保持为你 `cd` 去的那个。

### 交互式会话里

| 输入 | 效果 |
|---|---|
| `/help` | 列出可用命令与工具 |
| `/exit` | 退出（`Ctrl-D` 也行） |
| `Ctrl-C` | 掐断当前这一回合（正在跑的模型请求与命令一起断），进程不退，可以接着聊；空闲时按 = 退出，同一回合里连按两次 = 强制退出 |

工具要写盘或跑命令时，终端会打出预览并停下等你一行 `y/N`。**按别的键都算拒绝**。

## 配置

配置有两个来源，**不用每次 `export`**：

- 用户级：`~/.deepcode/config.json`（Windows 是 `C:\Users\<你>\.deepcode\config.json`）
- 项目级：`<工作目录>/.deepcode/config.json`

**优先级：环境变量 > 项目级 > 用户级。** 两层都有时逐字段合并，不是整体替换 ——
项目级只写 `model`，用户级的 `baseUrl` 仍然生效。

```json
{
  "apiKey": "sk-ant-...",
  "model": "claude-sonnet-5-5",
  "baseUrl": "https://api.anthropic.com",
  "debug": false
}
```

四个字段都可省略。**字段名写错会被点名**，不会安静地不生效 —— 拼成 `modle` 你会看到一行
`不认识的字段 "modle"`。JSON 语法错、顶层不是对象、类型不对，则直接报错并带上路径，不会退回默认值。

> ⚠️ 项目级配置里放 `apiKey` 有明显风险：这个文件很容易跟着仓库一起提交出去。
> 本仓库的 `.gitignore` 已经把 `.deepcode/` 排除在外；要在别的仓库里这么用，请自己确认那一行。
> 启动时若发现项目级配置带了 key，也会提醒你一次。更稳妥的做法是放用户级配置或环境变量。

对应的环境变量（优先级更高）：

| 变量 | 作用 |
|---|---|
| `ANTHROPIC_API_KEY` | API key。与 `ANTHROPIC_AUTH_TOKEN` 同时给时，**以 `ANTHROPIC_API_KEY` 为准** |
| `ANTHROPIC_AUTH_TOKEN` | 同上，Anthropic 兼容端点常用的名字 |
| `DEEPCODE_MODEL` | 覆盖模型 id，默认 `claude-sonnet-5-5`。与 `ANTHROPIC_MODEL` 同时给时以它为准 |
| `ANTHROPIC_MODEL` | 同上，兼容端点常用的名字 |
| `ANTHROPIC_BASE_URL` | 覆盖 API 端点 |
| `DEEPCODE_DEBUG` | 打开调试轨迹（走 stderr）：每次 dispatch 一行，说明这个事件被哪些 hook 应答、谁被跳过了。流式事件 `turn.step` 不打，否则会刷屏 |

此外还会读取项目指令文件，拼进系统提示：`<工作目录>/AGENTS.md`、`<工作目录>/CLAUDE.md`、
`~/.deepcode/AGENTS.md`。

### 换成别的后端（例如 DeepSeek）

Anthropic 兼容端点只要改三样。这套变量名已经内置支持，所以你在 Claude Code 里配过的那组
`ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_BASE_URL` / `ANTHROPIC_MODEL` 不用再 `export` 一遍：

```json
{
  "apiKey": "sk-...",
  "model": "deepseek-v4-flash",
  "baseUrl": "https://api.deepseek.com/anthropic"
}
```

认证头不用改：`x-api-key` 与 `Authorization: Bearer` 两种都收（DeepSeek 实测）。

### 排查：为什么它没走我的配置

**最常见的坑就是环境变量。** 它的优先级高于配置文件 ——
机器上残留的 `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN`（比如以前配过某个中转站）
会顶掉你写在配置文件里的那一项，你只会看到一堆 401。

好消息是从此不必自己猜：**只要环境变量顶掉了配置文件、而且两处值不一样，启动时就会打一行**：

```
环境变量 ANTHROPIC_BASE_URL 顶掉了配置文件里的 baseUrl（环境给的是 https://relay.example，
配置文件里是 https://api.deepseek.com/anthropic），配置文件这一项被忽略。
想让它生效，先清掉这个环境变量。
```

（两边值相同时不吭声 —— 同一把 key 既在环境里又在配置里是常态，每次都吼只会让人学会无视它。
apiKey 被顶掉时只说"两处内容不一致"，绝不把 key 打出来。）

先自检：

```powershell
$env:ANTHROPIC_BASE_URL; $env:ANTHROPIC_AUTH_TOKEN   # PowerShell
```
```bash
echo $ANTHROPIC_BASE_URL $ANTHROPIC_AUTH_TOKEN        # Git Bash
```
```cmd
echo %ANTHROPIC_BASE_URL% %ANTHROPIC_AUTH_TOKEN%      # cmd
```

打出了非空值，就是它在生效。两个办法：

```powershell
# 只影响当前窗口，立刻生效
Remove-Item Env:ANTHROPIC_BASE_URL, Env:ANTHROPIC_AUTH_TOKEN -ErrorAction SilentlyContinue
```
```bash
# 永久清掉（会同时影响其他用到这两个变量的工具）
reg delete "HKCU\Environment" /v ANTHROPIC_BASE_URL /f
reg delete "HKCU\Environment" /v ANTHROPIC_AUTH_TOKEN /f
```

> **Windows 上删了环境变量，已经开着的终端不会变。** 连在同一个终端程序里新开标签页也不行
> —— 新标签是从终端进程继承的，不是重新读注册表。要**把终端程序整个退出**再打开。

另一个判据是错误信息的形状：`"type":"authentication_error"` 是 Anthropic / DeepSeek 官方 API 的格式；
`"type":"new_api_error"` 是 one-api / new-api 这类**中转网关**的格式。看到后者，说明请求压根没发到你
以为的那个端点。

## 架构一句话

引擎在每个调用点抛出一个事件，所有插件（**包括六个内建工具**）把自己的 hook 注册成中间件，
按 tier 权威序 `prepend > user > append > builtin > core` 串成一条链。一个 hook 可以
应答 / 改写 / 拒绝 / 委托下层。

`Read`/`Write`/`Edit`/`Bash`/`Glob`/`Grep` 走的接口与未来的第三方插件**完全相同** ——
内核里没有一张硬编码的工具表：模型看得见的工具清单来自注册面上 `tool.call` 的 matcher 取值。

## 安全

MVP 的安全底线是 `tool.check` 事件上的最小确认：

- `Read` / `Glob` / `Grep` 只读，不询问。
- `Write` / `Edit` / `Bash` 打印预览后等一行 `y/N`。
- 非 TTY（管道、CI）环境下**默认拒绝** —— 所以拿它写脚本只能做只读的活。
- 不认识的工具**拒绝**，不是放行。
- `Write` 覆盖已有文件前，必须在本次会话里先 `Read` 过它。
- `tool.check` 走到链尾无人应答 = **deny**，不是 allow。

有意**没有** `--yes` / 自动放行开关：非交互环境里没人能按 `y`，那就写不了文件、跑不了命令。
谁加自动放行开关谁就是在开倒车。

也**没有路径围栏**：`Read` / `Write` / `Edit` / `Glob` / `Grep` / `Bash` 能碰到你进程权限内的任何路径，
不限工作目录。确认提示是唯一的一道闸，而且它拦的是「要不要动手」，不是「动哪里」 ——
所以别在装着重要东西的机器上放它乱跑。沙箱化（含 Bash 的）在设计文档里排到 P2。

完整的权限系统（settings 来源优先级、allow/ask/deny 规则、`sec-default` 守门器）是下一个阶段的事。

## 已知限制（MVP 有意不做）

- **无会话落盘**：退出即丢，没有 `--resume`。
- **中断只杀外壳**：`Bash` 在 Windows 上经 `cmd.exe` 起命令，`Ctrl-C` 掐断的是这层外壳，
  它下面的孙进程可能继续残留（没有进程组）。
- **渲染只有纯文本**：没有 TUI、没有语法高亮，也不走 `ui.render` 事件。
- **39 个事件里实现了 12 个**：其余 27 个已声明、未实现，用到时会抛 `NotImplementedError`。

## 开发

```bash
pnpm typecheck   # 类型检查
pnpm lint        # 依赖边界检查（往 contract/ 里加 import 会红）
pnpm test        # 测试，7 个文件 73 个用例
pnpm dev         # 免去 bin 转手，直接跑 tsx（cwd 是本仓库）
```

## 设计文档

- 设计：[`docs/superpowers/specs/2026-10-11-deepcode-mvp-design.md`](docs/superpowers/specs/2026-10-11-deepcode-mvp-design.md)
- 实施计划：[`docs/superpowers/plans/2026-10-11-deepcode-mvp.md`](docs/superpowers/plans/2026-10-11-deepcode-mvp.md)
- 架构参考：`claude-code-架构分析/`
