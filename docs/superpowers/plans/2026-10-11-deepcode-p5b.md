# DeepCode P5b 实施计划：指令文件五层优先级 + 托管下发

> **给执行者：** 逐任务做，任务级验收只跑 `pnpm typecheck`；**测试按检查点批量做**（用户长期指令：
> 一次校验多个任务，争取快速完成开发）。任务之间连续执行，不要停下来问。
>
> 上位文档：[`2026-10-11-deepcode-p5-design.md`](../specs/2026-10-11-deepcode-p5-design.md) §4。
> 同体例先例：[`2026-10-11-deepcode-p5a.md`](2026-10-11-deepcode-p5a.md)。

**目标**：指令文件从今天的三份扁平路径，长成与权限设置**同一张表**的五层；`managed` 那一层能
**下发指令内容**，而且个人层掀不翻它。

**今天的形状**（`mods/agents-md/instructions.ts`，P5a 搬进来的）：

```ts
const files = [
  join(deps.root, 'AGENTS.md'),
  join(deps.root, 'CLAUDE.md'),
  join(deps.home, '.deepcode', 'AGENTS.md'),
];
```

三份扁平、没有层名、没有本机层、托管层**完全不存在**。嵌套那层 P4a 已经做了（`nested.ts`，
惰性挂在 `Read` 的结果上，不进系统提示）。

---

## 1. 五层与顺序（判据先钉死）

| 层 | 谁写 | 路径 | 权限那边的对偶 |
| --- | --- | --- | --- |
| `project` | 这个仓库 | `<root>/AGENTS.md` · `<root>/CLAUDE.md` | `<root>/.deepcode/settings.json` |
| `local` | 这台机器上的这个仓库 | `<root>/.deepcode/AGENTS.md` · `<root>/.deepcode/CLAUDE.md` | `<root>/.deepcode/settings.local.json` |
| `user` | 你 | `~/.deepcode/AGENTS.md` | `~/.deepcode/settings.json` |
| `managed` | 组织 | 托管设置里的 `instructions` 段（文本 + 点名的文件） | `policy` 源 |
| 嵌套 | 约定 | `mods/agents-md/nested.ts`（P4a 已做） | —（它不是一层，是 `project` 按目录深度继续往外排） |

**送进模型那段文本的顺序 = 表自上而下**，即 `project → local → user → managed`。
理由一句话：**越贴近这个仓库的越靠前，托管那份压在最末 —— 它是权威，所以它最后说话。**
这也让 P5a 那条已有断言（"根 AGENTS → 根 CLAUDE → 用户层 AGENTS"）原样成立，不必改判词。

`local` 用 `.deepcode/` 而不是 `<root>/*.local.md`：`.deepcode/` 已经在 `.gitignore` 里
（`.gitignore:5`），"本机的东西不进版本库"这件事在那一个目录上已经说过了，不必再说第二遍。
与 `settings.local.json` 相比少一个 `.local.` 后缀 —— 那边要那个后缀是因为它**挨着**
`settings.json`（同一目录两个文件），指令文件没有这个歧义。

## 2. 托管下发（这一段是全部）

托管设置文件多认一个顶层键：

```json
{
  "instructions": {
    "text": "组织放进每一次系统提示的一段话（可省）",
    "files": ["/etc/deepcode/policy.md"]
  }
}
```

- `text` 在前，`files` 按给的顺序在后（顺序可预期才好被钉）；
- **只有 `policy` 层能写**。别的四层写了 → 整项丢弃 + 出声。这就是设计 §4.2 那句
  "把 managed 那一份写进个人规则里想覆盖它，结果是被忽略并被告知已丢弃"的落法，
  与 `sandbox.paths.allow`（只有托管层能设）、`plugins.enable`（托管层写会被丢）
  **同一条规矩、同一句判词形状**：让一份克隆下来的仓库文件往你每一次系统提示里塞一段话，
  正是"个人配置掀翻托管策略"的入场券。
- 点名的文件**读不动 / 不存在** → 吼一声、跳过那一段、**照旧返回**。组织配错了必须看得见
  （`defaultTextReader` 那条 fail-open 在哪儿落的第二处），但一行配置不该让整个 CLI 起不来。
- 形状错的处置沿用 `sandbox` 那一档（**块内降级 + 出声**，不废掉整份文件）：它不裁决任何动作，
  读不懂就不动，比"整层作废"少一次意外。

## 3. 边界规则（P5a 立的）怎么落

`mods/agents-md` 只许 import `src/contract/`，所以：

- **词表下沉契约**：新建 `src/contract/instructions.ts` 放 `INSTRUCTION_LAYERS` 与
  `ManagedInstruction`。CLI（`cli/settings.ts`）与 mod 两侧共用同一个说法
  （"同一件事只有一个说法"）。
- **路径表留在 mod**：哪几层读哪几个文件是 mod 自己的事（`node:path` 在契约里也不合适）。
- **托管内容以数据进来**：`ModDeps` 加一个**必填**的 `managedInstructions`。必填的理由与
  P5a 那条一样 —— 给默认 `[]` 的话，"忘了接线"会表现成"托管下发静默失效"而三条检查全绿。

---

## 任务

### Task 1：契约里的五层词表

**Files:** Create `src/contract/instructions.ts`

`INSTRUCTION_LAYERS = ['project','local','user','managed'] as const`（**数组顺序就是进提示的顺序**）、
`InstructionLayer`、`ManagedInstruction = { label, text }`。零 import（契约那格的白名单是空的）。
注释里写三件事：与权限五层的对偶表、嵌套不算一层、为什么这词表住在契约里。

### Task 2：`ModDeps` 加托管段

**Files:** Modify `src/contract/mod.ts`

```ts
/** 托管层下发的指令段（P5b）。与 `policyRules` 同一条：**只有托管层的话能到这儿**。 */
readonly managedInstructions: readonly ManagedInstruction[];
```

**必填**。这一条一加，`main.ts` / `test/harness.ts` / `test/mods.test.ts` / `test/cli.test.ts`
四处会红 —— 那正是它要的（"忘了接线"必须是个类型错）。

### Task 3：`settings.ts` 读 `instructions` 段

**Files:** Modify `src/cli/settings.ts`

1. `import type { ManagedInstruction } from '../contract/instructions';`
2. `KNOWN_TOP_LEVEL` 加 `'instructions'`（漏了就是给用户发一条假警告："不认识的顶层键"）。
3. `ResolvedPolicy` 加 `readonly instructions: readonly ManagedInstruction[]`。
4. 新函数 `readInstructions(value, layer, where, warn, readText)`，见 §2。
5. `LayerRead` 加 `instructions` 字段；`readLayer` 里 **`await` 调用它，且必须在
   `permissions` 的早期 return 之前** —— 一份只写 `instructions`、没有 `permissions` 的托管设置
   不该被丢掉（`plugins` 那一格踩过同一个坑，注释已经写在那儿了）。
   `readLayer` 的四个 return 都要带上这个字段。
6. `resolvePolicy` 里收 `instructionLayers.get('policy') ?? []` 进快照。

### Task 4：mod 改成五层

**Files:** Modify `mods/agents-md/instructions.ts`、`mods/agents-md/index.ts`

`InstructionsDeps` 加 `readonly managed: readonly ManagedInstruction[]`；
路径表按 §1 的顺序排成 `{ layer, path }`（层名进注释，供人对着表读）；读盘循环原样
（`ENOENT` 才算"没有"，其余抛出去 —— 那段注释保留）；托管那几段拼在最后：

```ts
for (const item of deps.managed) {
  parts.push(`托管下发的指令（${item.label}）：\n\n${item.text}`);
}
```

`index.ts` 把 `deps.managedInstructions` 传进去。

### Task 5：接线与测试脚手架

**Files:** Modify `src/cli/main.ts`、`test/harness.ts`、`test/mods.test.ts`、`test/cli.test.ts`

- `main.ts`：`loadMods` 的 deps 加 `managedInstructions: policy.instructions`。
- `harness.ts`：`modPlugins` 的默认 deps 加 `managedInstructions: []`。
- `test/mods.test.ts` 的 `DEPS`、`test/cli.test.ts` 的 `registered()` 各补一处。

### Task 6：测试（三个文件）

**Files:** Modify `test/settings.test.ts`、`mods/agents-md/test/instructions.test.ts`、
`test/plugin-wiring.test.ts`

`test/settings.test.ts` 新 describe 「instructions 段：只有托管层能下发」：

1. 托管层 `text + files` → 两条，`text` 在前、files 在后，`label` 是出处，**零警告**；
2. `user` / `project` / `local` 三层各写一次 → `instructions` 为空 **且** 出声（判词含"只有托管层"）；
3. 顶层键 `instructions` 不再触发"不认识的顶层键"；
4. 点名的文件不存在 → 出声（含那个路径）、跳过，另一条照收；
5. 点名的文件读不动（`readText` 抛）→ 出声、跳过，`resolvePolicy` 照旧返回；
6. 一份**只写了 `instructions`** 的托管设置照样收得下（早期 return 那个坑）。

`mods/agents-md/test/instructions.test.ts` 新 describe（自建临时树，**不动** 既有的
`beforeAll`，那五条断言原样留着当回归）：

7. 项目 → 本机 → 用户 → 托管 的顺序，用 `indexOf` 排一遍（顺序断了必须红）；
8. 没下发时那个字节都不多；下发时带出处。

`test/plugin-wiring.test.ts`：`modPlugins({ managedInstructions: [...] })` 之后
`prompt.section` 里真的能读到那段话 —— 证明 `ModDeps` 这条路是通的。

### Task 7：文档同步

**Files:** Modify `README.md`、`docs/项目简介.md`、`site/index.html`、
`docs/superpowers/specs/2026-10-11-deepcode-p5-design.md`（§4 补一句 `.deepcode/` 的取名理由）

README 的指令文件那一节补上五层表与 `instructions` 段；项目简介与官网的 P5 一行从
"P5a 已完成"进到"P5b 已完成"；测试数与用例数按实测改。

---

## 检查点

### C1（Task 1-3）：契约 + 设置层
`pnpm typecheck` + `pnpm vitest run test/settings.test.ts`

### C2（Task 4-6）：mod + 接线 + 测试
`pnpm typecheck` + `pnpm vitest run mods/agents-md test/plugin-wiring.test.ts test/mods.test.ts test/cli.test.ts`

### C3：全量三绿 + 反向验证
`pnpm typecheck && pnpm lint && pnpm test`，然后**逐条把断言改坏、确认它真的红**，再还原
（备份到 `/tmp/*.bak`，改完先 `grep` 确认变异落地）：

| # | 变异 | 必须红的是 |
| --- | --- | --- |
| 1 | 拿掉 `readInstructions` 里 `layer.source !== 'policy'` 那一守 | 第 2 条（个人层写 `instructions` 被丢弃）—— 否则"个人掀不翻托管"是摆设 |
| 2 | 把 `await readInstructions(...)` 挪到 `permissions` 的早期 return **之后** | 第 6 条（只写 `instructions` 的托管文件收不下） |
| 3 | 删掉 mod 里托管那段的 `for` 循环 | 第 7、8 条与 plugin-wiring 那条 |
| 4 | 把 `INSTRUCTION_LAYERS` 的顺序倒过来（顺序表反过来拼） | 第 7 条 |
| 5 | `ModDeps.managedInstructions` 改成可选 | `pnpm typecheck` 必须**不红**（那是刻意的：可选就等于允许"忘了接线"，这一条是反过来验的类型断言，不改代码，只记录） |

最后跑一遍全量三绿，把测试数同步进 README / 项目简介 / 官网，提交。

## 刻意不做

- **`/instructions` 命令**：设计 §4.2 的判据都能在 `prompt.section` 上验，多一条命令就多一处
  要维护的输出格式（P4d 的"零消费者"那条判定同一条）。
- **不做 `managed` 层的"关掉其余四层"开关**：设计 §4 没要求，而一个能关掉项目指令的托管开关
  今天没有消费者。
- **不做 `local` 层的通配 `*.md`**：点名两个文件名胜过扫一个目录（往 `.deepcode/` 里扔一个
  临时 `.md` 不该悄悄进提示）。
