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
deepcode --resume                           # 接上当前目录最近一次会话
deepcode --resume=20261011-034855-a1b2      # 接上指定 id 的会话
deepcode --help                             # 用法
deepcode --version                          # 版本号
deepcode --settings=./prod.json "..."       # 追加一层权限设置（flag 来源）
```

不用全局命令也行，等价：

```bash
node /path/to/DeepCode/bin/deepcode.mjs "..."
```

认的开关只有三组，外加 `--settings=<路径>`：`--help` / `-h`、`--version` / `-V` 和 `--resume` 系列（`--resume` / `--resume=<id>`），
其余 `argv` 一律被拼成**一句提示词**。所以 `deepcode --resume "继续修测试"` 里那句话是提示词，不是 id ——
指定 id 只能写成带等号的 `--resume=<id>`。

> ⚠️ 别写成 `pnpm --dir /path/to/DeepCode dev "..."`。pnpm 会把脚本的 cwd 设成**包目录**，
> 于是工作目录变成 DeepCode 仓库自己，模型会在错误的仓库里改文件。`bin/deepcode.mjs`
> 是在自己所在的位置解析 `tsx` 的，所以在哪都能跑，而工作目录保持为你 `cd` 去的那个。

### 交互式会话里

| 输入 | 效果 |
|---|---|
| `/help` | 列出可用命令与工具 |
| `/diff` | 看本会话改过哪些文件（unified 格式，带着色） |
| `/clear` | 清空上下文（磁盘上的转录保留） |
| `/exit` | 退出（`Ctrl-D` 也行） |
| `Ctrl-C` | 掐断当前这一回合（正在跑的模型请求与命令一起断），进程不退，可以接着聊；空闲时按 = 退出，同一回合里连按两次 = 强制退出 |

工具要写盘或跑命令时，终端会打出预览并停下等你一行 `y/N`。**按别的键都算拒绝**。

## 配置

配置有两个来源，**不用每次 `export`**：

- 用户级：`~/.deepcode/config.json`（Windows 是 `C:\Users\<你>\.deepcode\config.json`）
- 项目级：`<工作目录>/.deepcode/config.json`

**优先级：环境变量 > 项目级 > 用户级。** 两层都有时逐字段合并，不是整体替换 ——
项目级只写 `model`，用户级的 `baseUrl` 仍然生效。

不用编辑器也行：

```bash
deepcode config list                # 生效的每一项、当前值、从哪来的（env / user / project / default）
deepcode config set model <名字>     # 写进用户级 ~/.deepcode/config.json
```

**可写的只有 `model` 一个。** `config list` 把每一项的来源都标出来，就是为了让"想改哪一层"
先有个答案；**它会碰的设置一个字都不碰** —— `config.json` 与 `settings.json` 是两份文件，
权限、沙箱、插件那些在后者里，`config set` 够不着。一条命令替你把代码放行或把闸门拧松，
与这个项目禁掉 `--yes` 是同一条理由。写入是原子的（先写临时文件再 `rename`），
权限 `0600`。

```json
{
  "apiKey": "sk-ant-...",
  "model": "claude-sonnet-5-5",
  "baseUrl": "https://api.anthropic.com",
  "provider": "anthropic",
  "debug": false
}
```

五个字段都可省略。**字段名写错会被点名**，不会安静地不生效 —— 拼成 `modle` 你会看到一行
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
| `DEEPCODE_PROVIDER` | 选后端协议：`anthropic` / `openai`，默认 `anthropic`。写别的直接报错，**不静默退回默认值** |
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

### OpenAI 兼容端点

如果那个后端说的是 OpenAI 协议（`/chat/completions`），把 `provider` 设成 `openai`：

```json
{
  "provider": "openai",
  "apiKey": "sk-...",
  "model": "deepseek-chat",
  "baseUrl": "https://api.deepseek.com/v1"
}
```

**`baseUrl` 要自带版本段**（这里的 `/v1`）。请求路径是 `${baseUrl}/chat/completions`，
不做"看到没 `/v1` 就替你补上"的魔法 —— 那只能靠猜，而猜错的症状是一个 404。
换端点时也照这个规矩写全。`provider` 省略时默认 `anthropic`。

**模型 id 写错时，启动期查不出来**：端点各自认识哪些模型只有端点自己知道，
所以启动期只查形状（非空、不含空白字符，拦 `claude sonnet` 这种手滑）。真写错了，
请求失败时会得到一句点名模型 id 的提示（`模型 id "X" 在这个端点看来不存在……`），
而不是一个光秃秃的 404。

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

## 权限

`config.json` 管连接，权限是另一套：`.deepcode/settings.json`。

````json
{
  "permissions": {
    "allow": ["Read"],
    "ask":   ["Bash"],
    "deny":  ["Bash(git push:*)", "WebSearch"]
  }
}
````

三组数组都可省略。五个来源从低到高：

| 来源 | 路径 |
|---|---|
| `user` | `~/.deepcode/settings.json` |
| `project` | `<工作目录>/.deepcode/settings.json` |
| `local` | `<工作目录>/.deepcode/settings.local.json` |
| `flag` | `deepcode --settings=<路径>` |
| `policy` | 托管文件，见下 |

**`policy` 这一层刻意没有环境变量来源。** `config.json` 有（"别把 key 写进文件"是真需求），
权限不一样 —— 一个环境变量就能改掉权限，等于在规则引擎上开了个后门。托管策略必须来自文件：

- Windows：`%ProgramFiles%\DeepCode\managed-settings.json`
- 其它平台：`/etc/deepcode/managed-settings.json`

> 托管文件存在但**读不了**时，这一层按空处理，只打一行醒目的警告。这是本设计里唯一一条
> 真正的 fail-open，且无法消除：策略文件按定义是可选的，不存在时静默是正确行为；
> 存在却读不了时，"拒绝启动"对一个个人 CLI 是过度反应。**看到那行警告就是没有守护。**

### 规则怎么写

| 写法 | 含义 |
|---|---|
| `Bash` | 该工具的**所有**调用 |
| `Bash(git push)` | 命令行恰好等于 `git push` |
| `Bash(git push:*)` | 命令行以 `git push` 开头，按空白 token 边界 —— `git push origin main` ✓，`git pushup` ✗ |
| `Read(~/.ssh/**)` | `file_path` 按 glob 匹配：`*` 单段、`**` 跨段 |
| `Edit(...)` / `Write(...)` | 同 `Read`，都匹配 `file_path` |
| 其它工具带括号 | **不支持**：不命中，且启动时警告一次 |

`:` 是 token 边界，不是通配符 —— 当通配符的话 `Bash(git push:*)` 会要求命令里真有个冒号，
`git push origin main` 没有，规则永远不命中，安静地失效。

> ⚠️ **前缀匹配不懂 shell 语法，"藏在后面"的命令它看不见。** 规则比的是命令行**串的开头**：
> `Bash(git push:*)` 拦得住 `git push origin main`，也拦得住 `git push origin main; rm -rf ~`
> （开头就是 `git push `），但拦不住 `true && git push origin main` —— 开头是 `true`，
> 规则不命中。所以 deny 是给手滑与误操作加的一道闸，**不是反对抗手段**：写得出绕开写法的
> 东西照样绕得过去。真要封死得靠进程权限或操作系统级的隔离；下面「沙箱」那一节加的是闸，
> 不是墙 —— 它在同一个局限里。

路径规则按**绝对路径**匹配（`~` 会展开成主目录）；相对路径不会命中。大小写按平台原样比较，
不替文件系统做归一 —— 猜错的症状是一条防御规则悄悄不命中。

### 谁赢

**更严的永远赢：`deny` > `ask` > `allow`。** 与规则写在哪一层、在同一数组里排第几都无关 ——
重排一下配置文件不会换行为。托管策略因此天然压过个人规则：它坐 `prepend`，
个人规则坐 `user`，而**个人规则掀不翻任何一条 deny**（`allow` 规则的效力上限是把 `ask` 变成 `allow`）。

会话里用 `/permissions` 看当前生效的规则、每条来自哪一层、哪些工具被隐藏、哪些规则没生效。

**没有 `--yes` / 自动放行。** 托管策略里也不写 `allow`：策略说"不用问"会被当成自动放行开关，
与下面「安全」一节那条底线冲突 —— 守门器只在策略**更严**时才插手。

## 沙箱（只有 `Bash`）

`Bash` 命令在**真的起进程之前**会过一道路径闸。它默认**关着**，在 `settings.json` 里写：

```json
{
  "sandbox": {
    "enabled": true,
    "paths": { "deny": ["~/.ssh/**", "/etc/**"], "allow": ["/home/you/repo/**", "/tmp/**"] }
  }
}
```

- **落点在权限链的下游。** 判定发生在 `process` 名词里、`spawn` 之前，而权限链（`tool.check`）
  在**上游** —— 所以**任何 `allow` 规则都绕不过它**，包括你自己写的、将来插件写的。
  "个人规则掀不翻托管策略"在这里不是政策，是位置。
- **`deny` 各层取并集，`allow` 只有托管层能设。** 个人配置能收紧自己，不能替自己开圈 ——
  非托管层写了 `allow` 会被丢弃并出声，不静默。
- **规则里写裸路径**（`/etc/**`、`~/.ssh/**`），`~` 会展开，反斜杠会归一，`**` 跨目录。
  相对路径的规则会被拒收并点名 —— 判定的候选一律是绝对路径，相对规则永远不命中。
- **不做 `dangerouslyDisableSandbox`。** 那个键就是一个"放行开关"，与上面那条底线冲突
  （原话：**谁加自动放行开关谁就是在开倒车**）。
- **它只盖 `Bash`。** `Read` / `Write` / `Edit` 走各自的路径与确认，不在这道闸里。

> ⚠️ **它是文本分析，不是 shell 解析器。** 从命令行里取"可能被写到的路径"靠的是切分 token，
> 不是解析：`x=/etc/passwd; rm $x`、`rm $(echo /etc/passwd)`、`cd /etc && ...` 全都绕得过去。
> 这与上面那条"前缀匹配不懂 shell 语法"是**同一种**局限、同一句话：**它是给手滑与误操作
> 加的一道闸，不是反对抗手段** —— 正因为如此，它**不是**"可以放开权限"的理由。

## 会话落盘

每场会话都落成一份 JSONL，放在**用户级**目录下（不进项目目录，免得被跟着仓库提交出去）：

```
~/.deepcode/projects/<工作目录>/sessions/<id>.jsonl
```

Windows 上就是 `C:\Users\<你>\.deepcode\projects\<工作目录>\sessions\<id>.jsonl`。
`<id>` 形如 `20261011-034855-a1b2`，按文件名排就是时间序。接会话：

| 命令 | 接上 |
|---|---|
| `deepcode --resume` | 当前目录**最近一次**会话 |
| `deepcode --resume=<id>` | 指定 id 的那一次 |

`--resume` 只认当前目录自己的会话（每条转录里记着真实 cwd，撞名也不会接错）。
找不到时：`--resume` 说这个目录还没有可接上的会话，`--resume=<id>` 会列出这个目录下有哪些 id，
两者都以退出码 1 收场 —— 你明确要求恢复，没能恢复就不是成功。

> ⚠️ **转录里是代码与文件内容。** 删掉那个 `.jsonl` 文件，就等于删掉那次会话 ——
> 没有别的副本，也不做过期清理。

落盘写不进去（`~/.deepcode` 只读、磁盘满）时**不拖垮产品**：打一行警告，然后照常跑完这一轮，
只是这次 `--resume` 接不上。转录是便利功能，不该因为它能不能写而决定你能不能干活。

## 着色与 spinner

- `NO_COLOR`：设了**且非空**就关掉着色（空串等于没设）。
- `FORCE_COLOR`：非空且不为 `0` 就打开（有些 CI 把它设成 `0` 而不是删掉，那与不设同义）。
- 非 TTY（管道、重定向到文件、CI）自动关 —— 转义序列写进文件是明确有害的。
- spinner（braille 帧）**只写 stderr**，且只在 TTY 下转；非 TTY 环境里它一个字节都不产出。

关掉着色时输出与"根本没有这个功能"逐字节相同。

## 架构一句话

引擎在每个调用点抛出一个事件，所有插件（**包括六个内建工具**）把自己的 hook 注册成中间件，
按 tier 权威序 `prepend > user > append > builtin > core` 串成一条链。一个 hook 可以
应答 / 改写 / 拒绝 / 委托下层。

`Read`/`Write`/`Edit`/`Bash`/`Glob`/`Grep` 走的接口与未来的第三方插件**完全相同** ——
内核里没有一张硬编码的工具表：模型看得见的工具清单来自注册面上 `tool.call` 的 matcher 取值。

## 插件

装一个插件 = 把目录放进去。用户级 `~/.deepcode/plugins/<名字>/` 自动装载；
项目级 `<工作目录>/.deepcode/plugins/<名字>/` 要在设置里 `plugins.enable` 之后才装
（"我自己装的"与"这个仓库要求我装什么"是两件事）。

还有第三种放法：**装进来**。`plugin add` 从一份**本地索引**把插件拷进落点
`~/.deepcode/installed/<名字>/` —— 而落点**不参与自动装载**。

```bash
deepcode plugin list                # 装上的 / 装进来的 / 跳过的，各带理由
deepcode plugin validate <目录>      # 只校验一份清单，不执行任何代码
deepcode plugin add <名字> --from=<目录>   # 从一份本地索引装进来
deepcode plugin remove <名字>        # 从落点删掉
```

**装 ≠ 启用。** `plugin add` 只把文件放好，不放行任何东西；要它跑，得在**用户级**
`~/.deepcode/settings.json` 里写 `plugins.enable: ["<名字>"]`。**项目级设置里写同一个
名字不算数** —— 否则一个克隆下来的仓库就能按名字点亮你全局装着的插件。而且
`plugin add` 不会替你改设置：一条命令替你把代码放行，与这个项目禁掉 `--yes` 是同一条理由。
落点里那一份在 `plugin list` 里单占一节，标着启用与否 ——「装了但还没启用」是一个正常
状态，不是错误。

marketplace 就是一份本地目录：`<目录>/.deepcode-plugin/marketplace.json` 列出若干条目，
每条一个 `name` 与一个相对的 `source`。**只有本地索引**：没有网络、没有签名与校验和、
没有版本与升级（要更新就是 `remove` 之后再 `add`）。仓库自己那份在
[`.deepcode-plugin/marketplace.json`](.deepcode-plugin/marketplace.json)，列的就是下面那三个插件。

一份插件至少要有 `plugin.json`（`name` / `version`），可以再带：

- 一个入口模块（`main.mjs`）—— `export default { register(on) }`，用与内建工具完全相同的接口
  注册 hook。仓库里的 [`plugins/todo`](plugins/todo/) 是这样加了一个新工具。
- 一份 `hooks/hooks.json` —— Claude Code 风格的 classic 钩子。仓库里的
  [`plugins/secret-guard`](plugins/secret-guard/) 用它拦下了往仓库里写密钥。
- 两者都行 —— [`plugins/hookify`](plugins/hookify/) 是一份 `hooks.json` 加一个纯逻辑模块：
  规则用**数据**写，钩子只负责把规则读进来、把判定吐出去。

hookify 值得单独说一句，因为它演示的是"**加一套语法**"而不是"加一个工具"：你在项目里放一个
`.deepcode/hookify.<随便什么>.local.md`，它就被编译成一个 `PreToolUse` 判定。

```markdown
---
name: no-aws-keys
tool: Write|Edit
field: content
operator: matches
pattern: AKIA[0-9A-Z]{16}
decision: deny
message: 文件里出现了形似 AWS access key 的东西
---

要写就先把 key 换成占位符，或者从环境变量读。
```

判定词汇**只有 `deny` 与 `ask`**：`decision: allow` 会被当成规则文件的错误当场点名。
理由与上面那条一模一样 —— 一个插件的 `allow` 是空头承诺，支持它只会让人写出一条看起来
生效、其实什么都不做的规则。

> ⚠️ **一个写坏的规则文件会让你的 `Write` / `Edit` / `Bash` 全部被拒绝**，直到修好或删掉它。
> 规则文件读不动、frontmatter 缺字段、算子是写错的、正则编译不过、钩子进程自己崩了 ——
> 一律非零退出，而非零就是 `deny`（这就是 fail-closed 的代价，如实写在这里）。
> 报错会点名是哪个文件、哪一行。参考实现的 hookify 在这里反着来：它在 `finally` 里
> `sys.exit(0)`，注释写着"钩子出错永远不该阻断操作"。我们不接受那个方向 ——
> 一个读不懂自己规则的守卫，比一个假装没事的守卫危险。

**第三方插件只能拧紧，不能拧松。** 这不是约定，是结构：

- 它返回 `{ decision: 'allow' }` 会被丢弃 —— 那个判定连它自己那一层都出不去；
- 座位永远是 `append`（内层）：`prepend` 与 `user` 是策略层与个人规则层，不该由一个
  掉进目录的东西占着；`builtin` 及更内层够不着（`confirm` 在那儿结束链）；
- 注册的事件必须在清单的 `uses` 里，越界则**整个插件不装**（不是丢掉越界那一条）；
- 它没法扩展 `$`（往 `engine.create` 挂 hook 会被当场拒绝并告知）。

准入闸门认五层 settings 合并出来的 `plugins.deny`。这份名单只能关掉**掉进目录的**插件：
点到 CLI 自带的任何一个（`sec-default`、`plugin-guard`、`permissions` …）会被忽略并出声 ——
一份禁用名单不该有拆承重墙的能力。**它管的是链上权威，不是代码执行** ——
`import` 一个入口模块就是在你的进程里跑它，装一个插件就是信任它。`plugin validate`
会把钩子要跑的命令原文打出来，那是在装之前你能看见的全部。

已知偏差见 [P3 设计 §11](docs/superpowers/specs/2026-10-11-deepcode-p3-design.md)：
只桥了 3 个 classic 事件（`PreToolUse` / `SessionStart` / `SessionEnd`），
`type: "prompt"` 型钩子与正则 matcher 不支持，`commands/agents/skills/mcpServers` 只校验不加载。

## 子代理与技能

组合面加了两样东西：`Task` 派子代理、`Skill` 加载技能正文。两个都是**第一方插件**
（[`src/cli/subagents.ts`](src/cli/subagents.ts)）注册的工具，**不是内建工具** ——
模型看得见的工具因此从六个内建工具的 `Read` / `Write` / `Edit` / `Bash` / `Glob` / `Grep`
变成**八个**。

它们的名册来自两处约定目录，与插件目录并列（`.deepcode/` 下）：

| 类型 | 项目级 | 用户级 | 插件级 |
| --- | --- | --- | --- |
| 子代理 | `.deepcode/agents/<name>.md` | `~/.deepcode/agents/<name>.md` | `<plugin>/agents/<name>.md` |
| 技能 | `.deepcode/skills/<name>/SKILL.md` | `~/.deepcode/skills/<name>/SKILL.md` | `<plugin>/skills/<name>/SKILL.md` |

- 文件开头是一段 frontmatter，正文是**系统提示词**（agent）或**知识正文**（技能）。
  agent 认 `name` / `description` / `model` / `tools` / `disallowedTools` / `maxTurns`；
  不认识的字段会**出声忽略**，不会让整个文件作废 —— 一份用着别的字段的 agent 少几个特性照装，
  而不是一个字都读不了。
- **`description` 是路由的全部依据** —— 模型看到的只有这一行，不是文件。没有它就永远选不中，
  这样的文件会被跳过并给出警告。
- agent 的 `tools` 省略 = **继承会话的全部工具**；给出 = 白名单。
  「全权」指的是工具面，**不是免确认**：子代理写文件照样弹 `y/N`。
- 子代理**看不到**当前对话，`prompt` 就是它的全部上下文；它最后一段话作为工具结果回到父级。
- 嵌套靠白名单：`tools` 里有 `Task` 才能再派，外加 3 层的硬上限。
  一次失控的递归要花真钱，所以上限是保险丝，不是策略。
- **项目级的 agent 与技能不需要显式启用**（与插件不同）：它们是文本，和这个仓库的 README、
  源码同级，而 `Read` 本来就是无闸的。
- 技能只加载正文。它旁边的 `references/`、`scripts/` 由模型自己用 `Read` / `Bash` 取 ——
  这一层我们一行代码都不写。

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
所以别在装着重要东西的机器上放它乱跑。**`Bash` 另有一道可选的路径闸**（见下面「沙箱」一节），
但它只盖 `Bash`、只做文本分析 —— 它加的是闸，不是墙。

上面这些是**核心**（`prepend` 的 `sec-default` 与 `user` 的 `permissions` 两个插件之外，
引擎一行安全逻辑都没有）。P2 加了可配置的规则层：

- 五层 settings 来源、`allow` / `ask` / `deny` 规则、`/permissions` 审计输出 —— 见上面「权限」一节。
- 托管策略由 `sec-default` **持有裁决**：跑完整条链后，若下端把策略的更严判定放宽了，直接拿
  策略的规则原文推翻它。它自己抛错时兜底成 deny —— 不能指望 dispatch 的故障隔离替它兜，
  那会把抛错的 hook 跳过并继续跑下层，于是保护无声消失。
- 按权限过滤工具可见性：整工具 deny（`deny: ["WebSearch"]`）会让它从**模型可见清单**里消失。
  参数化 deny 绝不隐藏整个工具 —— 为拦一条命令藏掉整个 Bash 是灾难。

## 已知限制（MVP 有意不做）

- **沙箱是策略层的命令分析，不是 OS 隔离**：Windows 上没有 bubblewrap / sandbox-exec 的对应物，
  做真隔离等于写一段本机永远跑不到、也永远测不了的代码。候选路径的提取只有一组手写 fixture，
  准确率是"我们信这组 fixture"，不是"我们量过"。路径比较**区分大小写**（与权限规则一致）。
- **压缩的阈值 `compact.atTokens` 默认 100_000 是猜的**：参考笔记明说引擎内部看不见真实窗口。
  自动压缩**默认关**，`/compact` 手动始终可用；摘要失败 / 返回空 / 压完反而更长 —— 三种情况
  都**不压缩**，出声，原文一条不动。
- **中断只杀外壳**：`Bash` 在 Windows 上经 `cmd.exe` 起命令，`Ctrl-C` 掐断的是这层外壳，
  它下面的孙进程可能继续残留（没有进程组）。
- **没有 TUI、没有语法高亮**：现在有 ANSI 着色与单行 spinner，但界面仍是逐行的纯文本流，
  也不走 `ui.render` 事件（那一层排到 P3）。
- **39 个事件里实现了 19 个**：其余 20 个已声明、未实现，用到时会抛 `NotImplementedError`。
- **非 TTY 下 REPL 收不到输入**：`echo '/diff' | deepcode` 这种喂法**无效**。readline 在
  `createInterface` 之后就开始读，而 `main()` 到 `startRepl` 挂上第一个监听之间还隔着好几个
  `await`（找或建会话转录、建引擎、`session.start`、读指令文件）—— 管道里的那几行就在这段
  空窗里被读掉、扔了。要脚本化请用一次性模式 `deepcode "..."`，那条路是好的。
- **插件只桥了 3 个 classic 事件**（`PreToolUse` / `SessionStart` / `SessionEnd`）。
  参考实现有 33 个事件名；其余 30 个在 `hooks.json` 里会被跳过并点名，不是静默忽略 ——
  它们要的是我们还没有的钩子点（比如 `PostToolUse` 要一个 `tool.result` 事件）。
- **`uses` 只在事件级别校验**：`tool.check` 这一个名字是粗粒度的，一个声明了它的插件
  对每个工具都能说上话。细到 matcher 一级的声明排在 P4。

## 开发

```bash
pnpm typecheck   # 类型检查
pnpm lint        # 两个检查：依赖边界 + 工作流硬化
pnpm test        # 测试，44 个文件 738 个用例
pnpm dev         # 免去 bin 转手，直接跑 tsx（cwd 是本仓库）
```

三条命令在 [GitHub Actions](.github/workflows/ci.yml) 上也跑（Node 20 与 22 两个版本）。
CI 不需要任何密钥 —— 测试全是桩：假 `fetch`、临时目录。

> ⚠️ **工作流硬化检查是文本扫描，不是 YAML 解析器。** 它认不出动态拼出来的 `uses:`、
> 写在 YAML 锚点里的引用、以及 job 之间的包含关系。它是尽力而为的护栏，不是完备证明 ——
> 新工作流仍要人看一眼。

## 设计文档

- 项目简介（一页纸，给第一次听说的人）：[`docs/项目简介.md`](docs/项目简介.md)
- 设计：[`docs/superpowers/specs/2026-10-11-deepcode-mvp-design.md`](docs/superpowers/specs/2026-10-11-deepcode-mvp-design.md)
- 实施计划：[`docs/superpowers/plans/2026-10-11-deepcode-mvp.md`](docs/superpowers/plans/2026-10-11-deepcode-mvp.md)
- P2 计划：[`docs/superpowers/plans/2026-10-11-deepcode-p2.md`](docs/superpowers/plans/2026-10-11-deepcode-p2.md)
- P3 设计（插件系统）：[`docs/superpowers/specs/2026-10-11-deepcode-p3-design.md`](docs/superpowers/specs/2026-10-11-deepcode-p3-design.md)
- P4e 设计（CI 与工程化）：[`docs/superpowers/specs/2026-10-11-deepcode-p4e-design.md`](docs/superpowers/specs/2026-10-11-deepcode-p4e-design.md)
- 架构参考：`claude-code-架构分析/`

## 官网（静态页面）

[`site/index.html`](site/index.html) 是这个项目的门面：一屏讲完「是什么、凭什么信它、走到哪一步」，
再逐段展开。纯静态，一个 HTML / 一个 CSS / 一个 JS，没有框架、没有构建、不请求任何外部资源 ——
**双击就能看**（`file://` 下也完整可用）：

```bash
start site/index.html      # Windows；macOS 用 open，Linux 用 xdg-open
```

页面里的每个数字与断言都能追到本文件或 `docs/` 里的具体位置；`site/` 不在 `tsconfig.json`
的 `include` 里，也不被 `check-boundaries.mjs` 扫描，对上面三条命令零影响。

**部署**：产物就是 `site/` 这**一整个目录**，拷到任意静态主机即可（GitHub Pages / Netlify / 任意 nginx），
没有构建步骤。页面里没有一处绝对路径，放在域名根或子路径下行为一致；文档类链接指向 GitHub 上的文件，
不依赖仓库内的相对路径 —— 所以**部署 `site/` 时不需要连 `docs/` 一起带**。
