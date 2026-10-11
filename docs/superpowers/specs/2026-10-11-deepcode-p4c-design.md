# DeepCode —— P4c-1 分发设计（marketplace 与安装）

> 施工说明书。上位文档是 [`2026-10-11-deepcode-mvp-design.md`](2026-10-11-deepcode-mvp-design.md) §9，
> 分组依据是 [`2026-10-11-deepcode-p4a-design.md`](2026-10-11-deepcode-p4a-design.md) §17，
> 同体例的先例是 [`2026-10-11-deepcode-p4e-design.md`](2026-10-11-deepcode-p4e-design.md)。

**一句话**：给插件系统补上「装进来」这一步 —— 从一份**本地索引**把插件拷进一个**不自动装载的落点**。
装与启用是两件事，而能开这道闸的只有用户自己。

---

## 0. 决策摘要

1. **本轮只吃 P4c 的一片**。P4a §17 把 P4c 定成三样：marketplace、hookify DSL、
   `config.*` 与 `command.describe`。这三样不共享代码也不共享数据（前者是分发，中者是规则求值，
   后者是事件目录补格），一次 spec 装不下。**本轮只做 marketplace 与安装**，
   另外两片各自另开一轮。阶段名「分发与治理」因此只兑现了一半 —— 这一点写在 §9，不藏。

2. **装 ≠ 启用**。落点 `~/.deepcode/installed/<名>/` **不参与自动发现**。
   要它跑，得在**用户级**设置里显式写 `plugins.enable`。
   这与既有两级的语义**不冲突也不改**：`~/.deepcode/plugins/`（自己放的）仍然自动装载。

3. **能开这道闸的只有用户层**。装进来的插件只认 `~/.deepcode/settings.json` 里的
   `plugins.enable`，**项目的 project / local 层管不着它**。
   这条不是洁癖，是堵一条本设计**会新造出来**的路径：把一个落点目录也纳入同一个名单之后，
   别人仓库里的 `settings.json` 就能按名字点亮你全局装的插件 ——
   而仓库作者想启用的是它自己那份，可能在你这次克隆里压根不存在。

4. **`PLUGIN_ENABLE_SOURCES` 不动**。它是 `['project','local','flag']`
   （`src/cli/settings.ts:38`），注释写着「少了 `user`：用户级目录本来就自动装载，写 enable 是没用的」。
   那句话在装了 marketplace 之后只对**旧目录**成立。做法是**另加**一个只取用户层的名单
   （`ResolvedPolicy.plugins.enableByUser`），而不是把 `user` 塞进那个常量 ——
   塞进去会顺带让**你的**用户设置能点亮**别人仓库里**的插件，那是另一个方向的回归。

5. **索引格式刻意比参考实现小**。参考的条目是 `name/description/source/category` 加可选
   `version/author`（`claude-code-架构分析/02-plugin-system.md:89-93`）。我们砍到
   `name/description/source`：没有浏览 UI，`category` 没有消费者；版本与升级整条线不在本轮。
   砍掉字段是**可在 P5 加回来**的，先加后删不是。

6. **`source` 走既有的 `isSafeRelativePath`**（`src/contract/plugin-manifest.ts:105`）。
   清单校验用的就是这一条（`./` 开头、不含 `..`、不含反斜杠），读索引不该另立一套。

7. **装之前跑既有的 `validatePlugin`，并把整份报告打出来，包括它要跑的命令原文**。
   `plugin validate` 今天就在做这件事，理由写在 `src/cli/plugin-command.ts:15-17`：
   装一个插件 = 信任它，而能做到的下限是让你在装之前看见它想跑什么。

8. **CLI 动词是 `add` / `remove`，不是第二个 `install`**。
   `src/cli/plugin-dir.ts:199` 已经有一个 `installPlugins()`，它干的是**装载**（import 入口模块）。
   两个 `install` 各说各话是这个代码库里最容易让新读者搞反的一处，所以顺手改名
   `installPlugins` → `loadPlugins`（§6）。

9. **`plugin add` / `remove` 不替用户改设置**。它只打印那行要手抄的名字。
   一条命令替你把代码放行，与项目禁掉 `--yes` 是同一条理由（「谁加自动放行开关谁就是在开倒车」）。

10. **不引网络**。不 fetch、不 clone、不 HTTP：marketplace 永远是本地目录。
    MVP §9.4 已经把「marketplace 的托管服务」明确排除（`mvp-design.md:461`），
    而「本地索引格式」是 MVP 允许的那一半。引网络进 CLI 是另一个量级的事。

11. **签名与校验和不做**。没有可信密钥体系时做一个假的比不做更糟。
    本设计对「凭什么是可信的」的回答不是**验证来源**，而是三道能用眼睛看的闸：
    装只把文件放好、启用是另一道闸、而那道闸只有你自己能开。

12. **落盘要原子**：拷到 `<名>.tmp/` 再 `rename`。理由见 §5 —— 一次中断留下半个插件目录，
    而它下次会被当成一个坏插件报出来。

---

## 1. 出口标准怎么落

MVP §9.2 的 P4 行出口标准是子代理路由（P4a 已兑现），P4c 没有自己的出口标准行 ——
它来自 P4a §17 的分组。所以本轮的判据自定，且必须**可端到端验证**：

> 仓库根自带一份 marketplace；在一台干净的 HOME 上，
> 一条 `plugin add` 把插件放好而**它不跑**，写一行**用户级**设置之后它才跑。
> 同一个名字写在**项目级**设置里，**必须仍然不跑**。

最后半句是承重墙：它是决策 3 的**可执行的**形式，也是这一轮唯一一个「不做就会静默错」的地方。

**怎么判定做够了**：每条断言都要能反向弄红一次（§8）。任一条红不出来，
说明那条断言是摆设 —— 修断言本身，不是改设计（与 P4b / P4e 同一口径）。

---

## 2. 索引格式与校验

### 2.1 文件位置与形状

`<marketplace 根>/.deepcode-plugin/marketplace.json`：

```json
{
  "name": "deepcode",
  "description": "DeepCode 自带的插件",
  "plugins": [
    { "name": "todo", "description": "加一个 TodoWrite 工具", "source": "./plugins/todo" }
  ]
}
```

`.deepcode-plugin/` 这层点目录是照参考实现的 `.claude-plugin/` 取的。
P3 设计（`p3-design.md:562-563`）拒绝过那层嵌套，理由是「参考的插件目录**同时充当** marketplace 根」——
那条拒绝针对的是**插件目录**，不是 marketplace 根。这里两者是分开的：
marketplace 根是个普通目录，里面一个索引 + 若干插件目录（`./plugins/todo`）**并列**。

### 2.2 新文件 `src/contract/marketplace.ts`

**与 `src/contract/plugin-manifest.ts` 同形**：纯逻辑，所有读取都从外面注入，
于是它能在没有文件系统的地方跑，也能被 `plugin add` 与将来的任何消费者**共用同一份实现**。

**注入什么，是被依赖边界逼出来的**：`check-boundaries.mjs:18-24` 的规则表里
`contract: []` —— `contract/` 不许 import `src/` 下的任何顶层目录。而读索引与读某个
`source` 下的插件目录都要造一个 `PluginReader`，那个工厂（`dirReader`）在
`src/cli/plugin-dir.ts:73`。所以它**不能**自己拼路径，只能收一个工厂：

```ts
export type MarketplaceDeps = {
  /** 读索引本身。读不到返回 undefined（不存在是常态）。 */
  readonly readIndex: () => Promise<string | undefined>;
  /** 把某个 source 打开成一个插件目录读取面，交给 validatePlugin 用。 */
  readonly openPlugin: (source: string) => PluginReader;
};

export async function validateMarketplace(
  root: string,
  deps: MarketplaceDeps,
): Promise<ValidatedMarketplace>;

/** 与 `Validated`（plugin-manifest.ts:54-64）同形的两级结果。 */
export type ValidatedMarketplace = {
  readonly problems: readonly Problem[];
  /** 有没有 E 级问题。false = 这份索引不可用。 */
  readonly ok: boolean;
  /** 全绿时的条目表（名字已与清单核对过）。有 E 时是 undefined。 */
  readonly entries: readonly MarketplaceEntry[] | undefined;
};

export type MarketplaceEntry = {
  readonly name: string;
  readonly description: string | undefined;
  /** 通过 `isSafeRelativePath` 的原始写法，如 `./plugins/todo`。 */
  readonly source: string;
  /** 那份清单归一之后的形状 —— `plugin add` 要拿它打报告，不必再校验一次。 */
  readonly manifest: PluginManifest;
};
```

`root` 只用于组给人看的标签（「这份索引在 …」），不用于拼路径 —— 拼路径是注入方的活。

判据与代号：

| 代号 | 判据 | 级别 |
| --- | --- | --- |
| `M1` | `marketplace.json` 读得到、是合法 JSON、顶层是对象 | E |
| `M2` | `name` 必填且是合法插件名（复用 `isPluginName`） | E |
| `M3` | `plugins` 必须是数组，且非空 | E |
| `M4` | 每条 `name` 必填、是合法插件名、**在本索引内不重复** | E |
| `M5` | 每条 `source` 必填、通过 `isSafeRelativePath` | E |
| `M6` | 每条 `source` 打开之后，那份插件清单**过得了 `validatePlugin`** | E |
| `M7` | `description` 写了就是字符串 | E |
| `M8` | 索引条目的 `name` 必须与那份清单里的 `name` **一致** | E |
| `W1` | 未识别的顶层字段或条目字段 | W |

**`M8` 是踩过的那类坑**：不一致的话，`plugin list` 显示的名字与 `plugins.enable` 要写的名字
对不上，而这件事**是静默的** —— 你照着 `list` 写 enable，然后插件不生效，
没有一条报错解释为什么。

**`M6` 不另写规则，直接调 `validatePlugin`**（这是「共用同一份实现」那句的具体形式）：
它返回的 E 级问题原样带进索引的判据里，理由文案里带上 `source` 路径让人知道是哪一条。
顺带一个收益：**「source 指向的目录根本不存在」不需要单独的规则** ——
`validatePlugin` 的 `E2`（`plugin-manifest.ts:148-151`「没有 plugin.json」）已经覆盖了它，
而且它的措辞在那个场景下恰好是对的。

所以校验函数是 `async`（同 `validatePlugin`：`M6` 要读盘）。

---

## 3. 落点与发现层

### 3.1 第三个 origin

`src/cli/plugin-dir.ts` 的改动集中在一处结构上：`roots` 表（`:105-113`）加一行。

| origin | 目录 | 装载条件 |
| --- | --- | --- |
| `project` | `<工作目录>/.deepcode/plugins/` | 要在 `plugins.enable` 里（**不变**） |
| `user` | `~/.deepcode/plugins/` | 自动装载（**不变**） |
| `installed` | `~/.deepcode/installed/` | 要在**用户层**的 `plugins.enable` 里（新） |

`USER_DIR`（`:65`，`['.deepcode','plugins']`）保持不变，另加一个常量
`INSTALLED_DIR = ['.deepcode','installed']`。两个常量分开写，因为它们是**两个目录**，
而现在这个常量名（`USER_DIR`）被同时用于 project 与 user 两条路径这件事本身就已经容易读错。

**顺序：project > user > installed。** 既有两级的相对顺序与语义一个字不改；
中介最多的那个来源排最后 —— 同名冲突时，更**直接**的那个赢
（`claimed` 表 `:152-161` 已经在做这件事，不要动它的语义）。

### 3.2 闸门分家：`enabledInstalled?`

`DiscoverDeps`（`:53-63`）加一个**可选**字段：

```ts
/**
 * 装进来的那一层要哪几个名字启用。**只认用户层**，理由见设计 §0 决策 3。
 * 不给就是空 —— 一个都不启用。默认值必须是"什么都不开"。
 */
readonly enabledInstalled?: readonly string[];
```

可选而非必填，有两个理由：默认值 fail-closed（不给 = 不开），
以及 `test/plugin-dir.test.ts` 里十几处 `{ ...world, enabled: [] }` 的调用点不用全改。

闸门条件由 `origin === 'project'`（`:142`）扩成 `origin !== 'user'`，
但**理由文案要分两种** —— 两种情况的解法不同，写同一句就是让人照着做却做不成：

- project 层：`项目级插件要显式启用：在 .deepcode/settings.json 里写 plugins.enable: ["todo"]`
- installed 层：`装进来的插件只能由用户级设置启用：在 ~/.deepcode/settings.json 里写 plugins.enable: ["todo"]（项目级设置里写同一个名字不算数）`

### 3.3 那一串名字从哪来

`src/cli/settings.ts` 的 `ResolvedPolicy.plugins`（`:102`）加一个字段：

```ts
readonly plugins: {
  readonly enable: readonly PluginRule[];      // 不变：project / local / flag
  readonly enableByUser: readonly string[];    // 新：只取 user 层的名字
  readonly deny: readonly PluginRule[];
};
```

`enableByUser` 从 `pluginsBySource.get('user')?.enable ?? []` 取，**不**经过
`PLUGIN_ENABLE_SOURCES`（决策 4）。`PluginsLayer` 已经是每层都读的结构（`:183-191`），
所以这只是把一份已经读进来的东西导出去，不新增任何读盘。

`src/cli/main.ts` 侧：`:103` 与 `:208` 那两处 `policy.plugins.enable.map((rule) => rule.name)`
保持不变（那是给 project 层的），`discoverPlugins` 的调用加 `enabledInstalled: policy.plugins.enableByUser`。

### 3.4 `deny` 不用改

`plugins.deny` 走的是**另一条路**：`main.ts:249` → `cli/plugins.ts:134`
`createPluginGuardPlugin({ deny, firstParty: names })`。装进来的插件不在 `firstParty` 里，
所以五层里任何一层写下的 `deny` 对它**已经生效**。这一条要在计划里用一条测试**确认**，不是假设。

---

## 4. CLI

### 4.1 动词与参数

```
deepcode plugin list                                  列出装上的 / 装进来的 / 跳过的
deepcode plugin validate <目录>                        只校验一份清单，不执行任何代码
deepcode plugin add <名字> --from=<目录>               从一份本地索引装进来
deepcode plugin remove <名字>                          从落点删掉
```

`--from` **只认等号形式**（`--from=<目录>`），先例是 `--resume=`（`args.ts:26`）与
`--settings=`（`args.ts:29`）：一个指向路径的开关，裸写没法跟位置参数区分开。
`<名字>` 与 `validate <目录>` 一样是位置参数。

`parsePluginCommand`（`args.ts:87-94`）扩 `add` / `remove` 两个词。
它「只在第一个非开关 token 上、且第二个词是子命令名才认」的规矩不改 ——
`deepcode plugin 系统怎么写` 仍然是一句正经提问，不是报错（`:36-38` 的既有约定）。

### 4.2 `plugin add` 的六步

1. **读索引** → 按名字找条目。**找不到就把这份索引里有的名字列出来** ——
   一次 typo 教会你有哪些可选，于是不需要单独的 `plugin search` 命令（YAGNI）。
2. **校验 source 指向的目录**：跑**既有的** `validatePlugin(source 目录, dirReader(...))`。
3. **打报告**：复用 `plugin-command.ts` 现有的 `renderProblems` / `renderManifest` /
   `renderHooks`。**`renderHooks` 那一屏是这里最要紧的东西** —— 它把 `hooks.json` 里的命令
   **原文**打出来。装一个插件 = 信任它在你的进程里跑，而这一步能做到的下限就是让你先看见它想跑什么。
4. **要写盘之前，任何 E 级问题都要中止**：非零退出码，**一个字节都不写**。
5. **目标已存在就拒绝**：`~/.deepcode/installed/<名>/` 在 → 报错、非零码、告诉对方先 `plugin remove`。
   不做 `--force`（多一个开关，而且「覆盖掉的到底是什么」不容易看），不做幂等同步
   （那会把「装」与「升级」挤进同一个动词）。
6. **落盘**（§5），然后打两行：落到哪、以及那行要手抄进**用户级**设置的名字。

`plugin add` 排在 `main.ts:88-90` 的 `action.kind === 'plugin'` 分支里 ——
那一段在**读配置、要 key 之前**，所以它零密钥可跑，能进 CI（P4e 刚建起来的那条流水线）。

### 4.3 `plugin remove`

只删落点里那一个目录。不存在 → 非零码 + 说不存在。
**不碰设置**，但要把话说全：名字还在 `plugins.enable` 里的话，那一行现在指向一个不存在的东西，
下次装载会报「已启用但没找到」—— 提示对方顺手删掉。

### 4.4 `plugin list` 加一节

现在两节：装上来的 / 跳过的（`plugin-command.ts:88-114`）。中间插一节 **「装进来的」**，
逐条标**启用与否**；未启用的那一条，原因就是 §3.2 那句用户级设置的话。

它单独占一节而不是并进「跳过的」，因为「装了但还没启用」是一个**正常状态**，不是错误 ——
把它混进错误列表会让人觉得装坏了。

### 4.5 help 要改

`PLUGIN_HELP`（`:55-66`）今天在讲「装在哪」只有两个目录。加第三个，并且
**把「装 ≠ 启用」和「只有用户级能启用」这两句话写进去**。这个 help 是用户唯一会读到的地方。

---

## 5. 落盘要原子

```
拷 <source> → ~/.deepcode/.installed-staging/<名>/     （fs.cp, recursive）
rename ~/.deepcode/.installed-staging/<名> → ~/.deepcode/installed/<名>
失败：删掉暂存目录，报错，非零码
```

不做这一手的话，一次中断（Ctrl-C、磁盘满、权限失败）会留下**半个插件目录**，
而它下次会被发现层当成一个坏插件报出来 —— 到那时没人知道那半个目录是从哪来的。
这一段的成本是十几行，比它挡掉的那类 bug 便宜得多。

**暂存目录为什么是 `~/.deepcode/.installed-staging/` 而不是落点里的 `<名>.tmp/`**：
这一处我原本的直觉是错的，核过之后改了。`subdirectories()`
（`src/cli/walkdir.ts:38-49`）的过滤条件**只有 `entry.isDirectory()`，没有任何名字规则** ——
它不排点开头、不排 `.tmp`、什么都不排。所以：

- 落点里的 `<名>.tmp/` 在拷贝窗口内**会**被 `plugin list` 当成一个插件目录扫到，
  报成一条「坏清单」。名字里带 `.tmp` 一点保护都没有。
- `~/.deepcode/installed/.staging/<名>/` 同样不行：`.staging` 本身是落点的一个子目录，
  它会被枚举，然后被当成一个没有 `plugin.json` 的插件报出来。

所以暂存目录必须是**落点的兄弟节点**（`~/.deepcode/` 下），那个位置没有任何东西在枚举。
选它还因为它与落点**同一个文件系统**（都在 `~/.deepcode/` 下），于是 `rename` 是真原子动作 ——
换成系统临时目录就会退化成跨设备的拷贝，那还不如不原子。

符号链接：`fs.cp` 的 `dereference: false`（原样拷，不跟随）。不做额外处理，
理由是插件本来就是「以你的身份跑的代码」—— 它读得到的东西你本来也读得到，
符号链接换不来任何新权限。这一句写在这里，因为它是有人一定会问的那类问题。

---

## 6. 命名：`installPlugins` → `loadPlugins`

`src/cli/plugin-dir.ts:199` 的 `installPlugins()` 与新的 CLI 动词 `add` 指的不是同一件事：

- `installPlugins`：把**已经发现**的插件变成 `Plugin`（import 入口模块、合流 hooks）——**装载**。
- `deepcode plugin add`：把文件从 marketplace **拷进落点** ——**安装**。

同一个词在这个代码库里有两个意思，而这两个意思的差别恰好是「代码有没有开始跑」——
这是最不该含混的一处。所以改名 `loadPlugins`，并同步该文件头部注释（`:16`、`:21`）
与 `src/core/create.ts:22` 里引用它的那句注释。

改动面约 10 处（`main.ts` 三处、`plugin-dir.ts` 自身注释三处、`create.ts` 注释一处、
`test/plugin-dir.test.ts` 三处）。纯机械，零行为变化。

---

## 7. 风险

1. **测试绝不能碰真实 HOME**。`plugin add` 会往 `~/.deepcode/` 写东西；
   一条没隔离的用例会改掉开发机上真实装着的插件。
   `test/cli.test.ts` 已有把 `USERPROFILE` 指向一个不存在目录的先例 —— 本轮沿用，
   并且**每个用例自己的临时 HOME**（`mkdtemp`），不是共享一个。
2. **`installed` 与 `user` 两个目录都在 `~/.deepcode/` 下**，差一个词。
   在代码里它们由两个常量分管（§3.1），在输出里要写全路径，不能只写「用户级」。
3. **`.deepcode-plugin/` 是仓库根新增的一个点目录**。三个检查器都不看它
   （`check-boundaries` 只看 `src/` 与 `plugins/`，`tsc` 的 include 是 `["src","test","scripts"]`），
   所以它对本轮既有的三条命令零影响 —— 跑一遍确认。
4. **发现层的改动碰到的是 P3 的核心路径**。`test/plugin-dir.test.ts` 有十几处调用点，
   闸门条件从 `origin === 'project'` 改成 `origin !== 'user'` 时，
   既有用例**必须一条不改地继续绿** —— 那是「既有两级的语义一个字不改」的可执行形式。
5. **`M8`（索引名字与清单名字一致）在真实仓库里没有反例**：`plugins/todo/plugin.json` 的
   `name` 是 `todo`，索引里也写 `todo`。所以它只能靠**临时树**的测试行使，
   真仓库上它是绿的但没被行使 —— 这一点要在计划的预登记表里点名。

---

## 8. 验收标准

任务级只跑 `pnpm typecheck`（沿用长期口径）。测试按检查点批量做。

### C1：索引校验 + 发现层（纯单元）

- `test/marketplace.test.ts` 新建，正反成对：`M1`–`M8` 每条至少一正一反，
  反向那条**钉具体判词**，不是「非空即过」。
- `test/plugin-dir.test.ts`：既有用例**一条不改**地继续绿；
  新增三类 —— `installed` 层不给 `enabledInstalled` 就一个都不装载、
  给了就装载、同名时 `user` 赢过 `installed`。
- `pnpm lint` 仍然两句判词都在（`installed` 目录不引入新的裸包名依赖）。

### C2：CLI 端到端

- `test/cli.test.ts` 扩一整个 describe：临时 HOME + 临时 marketplace，
  真跑 `bin/deepcode.mjs`：`plugin add` → 落点里真有那些文件 → `plugin list` 显示为未启用 →
  改设置 → 再跑一次能看到它装载。**全程零密钥。**
- 至少两条反向验证必须真红：
  1. 索引里的 `source` 写成 `../x` → `add` 非零码，且**落点里什么都没多出来**。
  2. **项目级**设置里写上那个名字 → 仍然**不装载**（决策 3 的可执行形式）。
- 手工过一遍：`plugin add` 出来的报告里，**`hooks.json` 的命令原文真的在**。

### 收口

- 文档：`README.md`（开发一节旁边的插件段）、`docs/项目简介.md`、
  `site/index.html` 的 P4 路线图卡（P4c-1 落地）与已知限制（marketplace 只做本地索引、
  没有升级与签名）。
- 计划末尾的「与预登记的对照」表填完，尤其是 §7.5 那条。

---

## 9. 已知偏差与存疑

1. **这一轮只兑现了「分发」，没兑现「治理」**。P4c 的名字是「分发与治理」，
   而 hookify DSL 与 `config.*` / `command.describe` 留在后面。
   阶段名在文档与官网里都要如实写，不能让「P4c 已完成」读成这三样都做了。
2. **`enableByUser` 是本设计新造的一个不对称**：用户层在**别的**场景下写 `enable` 是无效的
   （`PLUGIN_ENABLE_SOURCES` 把它排除在外），而在这里它是**唯一**有效的一层。
   这个不对称是决策 3 的代价，不是疏漏。它是可以解释的（一个落点目录 + 一层唯一能信任的来源），
   但必须写进 `settings.ts` 的常量注释里，否则下一个人会把它当成 bug 修掉。
3. **`M2` 复用 `isPluginName` 意味着 marketplace 的名字也必须 kebab-case**。
   参考实现的 `name` 也是一样的约束，但参考里**有条目违反它**（`plugin-dev` 缺清单）——
   我们选择严格：索引里的名字是 `plugins.enable` 要写的那串字，它必须与清单校验同一套规则。
4. **落点的名字 `installed` 与 origin 的名字相同**（`~/.deepcode/installed/` ↔ `'installed'`）。
   特意选的：读代码时两个词指的是同一件事，不用在脑子里做一次映射。
   代价是它与 `user` 在字面上都是「装上的」，所以输出里一律带全路径（§7.2）。
5. **一处被核掉的错误直觉**（留在这里，因为它是这条设计的实际来源）：
   我原本假定「暂存目录名带 `.tmp` 就不会被发现层扫到」，核过 `walkdir.ts:38-49` 之后
   发现 `subdirectories()` 只判 `isDirectory()`、没有任何名字过滤 —— 直觉是错的，
   暂存目录因此挪到了落点的兄弟位置（§5）。**已解决，不是遗留项**；写在这里是因为
   下一轮再有人想往落点里塞临时目录时，会重新踩一次。

---

## 10. 明确不做

- **任何网络**：不 fetch、不 clone、不 HTTP、不引 git 依赖。marketplace 永远是本地目录。
- **marketplace 托管服务**（MVP §9.4 已明确排除）。
- **`plugin update` / 版本解析 / 依赖解析**：升级 = `remove` + `add`。
- **签名与校验和**：没有可信密钥体系（决策 11）。
- **`--force` 覆盖**：先 `remove`（决策见 §4.2 第 5 步）。
- **`plugin search` / 浏览 UI**：`add` 找不到名字时列出可选名字，够用了。
- **`plugin add` 自动写设置**（决策 9）。
- **装到项目级落点**：`plugin add` 只写 `~/.deepcode/installed/`。要把一个插件带进某个仓库，
  那是那个仓库自己的 `.deepcode/plugins/`，与 marketplace 是两件事。
- **hookify DSL 与 `config.*` / `command.describe`**：P4c 的另外两片，各走一轮（决策 1）。

---

## 11. 关键文件索引

**要新建**

- `src/contract/marketplace.ts` —— 索引 schema + 纯校验（`M1`–`M8` / `W1`）
- `test/marketplace.test.ts`
- `.deepcode-plugin/marketplace.json` —— 仓库自己当一份 marketplace，列 `todo` 与 `secret-guard`

**要改**

- `src/cli/plugin-dir.ts` —— `INSTALLED_DIR`（:65 旁）、`roots`（:105-113）、
  闸门条件与两种理由文案（:142）、`DiscoverDeps.enabledInstalled?`（:53-63）、
  `installPlugins`→`loadPlugins`（:199）
- `src/cli/plugin-command.ts` —— `add` / `remove` 两个分支（:33-53）、`list` 第三节（:88-114）、
  `PLUGIN_HELP`（:55-66）
- `src/cli/args.ts` —— `StartupAction` 的插件分支（:16-18）、`parsePluginCommand`（:87-94）
- `src/cli/settings.ts` —— `ResolvedPolicy.plugins.enableByUser`（:102、:230-238）、
  `PLUGIN_ENABLE_SOURCES` 的注释（:31-38，**常量本身不动**）
- `src/cli/main.ts` —— `enabledInstalled` 接线（:205-208）、改名后的 import（:20、:211）
- `src/core/create.ts` —— :22 注释里的函数名
- `test/plugin-dir.test.ts`、`test/cli.test.ts`
- `README.md`、`docs/项目简介.md`、`site/index.html`

**要读的先例**

- 纯逻辑 + reader 注入的校验器：`src/contract/plugin-manifest.ts`（全篇，尤其 `:105-117`；
  返回值同形的 `Validated` 在 `:54-64`）
- **`contract/` 不许 import 任何 src 顶层目录**：`scripts/check-boundaries.mjs:18-24`
  —— §2.2 那个注入形状的直接来源
- 两段式（读清单 / 执行代码）的分界与理由：`src/cli/plugin-dir.ts:11-24`
- 「装之前让人看见它想跑什么」：`src/cli/plugin-command.ts:8-18`
- 目录枚举**没有任何名字过滤**：`src/cli/walkdir.ts:38-49`（§5 那个改动的直接来源）
- 设置分层的来源标记：`src/cli/settings.ts:17-21`、`:229-238`
- 只认等号形式的开关：`src/cli/args.ts:25-29`
- 参考实现的 marketplace schema：`claude-code-架构分析/02-plugin-system.md:89-93`、`:274`
