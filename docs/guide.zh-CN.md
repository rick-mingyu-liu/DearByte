[返回首页](../README.md) · [English operations guide](guide.en.md)

# DearByte · 小拜使用指南

本指南介绍常用操作。完整的调度规则、通知行为和内部实现请参阅[英文运行参考](guide.en.md)。

## 终端聊天

需要 Node.js 24+。安装与密钥配置见[快速开始](../README.md#快速开始)。

```bash
npm run companion
npm run companion -- --fake  # 离线模拟，不调用模型
```

输入文字即可聊天。`/img <path> [配文]` 可发送 JPEG、PNG、WebP 图片；HEIC 转换依赖 macOS 的 `sips`。可以将图片拖入终端获取路径。

## 微信接入

适配 WeChat for Mac 4.x（在 4.1.13 上测过）和 3.8.4，英文界面，使用辅助功能读取和发送消息。4.x 收到的图片是加密的，小拜暂时看不到图，会如实说看不到；3.8.4 可以看图。同一时间只能开一个小拜（第二个会拒绝启动），否则两个会互相回复。此方案用于实验演示，存在账号受限风险，请使用测试账号。

运行前准备：

1. 用小拜的测试账号登录 WeChat for Mac。
2. 在「系统设置 → 隐私与安全性 → 辅助功能」中允许终端应用访问。
3. 安装 Xcode Command Line Tools，提供 Swift 编译器。原生辅助程序会在首次运行时自动构建。
4. 在微信主窗口打开指定的一对一聊天，滚动到底部。不要关闭主窗口，也不要将聊天拆到独立窗口。

```bash
npm run dearbyte -- --chat 张三  # 替换为聊天顶部显示的名称
npm run dearbyte                # 后续读取 data/contacts.json
npm run dearbyte -- --draft     # 只在终端生成草稿，不发送
npm run dearbyte -- --fake      # 模拟回复，不调用模型
npm run dearbyte -- --film      # 适合录制的简洁日志
npm run dearbyte -- --memory on
npm run dearbyte -- --proactive off
```

首次运行创建的 `data/contacts.json` 已被 Git 忽略。该文件目前只支持一个联系人；格式见根目录的 `contacts.example.json`。如微信可能显示备注、昵称或旧名称，请列出所有名称。修改后重启。

切到其他聊天时，小拜会等待。启动前已有的消息不会被回复；发现第二位发言者时会暂停。约 1.5 秒内连续到达的消息会合并为一轮。输入框里有未发送的草稿时，小拜不会发送。

要读取照片，在 `.env` 设置 `COMPANION_WECHAT_MEDIA_DIR`，指向该账号、该聊天的 `Message/MessageTemp/<chat>/Image` 目录。不配置时，小拜会被告知无法查看图片。语音、视频、文件和表情包目前不能直接读取。

### 设置允许回复的联系人

1. 在登录小拜账号的 Mac 微信主窗口中，打开你希望小拜回复的一对一聊天。
2. 按聊天顶部显示的名称运行以下命令；名称含空格时也要完整放在引号内：

```bash
npm run dearbyte -- --chat "Alex Zhang" --draft
```

首次设置会核对当前聊天名称，然后创建 `data/contacts.json`。`--draft` 只生成草稿，不发送，方便先检查设置。确认后退出程序，再运行 `npm run dearbyte` 开始自动回复。

要添加**同一个人的其他显示名称**，编辑项目根目录下的 `data/contacts.json`，例如：

```json
{
  "contacts": [
    {
      "id": "me",
      "names": ["张三", "Alex Zhang"]
    }
  ]
}
```

这里的 `张三` 和 `Alex Zhang` 是同一个人的备注或昵称示例，请换成微信实际可能显示的名称。`names` 匹配聊天顶部显示的名称，不是微信号；`id` 是内部标识，保留 `me` 即可。示例文件见 [contacts.example.json](../contacts.example.json)。

保存后退出并重新运行 `npm run dearbyte`。文件已存在时，`--chat` 不会追加或覆盖联系人，必须直接编辑文件。当前仅支持一个联系人，不要用多个名字代表不同的人，也不要添加第二个联系人对象。联系人之间尚未隔离历史与记忆，修改名单不等于建立新的独立对话。

如果小拜一直等待，请检查当前聊天顶部的名称是否与 `names` 中某一项完全一致，并确认编辑后已重启。该文件含真实姓名，已被 Git 忽略。

### 运行中控制

| 命令 | 作用 |
| --- | --- |
| `/pause` / `/resume` | 暂停 / 恢复回复；暂停期间到达的消息会跳过 |
| `/proactive on` / `/proactive off` | 开启 / 关闭主动消息 |
| `/memory` | 查看记忆 |
| `/memory on` / `/memory off` | 开启 / 关闭长期记忆，默认关闭 |
| `/memory forget <id>` | 删除指定记忆；旧消息不能重新带回它，日后重新提起则可以 |
| `/memory export` | 导出到 `data/memory-export.md` |
| `/history clear` | 删除聊天历史，保留记忆 |
| `/status` / `/help` / `/quit` | 查看状态 / 帮助 / 退出 |

## 主动消息

微信模式默认开启主动消息，可用 `/proactive off` 关闭。草稿模式不发送主动消息。

小拜可能发送早安、记住的考试或面试当天的问候、久未联系后的问候，以及围绕之前话题的日常消息。事件问候需要开启记忆。

- 22:30 至次日 8:00 不主动发消息，每天最多 2 条。
- 对话结束后至少等 90 分钟；上一条主动消息未收到回复前，不再发送下一条。
- 用户表达想安静时，暂停主动问候 3 天。
- 检测到危机信号后的 3 天，主动消息仅限温和关心。
- 只在指定聊天打开、未暂停回复时检查。用户在生成期间发来消息，会取消这条主动消息，优先回复用户。

更细的概率和时间窗口见[英文运行参考](guide.en.md)。

## 配置

在项目根目录的 `.env` 中设置：

| 变量 | 默认值与说明 |
| --- | --- |
| `COMPANION_PROVIDER` | `deepseek`（默认）。也可以是 `openai`、`anthropic`、`gemini`、`qwen`、`moonshot`（Kimi）、`zhipu`（GLM）、`openrouter`、`ollama`（本地），或 `custom`（任何 OpenAI 兼容接口） |
| `COMPANION_MODEL` | 模型名。DeepSeek 默认 `deepseek-flash`（旧的 `DEEPSEEK_MODEL` 仍然有效），其他服务商必填 |
| `COMPANION_API_KEY` | 密钥。也可以用各家自己的变量名：`DEEPSEEK_API_KEY`、`OPENAI_API_KEY`、`ANTHROPIC_API_KEY`、`GEMINI_API_KEY`、`DASHSCOPE_API_KEY`、`MOONSHOT_API_KEY`、`ZHIPU_API_KEY`、`OPENROUTER_API_KEY`。Ollama 不需要。`--fake` 模式都不需要 |
| `COMPANION_BASE_URL` | 覆盖接口地址；`custom` 必填 |
| `COMPANION_PRICE_INPUT`、`COMPANION_PRICE_OUTPUT`、`COMPANION_PRICE_CACHED` | 模型价格，美元 / 百万 token，照服务商公布的填。DeepSeek 已内置，Ollama 免费；其他付费模型必填，否则没法限制花费，程序不会启动 |
| `COMPANION_VISION` | `true` 或 `false`：模型能不能看图。默认按服务商判断；看不了图时，小拜会告诉对方她看不到 |
| `COMPANION_MAX_COST_PER_REPLY` | `1`：每条回复最多花多少美元，包括修复、安全检查、记忆和摘要。快超时会缩短输出，超了就不再调用模型。`0` 表示不限 |
| `COMPANION_DB` | `data/companion.sqlite` |
| `COMPANION_TZ` | Mac 的时区；建议与聊天对象一致，例如 `Asia/Shanghai` |
| `COMPANION_HISTORY_MESSAGES` | `40`，保留在上下文中的最近消息数 |
| `COMPANION_HISTORY_DAYS` | `30`，历史保留天数；`0` 表示不按天数清理 |
| `COMPANION_WECHAT_MEDIA_DIR` | 未设置；微信中该聊天的本地图片目录 |
| `COMPANION_ALERT_URL` | 可选的 ntfy 主题 URL，用于手机接收运行异常通知 |

换服务商的例子（价格填服务商公布的数）：

```dotenv
COMPANION_PROVIDER=anthropic
COMPANION_MODEL=服务商文档里的模型名
ANTHROPIC_API_KEY=你的密钥
COMPANION_PRICE_INPUT=…
COMPANION_PRICE_OUTPUT=…
```

小拜的人设是用 DeepSeek 调出来的，换模型后说话方式可能会变。可以先用 `npm run bakeoff -- --provider anthropic --model <模型名>` 对比一下。

配置 ntfy 后，需要在手机 ntfy 应用订阅对应主题。使用难以猜测的主题名；手机通知不包含聊天名称，详细原因留在 Mac 通知中。

运行时使用 `caffeinate` 防止 Mac 空闲休眠；屏幕仍可休眠。合上 MacBook 屏幕通常仍会休眠，除非满足接电、外接显示器等合盖运行条件。

## 记忆与隐私

聊天历史、记忆、摘要和设置保存在本地 `data/`。长期记忆默认关闭，聊天历史仍会保存。开启记忆后，模型提出的事实必须有用户原话作为依据，才会被保存。

生成回复会将相关上下文发送给你配置的模型服务商（默认 DeepSeek）；开启记忆时，还会有记忆提取与摘要相关的模型调用。图片只用于当前轮次。默认历史保留 30 天；开启记忆时，较早的聊天先纳入摘要再删除。

删除本地数据不会删除微信中已经发送的消息，也不会删除服务商可能保留的数据。小拜无法代替用户联系紧急服务。

## 开发验证

```bash
npm test
npm run typecheck
npm run bakeoff  # 在线角色评测，会调用模型并产生费用
```

角色评测结果写入 `data/bakeoff/`。更多内部说明见[工作原理（英文）](how-it-works.md)与[微信传输设计（英文）](design/wechat-transport.md)。
