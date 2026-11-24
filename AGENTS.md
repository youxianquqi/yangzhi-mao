1. **极简**：本机单用户，运行时只依赖 `express`；开发只用 TypeScript 的 `checkJs` 和 `tsc --noEmit`，零构建链、零前端打包。
2. **微内核优先**：核心只维护最小角色／剧情线／对话闭环与 `ctx` 契约。禁止在核心硬编码扩展业务；非基础功能一律做成插件。
3. **零信任**：保留 `127.0.0.1`、Host／Origin、CSP、`application/json`、Codex 只读禁用工具及无 shell 启动。浏览器只用 `textContent` 和安全 DOM API，禁用 `innerHTML`。插件须由 `DATA_DIR/plugins.json` 显式启用，单插件托管故障不得拖垮核心；进程内插件不是安全沙箱。
4. **磁盘为真**：本地存档是唯一事实源。目录 `0o700`、文件 `0o600`，通过 `wx` 临时文件与 `rename` 原子提交；同一剧情线写入互斥（`409`）。失败或提交前中途 Abort 不改变已存记录；兼容旧版 JSON。
5. **自解释与离线验收**：依赖单向，导出边界写简洁 JSDoc，注释只写原因。改动须离线通过 `npm run check`（`node --check`、`tsc --noEmit`）和 `npm test`；同步[架构](docs/architecture.md)与[插件契约](docs/plugin-dev.md)。
