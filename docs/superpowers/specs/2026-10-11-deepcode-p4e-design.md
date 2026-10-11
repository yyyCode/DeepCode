# DeepCode —— P4e 工程化设计（CI / plugins 边界 / 工作流硬化）

> 施工说明书。上位文档是 [`2026-10-11-deepcode-mvp-design.md`](2026-10-11-deepcode-mvp-design.md) §9，
> 分组依据是 [`2026-10-11-deepcode-p4a-design.md`](2026-10-11-deepcode-p4a-design.md) §17，
> 同体例的先例是 [`2026-10-11-deepcode-p4b-design.md`](2026-10-11-deepcode-p4b-design.md)。

**一句话**：让「本地三条命令全绿」变成「CI 上也全绿」，并把两处**今天没有任何检查覆盖**的东西
纳进来 —— `plugins/` 下的源码与清单，以及 `.github/workflows` 自身的安全卫生。**一行运行时行为都不改。**

---

## 0. 决策摘要

1. **CI 是本轮的主角，硬化校验器是它的纪律件**。P4a §17 把 P4e 定成「CI、`check-boundaries` 扩到 `plugins/`、
   发布流程」。参考实现的「硬化三件套」（防火墙 runner + egress allow list + `--permission-mode auto`）
   全部是为了约束**一个跑在 CI 里的 AI agent** —— 我们在 CI 里不跑 agent。照搬 = 三条规则全部空转通过 =
   一段永远跑不到的代码，与项目自己「做一半的隔离比不做更危险」的口径正面冲突。
2. **硬化校验器改成「我们自己的 CI 卫生版」**：规则指向我们**真实存在**的风险
   （第三方 action 未钉 SHA、`permissions:` 缺省、`pull_request_target`、checkout 带着凭据）。
   判据是：**这些规则当场能被一份坏工作流弄红**，所以不是空转（§2）。
3. **严格按参考实现的三件套排期**：它属于 P5 出口标准（`mvp-design.md:451` 原文写的就是
   「workflow 硬化校验器能在漏配 firewall runner 时让流水线失败」）。P4 那一行写的「硬化三件套」
   读作远期条目。本轮的卫生版是它的**前身**，不是它的替代。
4. **不做豁免表**（与参考实现的一处刻意偏差）。参考实现的 `EXEMPT_FROM_FIREWALL_RUNNER` /
   `EXEMPT_FROM_AUTO_MODE` 存在是因为「防火墙 runner 并非所有 job 都可用」这个它绕不开的真实约束；
   我们没有这个约束。一张表会让例外变**安静** —— 要破例就改规则本身，让它在 diff 里显式。
   与「谁加自动放行开关谁就是在开倒车」是同一条口径。
5. **`plugins/` 今天完全不在任何检查里**：它们是 `.mjs`（`tsc` 不看，`allowJs` 没开），
   又不在 `scripts/check-boundaries.mjs` 的 `src/` 走查范围内。这不是"检查得不够细"，
   是**两套检查的缝隙正好落在自家插件的源码上**。
6. **插件的边界规则一句话**：`plugins/<name>/**` 只许 import `node:` 内建，或停在**自己那个目录里**的相对路径。
   裸包名会解析到**宿主的** `node_modules` —— 那是隐式耦合，P5 插件独立分发那天必炸。
7. **补两个现有的洞**：`check-boundaries.mjs` 的正则认不出 `export ... from '...'`；
   一个 `walk` 不到任何文件的检查器会打印「通过」（假绿）。后者由 `test/tooling.test.ts` 钉住。
8. **两个检查都进 `pnpm lint`**。只在 CI 里跑的校验器是最容易漂的那种 —— 本地与 CI 必须同一条命令。
9. **P3 欠的那一格（「校验器进 CI」，`mvp-design.md:424` 自己承认没做）本轮还清**：
   对 `plugins/todo` 与 `plugins/secret-guard` 真跑 `deepcode plugin validate`。
10. **发布流程不做**：`package.json` 是 `private: true`，仓库**没有 LICENSE**（未指定许可证 / 保留所有权利）。
    许可证没定下来就发不了。归 P5 的「安装面」。

---

## 1. 出口标准怎么落

MVP §9.2 的 P4 行里 `CI 分发` 一格写的是「硬化三件套」；P5 出口标准写的是
「CI 里 workflow 硬化校验器能在漏配 firewall runner 时让流水线失败」。两处口径不同，本设计的读法：

| 阶段 | 做什么 | 依据 |
| --- | --- | --- |
| **P4e（本轮）** | CI 跑绿三条命令；`plugins/` 进边界检查；**我们自己的**工作流卫生校验器；`plugin validate` 进流水线 | P4a §17 的「CI、`check-boundaries` 扩到 `plugins/`」 |
| **P5** | 「三件套」——即 CI 里真有一个调用 agent 的 job，于是防火墙 runner / egress allow list / 权限模式才有对象可约束；`check-workflow-hardening` 扩出对应规则 | `mvp-design.md:451` |

**怎么判定本轮做够了**：把本轮新增的每条规则**故意弄坏一次**，看它是否真的红。
任一条没红，说明那条断言是摆设 —— 修断言本身，不是改设计（与 P4b 同一口径）。

---

## 2. `scripts/check-workflow-hardening.mjs`

### 2.1 规则（四条）

扫 `<root>/.github/workflows/*.yml` 与 `*.yaml`：

| # | 规则 | 拦的是什么 |
| --- | --- | --- |
| H1 | 第三方 action 的 `uses:` 必须钉 **40 位 commit SHA**（`./` 开头的本地复合动作豁免） | tag 可被上游重指；这是 CI 的头号供应链风险 |
| H2 | 每个 workflow 必须有**显式**的顶层 `permissions:` | 缺省 = 仓库默认 token 权限，通常比 job 需要的大得多 |
| H3 | 禁 `pull_request_target` | 它给不可信 PR 的代码一个带写 token 与 secrets 的上下文 |
| H4 | 每个 `actions/checkout` step 必须 `persist-credentials: false` | 否则 token 被写进 `.git/config`，后续任意 step 都能拿去用 |

### 2.2 零依赖、纯文本

**不引 YAML 解析器** —— 与 `check-boundaries.mjs` 同一路数（`package.json` 里没有 `dependencies` 字段，
这一轮也不打算有）。做法是按行扫，处理两件事：

- **剥注释**：`#` 到行尾去掉（`#` 前必须是行首或空白）。不剥的话，
  一行注释掉的 `# uses: foo/bar@v1` 会造成假红。
- **认字面量**：只认 `uses: <无引号或单双引号包裹的单个 token>`，只认 `on:` 下的裸 `pull_request_target` 行。

**诚实的边界（照沙箱那节的写法写进 README）**：文本扫描不是 YAML 解析器。
它看不见动态拼出来的 `uses:`（`uses: ${{ ... }}`）、看不见写在 YAML 锚点 / 复用块里的引用、
也不理解 job 之间的包含关系。**它是尽力而为的护栏，不是完备证明** ——
参考实现的 `CLAUDE.md` 对自家的 python 校验器说的也是同样一句话。

### 2.3 不做豁免表

见决策 4。要破例就改 §2.1 的规则表，让例外出现在 diff 里、出现在 review 里。

### 2.4 命令行形状

```
node scripts/check-workflow-hardening.mjs [root]
```

`root` 省略 = 仓库根（由脚本自身位置推出）。给了就用给的 —— 这一条是为了让它**可被测试**（§4）。
没有 `.github/workflows/` 目录 = 打印「工作流硬化检查通过（没有工作流）」并以 0 退出
（与 `check-boundaries.mjs` 对缺失 `src/` 的处理同形；一个新克隆不该因为这个脚本崩掉）。

---

## 3. `scripts/check-boundaries.mjs` 扩到 `plugins/`

### 3.1 规则

`plugins/<name>/**` 里的相对导入必须满足两条之一：

1. 目标**仍在自己那个 `plugins/<name>/` 目录内**；
2. 说明符是 `node:` 开头的内建（`node:fs`、`node:path`…）。

其余一律违规并列出理由：

| 形态 | 判词 |
| --- | --- |
| `from 'fs-extra'`（裸包名） | 会解析到**宿主的** `node_modules` —— 插件不该依赖宿主的依赖树 |
| `from '../src/core/engine'` | 插件只通过 hook 契约与引擎说话，不 import 引擎内部 |
| `from '../other-plugin/x'` | 跨插件引用 |

### 3.2 三处配套改动

1. **走查扩展名**：`.ts` → `.ts/.mjs/.js`。两个自带插件是 `.mjs`，今天就落在这两套检查的缝里。
   `src/` 侧仍只会命中 `.ts`（那里本来就没有别的），所以行为不变。
2. **可选根目录参数**：`node scripts/check-boundaries.mjs [root]`，默认仓库根。
   同样是为了可测。`pnpm lint` 的调用不带参数，行为一字不变。
3. **补上 `export ... from`**：现在的 `IMPORT_RE` 只认 `import ... from '...'`，
   一句 `export * from '../src/x'` 能整个溜过去。加一个分支覆盖 re-export。
   **已核过不会误伤**：`grep -rn "^export .* from '" src` 只有 `src/contract/index.ts` 的六行同级
   re-export（`./tier`、`./next`、…），扩了照样绿。动态 `import()` 只有
   `src/cli/plugin-dir.ts:212` 一处，且实参是 `pathToFileURL(file).href`（非字面量），新正则不匹配 ——
   这一处**有意不覆盖**：它要求正则去猜表达式，而猜错的代价是假红。

---

## 4. `test/tooling.test.ts`（新）

两个检查器都是 `.mjs`，`tsconfig.json` 的 `include` 是 `["src","test","scripts"]` —— 它们**连 tsc 都不经过**。
所以它们唯一的保障就是这个测试文件。

| 用例 | 怎么造 | 断言 |
| --- | --- | --- |
| 边界：干净目录 | 临时目录里 `src/contract/a.ts` + `plugins/p/main.mjs`（只 import `node:fs` 与 `./util.mjs`） | 退出码 0，stdout 含「通过」 |
| 边界：插件 import 引擎 | 同上，但 `main.mjs` 里加一行 `import '../../src/core/engine'` | 退出码 1，stderr 含 `plugins/p/main.mjs` 与「引擎」 |
| 边界：插件裸包名 | `import 'fs-extra'` | 退出码 1 |
| 边界：`src/` 越界仍然拦得住 | `src/contract/a.ts` 里 `import '../core/b'` | 退出码 1 |
| 边界：re-export 也算 import | `plugins/p/util.mjs` 里 `export * from '../../src/core/x'` | 退出码 1 |
| 硬化：干净工作流 | `.github/workflows/ci.yml`（钉 SHA + `permissions:` + `persist-credentials: false`） | 退出码 0 |
| 硬化：四个规则各红一次 | 四份只坏一条的工作流 | 各自的退出码 1 + 各自的判词 |
| 硬化：没有 workflows 目录 | 空临时目录 | 退出码 0 +「（没有工作流）」 |

**没有 `reseed` 那条的同类**：这里要防的是**假绿** ——
一个 `walk` 不到文件的检查器会打印「通过」。所以每一条「不红」的用例都配一条「会红」的用例，
且后者必须真的让脚本以 1 退出。

用 `execFile(process.execPath, [script, tmpRoot])` spawn，断言 `code` / `stdout` / `stderr`。
（`test/cli.test.ts:381` 已有「真跑一遍 bin」的现成范式。）

---

## 5. `plugin validate` 进流水线

P3 欠的那一格。接线方式**写进 vitest 测试**而不是 CI 里加 step：

- 好处：本地也跑（只在 CI 跑的检查最容易漂）、断言写得下、走的是**真 CLI 路径**；
- 代价：起两次 `tsx`（`bin/deepcode.mjs` → `tsx src/cli/main.ts`），可接受。

落点：`test/cli.test.ts` 末尾追加两个用例（该文件已有 `execFile(process.execPath, [bin/deepcode.mjs, …])` 的范式与 60s 超时），
对 `./plugins/todo` 与 `./plugins/secret-guard` 各跑一次 `plugin validate`，
断言退出码 0 且 stdout 含各自的插件名。

**不带任何 API key**：`src/cli/main.ts:88` 的子命令分支在**读配置、要 key 之前**处理，
所以这在干净环境里是条正经命令。测试里把 `ANTHROPIC_API_KEY` 等变量删掉，
既是复现 CI 环境，也是**再钉一遍那条顺序**（这与 `cli.test.ts:412` 那条 `--resume` 用例同一条用意）。

---

## 6. `.github/workflows/ci.yml`

```
on:
  push:   branches: [main]
  pull_request:
permissions:
  contents: read
```

单 job `check`，matrix `node: ['20', '22']`。步骤：

1. `actions/checkout@<sha>`（v5）+ `persist-credentials: false`
2. `pnpm/action-setup@<sha>`（v4，`version: 10`）—— 本机 pnpm 是 10.33.0，`pnpm-lock.yaml` 是
   `lockfileVersion: '9.0'`，pnpm 10 读得了
3. `actions/setup-node@<sha>`（v4）+ `node-version: ${{ matrix.node }}` + `cache: pnpm`
4. `pnpm install --frozen-lockfile`
5. `pnpm typecheck`
6. `pnpm lint`（= 两个检查器）
7. `pnpm test`

**三个 action 全部钉 40 位 commit SHA**，紧邻注释写版本号，让人能升级：

```yaml
# v5
- uses: actions/checkout@fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09
```

**为什么 matrix 是 20/22**：`engines: { node: ">=20" }` 是一句**没人验过的话**（本机 v22.19.0）。
CI 的职责是让这句话继续为真。20 是声明的地板，22 是开发机实际在跑的。
成本约多一分钟 —— 这一条是本设计里最可能被判为 YAGNI 的地方，但它换来的是
「`engines` 从一句声称变成一条被检查的事实」。

**为什么不需要任何 secret**：测试全是桩。`provider.test.ts` / `openai.test.ts` 用假 `fetch`，
transcript / e2e 用 `mkdtemp` 临时目录，`cli.test.ts:384` 甚至专门把 `USERPROFILE` 指到不存在的目录 ——
注释写的原话是「免得哪天这个开关真的坏了，测试却替你花掉一次 API 调用」。

### 6.1 本轮不做的两个轴

- **Windows runner 矩阵**：开发机是 Windows，理论上有价值。但本轮 CI 的第一要务是
  「本地三条命令在**干净环境**里成立」；等真出现平台 bug 再加第二个轴。
- **`site/` 的检查**：官网没有构建步骤、不在 `tsconfig` 的 `include` 里，也就没有可跑的检查。

---

## 7. 风险：Linux 上第一次跑可能红

测试套件只在 Windows 上跑过。CI 一上 ubuntu 可能露出 Windows-only 的假设
（最可疑的是 `src/core/nouns/process.ts` 用 `spawn(command, { shell: true })` —— 那边落在 `/bin/sh`）。

**口径**：第一次跑红了，**那不是 CI 配错了，是它逮到了真东西**。
按这个口径处理 —— 修实现或修那条测试对平台的假设，**不是**把断言改松。
若确认是「这条断言本来就只能在某个平台上成立」，那就把它改成显式的平台条件并写明原因，
而不是悄悄放宽。

---

## 8. 验收标准

### C1（两个检查器）

- `pnpm lint` 打两行「通过」（依赖边界、工作流硬化）。
- 反向验证：`plugins/p/main.mjs` 里写 `import '../../src/core/x'` → 边界检查红；
  一份 `uses: actions/checkout@v5`（未钉 SHA）的工作流 → 硬化检查红。
- `test/tooling.test.ts` 全绿。

### C2（流水线与文档）

- `pnpm typecheck` ✓ / `pnpm lint` ✓ / `pnpm test` ✓（文件数与用例数实测后同步进 README 与官网）。
- `pnpm test` 里有对 `plugins/todo`、`plugins/secret-guard` 的真 `plugin validate`。
- 推分支开 PR，**两个 Node 版本的 job 都绿**（这一条只能在推上去之后才算数）。
- `README.md`、`docs/项目简介.md`、`site/index.html` 三处「没有 CI」的说法全部改掉。
  这次是**删掉一条真实的限制**，不是加一条。

---

## 9. 已知偏差与存疑

### 与参考实现的刻意偏差

| 偏差 | 参考实现 | 我们 | 为什么 |
| --- | --- | --- | --- |
| 硬化规则的**对象** | 约束 CI 里跑的 agent（防火墙 runner + allow list + 权限模式） | 约束我们**自己的**工作流的供应链与权限卫生 | 我们 CI 里没有 agent，照搬必空转 |
| **豁免表** | `EXEMPT_FROM_FIREWALL_RUNNER` / `EXEMPT_FROM_AUTO_MODE` + 理由 | **不做** | 它的表源于「防火墙 runner 并非处处可用」这个真实约束；我们没有，而表会让例外变安静 |
| 校验器**语言** | Python（`.github/scripts/check_workflow_hardening.py`） | Node `.mjs`，零依赖 | 仓库本来就有 `check-boundaries.mjs` 这个先例，且没有 python 依赖 |

### 存疑（本设计拍板，但上位文档说不清）

1. **P4 那行的「硬化三件套」到底指什么**。`mvp-design.md:411` 的 `P4` 列写「硬化三件套」，
   而 §9.3 的 P5 出口标准写的正是工作流硬化校验器。两处不可能都对。本设计按 §9.3 排（见 §1），
   并把 P4 那行读作远期条目 —— 若你要的是「P4e 就把三件套做了」，那本案要重写。
2. **matrix 20/22 是否值得**（§6）。成本一分钟，换来 `engines` 被检查。判为值得，但这是可砍的。
3. **`plugin validate` 走测试还是走 CI step**（§5）。选了测试，因为它在本地也跑。
   若将来插件变多、validate 变慢，再挪回 CI step。

---

## 10. 明确不做（YAGNI）

| 不做 | 为什么 |
| --- | --- |
| 防火墙 runner / egress allow list / `--permission-mode auto` | 我们 CI 里没有任何 job 调用 agent。三条规则会全部空转通过 —— 一段永远跑不到的代码 |
| 豁免表 | 见决策 4 |
| YAML 解析依赖 | 零运行时依赖是仓库的既有底线；为四条文本规则引一个解析器不值 |
| 发布流程（npm publish） | `private: true` + 没有 LICENSE。许可证是你的决定，归 P5「安装面」 |
| Windows runner 矩阵 | 见 §6.1 |
| `site/` 的 lint / 构建 | 官网无构建步骤、无依赖、不在 `tsconfig` 里 |
| 给 `plugins/` 做类型检查 | 它们是 `.mjs`，开 `allowJs` 会牵动整个 `tsconfig`；边界规则 + 真跑 validate 已经覆盖了能出问题的地方 |
| 覆盖率门槛 | 没有基线，一个拍出来的百分比只会变成又一个"为了过线而写的测试" |

---

## 11. 关键文件索引（实现时对照）

| 要改的东西 | 去哪儿看 | 关键行 |
| --- | --- | --- |
| 边界检查脚本（**要扩**） | `scripts/check-boundaries.mjs` | `RULES` :11-17、`IMPORT_RE` :19、`walk` :21-29、`SRC` 推导 :6-7 |
| 两个自带插件（**今天无人检查**） | `plugins/todo/main.mjs`、`plugins/secret-guard/scan.mjs` | 两者 `import` 数均为 0 |
| 插件子命令（**在要 key 之前**） | `src/cli/main.ts` | :88-110 |
| `validate` 的实现与退出码 | `src/cli/plugin-command.ts` | `runPluginCommand` :50-52（`validated.ok ? 0 : 1`） |
| 真跑 bin 的测试范式 | `test/cli.test.ts` | :381-411、:412+（`execFile` + 清空 key + 60_000 超时） |
| 依赖边界规则的来源说明 | `docs/superpowers/specs/2026-10-11-deepcode-mvp-design.md` | §2.1 :58-64 |
| 参考实现的硬化校验器 | `claude-code-架构分析/09-ci-and-automation.md` | :250-400（三件套与豁免表） |
| 参考实现的 CI 硬化面 | `claude-code-架构分析/06-security-permissions.md` | :473-500、:602-630 |
| 「没有 CI」在哪几处 | `README.md`、`docs/项目简介.md:98`、`site/index.html:357` | — |
| 包脚本 | `package.json` | `scripts.lint` :12 |
