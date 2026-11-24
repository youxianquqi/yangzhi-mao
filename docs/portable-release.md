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

### 1. GitHub Actions 自动构建与发布（推荐）

项目配置了流水线 [`.github/workflows/release-portable.yml`](../.github/workflows/release-portable.yml)：
- **正式发版**：在本地或 GitHub 提交版本标签并推送（如 `git tag v0.1.0 && git push origin v0.1.0`），工作流将自动完成质量门禁、官方二进制哈希校验、便携版打包、离线冒烟测试，并将 `Write-*-win32-x64.zip` 与 `.sha256` 自动发布到对应的 GitHub Release。
- **手动触发与预览**：可在 GitHub 仓库 Actions 页面选择 **Release Portable (Windows x64)** 点击 `Run workflow`，构建产物将作为 Workflow Artifact 供下载验证。

### 2. 本地 Windows x64 手动制作步骤

从干净的发行源码开始，在 Windows x64 系统上执行：

1. **下载官方 Node.js 运行时**：
   从 [Node.js 官方发行件](https://nodejs.org/zh-cn/download) 下载 Node.js 22+ 的 Windows x64 ZIP 包（如 `node-v22.14.0-win-x64.zip`）及对应的 `SHASUMS256.txt`。
   在解压前必须先校验 SHA-256 哈希值：
   ```powershell
   # 校验哈希（须与 SHASUMS256.txt 中的记录一致）
   (Get-FileHash -Path node-v22.14.0-win-x64.zip -Algorithm SHA256).Hash
   ```
   校验通过后解压到独立目录（例如 `C:\Downloads\node-v22.14.0-win-x64`），该目录根层须包含 `node.exe` 与 `LICENSE`。

2. **在 Write 根目录验证门禁**：
   ```sh
   npm ci
   npm run check
   npm test
   ```

3. **执行一键打包**：
   ```sh
   # 准备仅含生产依赖的依赖树
   npm prune --omit=dev
   # 打包 Windows x64 便携版
   node scripts/package-portable.mjs --runtime "C:\Downloads\node-v22.14.0-win-x64" --out "./dist" --platform win32 --arch x64
   ```
   脚本会在 `./dist` 目录下自动生成 `Write-<版本>-win32-x64.zip` 以及同名的 `.sha256` 校验和文件。

4. **本地冒烟验证**：
   可直接运行自带的冒烟验证脚本，它会解压产物并使用内置的 `runtime\node.exe` 启动服务，验证 `GET /api/health` 正常响应 `200 ok`：
   ```sh
   node scripts/smoke-portable.mjs "./dist/Write-0.1.0-win32-x64.zip"
   ```
   也可以手动将生成的 ZIP 包解压至新目录，双击 `start.bat`，确认无需安装系统 Node.js 即可直接运行并打开浏览器。
