# AGENTS.md

1. **极简**：本机单用户应用，保持原生 ESM 与直接运行的静态前端；运行时仅依赖 `express`，开发期仅用 TypeScript（`checkJs` + `tsc --noEmit`）。
2. **微内核优先**：核心仅维护角色／剧情线／对话最小闭环与 `ctx` 契约；所有扩展功能均通过插件实现。
3. **零信任**：保持 `127.0.0.1`、Host／Origin、CSP、`application/json` 校验，以及 Codex 只读沙箱与直接进程启动；浏览器仅用 `textContent` 与安全 DOM API 渲染；插件须经 `DATA_DIR/plugins.json` 显式启用并隔离单插件异常（进程内插件与宿主共享信任边界）。
4. **磁盘为真**：以本地存档为唯一事实源，采用 `0o700` 目录、`0o600` 文件、`wx` 临时文件与 `rename` 原子提交，同一剧情线串行互斥（`409`）；仅在整轮完整成功后提交新记录，并保持兼容旧版 JSON。
5. **自解释与渐进披露**：保持单向依赖，在导出边界写简洁 JSDoc，注释聚焦设计原因；离线通过 `npm run check` 与 `npm test`，仅在任务涉及时按需查阅并同步[架构](docs/architecture.md)与[插件契约](docs/plugin-dev.md)。