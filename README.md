# DeepCode

一个终端里的 agentic 编码助手。给它一句自然语言，它会读文件、改文件、跑命令。

当前是**最小可用版本（MVP）**：能跑通「读 → 改 → 跑测试」的闭环。安全底线是每个会写盘或执行命令的动作，
都要你在终端上按一次 `y`。

官网（静态单页，双击就能看）：[`site/index.html`](site/index.html)

## 安装

需要 **Node ≥ 20** 与 **pnpm**。

```bash
git clone https://github.com/yyyCode/DeepCode && cd DeepCode
pnpm install
npm link          # 把 deepcode 挂到全局（撤掉用 npm rm -g deepcode）
```

给它一把 key —— 写进用户级配置最省事：

```bash
mkdir -p ~/.deepcode && cat > ~/.deepcode/config.json <<'EOF'
{ "apiKey": "sk-ant-..." }
EOF
```

换端点就改这三个字段。Anthropic 兼容（DeepSeek 实测可用）与 OpenAI 兼容都在内：

```json
{ "apiKey": "sk-...", "model": "deepseek-v4-flash", "baseUrl": "https://api.deepseek.com/anthropic" }
```
```json
{ "provider": "openai", "apiKey": "sk-...", "model": "deepseek-chat", "baseUrl": "https://api.deepseek.com/v1" }
```

`baseUrl` 要**自带版本段** —— 请求路径直接拼 `${baseUrl}/chat/completions`，不做「看到没 `/v1` 就替你补上」
的魔法（那只能靠猜，猜错的症状是一个 404）。不装全局命令也行，等价：

```bash
node /path/to/DeepCode/bin/deepcode.mjs "..."
```

## 启动

```bash
cd /你的项目
deepcode "跑一下测试，把失败的那条修掉"    # 一次性，跑完退出
deepcode                                    # 不带参数 = 交互式 REPL
deepcode --resume                           # 接上当前目录最近一次会话
deepcode --resume=20261011-034855-a1b2      # 接上指定 id 的会话
deepcode --settings=./prod.json "..."       # 追加一层权限设置（flag 来源）
deepcode --help / --version
```

认的开关只有三组，外加 `--settings=<路径>`：`--help` / `-h`、`--version` / `-V` 与 `--resume` 系列。
其余 `argv` 一律被拼成**一句提示词** —— 所以 `deepcode --resume "继续修测试"` 里那句话是提示词，不是 id；
指定 id 只能写成带等号的 `--resume=<id>`。

> ⚠️ 别写成 `pnpm --dir /path/to/DeepCode dev "..."`。pnpm 会把脚本的 cwd 设成**包目录**，
> 于是工作目录变成 DeepCode 仓库自己，模型会在错误的仓库里改文件。

## 会话里

| 输入 | 效果 |
|---|---|
| `/help` | 列出可用命令与工具 |
| `/diff` | 两块：本会话改过哪些文件、工作区还有什么没提交（unified 格式，带着色） |
| `/clear` | 清空上下文（磁盘上的转录保留） |
| `/compact [说明]` | 手动压缩上下文；带上一句说明就拼进摘要那一轮的提示（`/compact 保住 API 设计决策`）。自动压缩默认关 |
| `/context` | 看上下文账本：系统提示逐节多少 token、会话消息多少、合计、压缩阈值、上次实测用量 |
| `/permissions` | 看当前生效的权限规则、每条来自哪一层 |
| `/config` | 看生效的配置项与来源 |
| `/telemetry` | 看遥测开关、文件路径、本次会话写了多少行 |
| `/exit` | 退出（`Ctrl-D` 也行） |
| `Ctrl-C` | 掐断当前这一回合（正在跑的模型请求与命令一起断），进程不退，可以接着聊；空闲时按 = 退出，同一回合里连按两次 = 强制退出 |

工具要写盘或跑命令时，终端会打出预览并停下等你一行 `y/N`。**按别的键都算拒绝。**

`/diff` 的两块**来源不同**，这件事决定了它在没有 `git` 的机器上会怎样：`[本会话改动]` 归 CLI 自己
（进程内记录，照常打出），`[工作区未提交]` 归内建 mod `diff`（`git status` / `git diff`，没有 `git`
就整个消失，那一块换成一句人话）。

## 界面

界面是**逐行的纯文本流**，不占整屏（没有 alternate screen）—— 输出能被 `tee`、能被滚回、能被复制。
它只是既有事件（`turn.*` / `tool.*` / `session.compact`）的观察者，**零新增事件**。

- **开场那一屏**：版本、模型与端点、工作区、会话 id（能不能 `--resume` 接上），外加一行键位提示。
  **只在真终端里画** —— 管道与 `deepcode "…"` 下一个字节都不产出。
- **活动区是借来的**：模型在转、工具在跑的时候，那几行画在光标处、到点擦掉重画；结果一到就换成
  **永久行** —— 屏幕上留下来的每一行都有信息量。
- **一份账两个消费者**：每轮结束落一行摘要（几次工具、多少 token、改了哪些文件、花了多久），
  退出时同一份账再打一遍。token 是端点报的就照报，是估的就带 `（估）`。
- **内容面**：模型说的话按行过一遍 markdown 子集（标题、列表、行内代码、代码块、粗体）。
  认不出的语法**原样留着**，不吞字；代码块与行内代码**逐字节保真**。
- **输入面**：`~/.deepcode/history` 存上/下键历史（与转录同一套规矩：用户级 home、0600）；
  `Tab` 补全 `/` 命令名与 `@` 路径；行尾 `\` 续行；一次粘贴进来的多行算**一次**提交。

**非 TTY 下界面一个字节都不产出**：管道里的输出只由真正的数据行组成 —— 没有提示符、没有转义序列、没有半分屏。
（活动行与 spinner 只往 **stderr** 写；非 TTY 环境里它们一个字节都不产出。）
`NO_COLOR`（非空）关着色，`FORCE_COLOR`（非空且非 `0`）开，非 TTY 自动关；关掉着色时输出与
「根本没有这个功能」逐字节相同。

## 配置

两个来源，**不用每次 `export`**：

- 用户级：`~/.deepcode/config.json`（Windows 是 `C:\Users\<你>\.deepcode\config.json`）
- 项目级：`<工作目录>/.deepcode/config.json`

**优先级：环境变量 > 项目级 > 用户级。** 两层都有时按字段合并，不是整体替换 —— 项目级只写 `model`，
用户级的 `baseUrl` 仍然生效。

```bash
deepcode config list                # 生效的每一项、当前值、从哪来的（env / user / project / default）
deepcode config set model <名字>     # 写进用户级 ~/.deepcode/config.json
```

字段五个，都可省略：`apiKey` / `model` / `baseUrl` / `provider` / `debug`。**字段名写错会被点名**
（拼成 `modle` 你会看到一行 `不认识的字段 "modle"`），JSON 语法错、类型不对则直接报错并带上路径，
不静默退回默认值。

**`config set` 只有 `model` 可写**，而且它碰的设置一个字都不碰 —— 权限、沙箱、插件在另一份
`settings.json` 里。一条命令替你把代码放行或把闸门拧松，与禁掉 `--yes` 是同一条理由。
写入是原子的（先写临时文件再 `rename`），权限 `0600`。

> ⚠️ 项目级配置里放 `apiKey` 有明显风险：这个文件很容易跟着仓库一起提交出去。本仓库的 `.gitignore`
> 已经把 `.deepcode/` 排除在外；要在别的仓库里这么用，请自己确认那一行。更稳妥的是用户级配置或环境变量。

| 环境变量 | 作用 |
|---|---|
| `ANTHROPIC_API_KEY` | API key。与 `ANTHROPIC_AUTH_TOKEN` 同时给时，**以 `ANTHROPIC_API_KEY` 为准** |
| `ANTHROPIC_AUTH_TOKEN` | 同上，Anthropic 兼容端点常用的名字 |
| `DEEPCODE_MODEL` | 覆盖模型 id，默认 `claude-sonnet-5-5`。与 `ANTHROPIC_MODEL` 同时给时以它为准 |
| `ANTHROPIC_MODEL` | 同上，兼容端点常用的名字 |
| `ANTHROPIC_BASE_URL` | 覆盖 API 端点 |
| `DEEPCODE_PROVIDER` | 选后端协议：`anthropic` / `openai`，默认 `anthropic`。写别的直接报错 |
| `DEEPCODE_DEBUG` | 打开调试轨迹（走 stderr）：每次 dispatch 一行，说明这个事件被哪些 hook 应答、谁被跳过了 |

**排查「为什么它没走我的配置」**：最常见的坑就是环境变量优先级更高 —— 机器上残留的
`ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN`（比如以前配过某个中转站）会顶掉你写在配置文件里的那一项，
你只会看到一堆 401。只要顶掉了、**而且两处值不一样**，启动时就会打一行说明（两边相同时不吭声；
apiKey 被顶掉时只说"两处内容不一致"，绝不把 key 打出来）。

```bash
echo $ANTHROPIC_BASE_URL $ANTHROPIC_AUTH_TOKEN        # Git Bash
```
```powershell
$env:ANTHROPIC_BASE_URL; $env:ANTHROPIC_AUTH_TOKEN    # PowerShell
```

> **Windows 上删了环境变量，已经开着的终端不会变** —— 连在同一个终端程序里新开标签页也不行
> （新标签是从终端进程继承的）。要把终端程序**整个退出**再打开。

指令文件（`AGENTS.md` / `CLAUDE.md`）按**五层**拼进系统提示：项目 → 本机（`.deepcode/` 下）→ 用户
（`~/.deepcode/`）→ 托管 → 嵌套（更深目录的 `AGENTS.md`，读到那里的文件时才附上）。
**只有托管那层能写**，别的四层写了会被丢掉并告诉你。

系统提示**每一轮重算**（不是一个会话算一次）：会话中途改 `AGENTS.md` 当场生效，压缩之后注入面也
重新求值。代价是每轮多几次文件读，而且系统提示的字节可能在会话中途变化。

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

五个来源从低到高：`user`（`~/.deepcode/settings.json`）→ `project`（`<工作目录>/.deepcode/settings.json`）
→ `local`（同目录 `settings.local.json`）→ `flag`（`--settings=<路径>`）→ `policy`（托管，见下）。

| 写法 | 含义 |
|---|---|
| `Bash` | 该工具的**所有**调用 |
| `Bash(git push)` | 命令行恰好等于 `git push` |
| `Bash(git push:*)` | 命令行以 `git push` 开头，按空白 token 边界 —— `git push origin main` ✓，`git pushup` ✗ |
| `Read(~/.ssh/**)` | `file_path` 按 glob 匹配：`*` 单段、`**` 跨段 |
| `Edit(...)` / `Write(...)` | 同 `Read`，都匹配 `file_path` |
| 其它工具带括号 | **不支持**：不命中，且启动时警告一次 |

`:` 是 **token 边界**，不是通配符 —— 当通配符的话 `Bash(git push:*)` 会要求命令里真有个冒号，
规则永远不命中，安静地失效。路径规则按**绝对路径**匹配（`~` 会展开），相对路径不会命中。

> ⚠️ **前缀匹配不懂 shell 语法。** 规则比的是命令行**串的开头**：`Bash(git push:*)` 拦得住
> `git push origin main; rm -rf ~`（开头就是 `git push `），但拦不住 `true && git push origin main`。
> 所以 deny 是给手滑与误操作加的一道闸，**不是反对抗手段**。

**谁赢：`deny` > `ask` > `allow`。** 与规则写在哪一层、在同一数组里排第几都无关 —— 重排一下配置文件
不会换行为。托管策略因此天然压过个人规则，而**个人规则掀不翻任何一条 deny**（`allow` 规则的效力上限是
把 `ask` 变成 `allow`）。会话里用 `/permissions` 看当前生效的规则、每条来自哪一层、哪些工具被隐藏。

**没有 `--yes` / 自动放行**，托管策略里也不写 `allow` —— 策略说"不用问"会被当成自动放行开关。
**谁加自动放行开关谁就是在开倒车。**

**`policy` 这一层刻意没有环境变量来源**（`config.json` 有）—— 一个环境变量就能改掉权限，等于在规则引擎上
开了个后门。托管策略必须来自文件或由文件派生的 MDM 通道（环境变量 `DEEPCODE_MANAGED_SETTINGS` ／
Windows 注册表 `HKLM\SOFTWARE\DeepCode` ／ macOS 托管偏好域 `com.deepcode.settings` ／ 平台默认文件，
第一个有内容的赢）。托管策略存在但**读不了**时按空处理、只打一行醒目的警告 —— 这是整个设计里唯一一条
真正的 fail-open。**看到那行警告就是没有守护。**

## 沙箱（只有 `Bash`）

`Bash` 命令在**真的起进程之前**会过一道路径闸。默认**关着**，在 `settings.json` 里写：

```json
{ "sandbox": { "enabled": true, "paths": { "deny": ["~/.ssh/**", "/etc/**"], "allow": ["/home/you/repo/**"] } } }
```

- **落点在权限链的下游**（判定发生在 `spawn` 之前）—— 所以**任何 `allow` 规则都绕不过它**。
  「个人规则掀不翻托管策略」在这里不是政策，是位置。
- **`deny` 各层取并集，`allow` 只有托管层能设**（个人写了会被丢弃并出声）。规则里写**裸路径**，
  `~` 会展开、`**` 跨目录；相对路径的规则会被拒收并点名。
- **不做 `dangerouslyDisableSandbox`** —— 那个键就是一个"放行开关"。
- 它**只盖 `Bash`**，`Read` / `Write` / `Edit` 不在这道闸里。

> ⚠️ **它是文本分析，不是 shell 解析器。** 候选路径靠切分 token 拿到，`x=/etc/passwd; rm $x`、
> `rm $(echo /etc/passwd)` 全都绕得过去。**它是给手滑与误操作加的一道闸，不是反对抗手段** ——
> 也正因如此，它**不是**"可以放开权限"的理由。

## 会话落盘

每场会话落成一份 JSONL，放在**用户级**目录（不进项目目录，免得被跟着仓库提交出去）：

```
~/.deepcode/projects/<工作目录>/sessions/<id>.jsonl        # 权限 0600
```

`<id>` 形如 `20261011-034855-a1b2`，按文件名排就是时间序。`--resume` 只认当前目录自己的会话
（每条转录里记着真实 cwd，撞名也不会接错）。找不到时以退出码 1 收场并说清楚 ——
你明确要求恢复，没能恢复就不是成功。落盘写不进去（目录只读、磁盘满）时**不拖垮产品**：
打一行警告，照常跑完这一轮，只是这次 `--resume` 接不上。

**数组被改短时落盘游标要一起归零** —— 压缩和 `/clear` 都会就地改短那个数组，两处都跟着
`reseed` 一次；漏掉的话，被改短之后的新消息会有若干条**静默不落盘**，而转录看上去一切正常。

> ⚠️ **转录里是代码与文件内容。** 删掉那个 `.jsonl` 文件，就等于删掉那次会话 —— 没有别的副本，
> 也不做过期清理。

## 插件

装一个插件 = 把目录放进去。用户级 `~/.deepcode/plugins/<名字>/` 自动装载；项目级
`<工作目录>/.deepcode/plugins/<名字>/` 要在设置里 `plugins.enable` 之后才装（"我自己装的"与
"这个仓库要求我装什么"是两件事）。

```bash
deepcode plugin list                      # 装上的 / 装进来的 / 跳过的，各带理由
deepcode plugin validate <目录>            # 只校验一份清单，不执行任何代码
deepcode plugin add <名字> --from=<目录>    # 从一份本地索引装进来
deepcode plugin remove <名字>              # 从落点删掉
```

**装 ≠ 启用。** `plugin add` 只把文件拷进落点 `~/.deepcode/installed/<名字>/`，而落点**不参与自动装载**；
要它跑，得在**用户级** `~/.deepcode/settings.json` 里写 `plugins.enable: ["<名字>"]`。**项目级设置里写同一个
名字不算数** —— 否则一个克隆下来的仓库就能按名字点亮你全局装着的插件。`plugin add` 也不会替你改设置：
一条命令替你把代码放行，与禁掉 `--yes` 是同一条理由。

marketplace 就是一份**本地目录**：`<目录>/.deepcode-plugin/marketplace.json` 列出若干条目，每条一个
`name` 与一个相对的 `source`。**只有本地索引** —— 没有网络、没有签名与校验和、没有版本与升级
（要更新就是 `remove` 之后再 `add`）。仓库自己那份在
[`.deepcode-plugin/marketplace.json`](.deepcode-plugin/marketplace.json)。

一份插件至少要有 `plugin.json`（`name` / `version`），可以再带一个入口模块（`main.mjs`，
`export default { register(on) }`，用与内建工具完全相同的接口注册 hook）、一份 `hooks/hooks.json`
（Claude Code 风格的 classic 钩子），或者两者都行。仓库里三个示例：

| 插件 | 加了什么 |
|---|---|
| [`plugins/todo`](plugins/todo/) | 一个新的 `TodoWrite` 工具（`src/` 里 grep 不到这个名字） |
| [`plugins/secret-guard`](plugins/secret-guard/) | 一条 classic 钩子，拦下往仓库里写密钥 |
| [`plugins/hookify`](plugins/hookify/) | **一套语法** —— `.deepcode/hookify.<随便什么>.local.md` 里的声明式规则编译成判定 |

> ⚠️ **一个写坏的规则文件会让 `Write` / `Edit` / `Bash` 全部被拒绝**，直到修好或删掉它。
> 规则文件读不动、frontmatter 缺字段、算子是写错的、正则编译不过、钩子进程自己崩了 ——
> 一律非零退出，而非零就是失败。**但代价逐事件不同**：只有 `PreToolUse` 上 fail 会翻成 `deny`，
> 另外三个事件（`PostToolUse` / `UserPromptSubmit` / `Stop`）上只是一句 `notice` ——
> 那些点上没有可拦的动作，`decision: allow` 在那里是规则文件的错误，会当场点名。
> 参考实现在这里反着来（它在 `finally` 里 `exit(0)`，注释写着"钩子出错永远不该阻断操作"）——
> 我们不接受那个方向：一个读不懂自己规则的守卫，比一个假装没事的守卫危险。

**第三方插件只能拧紧，不能拧松。** 这不是约定，是结构：它返回 `{ decision: 'allow' }` 会被丢弃
（那个判定连它自己那一层都出不去）；座位永远是 `append`（内层）；注册的事件必须在清单的 `uses` 里，
越界则**整个插件不装**；它没法扩展 `$`。准入闸门 `plugins.deny` 只能关掉**掉进目录的**插件 ——
点到 CLI 自带的任何一个都会被忽略并出声（一份禁用名单不该有拆承重墙的能力）。

已知偏差见 [P3 设计 §11](docs/superpowers/specs/2026-10-11-deepcode-p3-design.md)：桥了 6 个 classic 事件，
`type: "prompt"` 型钩子与正则 matcher 不支持，`commands/agents/skills/mcpServers` 只校验不加载。

## 子代理与技能

`Task`（派子代理）与 `Skill`（加载技能）是**第一方插件**
（[`src/cli/subagents.ts`](src/cli/subagents.ts)）注册的工具，**不是内建工具** —— 模型看得见的工具
因此从六个内建（`Read` / `Write` / `Edit` / `Bash` / `Glob` / `Grep`）变成**八个**。名册来自两处约定目录：

| 类型 | 项目级 | 用户级 | 插件级 |
| --- | --- | --- | --- |
| 子代理 | `.deepcode/agents/<name>.md` | `~/.deepcode/agents/<name>.md` | `<plugin>/agents/<name>.md` |
| 技能 | `.deepcode/skills/<name>/SKILL.md` | `~/.deepcode/skills/<name>/SKILL.md` | `<plugin>/skills/<name>/SKILL.md` |

- 文件开头是 frontmatter，正文是**系统提示词**（agent）或**知识正文**（技能）。agent 认 `name` /
  `description` / `model` / `tools` / `disallowedTools` / `maxTurns`；不认识的字段会**出声忽略**。
- **`description` 是路由的全部依据** —— 模型看到的只有这一行，不是文件。没有它就永远选不中，
  这样的文件会被跳过并给出警告。
- agent 的 `tools` 省略 = **继承会话的全部工具**；给出 = 白名单。「全权」指的是工具面，
  **不是免确认**：子代理写文件照样弹 `y/N`。子代理**看不到**当前对话，`prompt` 就是它的全部上下文。
- 嵌套靠白名单（`tools` 里有 `Task` 才能再派），外加 3 层的硬上限 —— 一次失控的递归要花真钱，
  所以上限是保险丝，不是策略。
- 项目级的 agent 与技能**不需要显式启用**（与插件不同）：它们是文本，和这个仓库的 README、源码同级。
  技能只加载正文，旁边的 `references/` / `scripts/` 由模型自己用 `Read` / `Bash` 取。

## 内建 mod

`mods/` 下住着四个**内建 mod**：`sec-default`（权限裁决）、`agents-md`（指令文件）、`telemetry`（遥测）、
`diff`（`/diff` 的应答者）。它们**不是特权代码**：走的接口与第三方插件完全相同，`src/cli/` 只是替它们
挑好座位。边界由 `pnpm lint` 强制 —— mod 只许 import `node:` 内建、`src/contract/**` 与自己的目录，
反过来只有 `src/cli/` 许 import mod。

它们比第三方插件多一样东西：**可选依赖**。一个 mod 可以先探一下环境（"这台机器上有没有 `git`"），
没有就整个不装，而不是装上去再在运行时报错。今天只有一个真的消费者：`diff` 需要 `git`，缺了就不装载、
启动时**出声**（`内建 mod diff 没装：这台机器上没有 git。`），`/diff` 改由 CLI 自己应答，其余一切照常。

**降级必须看得见** —— 缺了东西却安静地少一块，比装不上还坏。而且**两条应答者不许同时在**：mod 装上了，
CLI 就**不注册**自己那条 `/diff`，否则同一条命令会打两遍。

## 遥测

**默认关着。** 打开它要你亲自在**用户级** `~/.deepcode/settings.json` 里写
`{ "telemetry": { "enabled": true } }` —— 只有用户层能开，项目级写的会被丢弃并出声（别人仓库里的一份
文件不该替你按下开关）；反过来，**托管层能一句话把它关掉**。

开着时六个事件（`session.start` / `turn.complete` / `tool.result` / `session.compact` / `agent.spawn` /
`session.end`）各写一行到**用户级** `~/.deepcode/telemetry.jsonl`，**没有网络上报**。

> ⚠️ **每一行都是零自由文本的。** 字段名与字符串值必须是标识符形状，任何一行不合规就**整条丢掉**
> （不是截断、不是改写），计数并说一声。这条协议是这份功能唯一的隐私闸门：能塞自由文本，就等于给插件
> 开了一条把文件路径、工具入参、模型输出写进磁盘的通道。

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

也**没有路径围栏**：六个工具能碰到你进程权限内的任何路径，不限工作目录。确认提示拦的是「要不要动手」，
不是「动哪里」—— 所以别在装着重要东西的机器上放它乱跑。

上面这些是**核心**（引擎一行安全逻辑都没有，全在 `prepend` 的 `sec-default` 与 `user` 的 `permissions`
两个插件里）。可配置的规则层见上面「权限」一节；托管策略由 `sec-default` **持有裁决** —— 跑完整条链后，
若下端把策略的更严判定放宽了，直接拿策略原文推翻它。

## 已知限制（MVP 有意不做）

- **沙箱是策略层的命令分析，不是 OS 隔离**：Windows 上没有 bubblewrap / sandbox-exec 的对应物。
  候选路径的提取只有一组手写 fixture，准确率是"我们信这组 fixture"，不是"我们量过"。
  路径比较**区分大小写**（与权限规则一致）。
- **压缩的阈值 `compact.atTokens` 默认 100_000 是猜的**（引擎内部看不见真实窗口）。自动压缩**默认关**，
  `/compact` 手动始终可用；摘要失败 / 返回空 / 压完反而更长 —— 三种情况都**不压缩**，出声，原文一条不动。
  自动压缩还有两道**断电器**：连续失败 3 次就停手、连压 3 次之后上下文仍然超阈值也停手（停手时会说清
  怎么恢复：`/compact` 手动再试一次、调大阈值、或关掉 `compact.auto`）。⚠️ **这两个 3 是照抄复刻对象的
  数，不是我们测出来的**（`docs/superpowers/specs/2026-10-11-deepcode-p7-design.md` §5 偏差 3）。
- **中断只杀外壳**：`Bash` 在 Windows 上经 `cmd.exe` 起命令，`Ctrl-C` 掐断的是这层外壳，
  它下面的孙进程可能继续残留（没有进程组）。
- **没有整屏 TUI、没有语法高亮**：界面是逐行的纯文本流，markdown 只认一个子集，代码块不着色。
  也不走 `ui.render` 事件 —— 那棵"界面数据树"的结构今天还没有消费者能把它钉住（P6 设计 §2.3 记了理由）。
- **41 个事件里实现了 22 个**：其余 19 个已声明、未实现，用到时会抛 `NotImplementedError`。
- **插件只桥了 6 个 classic 事件**（参考实现有 33 个事件名；其余 27 个在 `hooks.json` 里会被跳过并点名，
  不是静默忽略 —— 它们要的是我们还没有的钩子点）。
- **`uses` 只在事件级别校验**：`tool.check` 这一个名字是粗粒度的，声明了它的插件对每个工具都能说上话。
  细到 matcher 一级的声明**仍未做** —— 它是 P3 预登记的一条偏差（`p3-design.md:571`），
  不是"排到某一阶段"。

## 开发

```bash
pnpm typecheck   # 类型检查
pnpm lint        # 两个检查：依赖边界 + 工作流硬化
pnpm test        # 测试，66 个文件 1143 个用例
pnpm dev         # 免去 bin 转手，直接跑 tsx（cwd 是本仓库）
```

三条命令在 [GitHub Actions](.github/workflows/ci.yml) 上也跑（Node 20 与 22）。CI 不需要任何密钥 ——
测试全是桩：假 `fetch`、临时目录。`ci.yml` 里还有一个 `agent-smoke` job，在**防火墙 runner** 上跑真引擎、
假 provider，落在"非 TTY 下没人能确认 → 拒绝"这条 fail-closed 上；它**默认跳过**
（`if: vars.DEEPCODE_AGENT_CI == 'on'` —— 永远红的流水线等于没有流水线）。

## 架构一句话

引擎在每个调用点抛出一个事件，所有插件（**包括六个内建工具**）把自己的 hook 注册成中间件，
按 tier 权威序 `prepend > user > append > builtin > core` 串成一条链。一个 hook 可以
应答 / 改写 / 拒绝 / 委托下层。`next(e)` 是 Koa 式续体，不是事件发射器。

`Read`/`Write`/`Edit`/`Bash`/`Glob`/`Grep` 走的接口与第三方插件**完全相同** —— 内核里没有一张硬编码的
工具表：模型看得见的工具清单来自注册面上 `tool.call` 的 matcher 取值。图与各层允许 import 谁，
见 [官网的「架构」一节](site/index.html#architecture)。

## 设计文档

- 项目简介（一页纸，给第一次听说的人）：[`docs/项目简介.md`](docs/项目简介.md)
- 变更记录（每个阶段的范围 / 出口标准 / 偏差索引）：[`CHANGELOG.md`](CHANGELOG.md)
- 设计：[`docs/superpowers/specs/2026-10-11-deepcode-mvp-design.md`](docs/superpowers/specs/2026-10-11-deepcode-mvp-design.md)
- 实施计划：[`docs/superpowers/plans/2026-10-11-deepcode-mvp.md`](docs/superpowers/plans/2026-10-11-deepcode-mvp.md)
- P2 计划：[`docs/superpowers/plans/2026-10-11-deepcode-p2.md`](docs/superpowers/plans/2026-10-11-deepcode-p2.md)
- P3 设计（插件系统）：[`docs/superpowers/specs/2026-10-11-deepcode-p3-design.md`](docs/superpowers/specs/2026-10-11-deepcode-p3-design.md)
- P4c 设计（分发与治理）：[`docs/superpowers/specs/2026-10-11-deepcode-p4c-design.md`](docs/superpowers/specs/2026-10-11-deepcode-p4c-design.md)
- P4e 设计（CI 与工程化）：[`docs/superpowers/specs/2026-10-11-deepcode-p4e-design.md`](docs/superpowers/specs/2026-10-11-deepcode-p4e-design.md)
- P5 设计（内建与分发）：[`docs/superpowers/specs/2026-10-11-deepcode-p5-design.md`](docs/superpowers/specs/2026-10-11-deepcode-p5-design.md)
- P6 设计（界面与交互）：[`docs/superpowers/specs/2026-10-11-deepcode-p6-design.md`](docs/superpowers/specs/2026-10-11-deepcode-p6-design.md)
- P7 设计（记忆与上下文）：[`docs/superpowers/specs/2026-10-11-deepcode-p7-design.md`](docs/superpowers/specs/2026-10-11-deepcode-p7-design.md)
- 架构参考：`claude-code-架构分析/`

官网产物就是 `site/` 这**一整个目录**，拷到任意静态主机即可（无构建步骤，页面里没有绝对路径）；
`site/` 不在 `tsconfig.json` 的 `include` 里，也不被脚本扫描，对上面四条命令零影响。
