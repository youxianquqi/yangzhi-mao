# Write · 养只猫

本机单用户角色扮演聊天。默认使用 Codex CLI；无需启用任何插件即可管理角色和多条独立剧情线，接收流式回复、停止、编辑消息、回退或重抽。界面用原生 HTML/CSS/JS，无打包或运行时构建。

## 启动

需要 Node.js 22+。使用默认 Agent 时，在运行 Write 的系统账号下安装 Codex CLI，用 `codex login status` 查看登录状态，必要时运行 `codex login`。

```sh
npm ci
npm start
```

打开 [http://localhost:3210](http://localhost:3210)。服务只绑定 `127.0.0.1`；不要映射到公网或共享账号。

选角色后可在顶部新建、切换或删除剧情线。旧单会话记录显示在默认线。对话超过 60 条时点「加载更早记录」；编辑仅改选中的文本，回退删除该条及之后的记录，重抽成功后才替换最后一条回复。

| 环境变量 | 默认／含义 |
| --- | --- |
| `PORT` | `3210`。 |
| `DATA_DIR` | 项目内 `data/`，支持绝对路径；相对路径基于项目目录。使用支持硬链接的本机文件系统，不放共享盘或跨主机同步目录。 |
| `CODEX_BIN` | 可执行文件绝对路径；Windows 用 `.exe`，未设置时尝试原生 Codex 后再找 npm JS 启动器。 |
| `CODEX_TIMEOUT_MS` | 默认 120000 毫秒；允许 1000–600000。 |

## 选择插件

放进 `plugins/` 的代码不会自动执行。编辑 `DATA_DIR/plugins.json`，只启用自己已审查的插件，再重启服务、刷新浏览器。例如启用剧情线索本：

```json
{"plugins":{"story-clues":{"enabled":true}}}
```

- **story-clues**：剧情线索与阶段摘要，各剧情线共用角色笔记，加入新远端会话的首轮上下文。旧线索仍可读；下次保存写入插件命名空间，不改原字段。
- **agent-openai-compat**：可替换默认 Agent，支持 OpenAI、DeepSeek 与 Ollama 的 Chat Completions SSE；模型地址由用户明确配置。
- **persona-guard**：注入用户人设、防 AI 代替玩家行动和减少复读的提示；不保证模型一定遵守。
- **agent-antigravity**：可选的 Antigravity CLI 适配器。原本按角色选择 CLI 的入口已移出聊天壳；现在由启动配置选择全局 Agent。切回某个 Agent 时会恢复该剧情线之前在它那里的本地历史。

插件配置、停用与出站数据范围见[插件开发指南](docs/plugin-dev.md)。插件不是安全沙箱。除了默认 Codex，启用模型插件后不需要 Codex CLI 就能聊天。

## HTTP 接口

| 路由 | 用途 |
| --- | --- |
| `GET /api/health` | 返回当前 Agent ID，不检查登录。 |
| `GET /api/characters` / `POST /api/characters` | 列出／创建角色。 |
| `GET/PUT/DELETE /api/characters/:id` | 读／编辑／删除角色。 |
| `GET/POST /api/characters/:id/threads` | 列出／新建剧情线。 |
| `GET/DELETE /api/characters/:id/threads/:threadId` | 读取元数据／删除剧情线。 |
| 剧情线下的 `/messages` | 分页、发送、SSE、编辑、回退和重抽。 |
| `POST /api/characters/:id/messages` 和 `/messages/stream` | 兼容旧路径与响应格式。 |
| `GET /api/plugins/ui` | 当前启用插件注册的 UI 清单。 |

会话和插件数据见[架构与 SSE 协议](docs/architecture.md)。操作失败用响应的 `X-Request-Id` 排查；断开未收 `done` 时先查看历史再重发。

## 开发

```sh
npm run check
npm test
```

安装依赖后命令可离线执行。检查使用 Node 语法检查及 `tsc --noEmit`；测试使用临时目录、回环 mock HTTP 和 CLI 桩。目录：`server.js` 是 HTTP 宿主，`src/` 是内核与默认服务，`public/` 是聊天壳，`plugins/` 是扩展，`test/` 和 `fixtures/` 是离线用例。

[贡献指南](CONTRIBUTING.md) · [变更记录](CHANGELOG.md) · [安全政策](SECURITY.md) · [MIT 许可证](LICENSE)
