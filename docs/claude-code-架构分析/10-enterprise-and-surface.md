# 10 · 企业级部署与产品能力面（Enterprise Deployment & Product Surface）

> 本文档基于公开仓库 `anthropics/claude-code`（**非引擎源码**）中随仓库发布的参考产物撰写：
> `examples/gateway/{aws,gcp}`、`.devcontainer/`、`Script/`、`README.md`、`CHANGELOG.md`、`feed.xml`。
> 目的是同时回答两件事：
> **(a) 企业部署架构**——LLM gateway 在 AWS/GCP 上的落地形态，以及 devcontainer；
> **(b) 产品能力面盘点**——从 `CHANGELOG.md` + `README.md` 推导的特性版图、CLI/安装面、值得注意的子系统。
> 文中所有路径均为仓库相对路径；标识符一律用反引号保留英文原文。所有对外部文档的引用（`code.claude.com/docs/...`）不在本仓库内。

---

## 定位

本模块描述的是**「外壳」而非「引擎」**：一个 agentic 编码工具的**企业分发层**与**演进记录层**。

- **企业分发层**由两类产物构成：
  1. **LLM gateway**（“Claude apps gateway”）：一个独立部署的、面向组织的**模型访问代理**，把 Claude Code 客户端与上游模型（Amazon Bedrock / Google Agent Platform「原 Vertex AI」/ 其他）之间的**认证、路由、审计、限流、RBAC、模型目录**集中到一处。仓库在 `examples/gateway/aws/` 与 `examples/gateway/gcp/` 各给了一套**参考部署**（`setup.sh` 脚本轨 + `terraform/` 声明式轨）。
  2. **devcontainer**：`.devcontainer/` + `Script/run_devcontainer_claude_code.ps1`，给出一套**可复现、带出网防火墙的沙箱化开发环境**。
- **演进记录层**由 `CHANGELOG.md`（约 987 KB，418 个版本段落）与 `feed.xml`（Atom 发布订阅源）构成，是一份**机器生成风格的公开变更日志 + 发布源**，本身就是值得复刻的「产品表面产物」。

一句话：本模块 = **「一个 agentic CLI 工具如何被企业集中治理、如何被分发安装、以及它的能力如何随时间生长」**。

---

## 职责与边界

### gateway 的职责（为什么它存在）

gateway 是客户端与模型之间的**唯一收口点**，承担四类职责，均可从示例配置中读出：

1. **上游路由（Bedrock/Vertex 适配）**：`upstreams` 是一张按序排列的列表，`provider: bedrock` 或 `provider: vertex`，并支持故障转移——“tried top→bottom on 5xx/timeout/501”（`examples/gateway/aws/gateway.yaml.example:111-113`、`examples/gateway/gcp/gateway.yaml.example:99-101`）。它把同一逻辑模型（如 `claude-opus-4-8`）**自动翻译**成各家上游的模型 ID（`upstream_model: { bedrock: us.anthropic.claude-opus-4-8 }`，`aws/gateway.yaml.example:174`）。
2. **凭证代理（credential brokering）**：客户端**不持有**云凭证。上游鉴权用 `auth: {}`，走云上的默认凭证链——AWS 上是 ECS task role / EKS IRSA，GCP 上是 Cloud Run SA / GKE Workload Identity（`aws/gateway.yaml.example:109`、`gcp/gateway.yaml.example:97`）。开发者登录 gateway 用**组织 IdP**（Okta / Google Workspace）的 OIDC，而不是 Anthropic API key。
3. **集中审计与遥测**：gateway 的 stderr 同时承载**审计事件与运维日志**（`examples/gateway/aws/setup.sh:727`；`terraform/main.tf:336`），并作为 OTLP 扇出点，在服务端给事件打上 `user.id/user.email/user.groups`（`aws/gateway.yaml.example:115-129`）。
4. **限流 / RBAC / 模型目录**：`trusted_proxies` 使“per-IP rate limiting / audit IPs record the real client”正确工作（`aws/gateway.yaml.example:48-60`）；`managed.policies` 做 first-match-wins 的分组策略（可用模型、deny 规则）；`admin` API 启用 spend caps 运行时配置。

### devcontainer 的职责

提供**一致的、默认拒绝出网的**agent 运行环境，与宿主隔离：`postStartCommand` 在容器启动后执行 `init-firewall.sh`（`.devcontainer/devcontainer.json:55-56`），只放行白名单域名。

### 边界（明确不做什么）

- **本仓库不是引擎源码**：`claude` 二进制、`gateway` 子命令的**实现**都不在此仓库。Dockerfile 明确“does NOT build the binary”，只接收**预编译**的 `linux-x64` 可执行文件（`aws/Dockerfile:1-7`，`gcp/Dockerfile:4-10`）。
- **参考而非产品**：两处 README 都写明 “provided as a working example rather than a supported production deployment”（`aws/README.md:7-8`、`gcp/README.md:7-8`）。
- **只覆盖单条路径**：AWS 脚本/terraform 只实现 **ECS Fargate**（EKS 轨仅在 walkthrough §7 的 tab 中，“Not covered”，`aws/setup.sh:24`）；GCP 只实现 **Cloud Run**（GKE 轨 §7a 未覆盖，`gcp/setup.sh:23`）。
- **网络前置不代建**（AWS）：VPC 与私有子网是 walkthrough 前置，作为变量传入，“no network is created here”（`aws/terraform/main.tf:5-6`，`aws/terraform/README.md:7-9`）；而 GCP 模块**会**创建 VPC + Private Services Access，因为私网 Cloud SQL 需要它（`gcp/setup.sh:11-14`）。
- **settings/MDM 不在本文范围**：仅交叉链接，见 `examples/settings/README.md:29-35` 与 `examples/mdm/README.md`（`examples/settings/README.md` 第 13-21 行的配置矩阵、第 33-35 行的 HIPAA 组合；`examples/mdm/README.md` 第 13-19 行的模板表）。本文不复制其内容。

---

## 关键抽象与接口

### 1) `claude gateway` 可执行与 `gateway.yaml` 配置契约

运行时入口只有一个（两云一致）：

```dockerfile
ENTRYPOINT ["/usr/local/bin/claude", "gateway", "--config", "/etc/claude/gateway.yaml"]
```

（`examples/gateway/aws/Dockerfile:67`，`examples/gateway/gcp/Dockerfile:35`。）

`gateway.yaml` 是**唯一配置契约**，各段（section）如下（行号取自 AWS 模板，GCP 同名段含义一致）：

| 段 | 关键键 | 语义 | 出处 |
|---|---|---|---|
| `listen` | `host` / `port` / `public_url` / `trusted_proxies` / `tls` | 监听地址与**权威对外 URL**；`public_url` 必填，用于固定 IdP `redirect_uri`、OIDC discovery、gateway-token issuer，**绝不从客户端可控的 `Host` 头推导** | `aws/gateway.yaml.example:30-65` |
| `oidc` | `issuer` / `client_id` / `client_secret` / `allowed_email_domains` / `scopes` / `groups_claim` / `userinfo_fallback` / `google_groups` | 组织 IdP 登录 | `aws:67-82`、`gcp:61-78` |
| `session` | `jwt_secret`（≥32 bytes）/ `ttl_hours`（数组即轮换密钥） | 会话签发与撤销围栏 | `aws:84-91` |
| `store` | `postgres_url` | **必需**；gateway 无它拒绝启动，并在启动时跑自身 schema migration | `aws:93-96`、`aws/setup.sh:963` |
| `upstreams` | `provider` / `region` / `project_id` / `auth` / `base_url` / `models` | 上游列表与故障转移 | `aws:98-113`、`gcp:92-101` |
| `telemetry` | `forward_to[].url` / `headers` / `metrics` / `logs` / `traces` | OTLP 扇出；`logs` 含 bash 命令/工具输入，默认关，“opt in deliberately” | `aws:115-129` |
| `managed.policies` | `match`（`groups` / `email_domain`）/ `cli` / `code` / `desktop` | RBAC + 托管设置，**first-match-wins**，末条应为 catch-all | `aws:131-142`、`gcp:120-131` |
| `admin` | `write_keys` / `read_keys` / `admin_groups` | Admin API（db-mode 运行时配置 + spend caps），key 值 ≥32 字符 | `aws:144-157` |
| 模型目录 | `auto_include_builtin_models` / `models[]`（`id` / `label` / `upstream_model`） | 默认暴露全部内建 Claude 模型并自动翻译 | `aws:159-174` |

**密钥展开**是贯穿全文件的抽象：`${ENV_VAR}` 读环境变量，`${file:/path}` 读挂载文件（`aws/gateway.yaml.example:18-21`）。配置文件本身**不含密钥值**，只含引用。

### 2) 客户端如何被指向 gateway

客户端不认识“网关”这个概念，只通过**身份与端点配置**接入：

- 托管设置 `forceLoginMethod: "gateway"` + `forceLoginGatewayUrl`，让 `/login` 打开指定 gateway（`CHANGELOG.md` 2.1.295）。
- `allowedProviders` 托管设置限制某台机器可用哪些 provider，取值包含 “Claude gateway”（`CHANGELOG.md` 2.1.285）。
- `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN` 指向自定义 gateway/代理（`CHANGELOG.md` 中多处，如 2.1.290 对 `ANTHROPIC_BASE_URL with ANTHROPIC_AUTH_TOKEN` 的描述）。
- gateway 在配置了 `telemetry.forward_to` 且 `public_url` 就绪时，会**自动把** `CLAUDE_CODE_ENABLE_TELEMETRY` 与 OTEL exporter 选择器推给每个客户端，“no per-developer config needed”（`aws/gateway.yaml.example:120-121`）。
- LLM gateway 提示头：`CLAUDE_CODE_GATEWAY_HINT_HEADERS=1` 打开 `x-claude-code-prompt-id` 等头，便于网关按用户提示分组（`CHANGELOG.md` 2.1.283 / 2.1.273）。

### 3) 云资源抽象的映射

| 抽象角色 | AWS 实现 | GCP 实现 |
|---|---|---|
| 计算 | ECS Fargate service（`aws/setup.sh:868-895`）/ EKS | Cloud Run v2（`gcp/terraform/main.tf:274-382`）/ GKE |
| 入口负载均衡 | internal ALB + HTTPS:443 listener（`terraform/main.tf:425-464`） | Cloud Run `ingress=internal`（**不建 LB**，默认） |
| 数据库 | RDS for PostgreSQL 私网、`rds.force_ssl=1`（`setup.sh:556-647`） | Cloud SQL PostgreSQL 私网（`ipv4_enabled=false`，`main.tf:106-123`） |
| 镜像仓库 | ECR（IMMUTABLE + scan-on-push，`main.tf:191-197`） | Artifact Registry（`main.tf:59-66`） |
| 密钥 | Secrets Manager（`main.tf:261-329`） | Secret Manager（`main.tf:150-243`） |
| 运行身份 | task role（Bedrock invoke）+ execution role（拉镜像/注入密钥） | service account（`roles/aiplatform.user` + `secretAccessor`） |
| 日志 | CloudWatch Logs，默认保留 90 天（`main.tf:336-342`） | Cloud Logging（`setup.sh:521`） |
| 网络出口 | NAT 网关（`assign_public_ip=false`，`main.tf:481-487`） | Direct VPC egress，`egress=PRIVATE_RANGES_ONLY`，无需 Cloud NAT（`main.tf:308-314`） |

### 4) Terraform 模块接口

- AWS `variables.tf:16-33` 把 `vpc_id` / `private_subnet_ids`（≥2，跨 AZ）/ `corporate_cidr` 作为**必填前置**；`outputs.tf:1-34` 输出 `alb_dns_name` / `alb_zone_id` / `image` / `ecr_repository_url` / 两个 role ARN / `db_endpoint`。
- GCP `variables.tf` 以 `ingress` 约束为 `INGRESS_TRAFFIC_INTERNAL_ONLY` 或 `..._LOAD_BALANCER`，并校验 `/login` 只接受私网地址（`gcp/terraform/variables.tf:158-166`）；`outputs.tf:1-34` 输出 `service_url` / `oauth_redirect_uri` / `service_account_email` / `db_private_ip` 等。

### 5) 产品能力面盘点（feature-area inventory）

> 说明：**「出现时间」取自各关键词在 `CHANGELOG.md` 中的最早版本号**（该文件按版本倒序，`## <version>` 编号从 `0.2.21` 到 `2.1.296`，共 418 段，见 `CHANGELOG.md:1` 起）。变更日志是**精选子集**，不保证等于功能首次发布，故这些版本号应读作“最早见诸公开变更日志的版本”，见「存疑」。

| 能力域（area） | 它是什么 | 最早出现（版本，作为代理） |
|---|---|---|
| 终端 TUI / 主交互面 | 终端里的 agentic CLI | 起点即 `0.2.21`（日志最旧段） |
| MCP（Model Context Protocol） | 外部工具/服务器接入；`claude mcp add` 向导 | `0.2.31`（`--mcp-debug`），`0.2.32` 交互式向导 |
| 自定义 slash command | `.claude/commands/*.md` 变成斜杠命令 | `0.2.31` |
| 权限管理 | `/approved-tools`、`.claude/settings.json` 共享规则 | `0.2.26` / `0.2.67` |
| Web 工具 | `WebFetch` 让 Claude 打开粘贴的 URL | `0.2.53` |
| 会话续接 | `claude --continue` / `--resume` | `0.2.93` |
| Print/headless 模式 | `-p` + `--output-format=stream-json` | `0.2.66` |
| Bedrock 支持 | AWS 模型接入、ARN 语义 | `0.2.125`（含一项 breaking change） |
| Vertex AI 支持 | GCP 模型接入 | `1.0.8` |
| Claude Code GA | “generally available”；Sonnet 4 / Opus 4 | `1.0.0`（`CHANGELOG.md:8593`） |
| IDE 集成（VS Code） | 编辑器内 diff、图片粘贴等 | `1.0.17`（VS Code diff），`1.0.61`（粘贴图片） |
| Hooks | 事件钩子（`PreToolUse` 等） | `1.0.38` |
| Subagent | 子代理；`Stop`/`SubagentStop` 拆分 | `1.0.41`（`Explore` 子代理 `2.0.17`） |
| Plan mode | 先规划后执行 | `1.0.33` |
| Output styles | 可切换输出风格 | `1.0.81` |
| OpenTelemetry 遥测 | OTel 日志/指标；mTLS exporter | `1.0.28`（mTLS `1.0.126`） |
| 原生 VS Code 扩展 / Agent SDK / `--agents` / `/rewind` / `/usage` | 2.0 大版本 | `2.0.0`（`CHANGELOG.md:8073`） |
| Plugin 系统 | 市场、`extraKnownMarketplaces`、`/plugin` | `2.0.12`（文档/仓库级配置）/ `2.0.20`（Skills） |
| Agent Skills | “Claude Skills” | `2.0.20` |
| Bash 沙箱 | Linux & Mac 上的 Bash 工具沙箱 | `2.0.24` |
| 企业托管设置 / 托管 MCP 名单 | 组织级 allowlist/denylist | `2.0.22`；Windows 托管设置 `2.0.58` |
| LSP 工具 | go-to-definition 等代码智能 | `2.0.74` |
| Claude in Chrome（Beta） | Chrome 扩展协作 | `2.0.72` |
| 远程会话 / teleport | Web↔CLI 传送、`/teleport` | `2.0.24`（Web→CLI）/ `2.1.0`（`/teleport`） |
| 自托管 runner | `claude self-hosted-runner` 用自己的机器跑会话 | `2.1.224` |
| JetBrains 终端修复 | IDE 2025.2 终端滚轮等 | `2.1.132` |
| Claude apps gateway（LLM 网关） | 企业级模型访问代理（本文重点） | 初现 `2.1.25`，正式命名 `2.1.246`，完整配置面 `2.1.27x–2.1.29x` |
| Claude Tag（Slack `@Claude`） | Slack 内协同 | `2.1.267` |
| Mods | “behavior-in-hooks-module”的插件（可改深层行为） | `2.1.287` |
| 1M 上下文窗口 | 支持 1M context 的模型 + `/autocompact` | `CHANGELOG.md` 2.1.285 |

变更日志中的**分类动词**本身也刻画了产品重心：`Fixed` 3904 条、`Improved` 738、`Added` 706、`Changed` 359，另有 `Removed` / `Deprecated` / `Renamed` / `Hardened` / `Faster` 等，以及平台/子系统前缀 `Windows:`、`[VSCode]`、`IDE:`、`SDK:`、`Hooks:`、`MCP:`、`Bedrock`。

---

## 数据流 / 时序

### A. 企业 gateway 核心数据流：client → gateway → Bedrock/Vertex

```
开发者机器                                    VPC / 私网边界                          云上游
┌───────────────┐   HTTPS(私网地址)   ┌──────────────────────┐   HTTPS + IAM/SA  ┌──────────────┐
│ Claude Code   │ ─────────────────► │  gateway 容器        │ ────────────────► │ Amazon       │
│ (CLI/IDE/     │  /login → OIDC 跳转 │  :8080               │  auth:{} 默认链   │  Bedrock     │
│  Desktop)     │  ← gtoken(JWT)      │  ┌────────────────┐  │                   ├──────────────┤
│               │  /v1/messages       │  │ oidc / session │  │                   │ Agent        │
│  托管设置:     │ ─────────────────►  │  │ store(PgSQL)   │  │                   │  Platform    │
│  forceLogin   │                     │  │ upstreams[]    │  │                   │ (Vertex)     │
│  Method:      │                     │  │ managed/RBAC   │  │  OTLP/HTTP        ├──────────────┤
│  gateway      │                     │  │ telemetry      │  │ ─────────────────►│ OTel         │
└───────────────┘                     │  └────────────────┘  │  (扇出，服务端打标) │ Collector    │
        ▲                             └──────────────────────┘                   └──────────────┘
        │  审计事件 + 运维日志 → stderr → CloudWatch / Cloud Logging
        └─ 登录态由 gateway 签发的会话 JWT 承载；云凭证永不下发到客户端
```

**时序（首次登录 + 一次推理）：**

1. **入口终结 TLS**：AWS 在 internal ALB 的 `HTTPS:443` listener 终结（`terraform/main.tf:451-464`，pin `ELBSecurityPolicy-TLS13-1-2-2021-06`）；GCP 在 Google 前端终结，`gateway.yaml` 可选 `tls:` 自终结。
2. **`/login` 走 OIDC**：浏览器 302 到 IdP（Okta / `https://accounts.google.com`）。回调地址是 `<public_url host>/oauth/callback`（`aws/gateway.yaml.example:44-45`）。gateway **不信任** `X-Forwarded-Host/-Proto`，issuer 与 redirect 由 `public_url` 固定（`aws:34-42`）。
3. **会话签发**：登录成功后 gateway 用 `session.jwt_secret` 签发自有会话 JWT，`ttl_hours` 有界（默认 8）；IdP 的 `offline_access`/refresh 使会话静默续期并形成“撤销围栏”（`aws:84-91`）。Okta org 授权服务器的 thin `id_token` 缺 `email`/`groups`，由 `userinfo_fallback: true` 补齐（`aws:73-75`）。
4. **推理请求**：客户端把请求发到 gateway 的 `/v1/messages`；gateway 依 `managed.policies`（first-match-wins）决定该用户可用模型与拒绝规则，然后按 `upstreams` 顺序选择上游。上游鉴权 `auth: {}` 解析为运行身份（AWS task role / GCP SA），**客户端不带云凭证**。
5. **上游调用与故障转移**：命中 5xx / timeout / 501 时按 top→bottom 试下一个 upstream（`aws:111-113`）。GCP 侧可把 `base_url` 指向 Private Service Connect 端点以避免走公网（`gcp:98`）；AWS 侧可用 `bedrock-runtime` interface VPC endpoint（`aws:110`）。
6. **审计与遥测**：gateway 的 stderr 同时是审计流与运维流（`setup.sh:727`），落到 CloudWatch（默认 90 天保留，`terraform/main.tf:341`）。遥测由 gateway 扇出到 OTel Collector，并在服务端**盖章** `user.id/user.email/user.groups`（`aws:115-121`）。
7. **健康与就绪**：target group 健康检查走 `GET /readyz`（校验 store 可达，连不上 Postgres 就不进轮换），另有仅存活的 `/healthz`（`setup.sh:830-836`，`terraform/main.tf:436-448`）。Cloud Run 侧可用 `/.well-known/oauth-authorization-server` 返回 200 作为端到端启动校验（`gcp/setup.sh:509-521`）。

### B. OAuth 引导的「两趟」差异（重要权衡）

- **GCP / Cloud Run**：`run.app` URL **首次部署才分配**，故模板先放占位 `public_url: https://set-after-first-deploy.invalid`（`gcp/gateway.yaml.example:37-41`），第一趟只做 provisioning（**登录此时不可用**），拿到真实 URL 后回填并再跑一趟（`gcp/setup.sh:493-507`）。
- **AWS / ALB**：主机名由操作者**预先选定**（Route 53 私网区 + ACM 证书），所以没有占位往返（`aws/gateway.yaml.example:38-42`）。

### C. 部署时序（脚本轨，AWS）

`setup.sh` 的顺序即权威时序（`aws/setup.sh:5-9`、`301-936`）：安全组（§1）→ IAM 双角色（§2）→ 构建并推送镜像（config **烘焙进镜像**，§6+§4）→ DB subnet group + RDS（§3）→ 密钥（§5）→ ECS cluster/task/service + internal ALB（§7）。脚本**幂等**：已存在的资源跳过；对会改变暴露面的漂移是**致命**（如非 `internal` 的 ALB，`setup.sh:786-796`），其余仅告警。

### D. devcontainer 启动时序

`devcontainer.json` 声明 `postStartCommand: sudo /usr/local/bin/init-firewall.sh` 且 `waitFor: postStartCommand`（`.devcontainer/devcontainer.json:55-56`）。`init-firewall.sh` 的时序：先抓取 Docker DNS 规则 → flush `iptables`/`ipset` → 放行 DNS/SSH/localhost → 抓 GitHub meta 的 IP 段并用 `ipset allowed-domains` 聚合 → 解析白名单域名（`registry.npmjs.org`、`api.anthropic.com`、`sentry.io`、`statsig.com`、VS Code marketplace 等，`.devcontainer/init-firewall.sh:67-90`）→ 默认策略 `DROP` → 仅放行 `allowed-domains` → 其余 `REJECT` → 最后**自检**（`example.com` 必须不可达、`api.github.com` 必须可达，`init-firewall.sh:121-136`）。`run_devcontainer_claude_code.ps1` 则封装 Docker/Podman 后端选择、`devcontainer up`、取容器 ID、`exec ... zsh -c 'claude; exec zsh'`（`Script/run_devcontainer_claude_code.ps1:107-149`）。

### E. 安装/分发时序（客户端）

`README.md:19-45` 给出安装面：`curl -fsSL https://claude.ai/install.sh | bash`（macOS/Linux 推荐）、`brew install --cask claude-code`、`irm https://claude.ai/install.ps1 | iex`（Windows 推荐）、`winget install Anthropic.ClaudeCode`、以及**已弃用**的 `npm install -g @anthropic-ai/claude-code`（顶部明确 “Installation via npm is deprecated”，`README.md:14-15`）。安装后可执行 `claude`。gateway 镜像则从**发布端点**下载二进制并校验（`RELEASES_URL=https://downloads.claude.ai/claude-code-releases`，`gcp/setup.sh:40,182-216`）。

---

## 扩展点

产品表面提供多个**组织级与开发者级扩展轴**：

1. **gateway 上游可插拔**：`upstreams[]` 为列表，可混搭 `bedrock` / `vertex` / `anthropic`，实现多区域或跨云故障转移（`aws/gateway.yaml.example:98-113`）。`models[]` 允许 pin 到具体 inference profile / provisioned throughput（`aws:159-174`）。
2. **gateway 策略可配置**：`managed.policies[]` 的 `match`（`groups` / `email_domain`）→ `cli` / `code` / `desktop` 三套目标，实现按组下发模型与 deny 规则（`aws:131-142`、`gcp:120-131`）。`admin` API 支持 db-mode 运行时配置与 spend caps（`aws:144-157`）。
3. **gateway 遥测扇出**：`telemetry.forward_to[]` 可指向任意 OTLP Collector，并分别开关 `metrics`/`logs`/`traces`（`aws:115-129`）。
4. **IdP 可替换**：`oidc` 段对 Okta / Google Workspace 均给出模板；`groups_claim`、`google_groups`（Admin SDK 取 Workspace 组）、`extra_auth_params` 处理各家差异（`aws:67-82`、`gcp:61-78`）。
5. **客户端插件系统**：`plugins/`（官方示例插件，含 commands / agents / skills / hooks / `.mcp.json`）、`.claude-plugin/marketplace.json`（市场清单）、`mods/`（hooks 模块化的“mods”，可改深层行为，`mods/README.md:3-20`）。托管侧用 `extraKnownMarketplaces` / `strictKnownMarketplaces` 控制（`examples/settings/README.md:5`）。
6. **devcontainer 白名单可扩展**：`init-firewall.sh:67-74` 的 `for domain in ...` 列表是唯一扩展点，新增域名即新增出网授权。
7. **两个 IaC 轨可互换**：同一 scope 同时给 `setup.sh`（命令式）与 `terraform/`（声明式），二者默认值对齐（`aws/terraform/variables.tf:1`）。

---

## 设计决策与权衡

**应用/架构级：**

1. **配置烘焙 vs 运行时挂载**：AWS 把 `gateway.yaml` **烘焙进镜像** `/etc/claude/gateway.yaml`，密钥经 ECS `secrets` 注入为环境变量（`aws/Dockerfile:9-15`，`aws/setup.sh:440-456`）；GCP 把 `gateway.yaml` 发布为 Secret Manager 的 `gateway-config` 并在运行时挂载为文件（`gcp/gateway.yaml.example:13-15`，`gcp/setup.sh:364-387`）。**权衡**：AWS 改配置要重建镜像（用 config 的 sha 作 tag 强制重建，`setup.sh:454-456`）；GCP 改配置只需重发布 + 重部署，代价是引入占位 `public_url` 的两趟引导。
2. **服务端盖章审计**：遥测在 gateway 侧打 `user.*`，而非信任客户端自报（`aws:120`）——集中治理的关键决策。
3. **私网优先**：客户端 `/login` **只接受私网地址**的 gateway（`gcp/setup.sh:109-116`、`gcp/terraform/variables.tf:158-166`），因此**公网 ingress 无法服务客户端**——安全默认值，但把“从外部完成 OAuth 引导”变成运维负担（GCP README 建议在 VPC 内用代理浏览器，`gcp/terraform/README.md:130-131`）。
4. **`public_url` 必须显式**：绝不用客户端可控 `Host` 头推导 redirect/issuer，避免 OIDC 重定向劫持（`aws:34-42`）。
5. **凭证从不下发客户端**：`auth: {}` + 云默认凭证链，消除静态密钥（`aws:109`）。
6. **连接池 × 实例数受 DB 上限约束**：每任务/实例最多 5 条 Postgres 连接（`store.max_connections` 默认），故 `desired_count × 5`（AWS，`terraform/variables.tf:179-183`）或 `max_instances × 5`（GCP，`setup.sh:71`）必须低于 DB 档位 `max_connections`。
7. **流式响应需放宽超时**：ALB `idle_timeout=3600`（`terraform/main.tf:432`）、Cloud Run `timeout=3600s`（`gcp/terraform/main.tf:305-307`），否则长思考/首 token 前的静默会切断流。
8. **TLS 收紧**：ALB 显式 pin `ELBSecurityPolicy-TLS13-1-2-2021-06`（默认会退回仍接受 TLS 1.0/1.1 的 legacy policy，`terraform/main.tf:455-457`）；DB 侧 `rds.force_ssl=1` + `sslmode=verify-full`（`terraform/main.tf:217-230`，`setup.sh:664-666`）。
9. **镜像不可变**：ECR tag `IMMUTABLE` + scan-on-push，部署 tag 永不被静默重指（`terraform/main.tf:190-196`）。
10. **爆炸半径控制**：deployment circuit breaker + health-check grace period，坏镜像/坏配置自动回滚（`terraform/main.tf:476-497`）。
11. **配置/密钥变更触发滚动**：task definition 桩 `GATEWAY_CONFIG_SHA`（AWS，`terraform/main.tf:373-383`）/ Cloud Run `config-sha` label（GCP，`main.tf:296-303`）——旋转密钥或改配置即强制新 revision，避免热实例用陈旧值。

**分发/工程级：**

12. **多安装渠道 + 弃用 npm**：同时提供 `install.sh` / Homebrew / `install.ps1` / WinGet，`npm` 标记弃用（`README.md:14-45`）——把“路径最稳”的渠道放首位。
13. **防供应链**：镜像基于 `distroless/cc-debian12:nonroot` 且**按 digest pin**（`aws/Dockerfile:46`）；下载二进制时 `curl` 拒绝明文/降级（`--proto '=https' --proto-redir '=https'`，`setup.sh:125`），校验失败即 fail-closed，且 `DIST_SHA256` 要求**带外**获取、绝不来自下载服务器（`setup.sh:67-72,481-508`）。
14. **密钥不进 argv**：所有携带密钥的 `aws` 调用走 `--cli-input-json file://<0600 temp>`，因 argv 可经 `/proc` 与 EDR/auditd 读取（`setup.sh:212-235`）。
15. **“示例非产品”免责**：两 README 明确非受支持生产部署，降低期望值（`aws/README.md:7-8`）。

**变更日志/发布约定级：** 见「关键文件索引」下的 *发布产物约定*。

---

## 对复刻产品的启示

1. **先做「收口点」，再谈多上游**：把“客户端如何无凭证地访问多个模型云”抽象成一个 `upstreams[]` 列表 + `auth: {}` 默认凭证链，是最具复用价值的骨架。
2. **把 `public_url` 设为一级契约**：一切与身份相关的绝对 URL（redirect、issuer、discovery）都从它派生，绝不信客户端头——这是企业 SSO 安全的基石。
3. **审计在服务端盖章**：宁可让 gateway 多做一步 fan-out，也不要让客户端自报身份。
4. **同时给命令式与声明式两条 IaC 轨**，默认值对齐，让“快速试用”与“长期托管”各取所需。
5. **配置与密钥的落地策略要显式**：镜像烘焙（强不可变、改配置需重建）与运行时挂载（易改、需处理占位 URL）各有代价；关键是让**变更触发滚动**（config hash）成为机制而非约定。
6. **安装面要“推荐一个、兜底多个、弃用一个”**：推荐渠道放最前、明确弃用旧渠道，能显著降低支持成本。
7. **沙箱默认拒绝**：devcontainer 的 `iptables` 默认 `DROP` + `ipset` 白名单 + 启动自检，是“默认不可信出网”的干净范式，可直接照搬。
8. **变更日志即产品面**：把 `CHANGELOG.md` 当成**机器可发布**的产物（分类动词 + 平台前缀 + 原子发布源），本身就是对外可订阅的能力地图。
9. **参考产物要写清边界**：示例代码在每处显式声明“非生产受支持”，能避免大量误用型支持工单。

---

## 关键文件索引

**企业 gateway（AWS）**
- `examples/gateway/aws/README.md` — 总览、文件表格（`:14-20`）
- `examples/gateway/aws/gateway.yaml.example` — AWS 形态配置模板（Okta + Bedrock）
- `examples/gateway/aws/Dockerfile` — 运行时镜像（distroless、ENTRYPOINT、`NODE_EXTRA_CA_CERTS`）
- `examples/gateway/aws/setup.sh` — 端到端脚本（§1–§7）
- `examples/gateway/aws/terraform/main.tf` / `variables.tf` / `outputs.tf` / `versions.tf` / `terraform.tfvars.example` — 声明式轨
- `examples/gateway/aws/terraform/README.md` — 两趟 apply、私网访问、远程 state

**企业 gateway（GCP）**
- `examples/gateway/gcp/README.md` — 总览（`:1-18`）
- `examples/gateway/gcp/gateway.yaml.example` — GCP 形态配置模板（Google Workspace + Agent Platform）
- `examples/gateway/gcp/Dockerfile` — 运行时镜像（运行时挂载配置）
- `examples/gateway/gcp/setup.sh` — 端到端脚本（§1–§7b）
- `examples/gateway/gcp/terraform/*.tf` — 声明式轨（含 VPC/PSA）

**devcontainer / 沙箱**
- `.devcontainer/devcontainer.json` — 扩展、挂载、`postStartCommand`
- `.devcontainer/Dockerfile` — 基础镜像与工具链
- `.devcontainer/init-firewall.sh` — 出网白名单防火墙
- `Script/run_devcontainer_claude_code.ps1` — Windows 启动脚本

**客户端分发 / 表面**
- `README.md` — 安装方法（`:19-45`）、表面（`:7`）、数据收集（`:60-72`）

**发布产物**
- `CHANGELOG.md` — 变更日志（418 个 `## <version>` 段，`0.2.21` → `2.1.296`）
- `feed.xml` — Atom 发布源（20 条最新 entry）

**交叉链接（不复制内容）**
- `examples/settings/README.md` — 托管设置示例（lax / strict / bash-sandbox / HIPAA）
- `examples/mdm/README.md` — Jamf / Iru / Intune / GPO 分发模板
- `plugins/README.md` — 官方示例插件清单与结构
- `.claude-plugin/marketplace.json` — 插件市场清单
- `mods/README.md` — hooks 模块化“mods”

### 发布产物约定（CHANGELOG / feed）

**`CHANGELOG.md` 的格式约定**（可从 `CHANGELOG.md` 头部与全量结构直接读出）：

- **顶层**：文件以 `# Changelog` 开头，随后立即是版本段（`CHANGELOG.md:1`）。
- **版本标题**：`## <semver>`，**倒序**（新→旧），**不携带日期**；跨度 `0.2.21`（最旧，`CHANGELOG.md` 末尾）到 `2.1.296`（最新，`CHANGELOG.md:3`）。共 418 段。
- **条目**：每条以 `- ` 开头的**单行**，动词起首做分类：`Added` / `Fixed` / `Improved` / `Changed` / `Removed` / `Deprecated` / `Renamed` / `Hardened` / `Faster` / `Reduced` / `Updated`（全量计数：`Fixed` 3904、`Improved` 738、`Added` 706、`Changed` 359……）。**平台/子系统前缀**以 `Windows:`、`[VSCode]`、`IDE:`、`SDK:`、`Hooks:`、`MCP:`、`Bedrock` 等出现。
- **破坏性变更**：以 “Breaking change:” 起始的行内标注（全量仅 3 处，如 `0.2.125` 的 Bedrock ARN 语义变更，`CHANGELOG.md:8600`）。
- **极简引用**：绝大多数条目不附 issue/PR 链接或 URL（全文件仅 27 行含 `(#N)` 或 `http`）。
- **里程碑段**：`## 1.0.0`（`CHANGELOG.md:8593`，GA + Sonnet 4/Opus 4）与 `## 2.0.0`（`CHANGELOG.md:8073`，原生 VS Code 扩展 / Agent SDK / `--agents` / `/rewind` / `/usage`）是版本叙事的锚点。

**`feed.xml` 的格式与用途**：

- **用途**：面向机器/订阅者的**发布源（release feed）**，内容与 `CHANGELOG.md` 同源、自描述为 “Release notes for Claude Code”。
- **格式**：Atom 1.0（`xmlns="http://www.w3.org/2005/Atom"`）；`<id>` 指向 `CHANGELOG.md` 的 blob，`<subtitle>Release notes for Claude Code`，`<author>Anthropic`；`<link rel="self">` 指向 `raw.githubusercontent.com/.../feed.xml`；文件级 `<updated>` 是最新时间戳（`2026-10-09T19:28:36Z`）。
- **条目**：**仅保留最近 20 条**（比 418 段变更日志短），每条含 `<id>` = `.../releases/tag/vX.Y.Z`、`<title>Claude Code vX.Y.Z</title>`、`<link rel="alternate">`、`<updated>`、以及 `<content type="html">`——正文是把同批条目 HTML 转义成 `<p>• …</p>` 的浏览器列表。
- **日期来源**：由于 `CHANGELOG.md` 段标题**无日期**，要得到“某版本何时发布”只能借助 `feed.xml` 的 `<updated>` 或 GitHub release tag。

---

## 存疑与待确认

1. **「出现时间」是代理指标**：上文能力面表格中的版本号是**关键词在 `CHANGELOG.md` 中最早出现**的版本，不等于功能真实首发版本——变更日志是精选子集，且很多功能在此仓库之外（引擎侧）更早存在。需以官方发布记录为准。
2. **gateway 的完整配置面不在本仓库**：`gateway.yaml` 各段的**权威参考**指向外部文档（`code.claude.com/docs/en/claude-apps-gateway-config`），本仓库只有两套示例，**可能是子集**（例如 `listen`/`upstreams` 的完整可选键未知）。`claude gateway` 子命令与 gateway 服务的实现代码也不在本仓库，无法验证其行为。
3. **多云轨只覆盖一条**：AWS README 写 “ECS on Fargate or EKS”，但脚本与 terraform **只实现 ECS Fargate**（EKS 轨仅在外部 walkthrough）；GCP 同上（只实现 Cloud Run，GKE 轨在外部 walkthrough）。GKE/EKS 的具体产物需另找。
4. **`CHANGELOG.md` 段标题无日期**：本文对 2.x 内若干“附近版本”的引用（如 1M context、gateway 的 `2.1.27x–2.1.29x`）是**范围估计**，非精确锚点；精确日期须查 `feed.xml` 或 release tag。
5. **`feed.xml` 只含 20 条**：它不足以回溯历史，历史“何时”只能靠 `CHANGELOG.md` 的版本相对顺序。
6. **未验证的运行时细节**：`/v1/messages`、`/readyz`、`/healthz`、`/.well-known/oauth-authorization-server` 等端点是从配置注释与脚本提示（如 `setup.sh:935`、`gcp/setup.sh:519`）推得，未见引擎源码佐证其完整语义。
7. **`allowedProviders` 的取值枚举与 `forceLoginMethod` 的完整取值**来自变更日志条目文本，非 schema 定义；`CHANGELOG.md` 2.1.25 之后 `allowedProviders` 出现在 2.1.x 多条中，精确引入版本未逐条核对。
8. **`admin` API 的 spend caps / db-mode 细节**仅有配置模板中注释级信息（`aws:144-157`），无独立文档佐证。
9. **未在本仓库出现**：`examples/` 中未发现与 gateway 配套的**客户端 MDM 下发（walkthrough §8）**产物；`aws/setup.sh:26-27` 明说 “Client MDM push (§8) is covered by the walkthrough, not this script”，故客户端接入 gateway 的分发脚本需自行补齐。
