# DeepCode

一个终端里的 agentic 编码助手。给它一句自然语言，它会读文件、改文件、跑命令。

当前是最小可用版本（MVP）：能跑通「读 → 改 → 跑测试」的闭环，安全底线是每个会写盘或执行命令的动作都要你按一次 `y`。

## 快速开始

需要 Node ≥ 20 与 pnpm。

```bash
pnpm install
export ANTHROPIC_API_KEY=sk-ant-...
```

## 用法

```bash
# 交互式
pnpm dev

# 一次性：给一句话，跑完退出
pnpm dev "给 utils.ts 里的 parseDate 加上时区处理"
```

上面两条会把**本仓库**当工作目录。要让它在别的项目里干活，用 bin 入口并给绝对路径 ——
`bin/deepcode.mjs` 在自己所在的位置解析 `tsx`，所以在哪都能跑，而工作目录保持为你 `cd` 去的那个：

```bash
cd /path/to/your-project
node /path/to/DeepCode/bin/deepcode.mjs "跑一下测试，把失败的那条修掉"
```

> 注意别写成 `pnpm --dir /path/to/DeepCode dev "..."`：pnpm 会把脚本的 cwd 设成**包目录**，
> 于是工作目录变成 DeepCode 仓库本身，模型会在错误的仓库里改文件。

交互式会话里：

| 输入 | 效果 |
|---|---|
| `/help` | 列出可用命令与工具 |
| `/exit` | 退出（`Ctrl-D` 也行） |
| `Ctrl-C` | 掐断当前这一回合（正在跑的模型请求与命令一起断），进程不退，可以接着聊；空闲时按 = 退出，同一回合里连按两次 = 强制退出 |

## 配置

除环境变量外，还可以写配置文件，**不用每次 `export`**：

- 用户级：`~/.deepcode/config.json`（Windows 是 `C:\Users\<你>\.deepcode\config.json`）
- 项目级：`<工作目录>/.deepcode/config.json`
- 优先级：**环境变量 > 项目级 > 用户级**。两层都有时逐字段合并，不是整体替换。

```json
{
  "apiKey": "sk-ant-...",
  "model": "claude-sonnet-5-5",
  "baseUrl": "https://api.anthropic.com",
  "debug": false
}
```

四个字段都可省略（省略即用默认值 / 环境变量）。**字段名写错会被点名**，
不会安静地不生效 —— 拼成 `modle` 你会看到一行 `不认识的字段 "modle"`。

> ⚠️ 项目级配置里放 `apiKey` 有个明显风险：这个文件很容易跟着仓库一起提交出去。
> 本仓库的 `.gitignore` 已经把 `.deepcode/` 排除在外；如果要在别的仓库里这么用，
> 请自己确认那一行。启动时若发现项目级配置带了 key，也会提醒你一次。
> 更稳妥的做法是把 key 放在用户级配置或环境变量里。

对应的环境变量（优先级更高）：

| 变量 | 作用 |
|---|---|
| `ANTHROPIC_API_KEY` | API key |
| `ANTHROPIC_AUTH_TOKEN` | 同上，兼容端点用的名字（给了 `ANTHROPIC_API_KEY` 时以它为准） |
| `DEEPCODE_MODEL` | 覆盖模型 id，默认 `claude-sonnet-5-5` |
| `ANTHROPIC_MODEL` | 同上，兼容端点用的名字 |
| `ANTHROPIC_BASE_URL` | 覆盖 API 端点 |
| `DEEPCODE_DEBUG` | 打开调试轨迹（走 stderr）：每次 dispatch 一行，说明这个事件被哪些 hook 应答、谁被跳过了。流式事件（`turn.step`）不打，否则会刷屏 |

### 换成别的后端（例如 DeepSeek）

Anthropic 兼容端点只要改这三样 —— 上面已经认了这套变量名，
所以你在 Claude Code 里配过的那组 `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_BASE_URL` / `ANTHROPIC_MODEL`
不用再 `export` 一遍：

```json
{
  "apiKey": "sk-...",
  "model": "deepseek-v4-flash",
  "baseUrl": "https://api.deepseek.com/anthropic"
}
```

认证头不用改：`x-api-key` 与 `Authorization: Bearer` 两种都收。这套是实测跑通过的 ——
能读文件、能走工具调用回合、非 TTY 下 `Bash` 照样被拒。

会话启动时还会读取项目指令文件，拼进系统提示：`<工作目录>/AGENTS.md`、`<工作目录>/CLAUDE.md`、
`~/.deepcode/AGENTS.md`。

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
- 非 TTY（管道、CI）环境下**默认拒绝**。
- 不认识的工具**拒绝**，不是放行。
- `Write` 覆盖已有文件前，必须在本次会话里先 `Read` 过它。
- `tool.check` 走到链尾无人应答 = **deny**，不是 allow。

有意**没有** `--yes` / 自动放行开关：非交互环境里没人能按 `y`，那就写不了文件、跑不了命令。

也**没有路径围栏**：`Read` / `Write` / `Edit` / `Glob` / `Grep` / `Bash` 能碰到你进程权限内的任何路径，
不限工作目录。确认提示是唯一的一道闸，而且它拦的是"要不要动手"，不是"动哪里" ——
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
pnpm typecheck   # 类型检查（任务级验收就靠它）
pnpm lint        # 依赖边界检查
pnpm test        # 测试
```

## 设计文档

- 设计：[`docs/superpowers/specs/2026-10-11-deepcode-mvp-design.md`](docs/superpowers/specs/2026-10-11-deepcode-mvp-design.md)
- 实施计划：[`docs/superpowers/plans/2026-10-11-deepcode-mvp.md`](docs/superpowers/plans/2026-10-11-deepcode-mvp.md)
- 架构参考：`claude-code-架构分析/`
