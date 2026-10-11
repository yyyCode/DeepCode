# hookify

用**一份声明式规则文件**写 hook，不用写代码。

这个插件的意义不只在功能本身：它**没有改一行引擎代码**。规则文件 → 判定这条链上的每一步
（读 stdin、读盘、退出码、stdout 的 JSON）都只用框架已经有的东西。P3 的出口标准是
「一个不改引擎的插件能扩展出新能力」，`plugins/todo` 是加了个工具，hookify 是**加了一套语法** ——
比前者更对题。

## 装

```bash
cp -r plugins/hookify ~/.deepcode/plugins/     # Windows: xcopy /E /I
deepcode plugin validate ~/.deepcode/plugins/hookify
```

用户级目录自动装载，不用改任何设置。

## 写一条规则

在你的项目里建 `.deepcode/hookify.no-keys.local.md`：

```markdown
---
name: no-aws-keys
tool: Write|Edit
field: content
operator: matches
pattern: AKIA[0-9A-Z]{16}
decision: deny
message: 文件里出现了形似 AWS access key 的东西
---

要写就先把 key 换成占位符，或者从环境变量读。
```

之后让模型往文件里写一个 `AKIA…` 试试。

**一个文件一条规则。** 多条规则就多个文件 —— `hookify.*.local.md` 这个 glob 本来就是为
这件事准备的，而一个文件里塞多条会让正文里的 Markdown 分隔线（`---`）没法区分。
文件名任意，只要落在 `.deepcode/` 下、以 `hookify.` 开头、以 `.local.md` 结尾。读取按文件名排序。

## 七个字段

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `name` | 是 | 规则名。命中时出现在拒绝理由里 —— 请取一个能一眼认出是哪条的 |
| `tool` | 否 | 工具名；`Write\|Edit` 这样用竖线列多个；`*` 或**省略** = 对所有工具生效 |
| `field` | 是 | 取 `tool_input` 的哪个键（`Write`/`Edit` 是 `content` / `new_string`，`Bash` 是 `command`） |
| `operator` | 是 | 见下 |
| `pattern` | 是 | 与 `field` 比对的字面量；`operator: matches` 时是一个正则 |
| `decision` | 否 | `deny`（默认）或 `ask` |
| `message` | 是 | 命中时给模型看的一句话，说清"为什么"而不是"不许" |

frontmatter 之后的正文**可选**，接在 `message` 后面一起显示 —— 用来写一句"该怎么办"。

**不认识的字段只告警，不影响这条规则生效。** 给 frontmatter 加新字段不该让所有规则一起失效。

## 五种 operator

| operator | 含义 |
| --- | --- |
| `matches` | `pattern` 是正则，命中 `field` 的值 |
| `contains` | `field` 的值包含 `pattern` 这个子串 |
| `equals` | 全等（不是子串） |
| `starts_with` | 前缀 |
| `ends_with` | 后缀 |

`field` **只取字符串**。键不存在、或者值是数组 / 对象 / 数字 → 这条规则不匹配（不是错误）。

## 多条命中怎么办

`deny` 胜 `ask`；理由只列与最终判定同向的那几条。与权限引擎的 `deny > ask > allow`
同一条方向，重排文件名不换结果。

## `allow` 表达不出来

`decision: allow` 会被当成**规则文件的错误**（拒绝并点名），不是静默降级。

理由：在我们的框架里，第三方插件返回的放行判定一律被丢弃
（`src/cli/classic-hooks.ts:83-92`）—— 一个插件的 `allow` 连"让确认提示闭嘴"都做不到。
"支持"它只会让人写出一条看起来生效、其实什么都不做的规则。

## ⚠️ 失败方向：一个坏文件会让所有改盘工具停摆

**这是这个插件最该被知道的一件事。**

任何说不清的情况 —— frontmatter 没闭合、缺必填字段、算子不认识、正则编译不过、
文件读不动、stdin 读不懂、脚本自己崩了 —— 一律**非零退出**，而框架把非零读成 `deny`
（`src/cli/hook-run.ts:180-195` → `src/cli/classic-hooks.ts:75-79`）。

所以：`.deepcode/` 里放一个写坏的 `hookify.*.local.md`，**你的 `Write` / `Edit` / `Bash`
会全部被拒绝**，直到把那个文件修好或删掉。报错信息在拒绝理由里，会说清是哪个文件、
哪一行。

参考实现的 hookify 反着来：它在 `finally` 里 `sys.exit(0)`，注释写着"钩子出错永远不该阻断操作"。
我们不接受那个方向 —— 一个读不懂自己规则的守卫，比一个假装没事的守卫危险。
代价就是上面那一段，写在这里而不是藏在代码注释里。

## 它不做什么

不做熵分析（会误报的守卫只会被人关掉）、不认识形密钥但不是密钥的东西、
不做"路径看起来敏感就放行"这种反向猜测（路径判断是权限规则的活）。
规则文件只从**当前项目**的 `.deepcode/` 读 —— 这是项目级的配置，跟着仓库走。
