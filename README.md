# DeepCode

一个终端里的 agentic 编码助手。给它一句自然语言，它会读文件、改文件、跑命令。
安全底线是每个会写盘或执行命令的动作，都要你在终端上按一次 `y`。

不只是「读 → 改 → 跑测试」的闭环：工具系统、权限与沙箱、插件与分发、内建 mod、界面、上下文、
执行循环、工具清单、子代理的边界、上下文五层压缩、跨会话记忆、计划模式都已落地（P0–P14，
逐阶段的**范围 / 出口标准 / 偏差**记在 [`CHANGELOG.md`](CHANGELOG.md)）。做不到什么、哪些数是猜的，逐条在
[`site/已知限制.md`](site/已知限制.md) —— 这一页只留会改变**你怎么用它**的那几条。

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
| `/help` | 列出可用命令与工具（工具那一行与 `/tools` 是**同一份**：都是模型这一轮真能用的清单） |
| `/tools` | 模型这一轮能用哪些工具：每个的**来源**（哪个插件给的）、干什么用的，以及**哪些没进清单、为什么** |
| `/diff` | 两块：本会话改过哪些文件、工作区还有什么没提交（unified 格式，带着色） |
| `/clear` | 清空上下文（磁盘上的转录保留） |
| `/compact [说明]` | 手动压缩上下文；带上一句说明就拼进摘要那一轮的提示（`/compact 保住 API 设计决策`）。自动压缩默认关 |
| `/context` | 看上下文账本：系统提示逐节多少 token、**静态前缀/动态尾巴**各多少、**工具清单**多少、会话消息多少、合计、压缩阈值、**五层各自做了什么**、上次实测用量 |
| `/permissions` | 看当前生效的权限规则、每条来自哪一层，以及本次会话按 `a` 记住了什么；`/permissions forget` 把记住的清掉 |
| `/memory [名字]` | 看这个项目记住了什么（类型 · 名字 · 一句话 · 多久前）；带名字就打印那一条正文 |
| `/plan` | 进入只读计划模式（或显示状态）；`/plan off` 直接退出，不执行计划 |
| `/config` | 看生效的配置项与来源 |
| `/telemetry` | 看遥测开关、文件路径、本次会话写了多少行 |
| `/exit` | 退出（`Ctrl-D` 也行） |
| `Ctrl-C` | 掐断当前这一回合（正在跑的模型请求与命令一起断），进程不退，可以接着聊；空闲时按 = 退出，同一回合里连按两次 = 强制退出 |

一轮里模型要多个工具时，**只读的并发、会写的串行**：`Read` / `Glob` / `Grep` 各自声明了
`readOnly`，相邻的几条会一起跑；`Write` / `Edit` / `Bash` 是屏障 —— 排在它前面的只读都结束
才轮到它，它结束才轮到后面的只读。结果顺序始终按模型请求的顺序回填，与谁先跑完无关。
插件工具默认按"会写"处理（串行），除非它在 `tool.describe` 里声明 `readOnly: true`。

工具要写盘或跑命令时，终端会打出预览并停下等一个答案：

- `y` —— 放行**这一次**；
- `a` —— 放行**本次会话的这一类**，并把它记住了什么当场打给你看（`Bash` 记住的是那**一条命令**，
  其余工具是整个工具；只活在进程里，退出即失，`/permissions forget` 一句话忘掉）；
- 其余任何输入（包括直接回车）—— **算拒绝**。

`/help` 与 `/tools` 列的是**模型这一轮真能用的那一份**，不是"注册过哪些名字"。注册了却没进清单的工具
（子代理白名单之外、被权限规则整工具隐藏、插件没注册描述）会**带着原因单独列出来**：
前两种是**设计**（策略不让它露面），最后一种是**故障**（插件坏了）—— 屏幕上分得开，不当成同一件事。

`/context` 的 `合计` 是**请求里真的有的那三样之和**：系统提示 + 工具清单 + 会话消息。
这条口径从 P9 起才成立 —— 在那之前工具那一份根本没进合计（实测某一轮真切发出去约 448 token，
账本报 11）。所以**更早版本留下的 `/context` 数字偏小**，与今天不可比。

上下文变重时，DeepCode 按五道闸从轻到重处理（P11）：先去掉最老的整轮对话，再清掉可重新获取的
旧工具结果，只在更老的一段上做摘要，最后才是整段全量摘要。`/context` 会多一行「分层压缩」，
写清这一次请求各层做了什么（外置几个、清理几条、折叠几段、请求体积 before → after）。

单个工具结果超过 50 000 字符时，**原文会存到磁盘**：

```
~/.deepcode/projects/<项目>/tool-results/<会话>/<工具调用>.txt
```

消息里只留前 2 000 字符的预览和这个路径 —— 后面的内容用 `Read` 的 `offset` / `limit` 读回来。
阈值与保留轮数都能在 `settings.json` 的 `compact.layers` 里调（字段见
[P11 设计文档](docs/superpowers/specs/2026-10-26-deepcode-p11-context-layers-design.md)）。
默认值照抄 Claude Code 的形状，**不是我们测出来的最优值**；`pnpm bench` 可复现对比数据
（[`scripts/benchmark-context.ts`](scripts/benchmark-context.ts)）。

`/diff` 的两块**来源不同**，这件事决定了它在没有 `git` 的机器上会怎样：`[本会话改动]` 归 CLI 自己
（进程内记录，照常打出），`[工作区未提交]` 归内建 mod `diff`（`git status` / `git diff`，没有 `git`
就整个消失，那一块换成一句人话）。

## 记忆

跨会话要记住的东西放在项目目录里，**一条一个文件**：

```
~/.deepcode/projects/<项目>/memory/<名字>.md     # 正文 + frontmatter
~/.deepcode/projects/<项目>/memory/MEMORY.md     # 索引，自动生成，别手改
```

谁来记：模型自己。它有 `Memory` 工具（`save` / `read` / `forget`），只在**真的跨会话有用**时才写 ——
你的偏好（user）、你说过不要做什么（feedback，必须写清 `**Why:**` 与 `**How to apply:**`）、
正在发生的事与截止日期（project，写绝对日期）、去哪找什么（reference，只记入口）。
代码结构、git 历史、调试过程这些**能从仓库里查到的**，它不该记。

怎么进上下文：**索引每轮都在系统提示里**（上限 200 行 / 25KB，超了会截断并告诉你），
正文只在**被召回**时注入，最多 5 条。默认召回是关键词匹配（零 API、离线可复现）；
也可以在 `settings.json` 里指定一个小模型来挑：

```json
{ "memory": { "enabled": true, "maxRecall": 5, "recallModel": "deepseek-chat" } }
```

`enabled: false` 整块关掉（不注入、不注册工具）。记忆超过 1 天会带一句「可能过时，引用前先对照代码」。
`/context` 多一行「记忆」：几条、索引多少行 / 多少 token、这一轮召回了几条、走的关键词还是小模型。

召回是**关键词**，不是语义检索：换个说法、跨语言就可能召不回来 —— 这时模型仍能用 `Memory read`
按名字自己读。benchmark（`pnpm bench:memory`）量的是注入体积与命中，不是记忆质量：

| 场景 | 全量注入 | 索引 + 召回 | 省下 | 命中 |
| --- | ---: | ---: | ---: | ---: |
| 40 条记忆，12 个查询 | 7,598 token | 1,062 token | −86.0% | 12/12 |
| 250 条记忆，索引截断 | 47,778 token | 5,451 token | −88.6% | 12/12 |

## 计划模式

多文件、方向不确定的任务，先让它把方案写出来再动手：

```
你：给配置系统加一层校验，先别改代码，说说你打算怎么做
    → 它可以自己调用 EnterPlanMode
你：/plan            ← 也可以手动进
```

进去以后**只能读**：`Read` / `Glob` / `Grep` / `Skill` 在清单里，`Write` / `Edit` / `Bash` / `Task`
不在；就算模型点名调用也会被拒（`tool.check` 的第二道闸，不是靠提示词自觉）。整条一轮的成本也低一些：
省掉的工具 schema 比注入的计划提示更多（[`pnpm bench:loop`](scripts/benchmark-agent-loop.ts)）。

探索够了，模型调用 `ExitPlanMode`，把完整计划（目标、涉及文件、步骤、验证方式、风险）交上来；
你按 `y` 才恢复读写，按别的（包括直接回车）就留在计划模式继续改。计划本身在问你之前就已经落盘：

```
<工作目录>/.deepcode/plans/plan-<会话 id>-<时间戳>.md
```

拒绝执行不会删掉计划文件 —— 被拒的是执行，不是计划。子代理与 Bash 拿不到，所以计划模式里也没有
"绕过去"的路。没有 Shift+Tab，手动开关就是 `/plan` / `/plan off`。

## 一轮怎么收场

模型的一轮什么时候停，不一定等于"它说完了"。三件与这有关的事，全都**出声**，不静默处理：

- **被输出长度上限截断 → 接着往下写**。最多替它接 3 次，每一次都打一行通知（这会多花模型请求，
  所以不许悄悄花）。3 次之后还截断，就以「上面那段回答是半截的」收场。
- **一步什么都没产出**（可能只回了思考块）→ 重提示一次；还是空就说清「两次都没有产出任何内容」。
  空的一步**不会**在对话里留下一条空消息。
- **模型流到一半断了**（网络、进程被掐）→ 屏幕上已经显示过的那半句**留在转录里**，
  再加一行「本 turn 失败」。转录不许比屏幕少东西。

一次性模式的退出码按**白名单**来：正常收场是 `0`，`Ctrl-C` 是 `130`，**其余一律 `1`** ——
包括被截断、模型拒答、什么都没产出。所以 `deepcode "写一份长报告" && 下一步` 不会带着半截结果
往下走。

## 界面

界面是**逐行的纯文本流**，不占整屏（没有 alternate screen）—— 输出能被 `tee`、能被滚回、能被复制。

- **开场那一屏**：版本、模型与端点、工作区、会话 id（能不能 `--resume` 接上），外加一行键位提示。
  **只在真终端里画** —— 管道与 `deepcode "…"` 下一个字节都不产出。
- **一份账两个消费者**：每轮结束落一行摘要（几次工具、多少 token、改了哪些文件、花了多久），
  退出时同一份账再打一遍。token 是端点报的就照报，是估的就带 `（估）`。
- **输入面**：`~/.deepcode/history` 存上/下键历史（与转录同一套规矩：用户级 home、0600）；
  `Tab` 补全 `/` 命令名与 `@` 路径；行尾 `\` 续行；一次粘贴进来的多行算**一次**提交。
- 模型说的话过一遍 markdown 子集（标题、列表、行内代码、代码块、粗体）：认不出的语法**原样留着**，
  不吞字，代码块与行内代码**逐字节保真**。没有语法高亮，理由见「已知限制」。

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

提示本身分成两段（P13）：角色、安全边界、操作安全、工具选择、Git、输出这七节是**静态前缀**，
换项目、换日期都不变；环境（cwd / 是否 Git 仓库 / 平台 / Shell / 模型 / 日期）、指令文件、记忆与
清单是**动态尾巴**。Anthropic 端点会给静态前缀打 `cache_control`，OpenAI 兼容端点靠稳定前缀自动
命中。`/context` 的「缓存前缀」一行报两段各多少 token；`pnpm bench:prompt` 可复现 20 轮缓存账 ——
小项目省 50%，巨型 `AGENTS.md` 也省 25% 左右，第 2 轮回本。提示词只影响模型行为，**不是权限闸门**。

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
（[`src/cli/subagents.ts`](src/cli/subagents.ts)）注册的工具，**不是内建工具**；记忆的 `Memory`
（`src/cli/memory.ts`）与计划模式的 `EnterPlanMode`（[`src/builtins/plan.ts`](src/builtins/plan.ts)）
也是。模型看得见的工具因此从六个内建
（`Read` / `Write` / `Edit` / `Bash` / `Glob` / `Grep`）变成**十个**；
`ExitPlanMode` 也在册，但没进计划模式时被隐藏 —— `/tools` 会把它列在「不进模型可见清单的」。名册来自两处约定目录：

| 类型 | 项目级 | 用户级 | 插件级 |
| --- | --- | --- | --- |
| 子代理 | `.deepcode/agents/<name>.md` | `~/.deepcode/agents/<name>.md` | `<plugin>/agents/<name>.md` |
| 技能 | `.deepcode/skills/<name>/SKILL.md` | `~/.deepcode/skills/<name>/SKILL.md` | `<plugin>/skills/<name>/SKILL.md` |

- 文件开头是 frontmatter，正文是**系统提示词**（agent）或**知识正文**（技能）。agent 认 `name` /
  `description` / `model` / `tools` / `disallowedTools` / `maxTurns`；不认识的字段会**出声忽略**。
- **`description` 是路由的全部依据** —— 模型看到的只有这一行，不是文件。没有它就永远选不中，
  这样的文件会被跳过并给出警告。
- agent 的 `tools` 省略 = **继承父级那一轮的工具面**（父级是会话就继承会话，父级是子代理就继承
  那个子代理这一轮看得见的）；给出 = **在那份面里求交** —— 只能更小，拿不回父级看不见的东西。
  「全权」指的是工具面，**不是免确认**：子代理写文件照样弹 `y/N`。子代理**看不到**当前对话，
  `prompt` 就是它的全部上下文。
- 嵌套靠白名单（`tools` 里有 `Task` 才能再派），外加 3 层的硬上限 —— 一次失控的递归要花真钱，
  所以上限是保险丝，不是策略。这份面与这个数都在**内核**里算：不管走 `Task` 还是插件直接调
  `$.agent.spawn`，走的都是同一行判定（P10）。
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

安全底线是 `tool.check` 事件上的最小确认：

- `Read` / `Glob` / `Grep` 只读，不询问。
- `Write` / `Edit` / `Bash` 打印预览后等一个答案：`y` 放行这一次，`a` 放行本次会话的这一类
  （`Bash` 按那一条命令记，其余工具按整个工具记），**别的输入一律算拒绝**。
- 非 TTY（管道、CI）环境下**默认拒绝** —— 所以拿它写脚本只能做只读的活。
- 不认识的工具**拒绝**，不是放行。
- `Write` 覆盖已有文件前，必须在本次会话里先 `Read` 过它。
- `tool.check` 走到链尾无人应答 = **deny**，不是 allow。

有意**没有** `--yes` / 自动放行开关：非交互环境里没人能按 `y`，那就写不了文件、跑不了命令。
谁加自动放行开关谁就是在开倒车。`a` 不是它的变体 —— `a` 只能按在**一个已经摆在你面前的预览**上，
记下了什么当场打出来给你看，只活在内存里，`/permissions forget` 一句话忘掉。

也**没有路径围栏**：六个工具能碰到你进程权限内的任何路径，不限工作目录。确认提示拦的是「要不要动手」，
不是「动哪里」—— 所以别在装着重要东西的机器上放它乱跑。

上面这些是**核心**（引擎一行安全逻辑都没有，全在 `prepend` 的 `sec-default` 与 `user` 的 `permissions`
两个插件里）。可配置的规则层见上面「权限」一节；托管策略由 `sec-default` **持有裁决** —— 跑完整条链后，
若下端把策略的更严判定放宽了，直接拿策略原文推翻它。

## 已知限制

这一页只留**会改变你怎么用它**的那几条；完整清单（含每一句代价、每个"我们定的数"、
以及各自的设计文档指路）在 [`site/已知限制.md`](site/已知限制.md)。

- **沙箱不是 OS 隔离**：它是策略层的命令文本分析，且只盖 `Bash`。`x=/etc/passwd; rm $x` 这类绕得过去
  —— 它是给手滑与误操作加的一道闸，不是反对抗手段，所以**不是"可以放开权限"的理由**。
- **没有路径围栏**：工具能碰到你进程权限内的任何路径，不限工作目录 —— 别在装着重要东西的机器上放它乱跑。
- **子代理不继承指令文件**：`AGENTS.md` / `CLAUDE.md` 一个字都不进它的系统提示（**刻意**的硬隔离），
  代价是它不知道项目规矩 —— 要它守的规矩得写进那个 agent 文件或 `prompt` 里。
- **中断只杀外壳**：Windows 上 `Bash` 经 `cmd.exe` 起命令，`Ctrl-C` 掐断的是这层外壳，
  下面的孙进程可能继续残留。
- **账本里的数字全是估的**，工具那一行尤其粗 —— 够用是因为它要的是"离阈值还有多远"这个量级，
  但别拿它当账单核。
- **没有整屏 TUI、没有语法高亮，也没有后台工作**：界面是逐行的纯文本流；一轮跑完就是跑完，
  子代理是**同步**交回结果的（不是句柄）。

## 开发

```bash
pnpm typecheck   # 类型检查
pnpm lint        # 两个检查：依赖边界 + 工作流硬化
pnpm test        # 测试，84 个文件 1341 个用例
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
工具表：模型看得见的工具清单来自注册面上 `tool.call` 的 matcher 取值，再过白名单与 `hidden` 两道
（`core/tool-list.ts` 是这**一份清单的唯一算法** —— 模型、`/help`、`/context` 三个消费者共用它）。
图与各层允许 import 谁，
见 [官网的「架构」一节](site/index.html#architecture)。

## 设计文档

- 项目简介（一页纸，给第一次听说的人）：[`site/项目简介.md`](site/项目简介.md)
- 已知限制（做不到什么、哪些数是猜的）：[`site/已知限制.md`](site/已知限制.md)
- 变更记录（每个阶段的范围 / 出口标准 / 偏差索引）：[`CHANGELOG.md`](CHANGELOG.md)
- **设计文档**（一个阶段一份，`mvp` 起、P2–P10 逐份）：[`docs/superpowers/specs/`](docs/superpowers/specs/)
- **实施计划**（与设计一一对应）：[`docs/superpowers/plans/`](docs/superpowers/plans/)
- 架构参考（我们对着读了什么）：`docs/claude-code-架构分析/`

官网产物是 `site/` 里的 `index.html` / `docs.html` / `style.css` / `main.js` 与两张图，
拷到任意静态主机即可（无构建步骤，页面里没有绝对路径）。同目录另有三篇 `.md`
（`项目简介` / `已知限制` / `简历亮点与答辩`）—— 它们与页面是配套的，不进产物。
`site/` 不在 `tsconfig.json` 的 `include` 里，也不被脚本扫描，对上面四条命令零影响。
