# 在新 Mac 上安装独立的 Telegram agent

运行机制、功能和安全约束以 [README.md](README.md) 为准。本文用于全新部署：一台 Mac、一个独立 bot、一个仅你和 bot 的私有话题群、一个 relay 和一个本地 MCP server。旧电脑可继续使用其原 bot；这里不复制旧机凭据、群映射或 Codex 历史。

需要让另一台 Codex 代办时，使用 [DEPLOY_WITH_CODEX.md](DEPLOY_WITH_CODEX.md) 中的提示词。首次配置仍需要你在本机隐藏输入 token、在 Telegram 配对，并完成登录及系统权限授权。

## 1. 准备新电脑

安装 Git、Node.js 20 或更新版本（含 npm）、Python 3.9 或更新版本，以及 Codex CLI。Python 仅使用标准库，不需要安装 pip 包。Codex 的安装方式以 [OpenAI 官方 CLI 文档](https://learn.chatgpt.com/docs/codex/cli) 为准；本项目使用本机 Codex 登录，不要求提供 OpenAI API key。

```bash
git --version
node --version
npm --version
python3 --version
codex --version
codex login
codex login status
```

Codex 登录由你完成，不能把旧机 auth 文件提交到仓库。CLI 与桌面客户端是否共享登录或历史，必须在目标环境验证。[官方认证说明](https://learn.chatgpt.com/docs/auth)

## 2. 获取项目并检查

目标仓库为 `hengheng2004/codex-telegram-im`；仓库发布后使用以下命令。私有仓库需要新机先通过你自己的 GitHub 账号完成 Git 认证，不要把 GitHub token 放进克隆 URL。

```bash
mkdir -p "$HOME/Projects"
cd "$HOME/Projects"
git clone https://github.com/hengheng2004/codex-telegram-im.git
cd codex-telegram-im
npm ci
npm run check
python3 scripts/setup-macos.py plan --workspace "$HOME/Projects" --sandbox workspace-write
```

`plan` 只显示本机部署计划，不创建配置、不联网配对，也不启动服务。Windows 使用 README 中的 PowerShell 安装流程；此 Python 安装器只负责 macOS。

## 3. 创建新 bot 和私有话题群

1. 在 Telegram 的 @BotFather 创建专用于新 Mac 的 bot，名字可设为 `Mac mini Agent`。
2. 新建仅你和这个新 bot 的私有群，开启 Topics / 话题。
3. 将 bot 设为管理员，授予 Manage Topics / 管理话题；其他管理权限无需额外启用。
4. 不把旧电脑的 bot 放进这个群，也不在新机复用旧 bot token。

安装器会验证私有话题群、群主身份、bot 管理话题权限和两名成员，并仅接受本次随机配对码。它不会自动创建 Telegram 账号或替你操作 BotFather。

## 4. 本地隐藏输入与配对

在你自己能交互输入的 Terminal 中执行；不要在 Codex 聊天里发送 token，也不要把 token 放在命令参数或截图中。

```bash
cd "$HOME/Projects/codex-telegram-im"
python3 scripts/setup-macos.py configure --workspace "$HOME/Projects" --sandbox workspace-write
```

如新机确实使用本地 HTTP 代理，改用下面的命令；端口应按新机实际设置填写：

```bash
python3 scripts/setup-macos.py configure --workspace "$HOME/Projects" --sandbox workspace-write --proxy http://127.0.0.1:7890
```

代理选项要求 Node 支持环境代理；安装器会检测。这里的 `127.0.0.1` 是新机自身，不是旧电脑。安装器不支持 SOCKS 地址或在代理 URL 中嵌入密码。不提供 `--proxy` 时，配对请求直接联网。

根据提示隐藏输入新 token，在新群发送随机 `/pair ...` 指令，再回 Terminal 按回车。配置成功后会创建：

| 本地文件 | 作用 |
| --- | --- |
| `.env` | 新 bot 的授权、独立 bridge secret、工作目录和运行参数；权限 600 |
| `.data/state.json` | 新会话映射及跳过配对消息的 update offset；权限 600 |
| `.data/codex-wrapper.command` | 使用新机检测到的 Codex 路径和明确功能开关；权限 700 |
| `.data/macos-install.json` | 本机 Node/Codex 路径、Codex home 和服务环境；权限 600 |

目录 `.data` 权限为 700。已有 `.env` 或状态时安装器拒绝重新配对，避免把不同 bot 混用；如果配置中断，先在本机检查残留文件，不直接删除已有业务状态。

脚本默认 `read-only`；上述命令明确选择 `workspace-write`。默认并发 2、空闲回收 300 秒、单轮桥接超时 1800 秒。wrapper 允许 shell、apps、plugins、浏览器和桌面控制，关闭 hooks 与 multi-agent；具体可用性仍取决于 CLI 版本、客户端配置与系统授权，不会自动安装所有插件或绕过其权限。

## 5. 安装 MCP、skill 和后台服务

```bash
python3 scripts/setup-macos.py install
python3 scripts/setup-macos.py start
npm run doctor
codex mcp list
```

`install` 注册本地 `codex-telegram` MCP，复制仓库内同名 skill，并生成 `~/Library/LaunchAgents/com.codex.telegram.plist`；`start` 才在当前登录会话加载服务。plist 配置下次登录启动、异常退出后重启及 20 秒重启节流。已有不同 MCP、skill 或服务不会被静默覆盖，应先检查并备份。

MCP 使用新机 Node 和项目绝对路径，并设置服务所需的 PATH、Codex home 及可选代理变量。凭据从本机 `.env` 读取，不放进 MCP 启动参数。CLI 注册方法参考 [OpenAI 官方 MCP 文档](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)。

重启使用 MCP 的 Codex/ChatGPT 客户端。其他客户端若维护独立 MCP 配置，需要另外添加同一个本地 stdio server 并验证工具可见性；不能保证 CLI 注册自动覆盖所有客户端。

不要在服务运行时再执行 `npm start`，也不要启动第二份 `getUpdates` 轮询器。

## 6. 实际验收

- [ ] `npm run check` 和启动后的 `npm run doctor` 均通过。
- [ ] 新群建测试 topic，发送 `/project /你的实际项目绝对路径`，再要求回复一句固定文本。
- [ ] `/status` 显示新机目录和预期 sandbox；`/projects`、`/chats` 能列出新机相关记录。
- [ ] 本地 Codex 调用 `telegram_notify` 并带真实新机 `project_path`，消息进入正确 topic。
- [ ] 调用 `telegram_ask` 后手机回复，答案回到原等待调用。
- [ ] 本地和 Telegram 发起的任务分别回传一个无敏感内容的小文件，验证 `telegram_send_file`。
- [ ] 发送附件到测试 topic，确认在新项目 `.telegram-inbox/` 保存并可读取。
- [ ] 旧电脑的独立 bot 仍正常，两个群的任务互不串用。
- [ ] 重启并登录后验证 relay、代理及 MCP 可用；需要桌面自动化时另行验证锁屏与系统权限条件。

doctor 只检查 Node、目录、CLI、bridge secret 和本地健康接口，不能代替以上联调。单向通知可在 relay 不在线时直接发送，所以通知成功也不能单独证明服务正常。

## 7. 日常操作、更新与卸载

```bash
python3 scripts/setup-macos.py status
python3 scripts/setup-macos.py restart
python3 scripts/setup-macos.py stop
```

`stop` 卸载当前会话的服务，但保留登录启动文件，因此下次登录仍会启动。`restart` 会中断活跃任务和等待中的提问，先等任务结束。

更新时先停止任务和服务，再执行：

```bash
python3 scripts/setup-macos.py stop
git pull --ff-only
npm ci
npm run check
python3 scripts/setup-macos.py start
npm run doctor
```

skill 有更新时，先备份已安装 skill，再移开旧的同名目录、重新运行 `install`；不要覆盖个人修改。Node/Codex 安装路径、代理或项目路径变化时，也要核对本机 manifest、wrapper、MCP 和 plist，不能只修改其中一处。不要重新运行 `configure` 来完成普通更新。

长期禁用登录启动：

```bash
python3 scripts/setup-macos.py uninstall
```

此命令保留 `.env`、状态、MCP 注册和 skill。若不再使用 MCP，可单独执行 `codex mcp remove codex-telegram`；如需移除 skill，先确认没有其他本机安装在使用它。卸载服务不会自动删除聊天历史。

日志位于 `.data/relay.log`、`.data/launchd.stdout.log`、`.data/launchd.stderr.log`，应定期轮转并保护；不要把原始日志直接上传 GitHub。全天运行还需要配置主机睡眠、登录后启动代理，以及断电/重启后的 FileVault 解锁与恢复流程；用户级服务依赖登录，GUI 自动化还依赖可用的图形会话。
