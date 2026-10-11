# todo

一个**不改引擎**的插件：加一个 `TodoWrite` 工具，让模型能把待办记到一个文件里。

它演示的是这条：工具清单来自注册面，不是内核里的一张硬编码表 ——
所以"多一个工具"这件事，插件自己就做完了，一行引擎代码都不用改。

## 装

```bash
cp -r plugins/todo ~/.deepcode/plugins/     # Windows: xcopy /E /I
deepcode plugin validate ~/.deepcode/plugins/todo
```

然后跟模型说"把'改一下 README'记进待办"。

## 它依赖什么

`uses` 声明了三样，**三样都要真的挂上钩子**：`tool.describe`（说清参数）、
`tool.call`（干活）、`tool.check`（在准入链上应答一次）。

最后一条最容易被漏掉，而漏了它这个插件就是死的：`confirm` 坐在 `builtin`，
它对自己不认识的工具**直接拒绝**（"未知工具，不在确认器的白名单里"），
而它的钩子不调 `next` —— 链根本走不到插件那儿。只在清单里声明 `tool.check`
不够，那只让 W7 那条警告闭嘴。

调用一次 `TodoWrite` 依旧要走同一条准入链：`deny` 它、或者非 TTY 环境下没人按 `y`，
它就写不进去。插件能力的上限到此为止。
