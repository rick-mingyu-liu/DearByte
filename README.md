<p align="center"><strong>简体中文</strong> · <a href="README.en.md">English</a></p>

<h1 align="center">DearByte · 小拜</h1>

<p align="center"><strong>有点嘴硬，但会把你的话放在心上。</strong></p>

<p align="center">一个有自己脾气的 AI 聊天伙伴。<br>记住你说过的小事，偶尔主动问候，也尊重你想安静的时候。</p>

<p align="center">
<a href="https://github.com/rick-mingyu-liu/DearByte/stargazers"><img src="https://img.shields.io/github/stars/rick-mingyu-liu/DearByte?style=flat" alt="GitHub Stars"></a>
<img src="https://img.shields.io/badge/status-experimental-orange" alt="实验原型">
<img src="https://img.shields.io/badge/Node.js-24%2B-339933" alt="Node.js 24+">
</p>

<p align="center"><a href="#快速开始">快速开始</a> · <a href="docs/guide.zh-CN.md">使用指南</a> · <a href="#数据与隐私">数据与隐私</a> · <a href="#参与开发">参与开发</a></p>

小拜有点傲娇，也很细心。她会接你的玩笑，认真听你说烦心事；开启记忆后，还能记住你提过的偏好和日程，让下一次聊天接得上上一次。

DearByte 目前是一个可以在终端运行、也可以实验性接入微信的 AI 陪伴原型。文档提供简体中文与英文两个版本；**当前角色和对话设计以中文为主**。

如果你也喜欢这样的聊天伙伴，欢迎点个 ⭐ Star，回来看看小拜的新变化。

## 和小拜聊点什么

| 你想要的体验 | 小拜现在能做什么 |
| --- | --- |
| 下班后随便聊两句 | 用简短、有个性的消息回应，支持分条发送和自然的回复间隔 |
| 下次不用从头交代 | 开启长期记忆后，记住有原话依据的小事，并整理较早的对话 |
| 有人记得重要的一天 | 开启记忆和主动消息后，可在记住的考试、面试等事件当天问候 |
| 分享今天拍的照片 | 支持图片对话；微信模式需要额外配置本地图片目录 |
| 偶尔收到一句问候 | 支持早安、久未聊天的问候和日常主动消息，也有限频与安静时段 |
| 今天想一个人待着 | 可以关闭主动消息；表达想安静时，会暂停主动问候 3 天 |
| 自己决定留下什么 | 查看、删除、导出记忆，或关闭长期记忆；长期记忆默认关闭 |

## 快速开始

需要 **Node.js 24+**。先在终端认识小拜：

```bash
git clone https://github.com/rick-mingyu-liu/DearByte.git
cd DearByte
npm install
```

在项目根目录创建 `.env`，填入你的 API 密钥（该文件已被 Git 忽略）：

```dotenv
DEEPSEEK_API_KEY=你的_API_密钥
```

```bash
npm run companion
```

没有密钥也可以运行 `npm run companion -- --fake`，检查本地流程。该模式不调用模型，回复会标注为模拟内容。

| 命令 | 作用 |
| --- | --- |
| `/memory on` / `/memory off` | 开启或关闭长期记忆 |
| `/memory` | 查看记忆 |
| `/memory forget <id>` | 删除一条记忆 |
| `/memory export` | 导出记忆 |
| `/img <path> [配文]` | 发送本地图片 |
| `/history clear` | 清除聊天历史，保留记忆 |
| `/help` / `/quit` | 查看帮助 / 退出 |

### 在微信里聊天

微信接入通过 macOS 辅助功能操作桌面客户端，当前针对 **WeChat for Mac 3.8.4、英文界面、单个一对一聊天**。需要辅助功能权限和 Swift；图片另需配置目录。

这是一条实验性演示路径，存在账号受限风险。请使用测试账号。配置步骤、草稿模式、暂停与恢复见[中文使用指南](docs/guide.zh-CN.md#微信接入)。

## 数据与隐私

- **长期记忆默认关闭。** 开启后可随时查看、删除或导出。聊天历史与长期记忆是两回事，关闭记忆不会停止保存聊天历史。
- **本地保存，云端生成。** 历史、记忆、摘要和设置保存在被 Git 忽略的 `data/` 中。生成回复时，相关对话上下文会发送给 DeepSeek；图片仅用于当前轮次。
- **历史默认保留 30 天。** 开启记忆时，较早的聊天先纳入摘要再删除。清除历史不会同时清除记忆。
- **微信仍由腾讯传输。** 删除本地数据不会删除已经发出的微信消息，也不会删除模型服务商可能保留的数据。

## 当前进展

已实现终端聊天、可控记忆、图片输入、主动消息和实验性微信接入。微信文字与图片流程已于 **2026-09-24** 完成实机测试。

当前微信模式只支持一个联系人；语音、视频、文件和表情包不能被直接理解。小拜是 AI，不是真人；危机信号检测用于调整回复，不能代替专业帮助或联系紧急服务。

## 参与开发

```bash
npm test
npm run typecheck
```

欢迎通过 [Issues](https://github.com/rick-mingyu-liu/DearByte/issues) 反馈问题、讨论想法，或提交改进。复现问题时请去掉聊天中的个人信息和 API 密钥。

| 文档 | 内容 |
| --- | --- |
| [中文使用指南](docs/guide.zh-CN.md) | 安装、微信接入、常用配置与控制 |
| [完整运行参考（英文）](docs/guide.en.md) | 全部命令、主动消息规则、通知、配置和目录结构 |
| [工作原理（英文）](docs/how-it-works.md) | 回复生成、记忆和存储 |
| [项目计划（英文）](docs/plan.md) | 决策、进展和里程碑 |
| [改进方向（英文）](docs/improvements.md) | 后续可以改进的地方 |

## 致谢

小拜的对话设计参考了 [狗头军师](https://github.com/shengjidaguai-china/goutoujunshi)、[咫尺](https://github.com/oaa529/zhichi) 和 [前任.skill](https://github.com/perkfly/ex-skill) 的部分思路。具体来源、采用方式和差异见[来源说明（英文）](docs/upstream-provenance.md)。
