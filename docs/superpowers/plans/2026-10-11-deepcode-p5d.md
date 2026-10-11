# DeepCode P5d 实施计划 —— 托管推送（MDM）+ 分发面 + CI 硬化三件套

> **给执行者**：按任务顺序做，一批做完到检查点再验。任务级只跑 `pnpm typecheck`，
> 测试**按检查点批量做**（用户长期指令：一次校验多个任务，争取快速完成开发）。
> 任务之间**不要暂停**、不要逐任务汇报。

**目标**：把 P5 的最后一片收掉 —— 托管策略从"只有一个文件位置"变成**三个真实通道**；
把"我们是什么、走到哪一步"变成一份可查的史实；让 CI 里那三条硬化规则**有对象可约束**。

**上位文档**：[`2026-10-11-deepcode-p5-design.md`](../specs/2026-10-11-deepcode-p5-design.md) §6。
判据与"明确不做"都在那儿，本文只把它落成可执行的任务。

**技术栈**：TypeScript（`strict` + `noUncheckedIndexedAccess`），零运行依赖，无构建步骤。

---

## 0. 决策摘要（本文新增的判定）

| # | 决策 | 一句话理由 |
| --- | --- | --- |
| 1 | 托管通道归一成**同一段 JSON 文本**，不是同一个对象 | 下游（`settings.ts` 的 `readLayer`）只认文本。归一在文本层，"三个通道逐字节相同"这句话才是**字面**成立的，而不是"深比较相等" |
| 2 | plist 与注册表各写一个**自己的解析器**，不 shell 出去找 `plutil` / `pwsh` 转换 | 用系统自带转换器省事，但把"能不能读托管策略"绑到了另一个外部程序的版本上。我们已经有 `git` 那一次教训：外部程序的缺席要能**被测出来**，而不是在生产里才暴露 |
| 3 | 探针式的 `run` **注入**（与 `mods/diff/git.ts` 的 `GitRunner` 同形） | 三通道判据要的是**夹具**，不是真机。注入之后，"这台机器是 macOS 还是 Linux"变成测试里的一个参数 |
| 4 | 通道**有序**，第一个有内容的赢；`DEEPCODE_MANAGED_SETTINGS` 仍是最高优先 | P2 已经给了这个覆盖口子，行为不动。注册表排在同平台的默认文件**之前** —— MDM 的正规通道该赢过一个散落的文件 |
| 5 | gateway 接入面 = 托管层能**钉死** `baseUrl` / `model`，个人层改不动 | 这是"个人规则掀不翻托管策略"在**出网位置**上的落法：组织把所有人指到自己的网关上，员工绕不过去。与 `sandbox.paths.allow` 同形（只有托管层能写） |
| 6 | **不做** workspaces 拆包（真实分包），记成预登记偏差 | §6.2 原文给的条件是"视边界规则是否落地决定做多深"。规则立住了，但**消费者是零**（我们只发一个 CLI）。与"不做 ADMX"（决策 9）、"不建客户端"（决策 11）是同一条判定 |
| 7 | **不碰** `private: true` 与 `LICENSE` | §6 决策 10：那是用户的决定 |
| 8 | CI 里的 agent job **默认跳过**（`if: vars.DEEPCODE_AGENT_CI == 'on'`），但规则只管**形状** | 我们账号上没有 `ubuntu-24.04-firewall` 那个 runner。写一个永远排不上队的 job 会让 CI 永久红 —— 而规则要的是"**有对象**"，对象不跑也在那儿 |
| 9 | 第三条硬化规则钉的是**反面**：不许出现任何自动放行开关 | 参考实现要求"恰好 `--permission-mode auto`"。我们**没有** auto 模式，而且「谁加自动放行开关谁就是在开倒车」。于是我们要求 job 显式声明 `deny-by-default`，并把 `--yes` / `auto` / `skip-permissions` 钉成违规词 |

---

## 1. 任务组 A：托管推送（MDM 三通道）

### 判断链

```
readManagedSettings(deps)
  ├─ deps.path 给了（--settings= 之外的那条 override）→ 只读那个文件      ← 既有行为，测试全靠它
  └─ 否则按平台走通道表，第一个有内容的赢：
       env DEEPCODE_MANAGED_SETTINGS → 注册表(HKLM) / plist(managed prefs) → 平台默认文件
```

### Task 1：`src/cli/managed-plist.ts` —— 最小 XML plist 读取器

**新建** `src/cli/managed-plist.ts`，导出 `parsePlist(xml: string): unknown`。

支持的类型（就是一条托管设置会用到的那些）：`dict` / `array` / `string` / `integer` /
`real` / `true` / `false`；`data` 按 base64 原文当字符串（我们不用它，但不许抛）；
`date` 同。**不支持的标签抛错**（安静地吞掉一个 `<dict>` 等于安静地丢掉一段策略）。

```ts
/**
 * 最小 XML plist 读取器（P5d）—— 只够读托管偏好域。
 *
 * 为什么自己写：把"能不能读托管策略"绑到 `plutil` 的版本上，就多一个只能在真机上
 * 才发现的外部依赖。我们已经在 `git` 那件事上交过一次学费：外部程序的缺席必须
 * **可测**（见 `mods/diff/backend.ts` 的探针）。
 *
 * 它读不了什么（写进 README，不藏着）：二进制 plist（`bplist00`）、`<date>` 的
 * ISO 时间戳语义、`<data>` 的解码。前两条今天都用不到，第三条用到了也是当字符串用。
 */
```

实现要点：

- 先剥掉 `<?xml ...?>` / `<!-- ... -->` / `<!DOCTYPE ... >`（`>` 之前那段，DOCTYPE 里的
  `[...]` 内部子集一并吃掉）。
- 词法：`/<\/?([A-Za-z_][\w.-]*)[^>]*?(\/?)>/g` 逐段切，标签之间的非空文本是 `text` token。
- 递归下降：

```ts
type Token =
  | { readonly kind: 'open'; readonly name: string; readonly selfClosing: boolean }
  | { readonly kind: 'close'; readonly name: string }
  | { readonly kind: 'text'; readonly text: string };

function parseValue(tokens, at): [unknown, number]
```

- `<plist>` 只是外壳：读它里面的**一个**值。
- `dict`：循环读 `<key>` 的文本 → 再读一个值，直到 `</dict>`。
- `array`：循环读值，直到 `</array>`。
- 自闭合的 `<true/>` / `<false/>`。
- 文本按 XML 实体解码：`&lt; &gt; &amp; &quot; &apos;`（**顺序**：先 `&amp;` 最后解，
  否则 `&amp;lt;` 会被解成 `<`）。
- 结尾有多余 token 或提前用完 → 抛 `new Error('plist: ...')`。

### Task 2：`src/cli/managed-registry.ts` —— `reg query` 输出读取器

**新建** `src/cli/managed-registry.ts`，导出 `parseRegistryQuery(text: string): unknown`。

输入是 `reg query HKLM\SOFTWARE\DeepCode /s` 的真实输出形状：

```
HKEY_LOCAL_MACHINE\SOFTWARE\DeepCode
    telemetry.enabled    REG_DWORD    0x0
    permissions.deny    REG_MULTI_SZ    Bash(git push:*)\0Bash(rm -rf:*)
    instructions.text    REG_SZ    所有改动都要跑测试
```

规则：

| 注册表类型 | 变成什么 |
| --- | --- |
| `REG_SZ` / `REG_EXPAND_SZ` | 字符串，**但 `true` / `false`（忽略大小写）转布尔** |
| `REG_DWORD` / `REG_QWORD` | 数字（`0x` 前缀按 16 进制） |
| `REG_MULTI_SZ` | 字符串数组（按 `\0` 拆，同时兼容"同名多行"的旧版输出） |
| 别的 | 字符串原样 |

- **值名按 `.` 拆成嵌套路径**：`permissions.deny` → `{permissions: {deny: ...}}`。
  路径上已经是一个标量、现在又要往下拆 → 抛错（两份配置在抢同一个键，安静地覆盖最坏）。
- 不以空白开头的行是**键名行**（`HKEY_...`），跳过。空行跳过。
- 一行里**少于两段**（`名字 类型 值`）→ 抛错。宁可炸，也不要读出一个半截的策略。

⚠️ 注册表没有布尔类型。把 `REG_SZ` 的 `true`/`false` 读成布尔是**一条写进 README 的口径**，
不是随手做的强制转换 —— 代价是"想要字面量字符串 `true`"表达不出来，而我们的设置面里
没有一个字段会想要它（`permissions.deny` 是数组，走 `REG_MULTI_SZ`，不受影响）。

### Task 3：`src/cli/managed.ts` —— 通道表

**新建** `src/cli/managed.ts`：

```ts
/** 一次成功读取的结果。`where` 是给人看的位置说明（`/permissions` 里要显示）。 */
export type ManagedSource = { readonly where: string; readonly text: string };

export type ManagedDeps = {
  readonly env?: Record<string, string | undefined>;
  readonly platform?: string;
  /** 给定时**只**读这个文件（`ResolvePolicyDeps.managedPath` 从这进）。 */
  readonly path?: string;
  readonly readText?: TextReader;
  /** 注入的命令执行器 —— 三通道判据要的是夹具，不是真机。 */
  readonly run?: (file: string, args: readonly string[]) => Promise<string | undefined>;
};

export async function readManagedSettings(deps: ManagedDeps): Promise<ManagedSource | undefined>;
```

- `deps.path` 给了 → 只读它（读不到就是 `undefined`，**不落到通道表**）。
- `env.DEEPCODE_MANAGED_SETTINGS` → 当绝对路径读。
- `platform === 'win32'` → `run('reg', ['query', 'HKLM\\SOFTWARE\\DeepCode', '/s'])`
  → `parseRegistryQuery` → `JSON.stringify` → `where: '注册表 HKLM\\SOFTWARE\\DeepCode'`。
- `platform === 'darwin'` → `run('defaults', ['export', 'com.deepcode.settings', '-'])`
  → `parsePlist` → `JSON.stringify` → `where: '托管偏好域 com.deepcode.settings'`。
- 兜底 → 平台默认文件（`defaultManagedPath()`，已住在 `settings.ts`；**移到 `managed.ts`**，
  `settings.ts` 原样再导出一次，与 P5a 把 `TelemetryPolicy` 挪进契约同一条做法：不改既有 import）。

`run` 的默认实现：`execFile(file, args, { timeout: 5000, windowsHide: true, maxBuffer: 1MB })`；
**非零退出 / ENOENT 一律当"没有"返回 `undefined`，不抛** —— 一台没有配 MDM 的机器上
`reg query` 返回 1 是常态，不是故障。

### Task 4：接进 `settings.ts`

**改** `src/cli/settings.ts`：

1. `Layer` 加一个可选字段：`readonly text?: string`，注释写清"内容已经拿到了（托管通道），
   不走 `readText`"。`readLayer` 里：

```ts
    text = layer.text ?? await readText(where);
```

2. `resolvePolicy` 在拼 `layers` **之前**：

```ts
  // 托管层的内容**不一定在文件里**（P5d 三通道）。先把那段文本拿到手，
  // 再让 `readLayer` 照旧按"一段文本"处理它 —— 下游一个字节都不用改。
  const managed = await readManagedSettings({
    env: deps.env, platform: deps.platform, path: deps.managedPath,
    readText, ...(deps.run === undefined ? {} : { run: deps.run }),
  });
```

policy 那一层变成 `{ source: 'policy', path: managed?.where, ...(managed === undefined ? {} : { text: managed.text }) }`。

3. `ResolvePolicyDeps` 加 `env?` / `platform?` / `run?`（都可选）。

⚠️ **`managedPath` 的语义一个字都不许变**：给它就等于"只读这个文件"。既有的
`test/settings.test.ts`、`test/settings-plugins.test.ts` 全靠它把托管层指到临时目录 ——
这条改动之后它们必须**原样绿**。

### Task 5：夹具与判据

**新建** `test/managed.test.ts`。三份夹具表达**同一份策略**：

```json
{ "permissions": { "deny": ["Bash(git push:*)"] },
  "telemetry": { "enabled": false },
  "instructions": { "text": "所有改动都要跑测试", "files": ["/etc/deepcode/policy.md"] } }
```

- `test/fixtures/managed/policy.json` —— 文件通道
- `…/policy.plist.xml` —— `<dict>` / `<array>` / `<false/>` 的嵌套
- `…/policy.reg.txt` —— `permissions.deny` 用 `REG_MULTI_SZ`，`telemetry.enabled` 用
  `REG_SZ false`，`instructions.files` 用 `REG_MULTI_SZ`

三条断言：

1. **三个解析器对三份夹具给出同一个值**（`toEqual`）。
2. **`readManagedSettings` 对三个通道返回逐字节相同的 `text`** —— 这才是决策 1 要的强度。
   用注入的 `run` 与假的 `readText` 造出三个通道，`expect(a.text).toBe(b.text)`。
3. **同一份策略经三条通道进 `resolvePolicy`，`sources` 里 policy 那一层的规则与计数逐项相同。
   （`where` 不同 —— 那正是我们想看见的区别。）

再加：

4. `reg query` 没有那个键（输出只有键名行）→ `undefined`，不是空对象；
5. plist 里切成两半的 `<dict>` → 抛错，不是安静地少一块；
6. `DEEPCODE_MANAGED_SETTINGS` 压过注册表（两个都在 → 用 env 那个）；
7. 注册表里路径抢键（`a` 已是标量又来 `a.b`）→ 抛错。

**C1（Task 1-5）**：`pnpm typecheck` + `pnpm vitest run test/managed.test.ts test/settings.test.ts test/settings-plugins.test.ts`

---

## 2. 任务组 B：分发面

### Task 6：gateway 接入面

**改** `src/cli/settings.ts`：

- `KNOWN_TOP_LEVEL` 加 `'gateway'`。
- `export type GatewayConfig = { readonly baseUrl?: string; readonly model?: string }`。
- 新 `readGateway(record, layer, where, warn)`：与 `readSandbox` 的 `allow` 同形 ——
  **只有 `policy` 层能写**，别的层写了整项丢弃并出声：

```
`${label(source)} 里写了 gateway —— 出网位置只有托管层能钉，这一份已丢弃。`
```

- `ResolvedPolicy` 加 `readonly gateway: GatewayConfig`（默认 `{}`）。
- `readGateway` 必须在 **permissions 的早期 return 之前**调用 —— 与 plugins / sandbox /
  telemetry / instructions 同一条，一份只写了 gateway 的托管设置不该被丢掉。

**改** `src/cli/config.ts`：加一个**纯函数**（可单测，不碰 `main.ts` 的装配）：

```ts
/**
 * 托管层把出网位置钉死（P5d）。
 *
 * 与 `sandbox.paths.allow` 同一条：个人层能改的只有"发给谁"，而**发给哪**是组织的事。
 * 它不覆盖 `apiKey` —— 凭据仍然按原样解析（托管层钉的是端点，不是钥匙）。
 */
export function applyManagedGateway(config: ResolvedConfig, gateway: GatewayConfig):
  { readonly config: ResolvedConfig; readonly pinned: readonly string[] }
```

`pinned` 是真正被托管层改掉的字段名（`['baseUrl', 'model']` 的子集），供 `main.ts` 打一行通知。

**改** `src/cli/main.ts`：拿到 `policy.gateway` 之后过一遍 `applyManagedGateway`，
`pinned` 非空时 `render.notice(...)` 一行（**必须看得见** —— 与托管指令、托管遥测同一条）。

**改** `test/settings.test.ts`（或 `settings-plugins.test.ts`）+ 新增
`test/gateway.test.ts`：托管层钉 `baseUrl` → 生效；user/project/local/flag 写了 → 丢弃 + 出声；
`applyManagedGateway` 的三种情况（只有 baseUrl / 只有 model / 都没有）。

### Task 7：`CHANGELOG.md`

**新建** `CHANGELOG.md`。它**不是**从代码生成的变更日志，是**史实**：每个阶段一行
（范围 / 出口标准 / 偏差条目的索引），加一句"这份文件怎么读"。

内容来源：`git log --oneline` 的阶段提交 + `docs/superpowers/specs/` 各份的"预登记偏差"小节。
P0–P5 逐阶段写全，**每条偏差都给出它在哪份文档的第几行**。不编任何"改进""优化"这类词。

### Task 8：文档同步

- **`README.md`**：
  - 「配置」一节里那行托管路径 → 改成**三通道表**（含 `DEEPCODE_MANAGED_SETTINGS` 的最高优先）；
  - 新增一小节「托管策略从哪来」（plist / 注册表 / 文件的类型映射口径、注册表把
    `true`/`false` 读成布尔这条代价）；
  - 「权限」一节补 `gateway` 一段（只有托管层能钉，个人改不动）。
- **`docs/项目简介.md`**：P5 那一行补 P5d 已完成 + 用例数/文件数按实测改。
- **`site/index.html`**：同上（含数字条三处）。

**C2（Task 6-8）**：`pnpm typecheck` + `pnpm lint` + `pnpm test`

---

## 3. 任务组 C：CI 硬化三件套

### Task 9：`scripts/check-workflow-hardening.mjs` 扩到七条

既有 H1–H4 不动。新增：

**怎么认出"调用 agent 的 job"**（与参考实现的 `job_calls_claude` 对位）：

```
一个 job 是 agent job，当且仅当：
  · job 里有 `# deepcode:agent-job` 标记行，或
  · job 的某个 step 的 `run:` 里出现 `deepcode` 命令
```

**H5 —— 防火墙 runner**：agent job 的 `runs-on` 必须**恰好**是 `ubuntu-24.04-firewall`。
（参考实现允许一张 `EXEMPT_FROM_FIREWALL_RUNNER` 表；我们**不做**豁免表 ——
它的存在理由是"防火墙 runner 并非处处可用"，而我们只有一个 agent job。表会让例外变安静。）

**H6 —— 出口白名单**：`.github/egress-firewall.yaml` 必须存在、`mode: enforce`、
`allow:` 块非空、任何条目**不得含 `*`**。文本扫描的做法：找到 `mode:` 行取值；
`allow:` 之后收集以 `-` 开头的行。

**H7 —— 权限姿态显式**：agent job 必须有且只有一行
`# deepcode:permission-mode deny-by-default`；且整个工作流里不许出现这三个词：
`--yes`、`--dangerously-skip-permissions`、`--permission-mode auto`。

⚠️ H7 与参考实现方向相反，**这是刻意的**：它要求"恰好 auto"，我们要求"恰好没有自动放行"。
理由写在规则上面那句注释里：**「谁加自动放行开关谁就是在开倒车。」**

### Task 10：`.github/egress-firewall.yaml` + `scripts/agent-smoke.ts`

**新建** `.github/egress-firewall.yaml`：

```yaml
# 出口白名单。三条规矩（抄参考实现，它写在文件头）：
#   1. 只在真的有 step 需要时加；2. 写全名，禁 `*`；3. 注明用途。
# 我们的 agent job 不联网（假 provider 跑一遍引擎），唯一的出网是装依赖。
mode: enforce
allow:
  - host: registry.npmjs.org      # pnpm install
    port: 443
```

**新建** `scripts/agent-smoke.ts`：用 `test/harness.ts` 把引擎端到端跑一次 ——
装一个假 provider 让模型请求一次 `Write`，断言**非 TTY 下走到链尾是 deny**（fail-closed 底线），
并断言这一轮的 `session.start` / `tool.check` / `tool.call` 都真的派发过。
`process.exit(1)` + 一行原因表示失败。它的价值不是"测了什么都行"，是**让 CI 里那三条
规则有对象**，顺带把"fail-closed 在 CI 这种非 TTY 环境里也成立"变成每天跑一次的事实。

### Task 11：`ci.yml` 加 agent job

**改** `.github/workflows/ci.yml`，在 `check` 之后加：

```yaml
  agent-smoke:
    name: agent smoke（防火墙 runner）
    # deepcode:agent-job
    # deepcode:permission-mode deny-by-default
    # ⚠️ 默认跳过：这个仓库的账号上没有 `ubuntu-24.04-firewall` 那个 runner，
    # 真让它排队会得到一条永远红的流水线。规则管的是**形状**，形状不跑也在那儿。
    # 有 runner 的组织把它打开：Settings → Variables → DEEPCODE_AGENT_CI = on
    if: ${{ vars.DEEPCODE_AGENT_CI == 'on' }}
    runs-on: ubuntu-24.04-firewall
    permissions:
      contents: read
    steps:
      - uses: actions/checkout@fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09
        with:
          persist-credentials: false
      - uses: pnpm/action-setup@b906affcce14559ad1aafd4ab0e942779e9f58b1
        with:
          version: 10
      - uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020
        with:
          node-version: '22'
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm exec tsx scripts/agent-smoke.ts
```

⚠️ `permissions:` **写在 job 级**：顶层的那个是上限，H7 要的是这一层显式钉过。
（三个 `uses:` 的 SHA 从 `check` job 原样抄，不许换 tag —— H1 会红。）

### Task 12：`test/tooling.test.ts` 加三条规则的用例

**改** `test/tooling.test.ts` 的 `cleanWorkflow()`：加一个合规的 agent job（标记 + firewall
runner + job 级 permissions + `deny-by-default` 行），并按 H6 在临时树里放一份合规的
`.github/egress-firewall.yaml`。既有那几条断言（缺顶层 permissions → 红等）必须**原样绿**。

新增用例（每条只改一处）：

| 改什么 | 期望 |
| --- | --- |
| 删掉 agent job 的 `# deepcode:agent-job` 标记**并**把 `run:` 改成含 `deepcode` 的命令 | 红（H5：认得出它是 agent job 但 runner 不对） |
| `runs-on: ubuntu-24.04-firewall` → `ubuntu-latest` | 红，且信息里有 `防火墙` |
| 没有 `.github/egress-firewall.yaml` | 红 |
| 那份文件 `mode: report` | 红 |
| `allow:` 空 | 红 |
| 某条 allow 里写 `*.npmjs.org` | 红 |
| 删掉 `# deepcode:permission-mode deny-by-default` | 红 |
| 某 step 写 `--permission-mode auto` | 红 |
| 某 step 写 `--yes` | 红 |
| 非 agent job（没有标记、run 里没有 `deepcode`）**不**受 H5/H6/H7 约束 | 绿 |

### C3（Task 9-12）：出口标准第三条的**真实例证**

1. 先 `pnpm typecheck && pnpm lint && pnpm test` 三绿。
2. **把 `ci.yml` 里 `runs-on: ubuntu-24.04-firewall` 改成 `ubuntu-latest`，跑 `pnpm lint`，
   看它红**（这就是出口标准第三条的原话：「漏配 firewall runner 时流水线失败」）——
   确认之后立刻改回来。
3. 反向验证表（逐条改坏 → 确认红 → 从 `/tmp/p5d.bak/` 恢复；每条改完先 `grep` 确认变异落地）：

| # | 把什么改坏 | 必须红在哪 |
| --- | --- | --- |
| 1 | `managed.ts` 里把注册表通道挪到 `DEEPCODE_MANAGED_SETTINGS` **之前** | 「env 压过注册表」那条 |
| 2 | `parseRegistryQuery` 里把 `REG_SZ` 的 `true`/`false` 强制转换删掉 | 三通道逐字节相同那条 |
| 3 | `settings.ts` 里 `text = layer.text ?? ...` 改成总是 `readText` | 「同一份策略经三条通道进 resolvePolicy，规则逐项相同」 |
| 4 | `readGateway` 的 policy-only 检查删掉（任何层都能写） | 「个人层写了 gateway 会被丢弃且出声」 |
| 5 | H7 的"不许出现 `--yes`"那条谓词删掉 | 「某 step 写 --yes → 红」 |
| 6 | H6 的"条目不得含 `*`"删掉 | 「`*.npmjs.org` → 红」 |

---

## 4. 刻意不做（本片）

| 不做 | 理由 |
| --- | --- |
| 真实 workspaces 拆包 | 决策 6：前置条件（边界规则 + `mods/<name>` 各自可测）已经齐了，缺的是**消费者**。我们只发一个 CLI |
| 改 `private: true` / 加 `LICENSE` | 决策 7：用户的决定 |
| ADMX 模板 | 总纲决策 9 |
| 网关**服务端** | 总纲 §7；我们只做接入面（托管层钉 `baseUrl`） |
| `EXEMPT_FROM_FIREWALL_RUNNER` / `EXEMPT_FROM_AUTO_MODE` 豁免表 | 只有一个 agent job，表会让例外变安静 |
| 二进制 plist（`bplist00`） | 托管偏好域用 XML；真遇到再加 |
| 真机上的 MDM 验证 | 判据要的是**夹具**（总纲 §6.1 原话）。真机验证需要一台被 MDM 管的 Mac 与一台入域的 Windows |

---

## 5. 出口

P5d 做完，P5 四片全部收口。P5 之后：一次文档同步 → 推 `p5-builtins` → 开 PR（带
`🤖 Generated with [Claude Code](https://claude.com/claude-code)`）→ 合并回 `main`。
