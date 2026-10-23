# 发布到 GitHub

目标：`hengheng2004/codex-telegram-im`，默认私有。GitHub 保存基础代码、锁文件、跨平台安装说明、macOS 安装器、Codex 部署指引与离线测试。新机器使用新的 bot 和本机配置；仓库不承担凭据或聊天历史同步。

本项目基于 [patriceac/codex-telegram](https://github.com/patriceac/codex-telegram)，保留 MIT LICENSE 和原作者版权信息。

## 生成可发布源码包

```bash
npm run check
python3 scripts/package-release.py --check
python3 scripts/package-release.py
```

输出为 `dist/codex-telegram-im-source.tar.gz` 及其 `.sha256` 校验文件。归档采用明确的文件清单，不依赖“整个文件夹压缩后再排除几个名字”。包含完整工作树中的基础代码与未跟踪源码，但不包含 `.git` 历史、`.env`、`.data`、日志、附件、依赖目录和本机迁移盘点文档。

打包前会检查已知本机配置值、疑似 Telegram token、私钥与旧机绝对路径。检查不能替代人工审阅；发布前检查归档清单和改动。不要上传整个旧机目录，也不要把原有未检查的 Git 历史直接推送。

## 首次发布

在 GitHub 的 `hengheng2004` 账户下创建私有仓库 `codex-telegram-im`。从上面的源码包解压出干净目录，在该目录初始化新的 Git 仓库，不在旧机运行目录中操作：

```bash
git init -b main
git add .
git status --short
git diff --cached --stat
git commit -m "Package personal Telegram bridge with macOS deployment"
git remote add origin https://github.com/hengheng2004/codex-telegram-im.git
git push -u origin main
```

推送使用本机已配置的 GitHub 登录或 SSH，不将 GitHub 凭据写入命令、远程 URL、仓库文件或聊天记录。创建仓库时不额外生成 README/LICENSE，以免与源码包冲突。保留原 LICENSE 是发布的必要部分。

如果由 Codex 代为发布，应先完成源码整理、`npm run check`、打包和审阅，再使用用户授权的 GitHub 连接创建仓库并推送。没有已连接的 GitHub 账号或网络访问时，只能生成本地包，不能声称仓库已经上线。GitHub 上的 CI 结果也需要推送后另行确认。

仓库发布后，在新 Mac 按 [DEPLOY_WITH_CODEX.md](DEPLOY_WITH_CODEX.md) 操作。普通 git clone 获取源码，不会启动 relay，也不会获得旧机的任何 token。
