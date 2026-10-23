# 给新电脑上的 Codex 的部署说明

本仓库让每台电脑独立运行一个 Telegram bot。本机不需要旧电脑的 `.env`、`.data`、绝对路径或聊天历史。[README.md](README.md) 是功能、架构、安全默认值和重建命令的依据；执行步骤见 [INSTALL_MACOS.md](INSTALL_MACOS.md)。

将以下文字交给新电脑上的本地 Codex。私有 GitHub 仓库需要那台电脑有 GitHub 访问权限；仅提供名称不能保证 Codex 可以读取私有仓库。仓库尚未发布时，此提示词还不能完成克隆。

```text
请在这台 Mac 上部署 https://github.com/hengheng2004/codex-telegram-im 。
这是新工作站的独立安装，使用一个新 Telegram bot 和一个新的私有话题群。
旧电脑继续使用旧 bot，不复制旧机的凭据、运行状态或 Codex 历史。

请先克隆到 ~/Projects/codex-telegram-im，阅读 AGENTS.md、README.md、
INSTALL_MACOS.md 和 DEPLOY_WITH_CODEX.md，再执行部署。

请自动完成可执行的准备工作：
1. 检查 Git、Node/npm、Python 3、Codex CLI 以及 Codex 登录情况。
   缺少工具时按官方文档安装；不要假设 Homebrew Cellar 的版本路径。
2. npm ci，npm run check；发现失败先调查，不能跳过检查并宣称成功。
3. 运行 setup-macos.py plan，以 ~/Projects 为默认工作目录，
   sandbox 选择 workspace-write。代理按这台电脑实际情况配置。
4. 告诉我如何创建新 bot 和仅我与 bot 的私有话题群。
   准备好可在我自己的 Terminal 执行的 configure 命令，
   让我通过脚本隐藏输入 token，并在 Telegram 发送随机配对码。
   不要要求我把 token、密码、chat ID 或完整 .env 粘贴到聊天中。
5. 配对成功后继续运行 install、start、doctor，安装并验证本地 MCP 和 skill。
6. 用测试 topic 验证消息往返、项目绑定、提问回复和小文件上传，
   再验证重启登录后的服务恢复。真实发送测试消息仅使用这个新 bot 和新群。

除需要我本地登录、隐藏输入凭据和授予系统权限的步骤外，继续推进部署。
保持单用户、本机回环端口、独立状态和 workspace-write 权限。
不要启用 hooks 或 subagents，也不要扩大为多用户或公网服务。
无法验证的步骤明确列出，报告最终安装路径、服务状态和验收结果。
```

**执行约定**

- 所有路径从目标机器实际检测，不从旧机快照推断。
- 不运行来自网页的未审查脚本，不为绕过错误直接放宽 sandbox。
- token 仅由本地配置脚本读取，错误信息不能带 Telegram API 的含 token URL。
- 同一个 bot 只运行一个 relay；新机采用新 bot 后，无需停止旧机的独立 bot。
- 已有同名 MCP、skill、服务或私有状态时先核实归属，安装器默认拒绝静默覆盖。
- 桌面客户端、CLI、浏览器和插件的登录及权限分别验证，不承诺配置一次就全部可用。
- 配对、重启和真实消息测试未执行时，报告“待验证”，不写“部署完成”。
