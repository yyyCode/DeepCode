# Classic Hooks 系统架构

本文分析 Claude Code 的「classic hooks」系统：以 JSON 配置、外部命令/提示为执行单元、由固定 hook 事件驱动的自动化机制。它与 `mods/` 中较新的 function-hooks/mod 引擎是两套独立实现。文中所有代码片段均逐字摘自本仓库，路径为仓库相对路径。

---

## 定位

Classic hooks 是 Claude Code **面向用户的首要自动化接口**：用户或插件在 JSON 里声明「某个事件发生时执行某条命令（或某个提示）」，引擎在生命周期节点调用它，并消费它的 stdout/exit code 来放行、阻断、注入上下文或改写工具输入。

它的两个配置入口：

- **插件入口**：`plugins/<name>/hooks/hooks.json`，采用带 `hooks` 包装层的格式。插件清单 `.claude-plugin/plugin.json` 默认读取 `./hooks/hooks.json`，也可用 `hooks` 字段指向别的文件或内联对象（`plugins/plugin-dev/skills/plugin-structure/references/manifest-reference.md:259-296`）。
- **设置入口**：`.claude/settings.json` 采用**直接格式**，事件直接位于顶层、没有 `hooks` 包装层、没有 `description`（`plugins/plugin-dev/skills/hook-development/SKILL.md:102-119`）。托管设置可进一步收口（见「职责与边界」）。

在本仓库中，classic hooks 是多个官方插件的实现基础：

- `plugins/hookify/` 在 classic hooks 之上再封装一层**规则 DSL**（`.local.md` + YAML frontmatter），把「写 hook 脚本」降级为「写正则规则」。
- `plugins/security-guidance/` 用 `SessionStart`/`UserPromptSubmit`/`PostToolUse`/`Stop` 四类事件实现「模式告警 + LLM diff 复审 + 提交复审」三层。
- `plugins/ralph-wiggum/` 用 `Stop` hook 拦截退出、把同一 prompt 回灌，实现自主迭代循环。
- `plugins/explanatory-output-style/` 与 `plugins/learning-output-style/` 用 `SessionStart` 注入上下文，模拟已废弃的 output style。
- `examples/hooks/bash_command_validator_example.py` 是独立的 `PreToolUse` 守卫示例，演示 stdin/stdout JSON 契约与退出码语义。

## 职责与边界

**职责**

1. **工具调用校验与阻断**：`PreToolUse` 可放行/询问/拒绝（`allow`/`ask`/`deny`），并可改写工具入参。
2. **结果反应与上下文注入**：`PostToolUse` 可对工具结果追加 `additionalContext`，甚至替换工具输出。
3. **完成度与循环控制**：`Stop`/`SubagentStop` 可 `block` 退出，强制继续（Ralph 循环、测试强制）。
4. **会话上下文加载**：`SessionStart` 注入补充说明、初始用户消息、监听路径、重载 skills，并持久化环境变量。
5. **审计、遥测与外部集成**：`Notification` 等事件可用于日志、Slack、数据库等。

**边界（与相邻系统的分界）**

- **不是权限系统本身**。hooks 与 permission 规则是两套机制：managed 设置里分别有 `allowManagedHooksOnly` 与 `allowManagedPermissionRulesOnly`（`examples/settings/settings-strict.json:13`、`examples/settings/README-hipaa.md:75`）。`PreToolUse` 用 `hookSpecificOutput.permissionDecision` 参与权限判定，但 hook 本身不定义 allow/ask/deny 规则。
- **hooks 之间互不可见**。所有匹配的 hook **并行执行**，彼此看不到对方输出，执行顺序不确定；设计上必须相互独立（`plugins/plugin-dev/skills/hook-development/SKILL.md:495-518`）。
- **配置在会话启动时加载**。编辑 `hooks.json`、增删脚本、改命令都不会影响当前会话，必须重启（`plugins/plugin-dev/skills/hook-development/SKILL.md:572-598`）。注意：这是对**配置**的限制；hook 脚本自身每次执行都会重新读取它引用的数据文件（hookify 的规则文件因此「无需重启、即时生效」，`plugins/hookify/hooks/pretooluse.py:39-59`）。
- **沙箱不覆盖 hooks**。托管 `sandbox` 只约束 `Bash` 工具；被批准的 hook 在沙箱之外运行（`examples/settings/README.md:27`、`examples/settings/README-hipaa.md:139`）。
- **托管设置可整体收口**：`allowManagedHooksOnly` 决定哪些 hook 能运行；用它可让 hooks 仅来自 managed 设置（`examples/settings/README-hipaa.md:75`）。
- **classic hooks ≠ function hooks**。前者是 JSON + 外部进程协议；后者是 `mods/` 中 `register(on, options)` 的 TypeScript 模块，走进程内函数调用（见「设计决策与权衡」）。

## 关键抽象与接口

### 1. 事件名（Hook Events）

事件名是字符串字面量。运行时的**规范全集**定义在 type union `HookInput`（`mods/types/claude-code.d.ts:4288`），并可经 `ClassicHookEvent = HookInput['hook_event_name']` 取用（`mods/types/claude-code.d.ts:958`）。共 33 个：

| 事件 | 触发时机 | 输入专有字段（d.ts 行） |
|---|---|---|
| `PreToolUse` | 工具执行前 | `tool_name`、`tool_input`、`tool_use_id`、`mcp_server?`（6476） |
| `PostToolUse` | 工具成功返回后 | `tool_name`、`tool_input`、`tool_response`、`tool_use_id`、`duration_ms?`（6372） |
| `PostToolUseFailure` | 工具失败后 | `error`、`is_interrupt?`、`duration_ms?`（6358） |
| `PostToolBatch` | 一批并行工具全部结束后（每批一次） | `tool_calls[]`（6346、6343-6344） |
| `PermissionRequest` | 需要权限决策时 | `decision` 输出（6092） |
| `PermissionDenied` | 权限被拒时 | `retry` 输出（6064） |
| `Notification` | Claude 发出通知时 | — （5378） |
| `UserPromptSubmit` | 用户提交 prompt 时 | `prompt`、`source?`、`session_title?`（11284） |
| `UserPromptExpansion` | 提交的 prompt 展开时 | `suppressOriginalPrompt` 输出（11275） |
| `SessionStart` | 会话开始 | `source`、`model?`、`agent_type?`（9153） |
| `SessionEnd` | 会话结束 | — （8871） |
| `Stop` | 主 agent 准备停止 | `stop_hook_active`、`last_assistant_message?`、`background_tasks?`、`session_crons?`（9448） |
| `StopFailure` | 停止失败 | `error`、`error_details?`（9441） |
| `SubagentStart` | 子 agent 启动 | （9567） |
| `SubagentStop` | 子 agent 准备停止 | （9573） |
| `PreCompact` | 上下文压缩前 | `trigger`、`custom_instructions`（6385） |
| `PostCompact` | 上下文压缩后 | （6296） |
| `PreModelSwitch` / `PostModelSwitch` | 切换模型前后 | `from_model`/`to_model`（6391、6305） |
| `Setup` | 安装/初始化 | （9313） |
| `TeammateIdle` / `TaskCreated` / `TaskCompleted` | 多 agent 协作事件 | （9668、9656、9644） |
| `Elicitation` / `ElicitationResult` | 向用户征询信息前后 | （3182、3195） |
| `ConfigChange` | 配置变更 | （1590） |
| `InstructionsLoaded` | 指令文件加载后 | （4652） |
| `WorktreeCreate` / `WorktreeRemove` | worktree 增删 | `name` / `worktree_path`（11306、11311） |
| `CwdChanged` / `FileChanged` / `DirectoryAdded` | 目录与环境监视 | （3049、3962、3055） |
| `MessageDisplay` | 消息展示时 | `displayContent` 输出（5053） |

> 注意：官方插件开发文档只枚举其中 9 个事件（`PreToolUse`、`PostToolUse`、`UserPromptSubmit`、`Stop`、`SubagentStop`、`SessionStart`、`SessionEnd`、`PreCompact`、`Notification`，见 `plugins/plugin-dev/skills/hook-development/SKILL.md:634-644`，并被 `scripts/validate-hook-schema.sh:41` 的 `VALID_EVENTS` 硬编码）。运行时的实际事件集合远大于此（见「存疑与待确认」）。

### 2. JSON 配置 Schema

**插件包装格式**（结构取自 `plugins/hookify/hooks/hooks.json:1-49`；下方为节省篇幅压缩了重复的数组层级，字段值逐字）：

```json
{
  "description": "Hookify plugin - User-configurable hooks from .local.md files",
  "hooks": {
    "PreToolUse": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "python3 ${CLAUDE_PLUGIN_ROOT}/hooks/pretooluse.py",
            "timeout": 10
          }
        ]
      }
    ],
    "PostToolUse": [ { "hooks": [ { "type": "command", "command": "python3 ${CLAUDE_PLUGIN_ROOT}/hooks/posttooluse.py", "timeout": 10 } ] } ],
    "Stop":        [ { "hooks": [ { "type": "command", "command": "python3 ${CLAUDE_PLUGIN_ROOT}/hooks/stop.py", "timeout": 10 } ] } ],
    "UserPromptSubmit": [ { "hooks": [ { "type": "command", "command": "python3 ${CLAUDE_PLUGIN_ROOT}/hooks/userpromptsubmit.py", "timeout": 10 } ] } ]
  }
}
```

结构层级为 `EventName -> [ { matcher?, hooks: [ HookDef, ... ] }, ... ]`。一个事件可挂多个 matcher 组，一个组内可挂多个 `HookDef`（并行）。

`HookDef` 字段：

| 字段 | 含义 | 出处 |
|---|---|---|
| `type` | `"command"` 或 `"prompt"` | SKILL.md:22-58、validate-hook-schema.sh:97 |
| `command` | `type=command` 时的 shell 命令 | hookify/hooks.json:9 |
| `prompt` | `type=prompt` 时的 LLM 提示 | SKILL.md:26-32 |
| `timeout` | 超时秒数（命令默认 60s，prompt 默认 30s；校验脚本上限 600s） | SKILL.md:481-491、validate-hook-schema.sh:136 |

`security-guidance` 的 hooks.json 还使用了更丰富的运行时字段（`plugins/security-guidance/hooks/hooks.json:33-42`，逐字）：

```json
{
  "hooks": [
    {
      "type": "command",
      "command": "bash \"${CLAUDE_PLUGIN_ROOT}/hooks/sg-python.sh\" \"${CLAUDE_PLUGIN_ROOT}/hooks/security_reminder_hook.py\"",
      "if": "Bash(git commit:*)",
      "asyncRewake": true,
      "rewakeMessage": "Background security review of commit — address or acknowledge the findings below, then continue with the user's original request or continue waiting for their reply:",
      "rewakeSummary": "Commit security review found issues"
    }
  ],
  "matcher": "Bash"
}
```

其中 `if` 是工具/子命令前缀匹配（`Bash(git commit:*)`），`asyncRewake` 让 hook 在后台运行并在完成后「唤醒」模型续跑，`rewakeMessage`/`rewakeSummary` 是唤醒消息与终端一行摘要。这些字段未在插件开发文档中成文，仅在 `security-guidance` 中实际使用（见「存疑与待确认」）。

### 3. Matcher 语法

`matcher` 决定该组 hook 对哪些工具生效（`plugins/plugin-dev/skills/hook-development/SKILL.md:386-425`）：

- 精确名：`"Write"`；
- 多工具 OR：`"Write|Edit"`（hookify 内置引擎也实现按 `|` 拆分，`plugins/hookify/core/rule_engine.py:127-142`）；
- 通配：`"*"`；
- 正则：`"mcp__.*__delete.*"`、`"mcp__plugin_asana_.*"`；
- **大小写敏感**（SKILL.md:409）。

无 matcher 的组（如 hookify 的 hooks.json）对所有工具生效，再由脚本内部按 `tool_name` 分流（`plugins/hookify/hooks/pretooluse.py:43-50`）。

### 4. 输入契约（stdin）

所有 hook 从 stdin 收到一份 JSON。公共字段 `BaseHookInput`（`mods/types/claude-code.d.ts:583-609`，逐字）：

```ts
type BaseHookInput = {
    session_id: string;
    transcript_path: string;
    cwd: string;
    prompt_id?: string;
    permission_mode?: string;
    agent_id?: string;
    agent_type?: string;
    effort?: { level: string };
};
```

事件专有字段叠加其上，例如：

```ts
type PreToolUseHookInput = BaseHookInput & {
    hook_event_name: 'PreToolUse';
    tool_name: string;
    tool_input: unknown;
    tool_use_id: string;
    mcp_server?: McpServerProvenance;
};
```

```ts
type StopHookInput = BaseHookInput & {
    hook_event_name: 'Stop';
    stop_hook_active: boolean;
    last_assistant_message?: string;
    background_tasks?: BackgroundTaskSummary[];
    session_crons?: SessionCronSummary[];
};
```

脚本侧的读取方式见 hookify（`plugins/hookify/hooks/pretooluse.py:39`：`input_data = json.load(sys.stdin)`）与 Ralph（`stop-hook.sh:10`：`HOOK_INPUT=$(cat)`，随后 `jq -r '.transcript_path'`，`:58`）。

### 5. 输出契约（stdout / exit code）

**命令 hook 的退出码语义**（`examples/hooks/bash_command_validator_example.py:47-63`、SKILL.md:294-298）：

- `exit 0`：成功，stdout 进入 transcript；
- `exit 1`：非阻断错误，stderr 展示给用户但**不给** Claude；
- `exit 2`：**阻断**，stderr 反馈给 Claude；
- 其他：非阻断错误。

bash 校验示例逐字：

```python
    issues = _validate_command(command)
    if issues:
        for message in issues:
            print(f"• {message}", file=sys.stderr)
        # Exit code 2 blocks tool call and shows stderr to Claude
        sys.exit(2)
```

**JSON 输出**：hook 可向 stdout 打印结构化 JSON。通用形态（SKILL.md:280-292）：

```json
{
  "continue": true,
  "suppressOutput": false,
  "systemMessage": "Message for Claude"
}
```

规范的字段全集是 `ClassicResult`（`mods/types/claude-code.d.ts:976-1052`），各事件只读取自己的子集（`ClassicResultFields`，`mods/types/claude-code.d.ts:1060-1077`）。逐字摘录关键字段：

```ts
export type ClassicResult = {
    block?: string;                       // decision:"block" 与 reason
    preventContinuation?: true;           // continue:false
    stopReason?: string;
    additionalContext?: string[];         // hookSpecificOutput.additionalContext
    sessionTitle?: string;
    suppressOriginalPrompt?: true;
    initialUserMessage?: string;
    watchPaths?: string[];
    reloadSkills?: true;
    permissionDecision?: 'allow' | 'deny' | 'ask';   // PreModelSwitch
    permissionDecisionReason?: string;
    decision?: PermissionRequestDecision;            // PermissionRequest
    updatedToolOutput?: unknown;                     // PostToolUse：替换模型所见结果
    updatedMCPToolOutput?: unknown;
    retry?: true;
    displayContent?: string;
    worktreePath?: string;
};
```

`PreToolUse` 的返回另有独立类型 `PreToolUseResult`（`mods/types/claude-code.d.ts:6488-6498`），含 `updatedInput`（改写工具入参，执行前按工具 schema 校验）与 `additionalContext`。

各事件读取的输出字段（逐字，`mods/types/claude-code.d.ts:1060-1077`）：

```ts
export type ClassicResultFields = {
    UserPromptSubmit: 'additionalContext' | 'sessionTitle' | 'suppressOriginalPrompt';
    UserPromptExpansion: 'additionalContext' | 'suppressOriginalPrompt';
    SessionStart: 'additionalContext' | 'initialUserMessage' | 'sessionTitle' | 'watchPaths' | 'reloadSkills';
    Setup: 'additionalContext';
    PreModelSwitch: 'permissionDecision' | 'permissionDecisionReason';
    PostModelSwitch: 'additionalContext';
    SubagentStart: 'additionalContext';
    PostToolUse: 'additionalContext' | 'updatedToolOutput' | 'updatedMCPToolOutput';
    PostToolUseFailure: 'additionalContext';
    PostToolBatch: 'additionalContext';
    Stop: 'additionalContext';
    SubagentStop: 'additionalContext';
    PermissionDenied: 'retry';
    PermissionRequest: 'decision';
    MessageDisplay: 'displayContent';
    WorktreeCreate: 'worktreePath';
};
```

### 6. 环境变量

命令 hook 可用的环境变量（`plugins/plugin-dev/skills/hook-development/SKILL.md:322-338`）：

- `$CLAUDE_PROJECT_DIR`：项目根路径；
- `$CLAUDE_PLUGIN_ROOT`：插件目录（可移植路径，务必使用）；
- `$CLAUDE_ENV_FILE`：**仅 `SessionStart`**，把 `export` 写入此文件以持久化环境变量；
- `$CLAUDE_CODE_REMOTE`：远程上下文标志。

`SessionStart` 持久化示例（`plugins/plugin-dev/skills/hook-development/examples/load-context.sh:13-16`）：

```bash
if [ -f "package.json" ]; then
  echo "📦 Node.js project detected"
  echo "export PROJECT_TYPE=nodejs" >> "$CLAUDE_ENV_FILE"
```

### 7. 内容注入与阻断的两种风格

**注入（放行且补充上下文）**：输出 `hookSpecificOutput.additionalContext`。explanatory 输出风格用 `SessionStart` 注入一段说明（`plugins/explanatory-output-style/hooks-handlers/session-start.sh:4-8`）：

```json
{
  "hookSpecificOutput": {
    "hookEventName": "SessionStart",
    "additionalContext": "You are in 'explanatory' output style mode, ..."
  }
}
```

security-guidance 在 `PostToolUse` 命中模式时同样以 `additionalContext` 告警（`plugins/security-guidance/hooks/security_reminder_hook.py:2174-2178`）：

```python
            if all_guidance:
                output["hookSpecificOutput"] = {
                    "hookEventName": "PostToolUse",
                    "additionalContext": PROVENANCE_TAG + "\n\n" + "\n\n".join(all_guidance),
                }
```

**阻断**：两种等价路径——命令 hook `exit 2`（stderr 作为原因），或输出 `{"decision":"block","reason":...}`。hookify 的引擎按事件选用不同格式（`plugins/hookify/core/rule_engine.py:61-84`，逐字）：

```python
        if blocking_rules:
            messages = [f"**[{r.name}]**\n{r.message}" for r in blocking_rules]
            combined_message = "\n\n".join(messages)

            # Use appropriate blocking format based on event type
            if hook_event == 'Stop':
                return {
                    "decision": "block",
                    "reason": combined_message,
                    "systemMessage": combined_message
                }
            elif hook_event in ['PreToolUse', 'PostToolUse']:
                return {
                    "hookSpecificOutput": {
                        "hookEventName": hook_event,
                        "permissionDecision": "deny"
                    },
                    "systemMessage": combined_message
                }
            else:
                # For other events, just show message
                return {
                    "systemMessage": combined_message
                }
```

Ralph 的循环控制则输出 `Stop` 的 block（`plugins/ralph-wiggum/hooks/stop-hook.sh:170-174`，逐字）：

```bash
jq -n \
  --arg prompt "$PROMPT_TEXT" \
  --arg msg "$SYSTEM_MSG" \
  '{
    "decision": "block",
    "reason": $prompt,
    "systemMessage": $msg
  }'
```

### 8. Hook 类型：`command` 与 `prompt`

- **`command`**：执行确定性外部命令；适合快速校验、文件系统操作、外部工具集成、性能敏感检查（SKILL.md:42-58）。
- **`prompt`**：由 LLM 做上下文感知判断；官方文档称支持 `Stop`、`SubagentStop`、`UserPromptSubmit`、`PreToolUse`（SKILL.md:22-40；校验脚本对其它事件给出「可能不完全支持」告警，`validate-hook-schema.sh:124-127`），prompt 内可用 `$TOOL_INPUT`、`$TOOL_RESULT`、`$USER_PROMPT` 等占位符。

## 数据流 / 时序

### PreToolUse（工具调用前）

1. 引擎匹配 `matcher`，选中该工具的全部 hook；
2. **并行**执行每个 hook，向 stdin 写入含 `tool_name`/`tool_input`/`tool_use_id` 的 JSON；
3. hook 输出 JSON 或按退出码表态：`exit 0` 放行、`exit 2` 阻断、`permissionDecision` 参与权限；
4. 任一 `deny` 即拒绝；`updatedInput` 在通过 schema 校验后替换入参。

hookify 的实现即此流程：读 stdin → 依据 `tool_name` 映射到内部事件 `bash`/`file` → 载入规则 → 求值 → 打印 JSON → **始终 `exit 0`**（`plugins/hookify/hooks/pretooluse.py:35-70`，`finally: sys.exit(0)`）。它选择用 JSON 的 `permissionDecision: deny` 表达阻断，而非退出码。

### PostToolUse（工具返回后）

1. 引擎写入含 `tool_response`/`duration_ms` 的 JSON；
2. hook 反应：告警、替换输出（`updatedToolOutput`）、记录遥测；
3. `exit 2` 会把 stderr 回灌给 Claude（不撤销已完成的工具）。

security-guidance 在此事件对 `Edit`/`Write`/`MultiEdit`/`NotebookEdit` 做正则匹配（`plugins/security-guidance/hooks/security_reminder_hook.py:2112-2129`），命中即注入 `additionalContext`；对 `Bash` 则在 `git commit`/`git push` 时触发 LLM 复审，并以 `exit 2` 把发现回灌（`:2095-2109`、`:1376`）。

### Stop（准备停止）

1. 引擎写入 `stop_hook_active`（递归保护位）、`transcript_path` 等；
2. hook 决定放行（`exit 0`）或 `block`（`decision: "block"` + `reason`）；
3. `block` 时引擎把 `reason` 作为新一轮输入继续，直到放行。

Ralph 在此拦截退出：若 `.claude/ralph-loop.local.md` 存在且未达 `max_iterations`、未出现 `<promise>` 完成标记，则递增 `iteration` 并回灌原 prompt（`plugins/ralph-wiggum/hooks/stop-hook.sh:13-56`、`:136-177`）。security-guidance 在 Stop 用 `git diff` 对基准 SHA 做 LLM 复审并 `exit 2`（`security_reminder_hook.py:1700-1972`）。注意 `stop_hook_active` 是**递归保护**：Ralph 未显式检查它，而 security-guidance 一进入即检查（`:1719`）。

### SessionStart（会话开始）

1. 引擎写入 `source`（`startup`/`resume`/`clear`/`compact`/`fork`，`mods/types/claude-code.d.ts:9153-9155`）；
2. hook 输出 `additionalContext`/`initialUserMessage`/`watchPaths`/`reloadSkills`，并可写 `$CLAUDE_ENV_FILE` 持久化环境变量。

两个 output-style 插件均以 `SessionStart` 注入说明（`plugins/explanatory-output-style/hooks/hooks.json:5-13`）。

### UserPromptSubmit（用户提交 prompt）

1. 引擎写入 `prompt` 与 `source`（`user`/`sdk`/`system`/`loop_wakeup`/`schedule_wakeup`/`poll_event`，`mods/types/claude-code.d.ts:11284-11290`）；
2. hook 可注入 `additionalContext`、设 `sessionTitle`、`suppressOriginalPrompt`，或阻断。

security-guidance 在此捕获 git 基线 SHA（`security_reminder_hook.py:446-515`），为 Stop 复审提供 diff 基准。

### 典型端到端示例：security-guidance 三层

```
UserPromptSubmit ──► 捕获 baseline SHA（git stash create）
        │
每次 Edit/Write ──► PostToolUse ──► 25+ 正则模式 ──► additionalContext 告警
        │
git commit ──────► PostToolUse[Bash, if=Bash(git commit:*)] ──► asyncRewake LLM 复审 ──► exit 2 回灌
git push ────────► PostToolUse[Bash, if=Bash(git push:*)]   ──► asyncRewake push-sweep ──► exit 2
        │
Stop ────────────► 对 baseline..HEAD 的 diff 做 LLM 复审 ──► exit 2 回灌 / 更新 baseline
```

（依据 `plugins/security-guidance/hooks/hooks.json` 与 `security_reminder_hook.py:8-53` 的模块 docstring。）

## 扩展点

1. **插件目录 `hooks/hooks.json`**：`permissions`/`matcher` 声明式挂载；同一事件可多组、组内多 hook 并行。
2. **设置直接格式**：用户在 `.claude/settings.json` 顶层直接写事件（SKILL.md:102-119）。
3. **托管设置**：`allowManagedHooksOnly`、`allowedHttpHookUrls` 等键把 hooks 收归组织管控（`examples/settings/README-hipaa.md:75`）。
4. **命令 hook**：任意可执行文件，经 stdin/stdout/exit code 与引擎通信；可用 `${CLAUDE_PLUGIN_ROOT}` 保持可移植。
5. **prompt hook**：只写提示词，不写脚本。
6. **`if` + `asyncRewake`**：按子命令前缀细分触发、后台执行并唤醒模型（`plugins/security-guidance/hooks/hooks.json:36-42`）。
7. **环境变量持久化**：`SessionStart` + `$CLAUDE_ENV_FILE`。
8. **状态文件约定**：hook 间通过临时文件/JSON 状态共享（如 hookify 的 `.claude/hookify.*.local.md`、Ralph 的 `.claude/ralph-loop.local.md`、security-guidance 的会话状态文件与 `.git/sg-reviewed-shas`），因为并行 hook 之间没有内存共享。
9. **hookify 规则 DSL**：在 classic hooks 之上再抽象一层，用户只写正则与消息，由插件脚本统一解析执行（`plugins/hookify/`）。

## 设计决策与权衡

**1. 进程外协议（JSON-in / JSON-or-exit-out）**
用「stdin JSON / stdout JSON / exit code」而非进程内 API，使 hook 可用任意语言实现、天然隔离崩溃与卡死。代价是每次工具调用都要 fork 进程、序列化 JSON，且无法访问引擎内部状态（只能读 `transcript_path` 等文件）。性能由 `timeout` 兜底（hookify 用 `timeout: 10`）。

**2. 退出码 + JSON 双通道**
`exit 2` 是「阻断」的通用语法，JSON 的 `decision`/`permissionDecision` 是更结构化、更细粒度的语法。两种并存带来表达力，但也要求 hook 作者理解各自适用事件（hookify 的引擎即按事件切换两种格式）。

**3. 全并行、无序**
所有匹配 hook 并跑，最大化响应速度，但**禁止跨 hook 依赖时序**；需要跨事件协作时只能落盘共享状态（SKILL.md:495-518、`references/advanced.md:113、442-448` 明确警告「不要假设 hook 执行顺序」）。

**4. fail-open 的默认姿态**
hookify 的每个执行器都 `finally: sys.exit(0)`，并注释「ALWAYS exit 0 - never block operations due to hook errors」（`plugins/hookify/hooks/pretooluse.py:68-70`）。安全工具的失败不应阻断正常操作——但这也意味着静默失效风险，需靠 `systemMessage` 上报错误（`:30-31`、`:61-66`）。

**5. 配置启动时加载、数据运行时读取**
配置不可热替换（必须重启），但脚本引用的规则/状态文件每次执行都重读。hookify 借此实现「新建规则无需重启」的产品体验（README「No restart needed」），与 SKILL.md 的「配置需重启」并不冲突——前者是数据，后者是配置。

**6. 上下文注入是最强、也最微妙的原语**
`additionalContext` 让 hook 直接影响模型行为（output style、安全提醒）。security-guidance 特意加了 `PROVENANCE_TAG`/`PROVENANCE_BANNER` 与「continue with the user's original request」后缀，避免注入被当作 prompt injection 或被模型误读为用户新指令（`security_reminder_hook.py:184-191`）。

**7. classic hooks 与 function-hooks 的分野**
- **classic**：`hooks/hooks.json`，键是 `hooks`，值是外部进程/prompt；事件名即 `HookInput['hook_event_name']`；在 function-hooks 视角下以 `classic.<Event>` 暴露（`mods/types/claude-code.d.ts:938-966`），链序为「managed 设置 hooks → hooks modules → 其他设置 hooks」。
- **function hooks（mods）**：`hooks/hooks.json` 里是 `{"description":..., "modules":["./register.ts"]}`（`mods/telemetry/hooks/hooks.json:1-4`、`mods/sec-default/hooks/hooks.json:1-4`），实现为 `register(on, options)`，以 `($, e, next)` 函数与 `on('tool.call', ...)`/`on('session.start', ...)`/`on('engine.create', ...)` 等**进程内**事件交互（`mods/telemetry/hooks/register.ts:23-51`）；`next(e)` 表示「交给下层」，可返回改写后的 `e`（`mods/types/claude-code.d.ts:946-976`）。两者可共存且可被 `sec-default` 以「最外层座位」策略隔离（`mods/README.md:10`，`mods/sec-default/hooks/hooks.json:2`）。

**8. 安全与边界**
hooks 在沙箱外运行任意代码，因此托管设置提供 `allowManagedHooksOnly` 收口；`allowedHttpHookUrls` 限制远程 hook 端点。`sg-python.sh` 展示了跨平台健壮性（探测 `python3`/`python`/`py -3`，绕开 Windows Store 桩），`:1-40`。这也说明：hook 作者需自行处理解释器缺失、编码、超时等失败模式。

## 对复刻产品的启示

1. **把协议做小、做稳**：stdin 一行 JSON、stdout 一行 JSON、exit 0/2 表意。这套契约简单到任何语言十行可实现，是生态可扩展的关键。
2. **显式区分「配置」与「数据」**：配置随会话加载（可预测），数据每次执行重读（可热更）。产品上可据此提供「无需重启即时生效」的用户功能。
3. **给阻断两种表达**（退出码 + 结构化 JSON），并在文档里为每个事件列明「该事件读取哪些输出字段」——`ClassicResultFields` 式的**按事件白名单**比「一把大 JSON」更利于实现与校验。
4. **上下文注入要带出处与续跑指令**：给模型注入的内容需机器可识别的来源标记，并显式声明「这是补充，不是替换用户请求」，否则易被误当新指令。
5. **默认 fail-open、但上报**：执行层的异常一律放行，同时用 `systemMessage` 暴露错误，兼顾可用性与可观测性。
6. **并行 + 无序 + 状态落盘**：不要给 hook 排序保证；需要协作就落盘。产品应同时提供「状态文件位置/命名约定」与清理策略。
7. **事件表要完整且分层**：基础文档可只枚举高频事件，但**运行时类型**必须是全集的单一事实源；避免「文档 9 个、实现 33 个、校验脚本硬编码 9 个」这类漂移。
8. **把 DSL 建成插件**：hookify 证明「规则 DSL 当作 classic hooks 之上的一层插件」可行——底层协议保持最小，用户体验层单独演进。
9. **为托管/企业场景预留收口键**：`allowManagedHooksOnly` 之类的开关是企业采用的前提，应在复刻时一并设计，并把 hook 视为沙箱外的受信代码。

## 关键文件索引

**协议与契约**

- `mods/types/claude-code.d.ts:583-609` — `BaseHookInput` 公共输入字段。
- `mods/types/claude-code.d.ts:4288` — `HookInput` 联合类型（33 个事件的规范全集）。
- `mods/types/claude-code.d.ts:958` — `ClassicHookEvent` 定义。
- `mods/types/claude-code.d.ts:938-966` — classic 事件在 function-hooks 中的 `classic.<Event>` 映射与链序。
- `mods/types/claude-code.d.ts:976-1052` — `ClassicResult` 输出字段全集。
- `mods/types/claude-code.d.ts:1060-1077` — `ClassicResultFields` 按事件的输出白名单。
- `mods/types/claude-code.d.ts:6488-6498` — `PreToolUseResult`（`updatedInput`/`additionalContext`）。
- `mods/types/claude-code.d.ts:6372/6476/9153/9448/11284/6385` — 各事件输入结构。

**官方 hook 开发指引（plugin-dev）**

- `plugins/plugin-dev/skills/hook-development/SKILL.md` — 事件表（634-644）、输出格式（280-298）、输入格式（300-320）、matcher（386-425）、环境变量（322-338）、生命周期限制（572-598）、调试（600-628）。
- `plugins/plugin-dev/skills/hook-development/references/patterns.md` — 10 个常用模式（安全校验、测试强制、上下文加载、限流等）。
- `plugins/plugin-dev/skills/hook-development/references/advanced.md` — 多阶段校验、跨事件协作、外部系统集成、风险点。
- `plugins/plugin-dev/skills/hook-development/references/migration.md` — command → prompt hook 迁移。
- `plugins/plugin-dev/skills/hook-development/scripts/validate-hook-schema.sh:41` — 校验脚本硬编码的 9 个事件。
- `plugins/plugin-dev/skills/hook-development/examples/validate-bash.sh:24-40` — `PreToolUse` 阻断/询问示例。
- `plugins/plugin-dev/skills/hook-development/examples/load-context.sh` — `SessionStart` + `$CLAUDE_ENV_FILE` 示例。
- `plugins/plugin-dev/skills/plugin-structure/references/manifest-reference.md:259-296` — 插件清单 `hooks` 字段（路径/内联）。

**示例**

- `examples/hooks/bash_command_validator_example.py:30-37,47-63` — 独立 `PreToolUse` 守卫，stdin/stdout/exit-code 契约。
- `plugins/explanatory-output-style/hooks/hooks.json` + `hooks-handlers/session-start.sh:4-8` — `SessionStart` 注入上下文。
- `plugins/learning-output-style/hooks-handlers/session-start.sh` — 同上，更复杂的注入。

**hookify（规则 DSL）**

- `plugins/hookify/hooks/hooks.json:1-49` — 四个事件的 command hook 挂载。
- `plugins/hookify/hooks/pretooluse.py:39-70`（`posttooluse.py`/`stop.py`/`userpromptsubmit.py` 类似）— stdin/stdout/exit-0 契约。
- `plugins/hookify/core/rule_engine.py:35-94` — 匹配求值与按事件阻断格式。
- `plugins/hookify/core/rule_engine.py:96-180` — 规则匹配、字段提取、六种 operator。
- `plugins/hookify/core/rule_engine.py:127-142` — matcher 的 `|`/`*` 语义。
- `plugins/hookify/core/config_loader.py:87-195` — 手写 frontmatter 解析器。
- `plugins/hookify/core/config_loader.py:198-241` — `.claude/hookify.*.local.md` 动态加载。
- `plugins/hookify/skills/writing-rules/SKILL.md` — 规则语法权威文档（frontmatter、事件、conditions、operators）。
- `plugins/hookify/README.md`、`plugins/hookify/commands/hookify.md`、`configure.md`、`list.md`、`help.md` — 用户工作流。
- `plugins/hookify/agents/conversation-analyzer.md` — 从对话中抽取行为的子 agent。

**security-guidance**

- `plugins/security-guidance/hooks/hooks.json` — 四类事件 + `if`/`asyncRewake`。
- `plugins/security-guidance/hooks/security_reminder_hook.py:8-53` — 架构 docstring；`:163-191` 开关与续跑后缀。
- `plugins/security-guidance/hooks/security_reminder_hook.py:2019-2189` — `main` 分派与 `PostToolUse` 模式检查。
- `plugins/security-guidance/hooks/security_reminder_hook.py:1700-1972` — Stop 复审。
- `plugins/security-guidance/hooks/patterns.py:30-261` — 全部正则/子串模式与告警文案。
- `plugins/security-guidance/hooks/patterns.py:264-334` — `RuleId` 枚举与一致性断言。
- `plugins/security-guidance/hooks/sg-python.sh` — 跨平台解释器探测。

**ralph-wiggum**

- `plugins/ralph-wiggum/hooks/hooks.json` — `Stop` hook 挂载。
- `plugins/ralph-wiggum/hooks/stop-hook.sh:10-177` — 循环拦截、`decision: block` 回灌、完成标记检测。
- `plugins/ralph-wiggum/commands/ralph-loop.md`、`cancel-ralph.md` — 循环启停。

**托管/企业边界**

- `examples/settings/README-hipaa.md:75,139` — `allowManagedHooksOnly` 与 hook 权限。
- `examples/settings/settings-strict.json:13`、`settings-hipaa.json:5` — 实际托管值。

**function-hooks 对照**

- `mods/README.md:1-21,114-117` — mod 即 hooks module。
- `mods/telemetry/hooks/hooks.json`、`mods/sec-default/hooks/hooks.json` — `modules`/`register.ts` 格式。
- `mods/telemetry/hooks/register.ts:23-51` — `register(on)` 与 `on('...')` 函数 hook 形态。

## 存疑与待确认

1. **`if` 与 `asyncRewake` 的精确语义未在仓库文档中成文**。仅见 `plugins/security-guidance/hooks/hooks.json:33-42` 的实际用法与 `security_reminder_hook.py` 注释（`:2076-2109`）的推断：`if` 为形如 `Bash(<子命令>:*)` 的前缀匹配，`asyncRewake` 为后台执行并在完成后唤醒模型续跑，`rewakeMessage`/`rewakeSummary` 分别作为唤醒输入与终端摘要。其字段全貌、与 `timeout` 的交互、失败语义均**未经源码确证**。此外，`security_reminder_hook.py:2103` 显示同一 `tool_use_id` 在多个 `if` 命中时会**被 spawn 多次**，hook 需自行去重——这是复刻时必须验证的运行时行为。

2. **事件集合的「文档 vs 运行时」不一致**。运行时 `HookInput` 含 33 个事件（`mods/types/claude-code.d.ts:4288`），而官方 hooks 开发 skill 与 `validate-hook-schema.sh` 只认 9 个。无法从本仓库判定：classic 的 `hooks.json` 配置**实际**接受哪些事件名（是否所有 33 个都能在 classic 配置里声明），以及 `validate-hook-schema.sh` 的 9 项是否为滞后。本文据类型定义列出全集，但**不代表全部可用于 classic settings hooks 配置**。

3. **`matcher` 的正则语义归属**。SKILL.md:404-425 称 matcher 支持正则（如 `mcp__.*`），而 hookify 自研引擎（`rule_engine.py:127-142`）只做 `|` 拆分与精确匹配。二者的正则能力是否一致、`*` 的全量语义，未在引擎源码中确证。

4. **输出字段的逐事件白名单来源**。`ClassicResultFields`（`d.ts:1060-1077`）描述的是运行时读取行为；本仓库的插件开发文档未覆盖其中多数事件（如 `updatedToolOutput`、`reloadSkills`、`watchPaths`），故这些字段的**实际生效条件**未知。

5. **`timeout` 上限与默认值**。`validate-hook-schema.sh:136-141` 提示 600s 上限、小于 5s 过小；SKILL.md:491 称命令默认 60s、prompt 默认 30s。这些是**校验脚本/文档**口径，非引擎源码事实。

6. **`security-guidance` 的「9 个模式」表述**。任务描述与早期版本称监控 9 个安全模式；当前 `patterns.py` 实为 **25 个规则**（`SECURITY_PATTERNS`，`patterns.py:30-261`，`RuleId` 1-25）。README 也写「~25 known-dangerous patterns」（`plugins/security-guidance/README.md:5`）。复刻时以 `patterns.py` 为准。

7. **`SessionStart` 的 `source` 取值**。类型定义为 `'startup' | 'resume' | 'clear' | 'compact' | 'fork'`（`d.ts:9155`），但插件文档未列出，且这些分支下的 hook 行为差异（尤其 `compact`/`fork`）未在本仓库说明。

8. **hook 执行的并发上限、超时被触发时的具体动作（kill 后是否 `exit 2`）、以及 hook 进程的权限继承**（是否与主进程同权限）在本仓库无明确文档，需实测。
