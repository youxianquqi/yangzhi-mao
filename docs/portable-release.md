# 便携版打包与发布

## 给使用者

从 [GitHub Releases](https://github.com/youxianquqi/yangzhi-mao/releases) 选择与你的系统和 CPU 架构匹配的包，先完整解压，不要在压缩包预览中直接运行：

| 平台 | 包格式 | 打开 |
| --- | --- | --- |
| Windows | `.zip` | 双击 `start.bat` |
| macOS | `.tar.gz` | 双击 `start.command` |
| Linux | `.tar.gz` | 运行 `./start.sh`；在有图形桌面的会话中会尝试打开浏览器 |

便携版不需要安装 Node.js 或 npm，也不需要联网安装运行依赖。服务仍只监听本机；没有自动打开时，访问终端显示的本机地址（默认 [http://127.0.0.1:3210](http://127.0.0.1:3210)）。调用在线模型需要联网及对应的 API Key。请解压到当前账号可写的本机目录，停服后再复制 `data/` 做备份。

## 给发布者

从干净的发行源码开始，在**目标系统和芯片架构**上分别执行。构建机须有系统 `tar`（Windows 自带的 `tar.exe` 须支持 ZIP），用户运行便携版不需要它。使用 [Node.js 官方发行件](https://nodejs.org/zh-cn/download)，校验发行件的官方 SHA-256，再解压到独立目录。指定解压产物的最外层目录：Windows 必须包含 `node.exe`，macOS/Linux 必须包含 `bin/node`，并保留运行时的 `LICENSE`。使用 Node.js 22 或更新版本。

在 Write 根目录固定依赖并验收：

```sh
npm ci
npm run check && npm test
```

随后直接运行打包脚本；它不会再次联网安装依赖，不会发布文件：

```sh
node scripts/package-portable.mjs --runtime "/path/to/extracted-node" --out "./dist" --platform linux --arch x64
```

`--platform` 为 `win32`、`darwin` 或 `linux`，`--arch` 为 `x64` 或 `arm64`，均默认取构建机。Windows 示例：`node scripts/package-portable.mjs --runtime "C:\Downloads\node-win-x64" --out ".\dist" --platform win32 --arch x64`。

输出 `Write-<版本>-<平台>-<架构>.zip`（Windows）或 `.tar.gz`（macOS/Linux）。包中包含启动脚本、指定的 Node 运行时和许可、锁文件对应的生产依赖、应用及发行版内置插件。不会打包 `data/`、`secrets.json`、用户插件、不在锁文件生产依赖中的包、开发依赖或 `.git/`。

发布前解压到新的可写目录，用空存档启动一次，打开网页并确认设置、帮助、安全模式均可用。启动脚本支持 `--safe-mode`（跳过插件）和 `--no-browser`（不自动打开浏览器）；停用有问题的插件后，不加 `--safe-mode` 正常启动即可恢复。为每个产物生成 SHA-256，再把压缩包与校验值一起上传到 Releases。Windows 可用 `Get-FileHash -Algorithm SHA256`，macOS 可用 `shasum -a 256`，Linux 可用 `sha256sum`。
