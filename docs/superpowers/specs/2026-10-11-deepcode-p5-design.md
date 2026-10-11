# DeepCode —— P5 设计（内建与分发）总纲

> 施工说明书。上位文档是 [`2026-10-11-deepcode-mvp-design.md`](2026-10-11-deepcode-mvp-design.md) §9
> （出口标准 §9.3:451、明确不做 §9.4:455-460、模块矩阵 §9.2:397-410）。
> 同体例的先例是 [`2026-10-11-deepcode-p4d-design.md`](2026-10-11-deepcode-p4d-design.md)。
>
> **本文是总纲**：定 P5 的四片切法、每片的设计要点与判据、以及出口标准怎么逐条落。
> 每片执行前把它细化成自己的实施计划（`docs/superpowers/plans/2026-10-11-deepcode-p5X.md`）；
> 某片的要点若已在本文够用，就直接进计划，不再单写 spec —— 少一份文档，判断力不靠文档数量。

**一句话**：P4 把引擎长成了一个**可以被扩展**的东西，P5 让这些扩展**变成一个个独立的、能被单独测试、能被单独拿走、缺了也不塌的单元** —— 并把它们分出去。

---

## 0. 决策摘要

| # | 决策 | 一句话理由 |
| --- | --- | --- |
| 1 | 切四片：**P5a 内建 mod 平台 → P5b 指令文件五层 + 托管下发 → P5c diff 分屏 → P5d 托管推送 + 分发面 + CI 三件套** | 平台先立（出口标准前两条本身就是平台性质的要求），功能面随后，分发最后 —— 与 MVP §9.1 那三条硬约束同一条道理：**没有单元，就没有单元的分发** |
| 2 | "内建 mod" = `mods/` 下的**四个**：`diff` / `telemetry` / `agents-md` / `sec-default`。§9.3 出口标准里的"三个"指 **P5 这一阶段负责收口的那三个**（diff / telemetry / agents-md） | 两处口径对得上，顺带把仓库里"四个内建 mod vs 三个内建 mod"这条**已知漂移**判掉（见 §2） |
| 3 | mod 的**物理位置**是 `mods/<name>/`，不是 `src/cli/` 里的一堆文件 | P3 偏差 3 把"物理分离"排到 P5，理由写的是"要发布的时候才值钱"。现在就是那个时候（§3.1） |
| 4 | 边界规则：`mods/<name>/**` **只许 import `src/contract/`**（加 `node:` 与自身目录内的相对路径） | 这是 README 那句"内建工具不是特例""内建与第三方走同一条接口"从**口号**变成**lint 强制**的那一步。它的副作用比正作用还值钱：diff 因此只能产出**数据**，渲染必须留在 cli（§3.2） |
| 5 | "可选依赖缺失时主流程无损"拆成两半：P5a 交**机制**（探针 + 降级 + 可见报告 + 夹具测试），P5c 交**第一个真依赖**（`git`） | P5a 迁进来的两个 mod 都不依赖外部东西；在 P5a 就宣称这条出口标准已兑现，是假账 |
| 6 | 缺 mod **不等于**静默失效：缺了什么要在启动时说一句、并有一处可查 | 安静的失效是这个项目最想防的失败形状（`src/builtins/instructions.ts` 顶部那段是同一条） |
| 7 | 座位与顺序**仍由 CLI 钉**，mod 不自述权威 | P2/P3 已经立过的规矩（`core/create.ts` 的 `seating` / `thirdParty`）。mod 化不是把这条还回去 |
| 8 | 单 surface 下"分屏"落成一个**定宽 pane 块**，不做 TUI、不做实时重绘 | 我们只有一个 surface。照抄三栏布局会造出一个今天没人看得见、明天还得改的形状（与 P4d 缓下 D3 同一条判定） |
| 9 | 托管推送做**三个真实通道**（plist / 注册表 / `/etc`），不做 ADMX 模板 | ADMX 是给组策略管理界面用的**描述文件**，没有它注册表那条照样生效；多写一份 XML 等于多一份没人用的产物 |
| 10 | `LICENSE` 与是否 `private: true` **是用户的决定**，本轮只把它变成一句明确的话与一次记录 | P4e 已经把这条写成"许可证没定下来就发不了"。我不能替用户选许可证 |
| 11 | 桌面 / IDE 客户端**不建**；Agent SDK 只出一个**受支持的入口**（`src/sdk.ts` + 一条嵌入式宿主的测试） | §9.4 已经说了 UI 只到多 surface 抽象层。一个没有消费者的客户端是"做一半的隔离"的同族 |
| 12 | 每片各自 plan、**验收按检查点批量做**，任务级只要求 `pnpm typecheck` | 用户的长期指令（一次校验多个任务、快速完成开发），P2/P4 都是这么走的 |

---

## 1. 出口标准怎么落

§9.3:451 只给了三条，逐条指到片：

| 出口标准（原文） | 落在哪片 | 怎么验（可执行的判据） |
| --- | --- | --- |
| **三个内建 mod 全部通过各自测试套件** | P5a（`telemetry` / `agents-md`）+ P5c（`diff`） | 三个目录各有 `mods/<name>/test/`；`pnpm vitest run mods/<name>` 各自绿；全仓 `pnpm test` 仍绿 |
| **可选依赖缺失时主流程无损** | P5a（机制）+ P5c（`git` 这个真依赖） | P5a：一个"探针永远失败"的夹具 mod 装上去，CLI 照起、其它 mod 全在、缺的那件事有一句人话；P5c：把 `git` 从 PATH 里拿掉，`/diff` 降级、其余一切照常 |
| **CI 里 workflow 硬化校验器能在漏配 firewall runner 时让流水线失败** | P5d | 先让 CI 里真有一个**调用 agent 的 job**（否则那条规则没有约束对象，见 §6.3），再故意删掉它的 firewall runner 配置，看流水线红 |

**为什么第一条要按"各自绿"而不是"全仓绿"**：全仓绿只证明"这三个 mod 的测试**恰好**还在那一堆测试里"。`mvn` 一条命令跑全套与"每个单元能被单独验"是两种不同的能力 —— 后者才是"单元"二字的意思，也是 P5d 拆包的前置。

---

## 2. 口径：什么叫"内建 mod"

仓库里这条漂移已经存在一段时间了，本轮判掉：

- `claude-code-架构分析/00-overview.md:15,183` 写的是 **四个**：`mods/{diff,telemetry,agents-md,sec-default}/`。
- `mvp-design.md:451`（P5 出口标准）写的是 **三个内建 mod**。
- `docs/项目简介.md:85` 与 `site/index.html` 跟着写"三个"。

**判定**：这两个数字都对，指的不是同一件事。

| 说法 | 指什么 |
| --- | --- |
| **四个** | `mods/` 下那一组的内建 mod 全集：`diff` / `telemetry` / `agents-md` / `sec-default` |
| **三个** | §9.2 矩阵里「内建 mod」那一格**在 P5 还剩的三个** —— `sec-default` 在 P2 就已经交付（§9.2 权限安全格里那个"`sec-default` 守门器"），它不算 P5 的欠账 |

本轮之后，`docs/项目简介.md`、`site/index.html`、README 里的这句话统一改成：
**「四个内建 mod（`diff` / `telemetry` / `agents-md` / `sec-default`），P5 收口其中三个」**。

---

## 3. P5a 内建 mod 平台

### 3.1 目录：为什么是物理的 `mods/`

```
mods/
  telemetry/    index.ts  test/*.test.ts  README.md
  agents-md/    index.ts  test/*.test.ts  README.md
  sec-default/  index.ts  test/*.test.ts  README.md   ← 只归位，行为零变化
  diff/         index.ts  test/*.test.ts  README.md   ← P5c 才搬进来
```

三条理由，缺一条这个移动就不值：

1. **它是 P5d 拆包的唯一自然单元**。P3 偏差 3 把物理分离排到 P5，原话是"物理分离真正值钱的时候是'要发布'的时候，那是 P5 的安装面"。现在到了，那就别在最后一步临时搬 —— 要搬的东西在 P5a 就摆对位置。
2. **"各自通过测试套件"需要一个"各自"**。测试文件跟着源码走，`mods/<name>/test/` 与 `src/../test/` 的区别就是"这个单元可被单独验"与"这个单元恰好也在全量里"的区别。
3. **命名要能与 `plugins/` 区分**。`plugins/` 是第三方示例（`todo` / `secret-guard` / `hookify`，`.mjs` + `plugin.json`），`mods/` 是随 CLI 一起编译的内建 mod。同名会让"我写的插件"与"我们的内建"在文档与目录里混成一件事。

**来源清单**（哪个文件搬去哪，执行时照此 `git mv`）：

| 现在 | 搬到 | 备注 |
| --- | --- | --- |
| `src/cli/telemetry.ts` | `mods/telemetry/index.ts` | 插件定义 |
| `src/cli/telemetry-sink.ts` | `mods/telemetry/sink.ts` | 落盘 |
| `src/cli/telemetry-rows.ts` | `mods/telemetry/rows.ts` | 行协议 |
| `test/telemetry.test.ts` / `telemetry-sink.test.ts` / `telemetry-rows.test.ts` | `mods/telemetry/test/` | |
| `src/cli/agents-md.ts` | `mods/agents-md/nested.ts` | 惰性嵌套 |
| `src/builtins/instructions.ts` | `mods/agents-md/instructions.ts` | 指令文件装载 |
| `test/agents-md.test.ts` / `prompt-section.test.ts` | `mods/agents-md/test/` | `prompt-section` 测的就是这个 mod 的事件 |
| `src/builtins/sec-default.ts` | `mods/sec-default/index.ts` | 只归位 |
| `test/sec-default.test.ts` | `mods/sec-default/test/` | `policy.test.ts` 测 `contract/policy`，**不搬** |
| `src/cli/diff.ts` + `/diff` 那条命令 | `mods/diff/` | **P5c 做**，本片不动 |

**配置面**（都要改，漏一处就是"文件搬了但没被看见"）：
- `tsconfig.json` 的 `include` 加 `mods`；
- `vitest.config.ts` 的 `include` 加 `'mods/**/test/**/*.test.ts'`；
- `scripts/check-boundaries.mjs` 加第三个分支（见下）。

### 3.2 边界规则：`mods/<name>` 只许 import 契约

```
mods/<name>/**  →  允许：node: 内建 · src/contract/** · 自己这个目录里的相对路径
                   禁止：裸包名 · src/core/** · src/cli/** · src/builtins/** · src/providers/**
                   禁止：跨到 mods/<别的名字>/
```

⚠️ **规则只查 `mods/<name>/` 下的非测试源码**（`test/` 与 `*.test.ts` 除外）。这不是让步，是分寸：一个 mod 的测试**本来就应该**用真的 `createEngine` 与 `vitest` 去测它（`test/telemetry.test.ts` 与 `test/agents-md.test.ts` 今天都 import `src/core/create`），把它们关在契约后面等于逼测试去造假引擎 —— 而"用假引擎测真行为"恰好是这套仓库反复避开的东西。

**这条规则今天几乎零成本就能立起来** —— 四个候选 mod 的现状是干净的：

| 文件 | 今天的 import | 处置 |
| --- | --- | --- |
| `telemetry.ts` | `contract/plugin` ✓ · `cli/settings`（`TelemetryPolicy` **类型**）✗ · 同目录两个 | 把 `TelemetryPolicy` 挪进 `contract/`：它本来就是**策略的形状**，`settings.ts` 是解析器不是它家 |
| `telemetry-sink.ts` / `telemetry-rows.ts` | `node:` + 同目录 ✓ | 不用动 |
| `agents-md.ts` | `contract/engine` · `contract/plugin` ✓ | 不用动 |
| `instructions.ts` | `contract/plugin` ✓ | 不用动 |
| `sec-default.ts` | `contract/policy` · `contract/plugin` ✓ | 不用动 |
| `diff.ts` | `cli/ansi`（`Palette`）✗ | **P5c 处理，而且不许"把 ansi 也搬过去"糊过去** —— 见下 |

**最后一行是这条规则真正值钱的地方。** `diff.ts` 要 `Palette` 才能把 diff 上色。最省事的做法是把 `ansi.ts` 也挪进 mod，那等于把这条规则绕过去。正确的形状是参考实现 `03-mod-diff` 那条教训的直译：

> mod 产出**模型**（纯数据），渲染归引擎。
> 「不可变模型 + 派生子模块：`PaneModel` 全用 spread 更新，`partitionOf` / `drawnFilesOf` / `headerTotalsOf` 都是纯函数从 model 派生 —— 易测易调」（`03-mod-diff.md:388`）

于是 diff mod 返回一个**带着标记行的数据模型**（哪一段是 add、哪一段是 del、表头写什么），由 `src/cli/` 侧用 `Palette` 渲成带颜色的文本。**加分色这件事从 mod 里消失了，不是被禁掉了** —— 与 P3 那条"第三方 hook 的 allow 连它自己那一层都出不去"是同一种形状的判定。

### 3.3 mod 描述符与可缺省装载

```ts
// mods/<name>/index.ts 的导出形状（示意，执行时按实际类型写）
export const spec: ModSpec = {
  name: 'diff',
  summary: '会话改动的 pane',
  /** 可选依赖：探针返回 false 就不装这个 mod，主流程照常。 */
  optionalDeps: [{ name: 'git', probe: gitProbe }],
  create(deps): Plugin,
};
```

装载器落点 `src/cli/mods.ts`（**CLI 侧**，与 `cli/plugin-dir.ts` 同一条判定：发现是 CLI 的事，内核不认识 mod —— `core/create.ts` 那句"内核不认识任何 agent/skill 文件"是同一条）。装载器本身**不 import 任何 mod**：mod 清单从外面传进来，于是"缺依赖会怎样"能用一个夹具 mod 测：

1. 逐个 mod 跑 `optionalDeps` 的探针（探针是**注入**的，测试里给假的）；
2. 探针全过的 → 调 `create(deps)` 拿 `Plugin`，进插件清单；
3. 有探针不过的 → **不装**，并把"哪个 mod、缺哪个依赖"记进一份 `ModReport`；
4. `ModReport` 有一个**给人看的出口**：启动时一行提示（走 `main.ts` 既有的 `warnLine`），`/config` 里能查。

**判据（P5a 自己的验收）**：

- 夹具 mod（探针永远 false）装进去 → CLI 起得来、其余 mod 一个不少、报告里点名"`fake` 没装，缺 `nope`"；
- 夹具 mod 探针**抛异常** → 也当"缺"处理（一个坏探针不该让 CLI 起不来），但报告里要区分"探针说没有"与"探针自己坏了" —— 后者是**我们的 bug**，混进前者会被静默；
- 摘掉一个 mod 的 `create` 抛异常 → 同上（装载期的失败不传染）；
- 正常路径：四个 mod 都在时，`ModReport` 是空的，一个字节的额外输出都没有。

⚠️ **这里有一条分寸，执行时别弄反**：探针失败 → **降级**（少一个能力，CLI 照跑）；`create` 抛异常 → 也是降级，但**必须吼**。两者都不许让进程起不来 —— 因为"可选依赖缺失时主流程无损"是**出口标准**，不是优化。

### 3.4 装配：`cliPlugins` 怎么变

`src/cli/plugins.ts` 今天是一张手写的第一方插件表。P5a 之后：

- 内建 mod 的那几行（telemetry / agents-md）换成**从 mod 清单来**；
- **座位表与顺序约束留在 `plugins.ts`**（决策 7）：`seating` 仍然由 CLI 钉，顺序仍是契约（那段"顺序是契约"的注释一个字都不用改，只是名字换成了 mod 的）；
- `firstParty` 名单（P2 那条"一份禁用名单不能拆承重墙"的豁免）仍**从实际装上的插件推**，不另抄 —— 这条是 C3 变异测试实测过的，动手时别把它改成静态名单。

---

## 4. P5b 指令文件五层优先级 + 托管下发

### 4.1 五层是哪五层

参考实现在 `05-mod-agents-md.md:351` 给的骨架：

> **分层优先级模型是骨架**：`managed` / `user` / `project` / `local` / `memory` 五层，
> `project` 内部再按目录深度从 root 向外排。

**我们不改名字，但把第五层落到我们自己的东西上**：我们没有 `memory` 这种类型，我们有的是 P1 的**会话落盘/记忆**这条线（`src/cli/transcript.ts`）。判据是"同一件事只有一个说法"（P4d 决策 4 用过同一条）：指令文件的五层来源必须与 `settings` 的五层来源**是同五个概念**，不许另起一套。

| 层 | 谁写 | 落地路径（P5b 执行时定稿） |
| --- | --- | --- |
| `project` | 仓库 | `<root>/AGENTS.md` · `<root>/CLAUDE.md` |
| `local` | 本机 | `<root>/.deepcode/AGENTS.md` · `<root>/.deepcode/CLAUDE.md` |
| `user` | 用户 | `~/.deepcode/AGENTS.md`（今天已在 `instructions.ts` 里） |
| `managed` | 组织 | 托管设置里的 `instructions` 段，路径见 §6.1 |
| 嵌套 | 约定 | P4a 已经做了（`mods/agents-md/nested.ts`，惰性附在 `Read` 的结果后面） |

三条执行时定下的口径（都写进了代码注释与 README）：

1. **表的顺序就是送进模型那段文本的顺序**：越贴近这个仓库的越靠前，**托管那份压在最末** ——
   它是权威，所以它最后说话。这一条同时让 P5a 之前那条已有断言（根 AGENTS → 根 CLAUDE →
   用户层 AGENTS）原样成立，不必改判词。词表落在 `src/contract/instructions.ts`，
   mod 的顺序**从那张表推**，不另排一遍（两处各写一份就会漂）。
2. **`local` 用 `.deepcode/` 而不是通配 `*.md`**：那个目录在 `.gitignore` 里，"本机的东西不进
   版本库"在那一个目录上已经说过了；而点名两个文件名胜过扫一个目录 —— 往 `.deepcode/` 里
   扔一个临时 `.md` 不该悄悄进提示。与 `settings.local.json` 相比少一个 `.local.` 后缀，
   是因为那边要那个后缀只为了与同目录的 `settings.json` 分得开。
3. **`managed` 那一段以数据进 mod**：它是 `cli/settings.ts` 用五层那套读完的，经
   `ModDeps.managedInstructions`（**必填**）交进来 —— mod 只许 import 契约，
   而"哪几个来源算一层"是 CLI 那一侧的判定。

### 4.2 托管下发

`managed` 层能**下发指令内容**（不只是规则）：托管文件里新增一节，把一段文本/一个文件路径指成"必须进每一次系统提示的指令"。它与其它四层的区别只有一条，但这条是全部：

- 其它四层：**可以不放**、可以互相覆盖；
- `managed` 层：**在**，且个人层掀不翻（沿用 P2 那条"allow 的效力上限是把 ask 变成 allow"的方向）。

落地的写法是托管设置多认一个顶层键：

```json
{ "instructions": { "text": "一段话", "files": ["/etc/deepcode/policy.md"] } }
```

`text` 在前、`files` 按给的顺序在后。**只有 `policy` 层能写**，别的四层写了整项丢弃 + 出声 ——
与 `sandbox.paths.allow`（只有托管层能设）、`plugins.enable`（托管层写了会被丢）同一句判词形状。
点名的文件读不动 / 不存在：吼一声、跳过那一段、照旧返回（`defaultTextReader` 那条 fail-open
在哪儿落的第二处）—— 但一行配错的托管配置不该让 CLI 起不来。

判据：五层各写一份，按优先级看到它们在送进模型的那段文本里的**顺序**；把 `managed` 那一份的内容写进个人规则里"想覆盖它"，结果是被忽略并被告知已丢弃 —— 与 P4d 遥测那条"托管层能关、别人打不开"是同一条验收形状。

---

## 5. P5c diff 分屏

### 5.1 单 surface 下"分屏"是什么

参考实现的 diff mod 在 transcript 旁边开一个 pane（`03-mod-diff.md:13-16`）。我们只有一个 surface。判定（决策 8）：**pane = 一块定宽的块**，`/diff` 从"打印一串行"变成"打印一个有表头、有分区、逐文件的块"，并在本会话有改动时**标脏**（下次打印时刷新，不做实时重绘）。

### 5.2 三件要抄的东西

| 抄什么 | 出处 | 我们落成什么 |
| --- | --- | --- |
| **不可变 `PaneModel` + 纯函数派生** | `03:388` | mod 导出的模型全用 spread 更新，`partitionOf` / `headerTotalsOf` 从 model 派生，纯函数、单独可测 |
| **后端抽象三层** | `03:384`（`Backend` / `BackendProbe` / `BackendWords`） | "git 只是默认实现"这句话从一开始成立 —— 这同时是 §3.3 那个探针机制的第一个真消费者：`git` 不在就降级 |
| **性能闸放最前** | `03:351,386`（先 `--shortstat`，超 500 文件只留 totals） | 我们的对应：改动文件数超阈值时只给总数与文件名，不逐文件算 hunk。**先取小再决定要不要取大** |

### 5.3 判据

- `git` 从 PATH 里拿掉 → mod 不装/降级，`/diff` 给一句人话，其余全绿（**这就是出口标准第二条的真实例证**）；
- 一份改了 600 个文件的仓库 → 走退化路径，不逐文件算，有测试钉住"退化时**没有**调用逐文件那条路径"；
- 模型是纯数据：同一份改动，`PaneModel` 逐字节相同，无论渲染几次。

---

## 6. P5d 托管推送 + 分发面 + CI 三件套

### 6.1 托管推送（MDM）

P2 已经把接口留好了（`p2-design.md:441`：「MDM 落地（plist / 注册表 / ADMX）—— 排 P5。本轮只做文件，路径与 `DEEPCODE_MANAGED_SETTINGS` 已为 P5 留好接口」）。三个通道：

| 平台 | 通道 |
| --- | --- |
| macOS | `plist`（托管偏好域） |
| Windows | 注册表 `HKLM\SOFTWARE\DeepCode` |
| Linux | `/etc/deepcode/managed-settings.json`（今天已有） |

**不做 ADMX**（决策 9）：它是给组策略编辑器看的描述文件，没有它注册表那条照样生效。

判据：三个通道各给一份**夹具**（不是真机）→ 解析出来的策略与文件通道**逐字节相同**；`DEEPCODE_MANAGED_SETTINGS` 仍然能覆盖（P2 已有的那条）。

### 6.2 分发面

- **安装**：`bin/deepcode.mjs` + `package.json` 的打包面（今天 `private: true`）；
- **workspaces 拆包**：P3 偏差 3 欠的那一格，单元就是 `mods/*` 与 `src/`（契约先行）。这条**视 P5a 的边界规则是否真的落地**决定做多深 —— 规则立住了，拆包是机械活；立不住，拆了也是假的；
- **`CHANGELOG.md`**：从 git 历史按阶段生成一份**产品面**（参考实现那份 987 KB 的产物，`10-enterprise-and-surface.md` 把它当"演进记录层"）。我们不生成 987 KB，我们生成**史实**：每个阶段一行、附一句出口标准与偏差条目的索引；
- **gateway 接入**：P2 已经做了 `base_url` 收口。P5 只做**接入面**（一组 enterprise 设置 + 文档），**不做服务端**（§9.4 明写）。

### 6.3 CI 硬化三件套

出口标准第三条要的是：**漏配 firewall runner 时流水线失败**。要让它有对象，前提是 **CI 里真有一个调用 agent 的 job** —— 这正是 P4e 设计 §1 那张表把"三件套"排到 P5 的理由（`p4e-design.md:45-51`）：

> 「三件套」——即 CI 里真有一个调用 agent 的 job，于是防火墙 runner / egress allow list / 权限模式才有对象可约束；`check-workflow-hardening` 扩出对应规则

三件：

1. 调 agent 的 job 必须落在**防火墙 runner** 上；
2. 出网必须**显式 allow list**（不允许默认全通）；
3. 权限模式必须显式钉住（不存在"没写 = 默认"）。

`scripts/check-workflow-hardening.mjs` 从四条规则扩到管住这三条。**验收方式就是出口标准的原话**：把防火墙 runner 那行删掉一次，看它红。

---

## 7. 明确不做（延续 §9.4 + 本轮的判定）

| 不做 | 理由 |
| --- | --- |
| 桌面 / IDE 客户端 | §9.4:459 已写"UI 只到多 surface 抽象层"。我们也**不建抽象层**：P4d 缓下 D3 的理由（零消费者）今天依然成立 |
| Agent SDK 之外的嵌入式能力 | 只出 `src/sdk.ts` 一个受支持入口 + 一条宿主测试，不做框架、不做绑定 |
| marketplace 托管服务 | §9.4:460 |
| 自建 model gateway 服务端 | §9.4:458（P5 只做接入） |
| 遥测的 `collector` 备选目的地 | §9.4 |
| 多租户 / 团队协作 / 共享会话 | §9.4 |
| ADMX 模板 | 决策 9 |
| 替用户选 LICENSE | 决策 10 |

---

## 8. 风险与预登记的偏差

1. **搬目录会碰到几乎每个测试文件的相对路径**。这是纯机械改动，但量大 —— 按片做、一次一片、每片跑 `pnpm test` 全量（搬完立刻验，不留到最后）。
2. **`sec-default` 的归位**（P5a）动的是 P2 的承重墙。它是**纯物理移动**、行为零变化；搬完必须有一条测试证明"守门器还在原座位、豁免名单还是推出来的"（`test/plugin-guard.test.ts` 与 C3 变异测试的教训）。
3. **`TelemetryPolicy` 挪进契约**会动 `src/cli/settings.ts` 的公开面。契约是叶子（零 import），加一个类型进去不破坏那条性质，但要在 `contract/` 的自检里确认。
4. **`mods/` 进 `tsconfig` 的 include** 之后，`mods/**` 里任何类型错误都会让 `pnpm typecheck` 红 —— 这正是要的。
5. **P5a 若发现某个 mod 实在绕不开 `cli/` 的依赖**：不削规则、不把 `cli/` 整个搬过去。把那个依赖**提到契约里**（像 `TelemetryPolicy` 那样），或者**改成注入**（像 `Palette` 那样）。规则的价值就在这里，第一次破例之后它就不存在了。

---

## 9. 验收方式

沿用 P2/P4：**按检查点批量做，任务级只跑 `pnpm typecheck`**，一片一个或数个检查点，检查点里跑全量 `pnpm test` + `pnpm lint`，并做**反向验证**（把断言改坏一次，确认它真的会红；任一条没红，修的是断言不是设计）。

每片的出口都要能回答一个问题：**这条判据，我把它弄坏过没有？**
