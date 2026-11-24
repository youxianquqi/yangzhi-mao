# 🐱 Write · 养只猫（项目目前不可用）

运行在自己电脑上的轻量角色扮演与剧情推理聊天室。存档保存在本机；使用在线模型时，角色设定和必要的对话上下文会发送给选定的服务商。

## 特点

* **本地私有、可靠存档**：角色与剧情记录全部保存在本机目录，支持跨进程防冲突与原子写入，复制目录即可备份。
* **专注对话手感**：原生前端开箱即用，支持多剧情线、流式回复、中途停止、单条编辑、重抽、回退与长对话分页。
* **微内核 + 插件化**：核心只保留最小聊天闭环；DeepSeek 和 MiniMax 预设无需安装 CLI；线索本、角色卡导入、用户人设与其他模型适配器可按需启用。

## 快速开始

1. **便携版**：Windows 用户可直接到 [GitHub Releases](https://github.com/youxianquqi/yangzhi-mao/releases) 下载 `Write-*-win32-x64.zip`，解压后双击 `start.bat` 即可运行（无需安装 Node.js）。其他系统若有对应发行件，也可从 Releases 下载与你的系统和芯片架构匹配的压缩包，完整解压。**源码版**：先从 [Node.js 官网](https://nodejs.org/zh-cn/download) 安装 Node.js 22 或更新版本。
2. Windows 双击 `start.bat`，macOS 双击 `start.command`，Linux 运行 `./start.sh`。服务就绪后自动打开 [http://127.0.0.1:3210](http://127.0.0.1:3210)。若没有自动打开，可手动访问终端显示的地址。关闭启动窗口即停止服务。
3. 在网页顶部「模型与插件设置」选择 DeepSeek（默认）或 MiniMax，粘贴服务商的 API Key，测试并保存。已设置对应官方端点的 `DEEPSEEK_API_KEY` 或 `MINIMAX_API_KEY` 时，环境变量优先。然后新建角色，或在同一设置页开启 `card-importer` 后从顶栏导入 PNG／JSON 角色卡。顶部「?」有完整教程。

源码也可以在项目根目录运行：

```sh
npm ci
npm start
```

## 数据与安全

默认存档目录是项目内 `data/`（可用 `DATA_DIR` 指定本地路径）。备份前先停止 Write，复制整个目录，以保留角色、剧情线、聊天归档、插件笔记和设置。备份可能包含 `secrets.json` 中的 API Key，请勿公开分享。服务仅监听 `127.0.0.1`，不要暴露到公网或部署到共享账号。插件在本机同进程运行，只启用可信代码；如果插件阻止界面启动，可给启动脚本加 `--safe-mode`（或设置 `SAFE_MODE=1`），再在网页设置停用它。

[便携打包与发布](docs/portable-release.md) · [模型及插件配置](docs/plugin-dev.md) · [架构与接口](docs/architecture.md) · [贡献指南](CONTRIBUTING.md) · [更新日志](CHANGELOG.md) · [安全政策](SECURITY.md)
