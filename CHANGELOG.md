# 变更记录

这份文件**不是**从代码生成的变更日志。它是一份**史实**：每个阶段做了什么、拿什么判定
"做够了"、以及**在哪几处偏离了上位文档**——每条偏离都给出它在哪份文档的第几行。

## 怎么读

- **一行一个阶段**，不是一行一次提交。提交史在 `git log` 里，这里不重抄。
- 每个阶段三样东西：**范围**（实际交付了什么）、**出口标准**（拿什么判定做够了）、
  **偏差索引**（哪几处与上位文档不一致，逐条给 `文件:行`）。
- 范围只写**已经能验证的东西**：文档里这么写了、代码在那儿、测试盖住了。
  不写"改进""优化""增强"——那些词没有判据，写进来只会让这份文件失去作用。
- 偏差是**两份**：设计阶段**预登记**的（写设计时就知道会偏离），与施工阶段**实际发生**的
  （写代码时才发现设计做不到）。两者分开写，因为它们的成因完全不同。
- 一律用相对路径，且**行号是写下这一行时的行号** —— 文档改过之后它会漂。要看内容以章节号为准。

## 总表

| 阶段 | 范围 | 出口标准 | 偏差 |
| --- | --- | --- | --- |
| MVP | 契约、内核链、两个 provider、六个工具、最小确认、REPL | `mvp-design.md:375` | `mvp-design.md:465` |
| P1 会话与体验 | 落盘与 `--resume`、OpenAI 兼容、`/diff`、表现原语 | `p1-design.md:9`、`mvp-design.md:449` | 无独立小节（见下） |
| P2 安全与策略 | 五层来源、规则内核、`sec-default`、`/permissions` | `mvp-design.md:450` | `p2-design.md:407` |
| P3 扩展面 | `plugin.json` 校验、目录发现与装载、准入闸门、classic 桥 | `mvp-design.md:451` | `p3-design.md:542` |
| P4a 组合面 | 子代理与技能 | `p4a-design.md:35` | `p4a-design.md:872` |
| P4b 上下文与边界 | 沙箱（仅 Bash）、压缩、嵌套 `AGENTS.md` | `p4b-design.md:40` | `p4b-design.md:492` |
| P4c-1 分发 | marketplace 与安装 | `p4c-design.md:68`（自定） | `p4c-design.md:402` |
| P4c-2 治理 | hookify、`config.*`、`command.describe` | `p4c2-design.md:85`（自定） | `p4c2-design.md:394` |
| P4d 可观测与 prompt | `prompt.*`、classic 桥扩到六个、遥测 | `p4d-design.md:35`（自定） | `p4d-design.md:443` |
| P4e 工程化 | CI、边界扩到 `plugins/`、工作流硬化校验器 | `p4e-design.md:43` | `p4e-design.md:251` |
| P5a 内建 mod 平台 | 四个 mod 进 `mods/`、装载器、边界规则 | `p5-design.md:34` 第 1、2 条 | `p5-design.md:306`–`310` |
| P5b 指令文件五层 | 五层优先级 + 托管下发 | 同上 | 同上 |
| P5c diff 分屏 | 内建 mod `diff` 拿到第一份真的可选依赖 | 同上 | 同上 |
| P5d 托管推送与分发面 | MDM 三通道、gateway 接入面、CI 硬化三件套 | `mvp-design.md:451`、`p5-design.md:34` 第 3 条 | `p5d.md` §4 |
| P6a 活动面 | 五种活动行、结果摘要截断、`warnLine` 缺陷 | `p6-design.md:44` | `p6-design.md:311` §8.1 |
| P6b 内容面 | markdown 子集、按行缓冲的流式、折行 | `p6-design.md:45` | 同上 |
| P6c 改动面 | 一份账两个消费者、确认框预览、`+N −M` | `p6-design.md:46` | 同上 |
| P6d 输入面 | 行队列（空窗）、去抖、历史、补全、续行 | `p6-design.md:47` | 同上 |

每条分支的合并：`#1 p3-plugins`、`#2 p4a-subagents`、`#3 p4b-context-boundaries`、
`#4 p4e-engineering`、`#5 p4c-marketplace`、`#6 p4d-prompt-telemetry`、`#7 p5-builtins`、
`#10 p6-design`、`#11 p6a-activity`、`#12 p6b-content`、`#13 p6c-changes`（P6c + P6d 同一条）、`#14 p6d-banner`（收口后补的开场那一屏）、`#16 p6d-banner-fix`（那一屏第一版没画出来）、`#17 readme-site-trim`（README 与官网重写）、
`#19 site-centered-topo`（置中版式 + 拓扑图第一版）、`#20 site-topo-svg`（那版图还是文字，改成 SVG）、
`#21 site-topo-overlap`（连线把标题划穿了）。

---

## MVP

**范围**：`contract/`（39 个事件冻结）、内核链（tier 权威序、`next` 续体、故障隔离）、
Anthropic 与 OpenAI 兼容两个 provider、六个内建工具、最小 y/N 确认器、REPL 与一次性模式。

**出口标准**（`mvp-design.md:375`）：跑一次真实会话看完闭环；顺手验三件事（Ctrl-C 中断 Bash、
非 TTY 下写入被拒、`tool.check` 无人应答是 deny）；`pnpm test` 与 `pnpm lint` 一次全绿。

**预登记偏差**（`mvp-design.md:465`）：

| # | 行 | 偏离 |
| --- | --- | --- |
| 1 | :469 | 渲染不走 `ui.render`，cli 层直接写 stdout |
| 2 | :470 | 单包不拆 workspaces |
| 3 | :471 | `settings` 名词不实现 |
| 4 | :472 | 工具清单硬编码在 `builtins/`，不走插件发现 |
| 5 | :473 | `$` 的名词是直接实现，不是事件（连带：P2 之前拦不住最内层） |
| 6 | :474 | 不用 ESLint |
| 7 | :475 | `engine.create` 的折叠是空转的（P3 部分收口，见 `p3-design.md:568`） |

**施工期发现的缺陷**（`mvp-design.md:483`、`:487`：工具结果拆成多条消息、模型 id 无校验），
两条都在 P1 修掉，修法记在各条之下。

---

## P1 会话与体验

**范围**：会话落盘（JSONL，用户级）+ `--resume` / `--resume=<id>`；OpenAI 兼容 provider；
`/diff` 与本会话改动记录；ANSI 调色板与单行 spinner；同一轮多个工具结果合并成一条消息；
模型 id 形状校验与 404 翻译；`ui.*` 八个事件只钉形状不实现；`/clear`。

**出口标准**（`p1-design.md:9`，照抄 `mvp-design.md:449`）：重启后能接着上次会话；
TUI 下 `/diff` 看得见本会话改动；OpenAI 兼容 provider 用配置切换可用。

**偏差**：P1 没有独立的偏差小节——本轮没有偏离上位文档，两处施工期修正
（工具结果合并、模型 id 校验）修的是 MVP §10 已登记的缺陷本身。明确不做的清单在
`p1-design.md:392`（TodoWrite / WebFetch / WebSearch、任何运行时依赖、任何自动放行开关）。

---

## P2 安全与策略

**范围**：权限规则内核（解析、匹配、固定优先级 `deny > ask > allow`）；五层设置来源
（user / project / local / flag / policy，**刻意没有环境变量层**）；`permissions` 插件与
`sec-default` 守门器；`--settings=<路径>`；`/permissions` 可审计输出；工具可见性按权限过滤。

**出口标准**（`mvp-design.md:450`）：个人插件无法放宽组织策略；每个判定路径都有明确的失败行为；
deny 结果携带规则名。**第三条里的"决策可重放"未实现** —— 见偏差 1。

**预登记偏差**（`p2-design.md:407`）：

| # | 行 | 偏离 |
| --- | --- | --- |
| 1 | :411 | **不做 deny 重放**。改由 `sec-default` 直接把策略裁决拿在手里 |
| 2 | :414 | `sec-default` 不读 `$.settings.read`，规则在启动期注入 |
| 3 | :416 | `tool.check` 的规则由插件求值，不是内核 |
| 4 | :418 | 不做 `PermissionUpdate`（`/allow` 式写回 settings）——本轮最大的便利性缺口 |
| 5 | :420 | `/help` 不反映工具隐藏 |
| 6 | :422 | 策略层没有环境变量来源（托管策略只能来自文件） |

**存疑**（本设计拍板、上位文档说不清）：`:426` 工具可见性的原始语义、`:427` `*` 与 `:*` 的差别、
`:428` 多条规则同时命中谁赢。

---

## P3 扩展面

**范围**：`plugin.json` 校验器（E1–E14 / W1–W10）与 `plugin validate` / `plugin list`；
插件目录的发现与装载（发现不执行代码、装载才 `import`）；`plugin.register` 从空壳变成准入闸门；
classic hooks 的桥（3 个事件）；第三方插件的能力上限在**结构上**钉死（座位强制 `append`、
`allow` 一律剥掉、`uses` 越界整个插件不装）。

**出口标准**（`mvp-design.md:451`）：不改引擎的插件能扩展出新能力（`plugins/todo` 加出 `TodoWrite`，
`src/` 里 grep 不到这个名字）；`plugin validate` 能拦住坏清单；classic hook 的 `exit 2` 真能阻断。

**预登记偏差**（`p3-design.md:542`）：不拆 workspaces（`:553`）、不做 MCP 桥接（`:546`）、
不做 `ui.render` 数据树（`:549`，连带 `additionalContext` / `updatedInput` 没有着陆点）、
classic 钩子只桥 3 个且 `exit 1` 也 deny（`:557`）、串行执行（`:560`）、
`plugin.json` 在插件根（`:561`）、第三方 `allow` 被剥掉（`:565`）、第三方不能扩展 `$`（`:568`）、
`uses` 只在事件层面校验（`:571`）、`validate` 的测试用 `mkdtemp` 现造目录（`:575`）。

**计划期纠正**（写计划时发现设计稿有错，改的是设计稿）：§4.4 的包装判定是个绕过路径（`:581`）、
补一条 W10（`:585`）、E12 里引用的 `W12` 是笔误（`:587`）。

**明确不做**：`p3-design.md:602`。

---

## P4 组合面

P4 在路线图里横跨十一个工作面，拆成五片各走一轮设计 → 计划 → 验收。

### P4a 子代理与技能

**范围**：`agents/*.md` 与 `skills/*.md` 的发现与解析、`Task` 与 `Skill` 两个工具、
工具白名单、`agent.offer` 拼进 system prompt、子上下文隔离、模型分层。

**出口标准**（`p4a-design.md:35`）：六项逐项落点，含"各删一处白名单检查各红一条"的反向验证。

**计划期纠正**（`p4a-design.md:874`）：`confirm` 会把 `Task` / `Skill` 当未知工具拒掉（`:876`）、
`skill.prompt` 没人派得动（`:879`）、`LoopContext` 是三个可选字段（`:882`）、
`agent.offer` 的条目要带 `tools`（`:885`）、`SkillSpec` 要带 `dir`（`:887`）、
逗号切分不能放在通用 frontmatter 解析器里（`:889`）。

**偏差**（`p4a-design.md:893`）：`:895`–`:906` 八条，`agent.offer` 一次问链拿整张表、
不新增第 40 个事件、`agent.spawn` 只通知不可改写、`Task` 不吃 `description`、
`AgentSpec` 只收 7 个字段、省略 `tools` = 全权、子代理内部的 `$.tool.list()` 仍是全部工具、
`agent.offer` 由 `main.ts` 派一次。存疑三条在 `:911`–`:915`。

### P4b 上下文与执行边界

**范围**：沙箱（**仅 Bash**，只在这一层）、上下文压缩（`session.compact` 转正）、
`AGENTS.md` 惰性嵌套与双层去重。

**出口标准**（`p4b-design.md:40`）：沙箱含一条**副作用验证**（真起一条本该写文件的命令，
断言文件根本没被创建）；压缩含持久化游标不错位；嵌套含跨层去重。

**偏差**（`p4b-design.md:492`）：沙箱**不是 OS 隔离**（`:494`，本设计里最大的一处"我们做不到"）、
`atTokens` 默认值是猜的（`:496`）、"字符 ÷ 4"只是估计（`:497`）、候选路径提取没有基准（`:499`）、
"一个文件一次会话只附一次"以插件实例为界（`:501`）。

**明确不做**：`p4b-design.md:507`（`dangerouslyDisableSandbox`、
`sandbox.autoAllowBashIfSandboxed` —— 两个都是放行开关，与既有的那条线正面冲突）。

### P4c-1 分发

**范围**：marketplace 索引的纯校验器、落点 `~/.deepcode/installed/`、`plugin add` / `remove`
（落盘原子、目标已存在就拒绝）、`plugin list` 的落点一节、装载与安装分开。

**出口标准**（`p4c-design.md:68`，自定）：干净 HOME 上一条 `plugin add` 装好而**它不跑**，
写一行**用户级**设置之后才跑；同一个名字写在**项目级**里必须仍然不跑。

**偏差**（`p4c-design.md:402`）：本轮只兑现"分发"没兑现"治理"（`:404`）、
`enableByUser` 是本设计新造的不对称（`:407`）、索引里的名字必须 kebab-case（`:411`）、
落点名与 origin 名相同（`:414`）、一处被核掉的错误直觉（`:417`）。

### P4c-2 治理

**范围**：hookify（一份规则文件就是一个 hook，不改内核）、`config.describe` / `config.set`
与 `/config`、`command.describe` 转正（`/help` 从一列名字变成名字加一句话）。

**出口标准**（`p4c2-design.md:85`，自定）：C1 纯单元，C2 端到端（真起钩子进程拦下一次真 `Write`；
`config set model` 真落盘再被下一次 `loadConfig` 读回）。

**偏差**（`p4c2-design.md:394`）：推翻了 P4c-1 的拆分（`:396`）、hookify 的失败方向会挡住一切（`:401`）、
DSL 语法是我们自己定的（`:404`）、`field` 只取字符串（`:408`）、`config.set` 只认 `model`（`:410`）、
`/help` 的输出形状变了且**此前一个测试都没有**（`:412`）、`CommandDescription` 是三态而不是二态（`:423`）、
hookify 只挂 `PreToolUse`（`:427`）。

### P4d 可观测与 prompt

**范围**：`prompt.submit` / `prompt.section` 与一份 `context` 的三个落点；classic 桥 3 → 6；
hookify 扩到四个事件且逐事件只有它能兑现的词汇；`$.telemetry` 与零自由文本行协议。

**出口标准**（`p4d-design.md:35`，自定）：五条，都可验。第 4 条是"遥测关掉时零输出——
不建目录、不开文件、不写一行、不吭一声"。

**偏差**（`p4d-design.md:443`）：`:445`–`:459` 九条，含 `prompt.*` 另外六个事件仍未实现、
清单没走 `prompt.section`、`PostToolUseFailure` 不桥、遥测不做网络采集器与轮转、
遥测行的时间戳与序号由内核生成、节序规则只有一个使用者、`$.telemetry` 是插件提供的名词、
hookify 的 `event` 字段是新加的、一次性模式忽略 `handled`。

**明确不做**：`p4d-design.md:466`，最大的一条是 D3 多 surface —— 理由写得很直白：
**零消费者**，为它写实现就是把一个猜出来的数据树冻进契约。

### P4e 工程化

**范围**：GitHub Actions 跑 `typecheck` / `lint` / `test`（动作钉 SHA、最小 `permissions`）；
边界检查扩到 `plugins/`；`scripts/check-workflow-hardening.mjs`（H1–H4）；
`plugin validate` 进流水线。

**出口标准**（`p4e-design.md:43`）：把新增的每条规则故意弄坏一次，看它是否真的红。

**偏差**（`p4e-design.md:251`）：硬化规则的**对象**不同（约束我们自己的工作流卫生，
不是约束 CI 里的 agent）、不做豁免表、校验器用 Node `.mjs` 而不是 Python。
存疑三条在 `:263`–`:267`。

---

## P5 内建与分发

**出口标准**（`p5-design.md:34`）：三个内建 mod 各自测试套件全绿；可选依赖缺失时主流程无损；
CI 里 workflow 硬化校验器能在漏配 firewall runner 时让流水线失败。

**预登记偏差**（`p5-design.md:304`）：搬目录会碰到几乎每一个测试文件的相对路径（`:306`）、
`sec-default` 归位动的是 P2 的承重墙（`:307`）、`TelemetryPolicy` 挪进契约会动 `settings.ts`
的公开面（`:308`）、`mods/` 进 `tsconfig` 的 include（`:309`）、
若某个 mod 绕不开 `cli/` 的依赖**不削规则**（`:310`）。

### P5a 内建 mod 平台

**范围**：四个内建 mod 住进 `mods/`；`src/contract/mod.ts`；`sec-default` 归位（纯物理移动、
行为零变化）；边界规则（mod 只许 import `node:` 内建 + `src/contract/**` + 自身目录）；
装载器 `src/cli/mods.ts` 与"探针失败 → 降级，绝不阻塞启动"。

**检验记录**：`docs/superpowers/plans/2026-10-11-deepcode-p5a.md`（三个检查点）。

### P5b 指令文件五层优先级

**范围**：托管下发的指令段（**只有托管层能写**，其余四层写了整项丢弃并出声）；
mod 改成五层读取。

**刻意不做**：`2026-10-11-deepcode-p5b.md:198`。

### P5c diff 分屏

**范围**：`/diff` 的两块所有权——`[本会话改动]` 归 CLI，`[工作区未提交]` 归内建 mod `diff`；
渲染器注入（mod 不认识 `Palette`）；`git` 是这一片拿到的**第一份真的可选依赖**。

**刻意不做**：`2026-10-11-deepcode-p5c.md:461`。

### P5d 托管推送（MDM）+ 分发面 + CI 硬化三件套

**范围**：托管策略的三条通道（macOS 托管偏好域 / Windows 注册表 / 平台默认文件，
外加既有的 `DEEPCODE_MANAGED_SETTINGS`），归一在**文本**层；gateway 接入面
（托管层能钉死 `baseUrl` / `model`，个人层改不动）；本文件；CI 硬化规则扩到七条与一个
真的 agent job。

**刻意不做**：`2026-10-11-deepcode-p5d.md:404`——不拆 workspaces（预登记偏差）、
不改 `private: true`、不碰 `LICENSE`、不做 ADMX、不做网关服务端、不做豁免表、
不做二进制 plist、不在真机上验 MDM。

---

## P6 界面与交互

**出口标准**（`p6-design.md:42` §1，四条）：终端看得见每个工具的开始 / 结束 / 耗时 / 结果摘要，
且管道出去逐字节与 P6 之前相同；工具结果在终端被截断、回给模型的是完整原文（两条断言同时存在）；
这一阶段 `src/core/**` 没有行为改动（UI 是插件不是内核）；`NO_COLOR` / `TERM=dumb` /
拿不到宽度时全部降级为人话，不留残缺框线。

**预登记偏差**（`p6-design.md:311` §8）：终端能力探测不可靠、Windows 上的光标上移、
粘贴去抖窗口做不到可靠区分就退回按行提交、流式 markdown 的未闭合围栏与多字节边界、
改 `render.ts` 会动到既有逐字节断言、活动区与 readline 抢终端、可能逼出一处内核改动。
**七条里只有第 7 条没发生**（`src/core/**` 全程零改动），其余按各自的退路走。

**实际发生的偏差**（`p6-design.md` §8.1，五条，逐条带理由）：`agent.spawn` 没有专门的处理器
（那半对事件不齐，由 `Task` 的动作行覆盖）、代码块超宽时不截断（偏离 §4.3，保真优先）、
`（估）` 一路带到退出摘要（往严的一侧偏）、非交互下不画提示符（管道那头没有人在等）、
readline 的历史里同时也记下确认时的 `y`（与 shell 一致，不另记一本账）。

### P6a 活动面

**范围**：`cli/activity.ts`（`tool.check` / `tool.call` / `turn.start` / `turn.complete` /
`session.compact` 的观察者）、`cli/render.ts` 的活动区与 `settle`、结果摘要的截断、
`cli/width.ts`（宽 / 窄 / 零宽三档）、`main.ts` 的 `warnLine` 缺陷（警告曾经绕过渲染器、
粘在 spinner 那半行后面）。

### P6b 内容面

**范围**：`cli/markdown.ts` 的 markdown 子集与 `wrap()`（中文算 2 列）、按行缓冲的流式
（未闭合围栏是途中常态）、`render.delta` 只走 TTY 一侧 —— 非 TTY 下 `delta` 逐字节不变。

### P6c 改动面

**范围**：`cli/tally.ts`（会话账本，**一份两个消费者**：每轮摘要与退出摘要）、
`cli/preview-view.ts`（确认框那一屏从 `builtins/confirm.ts` 搬出来 —— 边界规则不许
`builtins/` import `Palette`）、`diff-render.ts` 的 `changeStat`（`+N −M` 与 `/diff`
同一份数据）、退出那一屏（干了多少 / 改了哪些 / 转录在哪儿）。

### P6d 输入面

**范围**：`cli/input.ts`（行队列补上启动空窗、30ms 去抖、`/`-命令就地切开、`\` 续行、
`/` 与 `@` 补全）、`cli/history.ts`（`~/.deepcode/history`，与 transcript 同一套安全规矩：
用户级 home、0600）、`repl.ts` 重写；收口后又补了 `cli/banner.ts`（开场那一屏：版本 /
模型与端点 / 工作区 / 会话 id，**只在真终端里画**，管道下一个字节都不产出）。

**顺带修掉的既有欠账**：README「已知限制」里那条**「非 TTY 下 REPL 收不到输入」**
（`echo '/diff' | deepcode` 无效）—— 修了，所以从三份文档里删掉，不是改成"解释了"。

**⚠️ 合并之后才逮出来的真 bug**：开场那一屏**整屏没画出来**。判据写成
`oneShot === undefined`，而 `parseArgs` 在没有提示词时给的是**空串** —— `if` 恒假，
九条测试却全绿（测的是 `banner()` 本身，没一条问"到底画不画"）。用户在自己机器上开
`deepcode` 看到光秃秃一个 `>` 才发现。修法是把这一问提成 `shouldShowBanner(text,
interactive)`，并把"`parseArgs([]).text` 就是空串"也钉一条测试。详见 `p6-design.md` §8.1 第 6 条。

**刻意不做**：`p6-design.md:293` §7 —— 全屏 alternate screen、语法高亮、鼠标、`ui.render`
数据树、多 surface、进度条、表格渲染、主题系统、打字机动画、任何形态的自动放行开关、没接上的 `esc` 键。

---

## 文档重写：README 与官网（`#17`）

**范围**：`README.md`（758 → 416 行）、`site/index.html`（563 → 519 → **337** 行）。
两者都从"解释为什么"改成"说清怎么用 / 亮出设计"。

官网第一版改完仍然琐碎，所以又砍一轮：去掉纯 CSS 标签页与那份 `/permissions` 输出样张
（权限压成「五个来源一行 + 规则表四行 + 一段实话」），去掉「工程质量」整节（三个数字并进
首屏的统计条），路线图从时间轴改成一张表，已知限制卡 10 → 6（完整清单指回 README）。
`style.css` 跟着瘦了 42 行 —— 标签页、时间轴、`.ticks` 那些只服务被删区块的规则一并清掉，
不留死样式。

**README** 只留四件事：**安装 / 启动 / 会话里怎么用**，加上一份「已知限制」。
深水区（MDM 三通道的注册表类型映射、遥测事件字段表、工作流硬化 H1–H7、
`hookify` 算子全表、内建 mod 的探针口径）本来就在各阶段的设计文档里，README 不再重抄一遍，
改成一句话加一个指路。

**官网**去掉了解释性的整节（「为什么再写一个」），把版面让给设计本身：
新增两处架构可视化 —— **运行时**的 tier 权威序，与**构建时**的目录分层
（`contract` / `core` / `providers` / `builtins` / `cli` / `mods` / `plugins`，谁许 import 谁）
加一张「八个工具，一条接口」的实现位置表。旧版那条 4 行的路线图长段落压成一两句，
「亮点」从 8 张卡收到 6 张（反向验证并进「工程质量」）。

**这一改没有动任何事实**：页面上每个数字仍能追到 README 或设计文档；
`site/` 依然零外部请求、`file://` 下完整可用、关掉 JS 也完整。

### 官网第二版：置中版式 + 架构拓扑（`#19`）

**版式**改成以**置中**为主：首屏、各级标题、导语、卡片、演示要点都是居中一栏。
长段落、代码块、表格仍然左对齐 —— 整段中文居中会让每行起点都不一样，读起来是受刑。

**架构一节换成一张拓扑图**（`site/index.html` 的 `.topo`），三条横带各答一个问题：

| 带 | 答的问题 | 内容 |
| --- | --- | --- |
| 执行链路 | 一次调用怎么走 | 终端 → 提示词 → `engine.dispatch`（每个调用点抛事件）→ tier 链 → 工具 / 模型 |
| 安全闸门 | 谁在哪儿把关 | 工具调用 → `tool.check`（y/N）→ `sandbox` 路径闸 → `spawn` / 写盘，附 fail-closed 三条 |
| 记忆与上下文 | 记在哪、怎么接上 | 指令五层、转录 JSONL（用户级 0600 → `--resume`）、输入历史、`/compact` |

用 HTML + CSS 画而不是 SVG：文字是真文字（能选中、能搜、读屏认得），窄屏自己换行，
也就不用往页面里塞几何代码。这张图**替掉了原来的 tier 列表**（同样的信息，一处讲清），
所以页面没有因此变长。

### 官网第三版：拓扑图改成真的画出来（`#20`）

**上一版做错了，这里记下来**。`#19` 那张"拓扑图"是三条横带、每条一行方框、方框之间夹
`→` 字符 —— 排版上确实像流程图，但用户一眼就看穿了：**它还是文字**。原话
「怎么你说的拓扑图只有这些文字描述？」。当时的理由（文字可选中、可搜、读屏认得）没
错，错在拿它当了图 —— 一张图要能一眼看出**谁连着谁、哪条线是回头路**，而字符箭头做
不到这件事。

改成**内联 SVG**（`site/index.html` 里的 `<svg class="topo" viewBox="0 0 1024 580">`，
21 个矩形）：

| 带 | 画了什么 |
| --- | --- |
| 执行链路 | 终端 → `engine.dispatch` → **tier 链**（五个小格 prepend/user/append/builtin/core）→ `provider`；`AGENTS.md × 5 层` 单独接到 `provider` |
| 安全闸门 | 工具 ×8 → `tool.check`（等一行 y/N）→ `sandbox`（Bash 路径闸）→ `spawn` / 写盘 |
| 记忆与上下文 | 转录 JSONL（用户级 · 0600）、输入历史、遥测、上下文压缩 |

带与带之间是**三条真的线**，不是箭头字符：链尾实线进工具；`tool.check` 的 `deny` 用琥珀
虚线**折回链上**（模型重新决定）；转录经 `--resume` 用墨绿虚线**绕右外边距**回到请求路径
（走外边距是为了不与任何框相交 —— 拐三次，零交叉）。带内的小格用 `marker` 画箭头，
`<title>` / `<desc>` 给读屏，图下保留原来那两行实话（fail-closed 三条 + 指令五层里只有
托管层能写）。窄屏不缩：`min-width: 880px` + `overflow-x: auto`，另加一句"左右滑动查看"。

**事实一条没变**：图的每个框里的字仍能追到 README 或设计文档，一个数字都没编。
页面 337 → 454 行、css 296 → 318 行（多出来的就是几何），旧的 `.topo__` 组件名全删。

### 官网第四版：图上有一处**压线**（`#21`）

用户反馈「拓扑图有点问题，好像渲染出错了」。查下来是**真的画错了**：从 tier 链下来、
折进「工具 ×8」的那条连线，竖直段在 x=130 —— 而「安全闸门 · 工具调用必经」那行字从
x=34 一直写到 x≈192，**那条线正好从字中间划过去**，像给标题加了一道删除线。右侧竖排的
「转录 → --resume 接回会话」也离墨绿虚线太近，看着像是粘在线上。

**上一轮为什么没发现**：那一轮验的是 HTML 结构（标签配平、class 对账、无外链），后来
虽然拍了 PNG，也没看出那条线是错的 —— 缩略图里它像一条下划线。**看结构看不出压线，得量。**

**修法**：把那条带的标题拆成两行（「安全闸门」/「工具调用必经」，最长到 x≈97），文字给图
让路，连线回到最短路径（tier 链正下方直落 → 工具正上方）。竖排注释与虚线拉开：viewBox
从 `1024×580` 拓到 `1060×580`。

**验法换了**：不再按 class 估字宽，改成用 headless Chrome 打开图，对每个 `<text>` 取
`getBoundingClientRect()`，对每条 `<path>` 沿弧长取点成折线，逐段与文字盒子求交 ——
线段盒子必须先按线宽撑开，否则竖直线的盒子宽为 0，面积恒为 0，永远测不出压线（第一版
检查器正是栽在这里，报了「没有压线」）。换对之后一次就逮到了那处。
