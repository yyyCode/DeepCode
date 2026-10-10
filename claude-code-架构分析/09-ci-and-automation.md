# 09 · Claude Code 的 GitHub / CI 集成与仓库自动化

> 分析对象：`anthropics/claude-code` 公开仓库中的 `.github/`、`scripts/`、`.claude/commands/`。
> 本文件描述其 CI/自动化层的架构、契约与安全模型，供复刻同类产品时参考。
> 除本文件外，未修改仓库任何内容。所有引用均为仓库相对路径 + 行号。

---

## 定位

本模块是 Claude Code 仓库**自身的运营自动化层**，而不是 Claude Code 引擎源码。它承担两类彼此正交的职责：

1. **CI agent 集成**：在 GitHub Actions 里以无人（headless）方式运行 Claude Code，把 `@claude`
   提及、新 issue、评论等事件转成一次受控的 Claude 会话。核心载体是
   `.github/workflows/claude.yml:34-48` 中的 `anthropics/claude-code-action@v1`。
2. **issue 生命周期自动化**：用纯脚本 + 定时任务（无模型）对 issue 做标签、提醒、过期关闭、
   去重关闭。核心载体是 `scripts/` 下的 Bun 脚本与 `.github/workflows/*.yml`。

两者共享同一套**安全硬化方案**（见下文），这是本仓库最值得复刻的部分：凡是"调用 Claude 的 job"
必须落在三件套约束下，且由 `.github/scripts/check_workflow_hardening.py` 强制校验。

仓库根 `CLAUDE.md` 明确写出这条策略的定位：

> Workflow jobs in this repository that call Claude run with three protections.

---

## 职责与边界

**职责**

- 把 GitHub 事件（`issue_comment`、`issues`、`pull_request_review*` 等）映射为 Claude 会话或脚本任务。
- 提供 issue 分流（triage）、去重（dedupe）、过期关闭（sweep）、重复评论回填（backfill）等状态机。
- 以最小权限 `permissions:` 与出口防火墙限制 job 能力。
- 用 `check_workflow_hardening.py` 作为"护栏的护栏"，在 PR/push 时静态校验工作流。

**边界（本模块不做的事）**

- 不实现 Claude 引擎本身；`mods/types/claude-code.d.ts` 只是类型/接口的公开投影。
- 不构建/发布 npm 包：`mod-tests.yml` 仅做 `tsc` 类型检查与 `claude plugin test`，不发布。
- 不代替 AppSec 评审：`non-write-users-check.yml` 只**提醒**，不阻断合并。
- 出口防火墙的默认放行主机（GitHub 平台自身）不由本仓库定义，而由 GitHub 的 runner 提供。

---

## 关键抽象与接口

### 1. CI agent 调用契约（`claude-code-action@v1`）

所有调用 Claude 的 job 都通过 `anthropics/claude-code-action@v1`，并向它传一组 `with:` 输入。
可归纳为四类参数：

| 参数 | 含义 | 例证 |
| --- | --- | --- |
| 认证 | Workload Identity Federation：用 workflow 的 OIDC token 换短期 API token，替代静态 API Key | `.github/workflows/claude.yml:41-44` |
| 提示 | `prompt:` 直接给定，或触发仓库本地 slash command | `.github/workflows/claude-issue-triage.yml:40`、`claude-dedupe-issues.yml:37` |
| 工具 | `claude_args` 里的 `--permission-mode`、`--disallowedTools`、`--model` | `.github/workflows/claude.yml:48` |
| 准入 | `github_token`、`allowed_non_write_users` | `.github/workflows/claude-issue-triage.yml:38-39` |

WIF 四个变量在 `.github/workflows/claude.yml:41-44`：

```yaml
anthropic_federation_rule_id: ${{ vars.ANTHROPIC_FEDERATION_RULE_ID }}
anthropic_organization_id: ${{ vars.ANTHROPIC_ORGANIZATION_ID }}
anthropic_service_account_id: ${{ vars.ANTHROPIC_SERVICE_ACCOUNT_ID }}
anthropic_workspace_id: ${{ vars.ANTHROPIC_WORKSPACE_ID }}
```

`claude_args` 是"透传给 Claude Code CLI 的字符串"。校验器把 `--permission-mode auto` 的语义定义为
`permission_mode_problem()`（`.github/scripts/check_workflow_hardening.py:109-189`）。`--model` 的默认
在 `claude.yml:48` 为 `claude-sonnet-4-6`，triage 在 `claude-issue-triage.yml:54` 升级为 `claude-opus-4-6`。

权限模式本身是引擎的公开抽象，`mods/types/claude-code.d.ts:6073-6076`：

```ts
/**
 * ... 'auto' - Use a model classifier to approve/deny permission prompts.
 */
type PermissionMode = 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan' | 'dontAsk' | 'auto';
```

即 **auto 模式 = 由一个模型分类器（classifier）对权限提示做 allow/deny 裁决**。`d.ts:9911-9915` 进一步
把分类器抽象为"mode 的 decider"（`'ask'` 交给 dialog、auto-mode classifier 或 headless host）。

### 2. 仓库本地 slash command（prompt 模板层）

`.claude/commands/` 下的三个 markdown 文件是**提示词模板 + 工具白名单**：

- `.claude/commands/triage-issue.md:1-2`：

  ```yaml
  ---
  allowed-tools: Bash(./scripts/gh.sh:*),Bash(./scripts/edit-issue-labels.sh:*)
  description: Triage GitHub issues by analyzing and applying labels
  ---
  ```

- `.claude/commands/dedupe.md:1-2`：`allowed-tools: Bash(./scripts/gh.sh:*),Bash(./scripts/comment-on-duplicates.sh:*)`
- `.claude/commands/commit-push-pr.md:2`：`Bash(git checkout --branch:*), Bash(git add:*) ... Bash(gh pr create:*)`

关键约束：命令把 Claude 能用的工具**锁死在脚本包装器**上。`dedupe.md:26` 明确要求
"Do not use other tools, beyond `./scripts/gh.sh` and the comment script"。

### 3. 受限的 GitHub 工具面（client tools）

- `scripts/gh.sh`：`gh` CLI 的白名单包装器。仅允许 `issue view`、`issue list`、`search issues`、
  `label list`（`scripts/gh.sh:29-36`），只允许 `--comments --state --limit --label` 四类 flag
  （`scripts/gh.sh:23`），并把仓库强行绑定到 `GH_REPO`/`GITHUB_REPOSITORY`（`scripts/gh.sh:16-21`）。
  `search issues` 还额外禁止 `repo:`/`org:`/`user:` 限定符来防越权搜索（`scripts/gh.sh:76-82`）。
- `scripts/edit-issue-labels.sh`：只接受 `--add-label`/`--remove-label`，且先用
  `gh label list --limit 500` 过滤，**只允许仓库里已存在的标签**（`scripts/edit-issue-labels.sh:44-60`）。
- `scripts/comment-on-duplicates.sh`：只接受 `--potential-duplicates`，最多 3 个编号
  （`scripts/comment-on-duplicates.sh:46-49`），并逐个 `gh issue view` 校验存在性。

三者都用同一手法**把 issue 编号绑定到触发事件**：`jq -r '.issue.number // .inputs.issue_number // empty'
"$GITHUB_EVENT_PATH"`（`scripts/edit-issue-labels.sh:13`、`comment-on-duplicates.sh:15`），避免模型自选目标。

### 4. 脚本调用配额：`CLAUDE_CODE_SCRIPT_CAPS`

工作流通过 env 限制**每个会话对某脚本的调用次数**，属于防御"agent 反复调用脚本刷操作"的抽象：

- `.github/workflows/claude-issue-triage.yml:36`：`CLAUDE_CODE_SCRIPT_CAPS: '{"edit-issue-labels.sh":2}'`
- `.github/workflows/claude-dedupe-issues.yml:33`：`CLAUDE_CODE_SCRIPT_CAPS: '{"comment-on-duplicates.sh":1}'`

其来源见 `CHANGELOG.md:5909`（"`CLAUDE_CODE_SCRIPT_CAPS` env var to limit per-session script invocations"）。

### 5. 生命周期单一事实源：`scripts/issue-lifecycle.ts`

`scripts/issue-lifecycle.ts:3-38` 是标签、超时天数、文案的唯一来源：

```ts
export const lifecycle = [
  { label: "invalid",     days: 3,  reason: "...", nudge: "..." },
  { label: "needs-repro", days: 7,  reason: "...", nudge: "..." },
  { label: "needs-info",  days: 7,  reason: "...", nudge: "..." },
  { label: "stale",       days: 14, reason: "...", nudge: "..." },
  { label: "autoclose",   days: 14, reason: "...", nudge: "..." },
] as const;
export const STALE_UPVOTE_THRESHOLD = 10;
```

`stale`/`autoclose` 是**自动关闭**标签；`invalid`/`needs-repro`/`needs-info` 是**等待响应**标签；
`STALE_UPVOTE_THRESHOLD = 10` 是"足够多 👍 就不关闭"的豁免阈值。

---

## 数据流 / 时序

### A. `@claude` 提及路径（`.github/workflows/claude.yml`）

```
issue_comment / pull_request_review_comment / issues / pull_request_review 事件
  → job `claude` 的 if 判断 body/title 是否含 "@claude"（claude.yml:15-19）
  → runs-on: ubuntu-24.04-firewall（claude.yml:22）  ← 出口防火墙
  → actions/checkout（fetch-depth: 1）
  → anthropics/claude-code-action@v1：
       WIF 换 token（claude.yml:41-44）
       claude_args: "--model claude-sonnet-4-6 --permission-mode auto"（claude.yml:48）
```

`claude.yml:45-47` 的注释点明了一条**覆盖规则**：action 自己会对 `@claude` 提及设置
`--permission-mode acceptEdits`，而工作流里**后出现的** `--permission-mode auto` 覆盖它。这一点在
根 `CLAUDE.md` 中也单独强调。

### B. 新 issue / 评论 → triage 路径（`.github/workflows/claude-issue-triage.yml`）

```
issues:opened  或  issue_comment:created（且非 PR、非 Bot）
  → if: 事件过滤（claude-issue-triage.yml:14-16）
  → concurrency: issue-triage-<num>, cancel-in-progress（同一 issue 串行化，:17-19）
  → runs-on: ubuntu-24.04-firewall（:12）
  → prompt: "/triage-issue REPO:<repo> ISSUE_NUMBER:<num> EVENT:<event>"（:40）
  → claude_args:
       --permission-mode auto
       --disallowedTools "WebFetch,WebSearch,Write,Edit,MultiEdit,NotebookEdit"
       --model claude-opus-4-6                       （:51-54）
  → allowed_non_write_users: "*"（:39）  ← 允许无写权限者触发
  → env CLAUDE_CODE_SCRIPT_CAPS: '{"edit-issue-labels.sh":2}'（:36）
```

Claude 执行 `triage-issue.md` 的流程：先 `gh.sh label list` 取合法标签 → `issue view` 读正文与评论 →
按 `EVENT` 分支加/删标签（`triage-issue.md:31-74`）。新 issue 走"分类 + 生命周期标签"，评论事件只
调生命周期标签且**从不发评论**（`triage-issue.md:8`）。

### C. 生命周期状态机（脚本层，无模型）

```
                 ┌──────────── 新 issue ────────────┐
                 ▼                                   │
   triage 加标签 needs-repro / needs-info / invalid / stale / autoclose
                 │                                   │
                 ▼                                   │
   issue-lifecycle-comment.yml (issues:labeled) ─────┘
     bun scripts/lifecycle-comment.ts → 发"将在 N 天后自动关闭"提醒
                 │
     人类评论 ───┴──> claude-issue-triage.yml (issue_comment) 移除 stale/autoclose/needs-*
                       remove-autoclose-label.yml (issue_comment) 兜底移除 autoclose
                 │
   sweep.yml 每天 2 次 (0 10,22 * * *)
     bun scripts/sweep.ts：
       markStale()   : 对 updated 距今 > stale.days 的 open issue 打 stale
       closeExpired(): 对每个生命周期标签，若打标时间 > days
                       且打标后无人类评论、👍 < 10 → 评论 + 关闭(state_reason=not_planned)
```

`scripts/sweep.ts` 的判定细节：分页拉 `issues?state=open&sort=updated&direction=asc`，跳过
`pull_request`/`locked`/有 assignee/已带 `stale` 或 `autoclose`/点赞 ≥ 阈值的 issue
（`sweep.ts:60-74`）。关闭前用 `/issues/<n>/events` 找该标签的 `labeled` 时间
（`sweep.ts:115-122`），再用 `/comments?since=<labeledAt>` 检测标签之后有无人类评论作为安全网
（`sweep.ts:124-138`）。支持 `--dry-run`（`sweep.ts:8,163`）。

### D. 去重状态机

```
新 issue ─> claude-dedupe-issues.yml ─> /dedupe（5 个并行 agent 搜索）
              └─> scripts/comment-on-duplicates.sh 发 "Found N possible duplicate issues"
                    文案含 "automatically closed as a duplicate in 3 days"（comment-on-duplicates.sh:87）

auto-close-duplicates.yml 每天 0 9 * * *
  bun scripts/auto-close-duplicates.ts：
    找 Bot 评论 body 含 "Found"+"possible duplicate"、距今 > 3 天、
    其后无任何评论、issue 作者未对识别评论点 👎 → 关闭 state_reason=duplicate + label duplicate

backfill-duplicate-comments.yml（手动 dispatch）
  bun scripts/backfill-duplicate-comments.ts：
    对 [MIN_ISSUE_NUMBER, MAX_ISSUE_NUMBER) 内、尚无检测评论的旧 issue
    调用 /actions/workflows/claude-dedupe-issues.yml/dispatches 回填
```

`auto-close-duplicates.ts:164-241` 的全套守卫：`dupeCommentDate > threeDaysAgo` 跳过、
`commentsAfterDupe.length > 0` 跳过、`authorThumbsDown` 跳过。`backfill` 默认 `DRY_RUN !== "false"`
即**默认干跑**（`backfill-duplicate-comments.ts:91`），每次 trigger 间 `setTimeout 1000`
（:202）做节流。

### E. 护栏的护栏（`.github/workflows/workflow-hardening.yml`）

```
pull_request / push:main
  → python3 .github/scripts/check_workflow_hardening.py（workflow-hardening.yml:23）
```

`check_workflow_hardening.py` 的判定链：

1. `job_calls_claude(job)`（:97-106）：job 中出现 `anthropic_federation_rule_id` 标记，或某 step 用了
   `anthropics/claude-code-action`/`claude-code-base-action`，或用了带 `claude_args` 输入的本地 action。
2. `check_job`（:231-274）：job 必须 `runs-on: ubuntu-24.04-firewall`（除非在
   `EXEMPT_FROM_FIREWALL_RUNNER`）；job JSON 中出现 `defaultMode` 直接报错；对每个 Claude step 调
   `permission_mode_problem()`。
3. `permission_mode_problem`（:109-189）：禁止 `--dangerously-skip-permissions`；要求恰好
   `--permission-mode auto`（除非在 `EXEMPT_FROM_AUTO_MODE`，此时**不得设置任何模式**）；并校验所有
   可能的模型来源（step 的 `model`、env `ANTHROPIC_MODEL`、`claude_args` 的 `--model`/`--fallback-model`、
   settings 里的 `model`）不早于 `AUTO_MODE_MIN_VERSION = (4, 6)`（:22）。
4. `check_policy()`（:277-309）：`.github/egress-firewall.yaml` 必须存在、`mode: enforce`、`allow` 非空、
   且任何条目不得含 `*`。
5. `predates_auto_mode()`（:200-209）：模型名带版本号时比较版本；无版本名的名字视为当前模型，
   但 `haiku` 例外（视为过旧）。

### F. 其它事件流

- `issue-opened-dispatch.yml`：新 issue → `gh api repos/<TARGET_REPO>/dispatches` 转发 `issue_opened`
  事件到外部仓库；失败时 `|| exit 0` 静默放过（:26-28）。
- `log-issue-events.yml` / `claude-dedupe-issues.yml` 的 Statsig step：用 `curl` 向
  `https://events.statsigapi.net/v1/log_event` 上报指标。`log-issue-events.yml:22-23` 特意注明所有值经
  env 传入、不做 shell 内联模板，以防注入。
- `lock-closed-issues.yml`：用 `actions/github-script@v7` 搜索 `is:closed is:unlocked updated:<cutoff`，
  逐个评论 + `lock(reason='resolved')`，上限 250/次、每次 sleep 1s（:33-70）。
- `remove-autoclose-label.yml`：带 `autoclose` 的 open issue 收到非机器人评论即移除该标签（:13-16）。

---

## 扩展点

按"想加什么"分类：

1. **新增调用 Claude 的工作流**：照抄 `.github/workflows/claude-issue-triage.yml` 的骨架 ——
   `runs-on: ubuntu-24.04-firewall`、最小 `permissions:`、`id-token: write`、WIF 四个 vars、
   `claude_args` 带 `--permission-mode auto`。否则 `workflow-hardening.yml` 会让 CI 失败。
2. **新增网络主机**：编辑 `.github/egress-firewall.yaml` 的 `allow:`，规则写在文件头
   （`egress-firewall.yaml:1-3`）：只在某 step 需要时添加、写全名（禁 `*`）、注明用途。
3. **新增生命周期标签**：只改 `scripts/issue-lifecycle.ts` 的 `lifecycle` 数组；`sweep.ts`、
   `lifecycle-comment.ts` 都从这里派生，无需改脚本。
4. **新增 slash command**：在 `.claude/commands/` 加 markdown，`allowed-tools` 收窄到最小，
   并在对应工作流的 `prompt:` 里引用。
5. **新增受限工具脚本**：仿 `scripts/gh.sh` 的白名单模式，并在工作流 env 用
   `CLAUDE_CODE_SCRIPT_CAPS` 设调用上限。
6. **豁免**：若某 job 无法满足 runner 或 auto mode，把 `"<文件名>:<job id>"` 加进
   `check_workflow_hardening.py` 的 `EXEMPT_FROM_FIREWALL_RUNNER` / `EXEMPT_FROM_AUTO_MODE` 并写原因
   （:29-31）。列入 `EXEMPT_FROM_AUTO_MODE` 的 job 必须不设任何权限模式（:134-139）。
7. **本地 mod 测试**：在 `mods/<name>/` 下加 `hooks/` 与 `tests/`，`mod-tests.yml` 会自动发现
   （:34-38）。

---

## 设计决策与权衡

### 1. 为什么是"出口防火墙 + 允许清单 + auto 模式"三件套

- **出口防火墙 runner**：Claude 会话是"按不可信输入执行命令"的典型场景；限制它只能访问
  白名单主机，把"数据外泄/调用任意服务"这类风险从"取决于提示词"变成"取决于清单"。实现载体是
  `runs-on: ubuntu-24.04-firewall`，且**每个调 Claude 的 job 都必须用它**（`check` 强制）。
- **允许清单 `mode: enforce`**：`mode: enforce` 是"默认拒绝"的开关，缺了它防火墙形同虚设，所以
  `check_policy()` 把 `mode != "enforce"` 与 `*` 通配都判为错误。清单条目还要求写明用途，
  是可审计的。
- **auto 权限模式**：模型驱动的 agent 需要动态权限决策，人工审批在 CI 里不现实。`auto` 用模型
  分类器逐次裁决，属于"用智能替代人工审批"的权衡；但分类器只在 **`claude-opus-4-6` 及更新模型**
  上启用，旧模型会**静默回退到默认模式且无安全评审**，故校验器用版本号挡住。

三者叠加的净效果：**即使提示词被注入，攻击者也只能在"白名单主机 + 最小 GitHub 权限 + 分类器允许
的工具"范围内行动。**

### 2. 最小权限 `permissions:` 模式

每个工作流按需声明，且多为只读：

| 工作流 | `permissions:` | 备注 |
| --- | --- | --- |
| `claude.yml` | `contents: read`, `pull-requests: read`, `issues: read`, `id-token: write` | 几乎全只读；`id-token` 仅用于 WIF |
| `claude-issue-triage.yml` | `contents: read`, `issues: write`, `id-token: write` | 需改标签故有 `issues: write` |
| `claude-dedupe-issues.yml` | `contents: read`, `issues: write`, `id-token: write` | 需发评论 |
| `mod-tests.yml` | `contents: read`（workflow 级）+ `persist-credentials: false` | 只读 + 不落凭据 |
| `workflow-hardening.yml` | `contents: read` | 只读代码 |
| `issue-opened-dispatch.yml` | `issues: read`, `actions: write` | 需 dispatch，故 `actions: write` |
| `backfill-duplicate-comments.yml` | `contents: read`, `issues: read`, `actions: write` | 需 dispatch dedupe |
| `lock-closed-issues.yml` | `issues: write` | 只操作 issue |
| `auto-close-duplicates.yml` | `contents: read`, `issues: write` | |
| `sweep.yml` | `issues: write` | |
| `issue-lifecycle-comment.yml` | `issues: write` | |
| `log-issue-events.yml` | `issues: read` | 只上报指标 |
| `remove-autoclose-label.yml` | `issues: write` | |
| `non-write-users-check.yml` | `contents: read`, `pull-requests: write` | 需发 PR 评论 |

规律：**`id-token: write` 与 `contents/pull-requests/issues` 只读配对，写权限按 job 实际动作给。**
根 `CLAUDE.md` 要求"keep each workflow's `permissions:` block minimal"。

### 3. WIF 取代静态 API Key

`.github/workflows/claude.yml:38-40` 注释说明用 OIDC token 换短期 token。权衡是：消除长期密钥的
泄露面，代价是每次运行多一次 token 交换（需 `id-token: write` 和 `api.anthropic.com` 在白名单里）。
`CHANGELOG.md:2240` 提到 action 通过 profile 配置 WIF 的历史问题，佐证它是真实运行路径。

### 4. 事件绑定而非模型自选目标

脚本一律从 `$GITHUB_EVENT_PATH` 读 issue 编号（`edit-issue-labels.sh:13`），并做数字正则校验。
这是针对"提示词注入让 agent 操作别的 issue"的纵深防御：**目标由事件决定，模型无权改。**

### 5. 允许无写权限用户（`allowed_non_write_users: "*"`）

triage/dedupe 允许非仓库成员触发，因为有外部 issue 来源。代价是：这类运行里 Claude Code
会安装 `bubblewrap` 与 `socat` 做沙箱（见 `egress-firewall.yaml:20-25` 注释），且风险更高，所以
`non-write-users-check.yml` 专门在 PR 里检测新增/修改 `allowed_non_write_users` 并提醒 AppSec。

### 6. 干跑优先

`sweep.ts` 支持 `--dry-run`，`backfill-duplicate-comments.ts` 默认 `DRY_RUN=true`
（`backfill-duplicate-comments.ts:91`）。批处理脚本的默认安全姿态是"先看会做什么"。

### 7. 并发控制

`claude-issue-triage.yml:17-19` 用 `concurrency: issue-triage-<num>, cancel-in-progress` 让同一 issue
的连续事件串行/取消旧任务；`sweep.yml:11-12` 与 `lock-closed-issues.yml:12-13` 各用一个全局 group
防止定时任务重叠。

### 8. 校验器的覆盖面与其盲区（权衡）

`check_workflow_hardening.py` 只能看见"用 Claude Code action 或提到 WIF 标记"的 job。根 `CLAUDE.md`
坦承："It cannot see a job that calls Claude another way, so check new workflows by hand too."
即静态校验是**尽力而为的护栏**，不是完备证明。另外注意一处细微差别：`CLAUDE.md` 文字说
"Use `claude-opus-4-6` or a newer model"，但校验器实际是**按版本号比较**（`AUTO_MODE_MIN_VERSION=(4,6)`），
因此 `claude-sonnet-4-6` 也能通过（`claude.yml:48` 与 `claude-dedupe-issues.yml:48` 正是用了 sonnet-4-6）。

---

## 对复刻产品的启示

1. **把"调用 AI 的 job"定义成一等公民，并配套一个校验器。** 三件套（防火墙 runner、允许清单、
   权限模式）本身不难，难的是**保证每个新工作流都遵守**——用 CI 校验 + 豁免表 + 明确错误信息
   （"See CLAUDE.md, Security hardening..."）把纪律自动化。
2. **允许清单要"说法即文档"。** 每条主机写清"谁在用、为什么"，并禁止通配。复刻时把"新增主机"
   的规则写进文件头，降低后续维护成本。
3. **权限模式与模型版本强耦合。** 若你的产品也有 "agent 自动批准" 模式，务必在 CI 中校验模型
   能力下限，且对"静默回退"零容忍。
4. **把 agent 的工具面锁进脚本包装器，而不是给它裸 `gh`/网络。** `gh.sh` 的白名单 + 事件绑定是
   可复用的低风险模式；配合 `CLAUDE_CODE_SCRIPT_CAPS` 类的调用配额能限制刷操作。
5. **生命周期状态机用单一事实源驱动。** 把标签/超时/文案集中在一个常量数组，多个脚本与工作流
   共享，避免"改了 sweep 忘了 comment"。
6. **批处理默认干跑、可重入、有节流。** `DRY_RUN` 默认 true、分页带上限、trigger 间 sleep、
   `concurrency` 组，都是可复制的稳健性细节。
7. **安全评审靠"检测 + 提醒"而非硬阻断的地方要显式化。** `non-write-users-check` 用注释标记
   （`<!-- non-write-users-check -->`）防重复提醒，这个模式值得借鉴。

---

## 关键文件索引

| 路径 | 作用 |
| --- | --- |
| `CLAUDE.md` | 三件套安全策略与 rule that auto 覆盖 acceptEdits 的权威说明 |
| `.github/egress-firewall.yaml` | 出口防火墙允许清单（`mode: enforce`）+ 加主机规则 |
| `.github/scripts/check_workflow_hardening.py` | 硬化校验器；豁免表 `EXEMPT_FROM_FIREWALL_RUNNER`/`EXEMPT_FROM_AUTO_MODE` |
| `.github/workflows/claude.yml` | `@claude` 提及处理；WIF + `--permission-mode auto` |
| `.github/workflows/claude-issue-triage.yml` | 新 issue/评论 triage；`--disallowedTools` + opus-4-6 |
| `.github/workflows/claude-dedupe-issues.yml` | 去重 slash command + Statsig 上报 |
| `.github/workflows/workflow-hardening.yml` | 跑校验器的元工作流 |
| `.github/workflows/mod-tests.yml` | mod 类型检查 + `claude plugin test` |
| `.github/workflows/issue-opened-dispatch.yml` | 转发新 issue 事件到外部仓库 |
| `.github/workflows/issue-lifecycle-comment.yml` | 打生命周期标签时发提醒评论 |
| `.github/workflows/auto-close-duplicates.yml` | 定时关闭重复 issue |
| `.github/workflows/backfill-duplicate-comments.yml` | 回填旧 issue 的去重检测 |
| `.github/workflows/lock-closed-issues.yml` | 关闭 7 天后锁定 |
| `.github/workflows/log-issue-events.yml` | issue 事件上报 Statsig |
| `.github/workflows/non-write-users-check.yml` | 检测 `allowed_non_write_users` 变更并提醒 |
| `.github/workflows/remove-autoclose-label.yml` | 有新评论则移除 `autoclose` |
| `.github/workflows/sweep.yml` | 定时执行 `sweep.ts` |
| `scripts/issue-lifecycle.ts` | 生命周期标签/超时/文案单一事实源 |
| `scripts/sweep.ts` | 打 stale + 过期关闭状态机 |
| `scripts/lifecycle-comment.ts` | 生命周期提醒评论 |
| `scripts/auto-close-duplicates.ts` | 重复 issue 自动关闭状态机 |
| `scripts/backfill-duplicate-comments.ts` | 触发 dedupe 工作流回填 |
| `scripts/comment-on-duplicates.sh` | 发"发现 N 个疑似重复"评论 |
| `scripts/edit-issue-labels.sh` | 白名单式改标签 |
| `scripts/gh.sh` | `gh` CLI 白名单包装器 |
| `.claude/commands/triage-issue.md` | triage slash command 模板 |
| `.claude/commands/dedupe.md` | dedupe slash command 模板 |
| `.claude/commands/commit-push-pr.md` | commit/push/PR slash command 模板 |
| `.github/ISSUE_TEMPLATE/*.yml` | issue 表单，预置 `bug`/`enhancement`/`documentation`/`model` 等标签 |
| `mods/types/claude-code.d.ts` | `PermissionMode`、auto-mode classifier 等接口定义 |

### 工作流逐条总表

| 文件 | 触发 | runner | `permissions:` | 调 Claude? / `claude_args` | 作用 |
| --- | --- | --- | --- | --- | --- |
| `claude.yml` | `issue_comment`、`pull_request_review_comment`、`issues[opened,assigned]`、`pull_request_review` 含 `@claude` | `ubuntu-24.04-firewall` | `contents:read, pull-requests:read, issues:read, id-token:write` | 是；`--model claude-sonnet-4-6 --permission-mode auto` | `@claude` 通用助手 |
| `claude-issue-triage.yml` | `issues[opened]`、`issue_comment[created]`（非 PR/非 Bot） | `ubuntu-24.04-firewall` | `contents:read, issues:write, id-token:write` | 是；`--permission-mode auto --disallowedTools "WebFetch,WebSearch,Write,Edit,MultiEdit,NotebookEdit" --model claude-opus-4-6` | 加/删标签分流 |
| `claude-dedupe-issues.yml` | `issues[opened]`、`workflow_dispatch(issue_number)` | `ubuntu-24.04-firewall` | `contents:read, issues:write, id-token:write` | 是；`--model claude-sonnet-4-6 --permission-mode auto --disallowedTools "…"` | 找重复并评论 |
| `workflow-hardening.yml` | `pull_request`、`push: main` | `ubuntu-latest` | `contents:read` | 否 | 跑硬化校验器 |
| `mod-tests.yml` | `pull_request`（`mods/**` 或本文件） | `ubuntu-latest` | `contents:read`（workflow 级） | 否（用 `@anthropic-ai/claude-code` CLI 而非 action） | mod 类型检查 + 测试 |
| `issue-opened-dispatch.yml` | `issues[opened]` | `ubuntu-latest` | `issues:read, actions:write` | 否 | 转发 issue 事件 |
| `issue-lifecycle-comment.yml` | `issues[labeled]` | `ubuntu-latest` | `issues:write` | 否 | Bun 发提醒评论 |
| `auto-close-duplicates.yml` | `schedule 0 9 * * *`、`workflow_dispatch` | `ubuntu-latest` | `contents:read, issues:write` | 否 | 关闭重复 issue |
| `backfill-duplicate-comments.yml` | `workflow_dispatch(days_back, dry_run)` | `ubuntu-latest` | `contents:read, issues:read, actions:write` | 否 | 回填去重检测 |
| `lock-closed-issues.yml` | `schedule 0 14 * * *`、`workflow_dispatch` | `ubuntu-latest` | `issues:write` | 否 | 锁定陈旧关闭 issue |
| `log-issue-events.yml` | `issues[opened, closed]` | `ubuntu-latest` | `issues:read` | 否 | Statsig 事件上报 |
| `non-write-users-check.yml` | `pull_request`（`.github/**`） | `ubuntu-latest` | `contents:read, pull-requests:write` | 否 | 检测 `allowed_non_write_users` |
| `remove-autoclose-label.yml` | `issue_comment[created]` | `ubuntu-latest` | `issues:write` | 否 | 有新评论则移除 `autoclose` |
| `sweep.yml` | `schedule 0 10,22 * * *`、`workflow_dispatch` | `ubuntu-latest` | `issues:write` | 否 | 执行 `sweep.ts` |

---

## 存疑与待确认

1. **`EXEMPT_FROM_FIREWALL_RUNNER` 与 `EXEMPT_FROM_AUTO_MODE` 当前为空 dict**
   （`check_workflow_hardening.py:30-31`）。文档未能验证历史上是否有过豁免项；表中确无现有豁免，
   故本仓库目前**没有**任何 job 被豁免——这是观察，不是策略承诺。
2. **Claude Code Action 的内部行为不可见**：本仓库只引用 `anthropics/claude-code-action@v1`，其
   实现不在仓库内。诸如 action 如何设置 `--permission-mode acceptEdits`、如何安装 `bubblewrap`/`socat`、
   WIF 交换细节，均据工作流注释、`.github/egress-firewall.yaml` 注释与 `CHANGELOG.md`
   （如 `:2240`、`:3396`）推断，未直接读取 action 源码。
3. **`anthropic_*` vars 与 `ISSUE_OPENED_DISPATCH_*` secrets 的实际取值**由 GitHub 仓库/组织设置提供，
   仓库内不可见；`ISSUE_OPENED_DISPATCH_TARGET_REPO` 指向哪个仓库未知。
4. **模型版本校验的语义边界**：`CLAUDE.md` 文字说用 `claude-opus-4-6` 或更新，但校验器按版本号
   ≥ (4,6) 判定，故 `claude-sonnet-4-6` 亦通过。这是文本与实现的差异，复刻时需决定以哪个为准。
5. **`--permission-mode auto` 与 `allowed_non_write_users` 的交互**：auto 模式的分类器在"无写权限用户
   触发"时是否改变策略，本仓库无从确认。
6. **`claude.yml` 的默认 `prompt`**：该工作流**未**显式传 `prompt:`，仅传 `claude_args`，暗示由 action
   从事件评论正文自行构造提示；具体构造逻辑在 action 内部，未验证。
7. **`sweep.ts` 的 `markStale` 提前 `return`**：`sweep.ts:66` 在遇到第一个"未过期"issue 时直接
   `return labeled`（因结果按 `updated` 升序，后面都更新），逻辑成立但依赖排序假设；文档按代码语义
   描述，未做行为测试。
8. **`claude-dedupe-issues.yml` 的 Statsig 上报**使用 `curl` 到外部域，需 `events.statsigapi.net`
   在白名单中（已在 `egress-firewall.yaml:26-27`）。
9. **`mod-tests.yml` 的 `claude plugin test` 能力探测**：脚本用 `claude plugin test --help | grep -q`
   做软探测（`mod-tests.yml:29-32`），在能力缺失时**跳过而非失败**；这是有意为之还是临时兼容，无从确认。
10. **`GitHub Actions mode` 的描述**：任务提到"grep `github-action`/`headless`/`--print`"。仓库内未发现名为
    `github-action` 的模式常量；`mods/types/claude-code.d.ts` 中与 headless 相关的是权限裁决宿主
    （`d.ts:9913` "the auto-mode classifier, a headless host"）。CI 场景本质是**非交互/headless 会话**，
    由 action 驱动，而非某处显式的 `github-action` 字符串。
