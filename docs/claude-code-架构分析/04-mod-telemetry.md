# 04 · `telemetry` 内建 mod 架构分析

> 分析对象：`mods/telemetry/`（约 275 个文件）以及它所定义的第一方分析（first-party analytics）设施 `$.telemetry`。
> 所有路径均相对仓库根 `F:\ts\claude-code`。本 doc 只描述代码中可验证的行为；不能从代码确证之处一律放入「存疑与待确认」。
> 代码引用中的事件名、类型名、常量名保留英文，其余叙述用中文。

---

## 定位

`telemetry` 是随 Claude Code 二进制一同发布的四个内建 mod 之一（`mods/README.md:12`）。它以「一个插件」的形式实现引擎的第一方分析能力：hooks 挂载在 `$.telemetry` 名词的两个事件 `telemetry.log` 与 `telemetry.mark` 上，并在 `engine.create` fold 中为「自身没有该名词的引擎」补上名词。它让**内建插件**（built-in plugin）能把一次事件记为一行第一方分析数据，批量发送。

用 `hooks/hooks.json:2` 的自我描述概括其定位：

> Plugin analytics: hooks on telemetry.log and telemetry.mark queue first-party rows over `$.session`, `$.env`, `$.settings`, `$.fs`, `$.process`, `$.clock` and `$.http` beneath, the noun added in engine.create where the engine has none; rows go out in batches; sends nothing wherever the CLI's analytics are off

它不是「通用遥测收集器」，而是**`tengu_` 体系内的插件侧埋点入口**：产出的行与 CLI 自身的埋点行同表、同 ingest、同 CSV 列（见「数据流」）。这是刻意的定位——`README.md:49` 说明「行带上 CLI 自身行所带的一切」，使插件的埋点能与 CLI 原生埋点一起做产品分析，而不必另建一张表。

对外，这个名词由 `types/index.d.ts` 单点声明，是「所有调用方看到的唯一契约」（`types/index.d.ts:1-12`、`README.md:61-63`）。

---

## 职责与边界

### 它负责什么

1. **名词提供（noun provider）**：在 `engine.create` fold 中构建 `$.telemetry`（`hooks/register.ts:53-368`）。
2. **两个事件的实现**：`telemetry.log` / `telemetry.mark` 的 handler 就是「校验 + 入队」（`hooks/register.ts:31-39`）。
3. **门禁（gate）**：`telemetry.*` 上的 hook 只放行 `builtin` 与 `core` 两级（`hooks/gate/served-tiers/served-tiers.ts:5`）。
4. **校验与行模式**：把自由输入收敛为零自由文本的行字段（`hooks/entries/checked-fields.ts`、`checked-value.ts`）。
5. **批量与发送**：定时、满批、会话结束时 flush；一次重试；失败丢弃（`hooks/telemetry-of/telemetry-of.ts:143-183`）。
6. **隐私/退出开关**：每个 batch 之前重读开关；关了就什么都不发（`hooks/is-analytics-off/is-analytics-off.ts`）。
7. **上下文采集**：会话内一次采集设备/账号身份、session 字段、`env` 块、仓库 hash（`hooks/context/`）。

### 它明确不做什么（边界）

- **只服务内建/core 层**：`SERVED_TIERS = ['builtin', 'core']`（`served-tiers.ts:5`），其余 tier 一律 `REFUSED`（`hooks/gate/served/served.ts:18`）。个人安装的插件（`user`）、管理员 `prepend`/`append` 的插件都被拒（测试 `tests/register.test.ts:708-748`）。
- **不替换引擎自身的名词**：merge 顺序是 `{ ...added, ...beneath }`（`register.ts:367`），beneath 自己的 `telemetry` 优先；本 mod 只在引擎没有时才补上（测试 `tests/gate.test.ts:112-131` 验证上层无法用它自己的 `telemetry` 顶替）。
- **不处理 `collector` 目的地**：`to: 'collector'` 的 `log` 条目不属于本 mod，handler 直接 `next(e)` 交给下面（`register.ts:31-35`、`types/index.d.ts:66-85`）。
- **引擎内部才知道的列留空**：运行时版本、进程内存、请求 betas、订阅 tier、调用 agent 等不在 `$` 上，这些列保持空（`README.md:36-39`）。
- **不发往非生产 API base**：`INGEST_URL` 是硬编码的生产地址（`entries/ingest-url.ts:8`）。

---

## 关键抽象与接口

### 1. 名词契约（唯一声明）

`mods/telemetry/types/index.d.ts` 是名词的**唯一契约文件**，无任何 import，独立成立。其注释明确说明三方共用：本 mod 的 hooks、调用该名词的 mod、应答它的测试，都读这一个文件（`types/index.d.ts:1-12`）。

核心类型（逐字引用）：

```ts
export type Telemetry = {
  log: (entry: TelemetryLogEntry) => Promise<void>
  mark: (entry: TelemetryMarkEntry) => Promise<void>
}
```
（`types/index.d.ts:21-64`）

```ts
export type TelemetryDestination = 'anthropic' | 'collector'          // :71
export type TelemetryLogEntry  = { to?: TelemetryDestination; event: string; props?: Readonly<Record<string, TelemetryProp>> }  // :81-85
export type TelemetryMarkEntry = { feature: string; kind: TelemetryMarkKind; reason?: string; props?: Readonly<Record<string, TelemetryProp>> }  // :91-96
export type TelemetryMarkKind  = 'ok' | 'sad' | 'bad'                 // :105
export type TelemetryProp      = number | boolean | TelemetryChoice    // :111
export type TelemetryChoice    = { value: string; of: readonly string[] }  // :121
```

名词通过 **declaration merging** 挂到引擎接口上：

```ts
declare module 'claude-code' {
  interface EngineInterface {
    telemetry: Telemetry
  }
}
```
（`types/index.d.ts:123-131`）

契约的语义细节都写在 JSDoc 里，且**是规范的一部分**：`log` 的 `event` 是 snake_case token、已经是 `tengu_…` 的按原名发送（`types/index.d.ts:26-28`）；`mark` 承载 `feature_name`、`error_code`（`sad`/`bad` 必填 `reason`，`ok` 必须不填）（`:47-52`）；`to` 永不进入行（`:76-80`）；字符串值必须是 `Choice`，自由文本被拒（`:110-121`）。

### 2. 运行时抽象

| 抽象 | 位置 | 作用 |
| --- | --- | --- |
| `Sender` | `hooks/sender/sender.ts:7-14` | `{ telemetry: Telemetry; flush: () => Promise<void> }`，`telemetryOf` 的产物 |
| `TelemetryDeps` | `hooks/telemetry-deps/telemetry-deps.ts:25-128` | 对 `$` 下方的全部依赖（authorize/id/model/isInteractive/environment/policy/facts/deployment/configLocation/cwd/repo/version/read/list/exists/run/fetch/after/sleep/debug），是 DI 边界 |
| `Environment` | `hooks/environment/environment.ts:8-23` | 每个 batch 前重读的开关快照 |
| `Facts` | `hooks/facts/facts.ts:9-66` | 会话内只读一次的描述性变量（含大量 `has*` 布尔，用于「只读是否设置」） |
| `Context` | `hooks/context/context/context.ts:12-17` | 会话内采集一次：`identity`/`session`/`environment`/`remoteHash` |
| `Probe` | `hooks/context/probe/probe.ts:13-25` | 采集后、成行前的原始材料 |
| `PolicyPins` | `hooks/policy-pins/policy-pins.ts:7-10` | 托管策略里的 gateway 钉选 |
| `ConfigLocation` | `hooks/config-location/config-location.ts:8-12` | 全局 config 位置（只用于读，不发送） |
| `Fields` | `hooks/entries/fields/fields.ts:5-8` | 校验后的 `{ name, props }` |
| `PendingRow` | `hooks/batching/pending-row/pending-row.ts:7-11` | 待发的一行：`{ fields, eventId, loggedAt }` |
| `RefusedEntry` | `hooks/entries/refused-entry/refused-entry.ts:5-6` | 被拒条目：`Error & { what: string }` |
| `BatchStamp` | `hooks/entries/batch-stamp/batch-stamp.ts:10-16` | 一批内共享的 session 字段与 context |

### 3. 类型分层

仓库里**只有一个**类型契约目录 `mods/telemetry/types/`（不存在 `hooks/telemetry/types/`）。分层规则是：

- 契约层：`types/index.d.ts`——对外、可被别的 mod 与测试 `include`。
- 实现层：`hooks/**` 通过相对路径导入契约类型，例如 `hooks/telemetry-of/telemetry-of.ts:3` `import type { Telemetry } from '../../types'`；`hooks/entries/mark/mark.ts:1` `import type { TelemetryMarkKind } from '../../../types'`。
- 实现层内部还有大量「每文件一导出」的小类型（如 `Environment`、`Facts`），它们不出现在契约文件里。

跨 mod 共享靠 tsconfig 的 `include` 完成：`mods/tsconfig.json:16` 为 `["types", "*/types/**/*.d.ts", "*/hooks", "*/tests"]`，因此 `diff` 中 `$.telemetry.log(…)` 会按 telemetry 的契约做类型检查，而**永不复制**契约（`mods/README.md:98-101`）。

---

## 数据流 / 时序

### 1. 装配（`engine.create` fold）

`register.ts` 只在 `engine.create` 中构建 sender（`register.ts:53-368`）：

```
on('engine.create', async (_$, e, next) => {
  const beneath = await next(e)                       // 先让下面建好引擎
  sender = telemetryOf({ …所有 deps 从 beneath.* 取… })  // DI：把 $ 的能力注入 sender
  const telemetry = sender.telemetry
  const added = { telemetry }
  return { ...added, ...beneath }                     // beneath 优先，本 mod 只做兜底
})
```

要点：
- **命名规范 DI**：`telemetryOf` 不知道 `$`，只接受一个 `TelemetryDeps` 对象；`register.ts:56-362` 把每个依赖映射到 `beneath.session.*` / `beneath.env.get(...)` / `beneath.fs.*` / `beneath.process.run` / `beneath.http.fetch` / `beneath.clock.*` / `beneath.ui.log`。这使核心逻辑可在没有真实引擎的情况下单测（`tests/fixtures/first-party-session.ts` 就是这套「假世界」）。
- **兜底语义**：`{ ...added, ...beneath }` 决定「引擎已有同名名词时以引擎为准」；测试 `gate.test.ts:112-131` 用一个上层插件交回 `DEAF_TELEMETRY` 来验证顶替失败。
- **失败即无 provider**：若引擎既没有自己的 `telemetry`、本 mod 又缺席（或 analytics off 而未被 seat），调用方 `$.telemetry` 根本不存在或因无人应答而抛错——`mods/README.md:109-112` 与 diff 的 `safely()` 都是对这个「无 provider」事实的降级处理。

### 2. 事件时序（一次 `log`）

```
插件: await $.telemetry.log(entry)
      │
      ▼  hook 链（引擎内）
telemetry.*  →  Gate.served(e, next)            gate/served.ts:13-19
   ├ next.origin?.tier === undefined → throw '$.telemetry: the call names no origin'
   ├ tier ∈ {builtin, core} → next(e) 继续
   └ 否则 → REFUSED { deny: '$.telemetry serves the plugins built into Claude Code alone' }  refused.ts:5-7
      │（gate 抛错时由 .catch → Gate.caught 兜底为 REFUSED） register.ts:27-29, gate/caught/caught.ts:13-14
      ▼
telemetry.log  →  sender===undefined || e.to==='collector' ? next(e)
                 : answerOf(sender.telemetry.log(e))          register.ts:31-35
      ▼
Sender.telemetry.log = async entry => queued(Entries.checkedFields(entry))  telemetry-of.ts:186
      ▼
checkedFields: isRecord → event 是 TOKEN → checkedProps
      ├ 任一步失败 → throw refusal(...)（携带 what）
      ▼
fieldsOf: 已是 tengu_ 前缀保留原名，否则加 'tengu_plugin_'  entries/fields-of.ts:13-16
      ▼
queued(fields):
   priming ??= primed().catch(()=>undefined)
   pending.push({ fields, eventId: crypto.randomUUID(), loggedAt: new Date().toISOString() })
   if (pending.length >= BATCH_ROWS) flush()
   else timer ??= deps.after(BATCH_WINDOW_MS, () => void flush())
```

`answerOf`（`hooks/answer-of/answer-of.ts:14-24`）把 `Promise<void>` 转成引擎的 hook 应答：成功 `{ value: undefined }`，若是 `RefusedEntry` 则 `{ deny: error.what }`（`$.telemetry` 的 promise 因此 reject 并带原因），其它异常继续向上抛（表示 hook 自身故障）。

### 3. flush 与发送

`flush()`（`telemetry-of.ts:143-165`）：
- 取消 timer、取出并清空 `pending`；
- 空则返回当前 `sending`；
- 否则把 `send(rows)` 串到 `sending` 链上（**串行化**，避免并发 POST），并 `.catch` 成一条 debug 行 `telemetry: N row(s) not sent: …`。

`send(rows)`（`telemetry-of.ts:107-141`）：
1. `sendingEnvironment()`：`Promise.all([deps.environment(), deps.policy()])` → `isAnalyticsOff(...)`；**off 或读不到**则 `return`（不发，debug 记因）。
2. `deps.authorize()` 取会话凭证；**没有** → 抛 `this session has no first-party credential to authorize`。
3. `gathered()` 取（会话内一次采集的）context。
4. `Entries.batchOf(rows, stamp)` 构造 JSON。
5. `postedWithRetry(body, auth)`。
6. `response.ok` 为假 → 抛 `the ingest answered <status>`；成功记 `telemetry: sent N row(s)`。

`postedWithRetry`（`telemetry-of.ts:83-105`）：POST 一次；若抛错或返回 `isRetriable(status)`（5xx / 408 / 429，`batching/is-retriable/is-retriable.ts:12-15`）则 `sleep(RETRY_DELAY_MS=500)` 后**再 POST 一次**；否则直接返回。

触发时机（三条，见 `register.ts:18-19` 注释与测试）：
- 定时：`BATCH_WINDOW_MS = 5000`（`batching/batch-window-ms/batch-window-ms.ts:5`）；
- 满批：`BATCH_ROWS = 100`（`batching/batch-rows/batch-rows.ts:5`）；
- 会话结束：`on('session.end', … await sender?.flush() …)`（`register.ts:47-51`）。

### 4. 行的形状（wire schema）

`batchOf`（`entries/batch-of.ts:14-22`）：

```json
{ "events": [ { "event_type": "ClaudeCodeInternalEvent",
                "event_data": <eventDataOf 的产物经 wireOf 拼写> } ] }
```

`eventDataOf`（`entries/event-data-of/event-data-of.ts:17-31`）的字段：

```
eventId, eventName, clientTimestamp,
deviceId, email, auth,                 ← identity
sessionId, model, userType, isInteractive,
...stamp.context.session,              ← clientType, entrypoint, agentSdkVersion, sweBench*
env: { ...context.environment, isClaudeAiAuth },
additionalMetadata                     ← base64(JSON.stringify({ rh, ...props }))
```

`wireOf`（`entries/wire-of/wire-of.ts:10-24`）递归把**所有对象键**从 camelCase 改写成 snake_case（`platformRaw → platform_raw`），数组与叶子保留。所以最终列名是 `event_id`、`device_id`、`client_timestamp`、`client_type`、`agent_sdk_version`、`additional_metadata`、`linux_distro_id`、`github_actions_runner_os` 等。

`additionalMetadata` 是 base64 文本：`btoa(JSON.stringify({ rh: remoteHash, ...row.fields.props }))`（`metadata-of/metadata-of.ts:11-12`）。测试用自实现的 `base64Decoded` 回读（`tests/fixtures/wire/base64-decoded.ts`）。

`mark` 的行名与字段由 `markFieldsOf` 决定（`entries/mark-fields-of/mark-fields-of.ts:17-28`）：

- `name = 'tengu_feature_' + kind`；
- `ok`：props 先展开，再放 `feature_name`（`{ feature_name: feature, ...props }`）；
- `sad`/`bad`：`{ ...props, feature_name: feature, error_code: reason }`。

字段命名 vs 常量：`EVENT_PREFIX = 'tengu_plugin_'`（`entries/event-prefix/event-prefix.ts`）、`FEATURE_PREFIX = 'tengu_feature_'`、`CORE_EVENT_PREFIX = 'tengu_'`（`fields-of` 用后者判断「已是 CLI 自带事件名则保留」）。

### 5. 上下文采集（会话内一次）

`telemetryOf.gathered()` 用 `context ?? …` 记忆化（`telemetry-of.ts:30-44`），失败时把 `context` 重置为 `undefined` 以便下一批重试。`Context.contextOf`（`context/context-of.ts:18-30`）→ `probeOf`（`context/probe-of/probe-of.ts:21-64`）：

- `Promise.all` 拉 `facts / deployment / configLocation / environment / cwd / repo / version`（`cwd`、`repo`、`version` 各自 `catch` 成空，`version` 失败额外写一行 debug）；
- 再 `Promise.all` 拉 `identity / machine / vcs / remoteHash`；
- 再 `linuxFilesOf`（仅 Linux，读 `/etc/os-release`、`/proc/version`、`/sys/hypervisor/uuid`、`/.dockerenv`）；
- 组装 `Probe`，交给 `sessionFieldsOf` / `environmentFieldsOf` 成行。

`gathered()` 只在开关为「on」时被调用（见 `primed()`：`sendingEnvironment()` 有值才 `gathered()`，`telemetry-of.ts:64-70`），因此 analytics off 时连机器都不会去探（测试 `register.test.ts:243` 断言 `session.reads` 为空）。

### 6. 门禁与转发路径

`to` 字段的语义在两处体现：
- `telemetry.log` handler：`e.to === 'collector'` 时 `next(e)`，即「原样交给下面」（`register.ts:31-35`）。这些 collector 行不由本 mod 发送，供会话操作者配置的 telemetry collector 处理。
- 但**门禁先于**这条分支：`telemetry.*` 上的 gate 对所有 tier 生效，所以**安装型插件的 collector 调用同样被拒**（测试 `register.test.ts:708-727`：`visiting` 是 `user` tier，即使 `to: 'collector'` 也被 REFUSED）。collector 通道实际只对 builtin/core 开放。

---

## 扩展点

1. **两个事件即接口**：`telemetry.log` / `telemetry.mark` 是唯一被 hook 的事件（`register.ts:31,37`）。要接入本设施，只需调用 `$.telemetry`，无需知道 batching/sender 存在。
2. **`engine.create` fold 提供名词**：`{ ...added, ...beneath }` 的兜底语义让本 mod 可与「自带 telemetry 的引擎」共存，且不破坏任何下层对象（`register.ts:364-367`、`mods/README.md:84-91`）。
3. **跨 mod 名词消费**：`diff` 通过 `EngineInterface['telemetry']['mark' | 'log']` 引用类型（`mods/diff/hooks/host/host.ts:121-129`），在 `session.start` 时把 `$.telemetry.*` 绑定进自己的 `Host`（`mods/diff/hooks/register.ts:687-688`），再用 `safely()`（`mods/diff/hooks/record/safely/safely.ts:7-11`）吞掉「名词缺失（同步抛）」与「行被拒（reject）」两种失败，使埋点永不干扰 `/diff`。
4. **测试中的 provider 座位法**：调用方 mod 的测试用 inline 插件在 `engine.create` 里补名词、并用 `on('telemetry.log', …)` 应答（`mods/diff/tests/record.test.ts:13-19`、`mods/diff/tests/register.test.ts:788-792`），**坐在真 provider 的 hook 之上**，这正是 `mods/README.md:102-107` 描述的约定。
5. **`to` 作为目的地开关**：把 collector 目的地预留给操作者配置的 collector，本 mod 不发送，是可扩展的「多目的地」缝。
6. **常量化的批策略**：`BATCH_ROWS`、`BATCH_WINDOW_MS`、`RETRY_DELAY_MS`、`PROP_LIMIT`、`CHOICES_LIMIT`、`PROBE_TIMEOUT_MS` 各自独立成文件，便于调整。

---

## 设计决策与权衡

1. **名词提供走 `engine.create` fold + 命名依赖注入，而非全局单例。**
   sender 在 fold 里从 `beneath.*` 逐项绑定（`register.ts:56-362`），核心逻辑 `telemetryOf(deps)` 与引擎解耦。收益：可测试、可被上层覆盖、可在没有该名词的引擎上自然缺席。代价：`register.ts:56-362` 是一大段样板映射，且把「读哪些环境变量」硬编码进装配层。

2. **`{ ...added, ...beneath }` 的优先级选择。**
   下层优先意味着「引擎自己的 telemetry 永远赢」。这是保守而正确的选择：本 mod 是**兜底 provider**而非接管者。测试用 `replacing`/`holding`/`reaching` 等敌对 fixture 验证了这一不变量。

3. **门禁按 tier 而非按能力位。**
   `next.origin?.tier` 由宿主在每次调用上盖章（`gate/gate-next/gate-next.ts:7`），gate 只查白名单 `['builtin','core']`。同时规定「没有 origin 就抛」（`served.ts:14-16`），`Gate.caught` 把 gate 抛错兜成 REFUSED（`caught.ts:13-14`）——即「读不到来源 = 拒绝」。这是 fail-closed 的隐私姿态。

4. **hook 应答用 `{ value }` / `{ deny }` 区分「成功」与「条目被拒」。**
   `answerOf` 只在 `isRefusedEntry` 时转 `{ deny }`，其它错误继续抛（`answer-of.ts:14-24`）。这样「调用方写错条目」与「mod 内部故障」在协议层被区分：前者是可读的拒绝理由，后者是 hook 失败让引擎继续往下。

5. **行校验 = 隐私闸门：零自由文本。**
   事件名与属性键都是 `TOKEN = /^[a-z][a-z0-9_]{0,63}$/`；值只允许有限数、布尔、或 `Choice`（`checked-value.ts:19-73`）。字符串必须给 `of` 闭集且 `value ∈ of`。这从**类型和运行时两侧**杜绝了自由文本进入行（`types/index.d.ts:108-121`）。属性数上限 16（`PROP_LIMIT`），Choice 成员上限 32（`CHOICES_LIMIT`）且成员是 `CHOICE_TOKEN = /^[a-z0-9][a-z0-9_-]{0,63}$/`（可数字开头、可带连字符，如 `110_to_143`、`merge-base`）。

6. **敏感值只读「是否设置」。**
   `Facts` 中如 `CLAUDE_CODE_SESSION_ACCESS_TOKEN`、`P4PORT`、`SSH_CONNECTION` 等只保留布尔（装配层用 `IsAnalyticsOff.isEnvSet`，`register.ts:106-187`）；shell 只留 basename 且限定闭集（`shell-of/shell-of.ts:12-23`）；仓库 remote 只发 SHA-256 前 16 位十六进制（`remote-hash-of/remote-hash-of.ts:12-24`、`remote-hash-length = 16`）；email 仅内部构建（`USER_TYPE === 'ant'`）才保留（`identity-of.ts:46`）。

7. **每个 batch 重读开关 + fail-closed。**
   `sendingEnvironment()` 每批都重新 `environment()` + `policy()`，`isAnalyticsOff` 为真或**读取抛错**都返回 `undefined` → 不发（`telemetry-of.ts:46-62`）。收益：会话中途切到第三方 provider/gateway 会**立即停止**后续发送。`isAnalyticsOff`（`is-analytics-off.ts:18-44`）的判定是四个维度取并集：`isPrivate`（test/`DISABLE_TELEMETRY`/`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`/`DO_NOT_TRACK`）、`isThirdParty`（Bedrock/Vertex/Foundry/Anthropic-Aws/Google-Cloud/Mantle，且未被 host 托管）、`isGateway`（环境开关或托管策略 `forceLoginMethod=gateway`/`forceLoginGatewayUrl`）、`isCustomDeployment`（`CLAUDE_CODE_CUSTOM_OAUTH_URL`）。

8. **`isEnvSet` vs `isEnvTruthy` 两套开关语义。**
   `isEnvSet` 对 `DISABLE_TELEMETRY` 采用「任何非空值都算开」——连 `0` 也算（`is-env-set.ts:8-9`，测试用 `{ DISABLE_TELEMETRY: '0' }` 断言不发，`analytics-off-environments.ts:8`）；`isEnvTruthy` 只认 `1/true/yes/on`（`is-env-truthy.ts:8-9`）。文档注释解释了这分别是 CLI 隐私级别与布尔开关的两套读法。

9. **批处理策略：小批快发 + 一次重试 + 失败即弃。**
   100 行满批或 5s 窗口先到者触发；会话结束兜底 flush。重试只针对「值得重试」的状态（5xx/408/429）且只一次、固定 500ms；客户端错误（如 400）与二次失败都丢弃整批。**丢弃是显式选择**：第 2 条约束是「不阻塞、不重放」，每批结果只落一行 debug。串行化 `sending` 链避免并发与乱序。

10. **`credential` 每批重取。**
    `deps.authorize()` 每次 send 都调用（`telemetry-of.ts:114`），测试 `register.test.ts:681-706` 验证一次 authorize 失败**不会**污染下一批。`isClaudeAiAuth` 由「`authorization.kind === 'bearer'` 且 identity 有 accountUuid」推出（`telemetry-of.ts:128-131`）。

11. **事件名双前缀策略。**
    `log` 默认加 `tengu_plugin_`，但**已是 `tengu_` 的按原名发送**（`fields-of.ts:14`）。这样「从 CLI 原生埋点迁移过来的内建插件」可保留原有行名（如 `diff` 直接发 `tengu_repl_diff_panel_shown`，`diff/hooks/record/recorder-of.ts:21-27`），与 CLI 自身的数据无缝续接。

12. **上下文「一次采集、跨批复用」。**
    identity/machine/version 等昂贵读取在会话内只做一次（`context ??`），而开关类读取每批重做。测试 `register.test.ts:567-587` 断言 config 只读一次、`sh` 只跑一次。

---

## 对复刻产品的启示

若要做同类的「插件侧第一方埋点」产品，可直接复用的模式：

- **单一契约文件 + `declare module`**：契约（`types/index.d.ts`）无 import、可被第三方 tsconfig `include`，实现方按相对路径导入以免漂移。跨模块消费只读、不复制。
- **fold + DI 提供名词**：核心逻辑写成 `factory(deps)`，装配层负责把宿主能力映射成 deps；merge 时用 `{ ...added, ...beneath }` 做「兜底不覆盖」。无 provider 时自然缺席，调用方用 `safely()` 降级。
- **tier 门禁 + fail-closed**：白名单 + 「无来源即拒」+「gate 抛错即拒」，把「谁能发」与「发什么」解耦。
- **零自由文本的行协议**：事件名/键用严格 token 正则，字符串值用 `{ value, of }` 闭集，属性数与闭集大小设上限。这比事后 redaction 更根本（本 mod 里**没有独立的 redaction 模块**，隐私靠协议本身 + 敏感值「只读是否设置」+ 哈希）。
- **每批重读退出开关**：让隐私开关具备「会话中途生效」的能力，且读不到就当关闭处理。
- **小批快发 + 一次重试 + 失败丢弃 + 每结果一行 debug**：埋点绝不影响主流程。
- **测试用 inline provider 座位**：被测 mod 的测试只需 `on('telemetry.log', …)` 就能在真 provider 上层应答，验证「调用方视角」而不必启动完整设施。
- **`to` 目的地预留**：为「第一方 ingest」与「操作者 collector」留多目的地缝，后者本设施不处理。

---

## 关键文件索引

**契约与装配**
- `mods/telemetry/types/index.d.ts` —— 名词契约、全部对外类型、`EngineInterface` 声明。
- `mods/telemetry/hooks/register.ts` —— 全部 hook 注册、`engine.create` fold 与依赖映射。
- `mods/telemetry/hooks/hooks.json` / `.claude-plugin/plugin.json` / `README.md` —— 描述与自述。
- `mods/telemetry/hooks/index.ts` —— hooks 子树再导出。

**门禁**
- `hooks/gate/served/served.ts`、`served-tiers/served-tiers.ts`、`refused/refused.ts`、`caught/caught.ts`、`gate-next/gate-next.ts`。
- `hooks/answer-of/answer-of.ts` —— hook 应答 `{value}`/`{deny}` 转换。

**校验与行模式（entries/）**
- `checked-fields.ts`、`checked-mark.ts`、`checked-props/`、`checked-value/`、`token/`、`choice-token/`、`prop-limit/`、`choices-limit/`、`is-record/`、`is-mark-kind/`、`mark-kinds/`。
- `fields/`、`fields-of/`、`mark/`、`mark-fields-of/`、`event-prefix/`、`feature-prefix/`、`core-event-prefix/`。
- `refusal/`、`refused-entry/`、`is-refused-entry/`。
- `batch-of.ts`、`wire-of/`、`event-data-of/`（含 `auth-of/`、`metadata-of/`）、`batch-stamp/`、`ingest-url.ts`。

**批量与发送**
- `hooks/telemetry-of/telemetry-of.ts` —— sender、flush、send、retry 的全部逻辑。
- `hooks/sender/sender.ts`、`hooks/telemetry-deps/telemetry-deps.ts`。
- `hooks/batching/`（`batch-rows`、`batch-window-ms`、`is-retriable/`、`message-of`、`pending-row`、`retry-delay-ms`）。

**隐私开关**
- `hooks/is-analytics-off/is-analytics-off.ts`、`is-env-set/`、`is-env-truthy/`。
- `hooks/environment/`、`hooks/policy-pins/`。

**上下文（context/）**
- `context-of.ts`、`probe/probe.ts`、`probe-of/probe-of.ts`、`context/`。
- `identity/`（`identity-of.ts`、`global-config-path/`、`plausible-uuid/`）。
- `facts/`、`session-fields(-of)/`、`environment-fields(-of)/`（含 `action-ref-of/`、`tags-of/`、`github-actions-fields-of/`）、`client-type-of/`、`entrypoint-of/`。
- `machine/`（`machine-of.ts`、`probe-script/`、`probe-timeout-ms/`、`platform-of/`、`arch-of/`）、`linux-distro-of/`、`wsl-version-of/`、`shell-of/`、`terminal-of/`、`vcs-of/`、`remote-hash-of/`、`version-of/`。
- `hooks/deployment/`（`deployments.ts` 全量列表、`deployment-of.ts`、`deployment-signal/`、`deployment-name/`）。
- `hooks/config-location/`。

**测试**
- `tests/register.test.ts`（行内容、批处理、隐私、重试、拒绝、平台、tier）、`tests/gate.test.ts`（门禁与敌对插件）。
- `tests/fixtures/`：`first-party-session.ts`（假世界与 `posts/reads/runs/lines/clock` 记录）、`expected-row.ts`（完整期望行）、`plugins/`（`recording`/`marking`/`visiting`/`managing`/`reaching`/`meddling`/`swallowing`/`replacing`/`holding`/`sweeping`/`annotating`）、`gate/`、`wire/`、`environments/`。

**跨 mod 消费**
- `mods/diff/hooks/host/host.ts:121-129`（类型引用）、`mods/diff/hooks/register.ts:687-688`（绑定）、`mods/diff/hooks/record/recorder-of.ts`（行形状）、`mods/diff/hooks/record/safely/safely.ts`（降级）、`mods/diff/tests/record.test.ts`、`mods/diff/tests/register.test.ts`。
- `mods/README.md:84-112`（名词契约组合模型）、`mods/tsconfig.json:16`（跨 mod `include`）。

---

## 存疑与待确认

1. **`hooks/telemetry/types/` 不存在。** 任务假设中提到的 `types/` 与 `hooks/telemetry/types/` 双层，在代码里并不存在：`find` 结果显示契约只有 `mods/telemetry/types/index.d.ts` 一份，实现层用相对路径导入。已按实际分层描述。若存在其他版本/分支，需另行确认。
2. **通配 hook 与具体 hook 的执行顺序未在 mod 源码中直接可见。** 我据测试行为（`gate.test.ts` 中 gate 对敌对插件生效、collector 行仍被拒）推断 `telemetry.*`（gate）在 `telemetry.log`/`telemetry.mark` 之外层。该顺序由引擎 dispatch 决定，mod 源码未显式声明——需对照引擎 hook 派发实现确认。
3. **`INGEST_URL` 硬编码生产地址**（`entries/ingest-url.ts:8`）。注释称「另一 base 的会话 authorize 闸门已使其不发生」，但「authorize 如何隐含 base 约束」在 mod 内不可见，未验证。
4. **`to: 'collector'` 的落点不在本仓库。** 本 mod 只 `next(e)` 交给下面；collector 的最终处理方在引擎/操作者一侧，仓库内无实现，故「交给谁、怎么发」不可验证。
5. **`session.start` 是否总先于 `engine.create` 完成。** `isInteractive` 先取 `session.start` 的值，缺失时回退到 `session.surfaces()` 是否含 `'terminal'`（`register.ts:60-62`）。该回退到 `session.end`/`session.start` 的实际顺序，以及 resumable/多 surface 场景下的稳定性，未在 mod 内证实。
6. **`register.ts:56-362` 中约 130 个环境变量是逐字硬编码**（`USER_TYPE`、`GITHUB_*`、`SWE_BENCH_*`、`ConEmu*` 等），注释暗示这是移植 CLI 原生埋点列的结果。这些变量名的完整语义与来源不可从 `$` 类型导出，属「移植清单」，复刻时需逐项核对。
7. **`crypto.randomUUID`、`crypto.subtle`、`btoa` 被当全局使用**（`telemetry-of.ts:172`、`remote-hash-of/remote-hash-of.ts:22`、`metadata-of.ts:12`），未见注入或 polyfill；依赖插件运行时提供这些全局，未验证其在所有目标平台的可用性。
8. **无独立 redaction 模块。** 隐私完全依赖「Choice 闭集 + token 正则 + 敏感值只读是否设置 + remote 哈希」。是否还有引擎侧的二次脱敏，mod 内不可见。
9. **重试语义边界。** 只重试一次、固定 500ms、且对网络层「抛错」也重试（`postedWithRetry` 中 `catch { first = undefined }` 后同样进入重试）。幂等性依赖 ingest 端按 `eventId` 去重；本 mod 不生成去重键之外的东西。该假设需对照 ingest 端确认。
10. **`deploymentEnvironment` 的判定顺序**由 `DEPLOYMENTS` 数组顺序决定，文件信号（EC2/Docker）与变量信号合并后取首个命中（`deployment-of.ts:12-18`）。多信号同时成立的优先级即数组顺序，属实现约定而非规范。
