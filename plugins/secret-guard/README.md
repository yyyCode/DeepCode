# secret-guard

一个**只会拧紧**的插件：`Write` / `Edit` 之前扫一眼要写的内容，发现密钥形状的东西就拦下。

它证明的是这条能力边界：**第三方插件能拦下动作，但没法放行任何东西。**
钩子返回 `{"permissionDecision":"allow"}` 也会被忽略 —— 一个插件做得到的只有
"拦下"与"什么都不说"。

## 装

```bash
cp -r plugins/secret-guard ~/.deepcode/plugins/     # Windows: xcopy /E /I
deepcode plugin validate ~/.deepcode/plugins/secret-guard
```

用户级目录自动装载，不用改任何设置。之后让模型往文件里写一个 `sk-ant-…` 试试。

## 它扫什么

`sk-ant-…`、`AKIA…`、PEM 私钥头、`gh[pousr]_…`，以及"写成字面量的口令"（`password = "…"`）。
命中就退出码 2，stderr 里的理由会作为拒绝原因交给模型。

**它不做什么**：不看文件路径（那是权限规则的活），不做熵分析，
不认识形如密钥但不是密钥的东西 —— 一个会误报的钩子只会被人关掉。
