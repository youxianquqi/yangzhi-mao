# 微内核架构

| 层 | 职责 |
| --- | --- |
| `src/kernel.js`、`src/plugin-loader.js` | 类型化 `ctx`、白名单、槽位、钩子及卸载。不包含剧情插件逻辑。 |
| `server.js`、`src/chat.js` | 本机 HTTP 边界、角色与剧情线、SSE 和对话事务。 |
| `src/storage.js`、`src/character-lock.js`、`src/agents/` | 默认 JSON、宿主跨进程锁、Codex 与 Agent 契约。 |
| `public/` | 原生聊天壳、分页与 SSE；插件界面经声明挂载到 Shadow DOM 槽位。 |
| `plugins/` | 默认不执行，通过 `ctx` 扩展，不由核心导入。 |

```text
browser -- HTTP --> thread route --> per-thread lock --> persisted history
   ^                                           |              |
   +--- SSE delta <---- agent slot <----- beforePrompt        |
   +--- SSE done <----------------- wx temp + rename <--- valid reply
```

## 磁盘与并发

- 角色档案和默认剧情线兼容 `DATA_DIR/characters/<roleId>.json`。旧单会话记录虚拟映射到与角色同 UUID 的默认线，读取不改写。额外剧情线写在 `DATA_DIR/threads/<roleId>/<threadId>.json`，各自维护 Agent 专属的本地记录与可丢弃的远端 `sessionId`。删除最后一条剧情线返回 409。旧接口使用默认线；若该线已删除，则使用下一条仍存在的线。
- 同一剧情线的消息修改、重抽和发送共享一把跨进程锁；不同线独立。涉及成员变更或角色删除的操作另做协调。操作正在进行时返回 `409 CHARACTER_BUSY`；只有在确认同机持锁进程已退出且令牌相符时才回收遗留锁。不要在共享盘上使用锁目录。
- 一轮成功后才写入。目录与文件以 `0o700`／`0o600` 创建（Windows 由父目录 ACL 主导）；写入经过 `wx` 临时文件和 `rename`。提交前观察到 Abort 时回收子进程、释放锁、保留原文件。若连接正好在提交后断开，先重新读取历史，不要自动重发。远端 CLI 已收到的输入或会话状态无法随本地 Abort 回滚。
- 编辑只替换目标文本，不改角色也不重新生成后文；回退删除目标及之后的内容。两者均清空当前远端续聊引用。重抽用最后一个用户输入和早于它的已提交历史开启新远端会话，成功才替换最后一条助手回复，失败仍保留旧回复。默认适配器发送本地历史作为新会话的上下文，不自动重试。
- 每个角色最多 24 条剧情线，每线每个 Agent 最多 200 条消息；旧超额记录仍能读取，可先回退或重置，不默默删除早期消息。默认每页 60 条（接口允许 1–100 条），最多取 `before` 之前的消息（不含该序号）；返回绝对零基 `start` 和 `revision`。编辑、回退、重抽要求当前修订；客户端对错版数据重新加载，服务端返回 `409 THREAD_CHANGED`，不把旧序号应用于新历史。
- 插件命名空间位于 `DATA_DIR/plugin-data/<pluginId>/`。键值单独原子提交，不属于聊天事务，也不随角色删除或卸载自动清理。第三方存储实现可复用 `storage` 契约改用 SQLite。只提供旧角色存储接口的实现可继续运行默认线，无法创建额外的剧情线。

## HTTP 与 SSE

`C = /api/characters/:id`，`T = C/threads/:threadId`，`M = T/messages`。所有 POST、PUT、PATCH 带 `Content-Type: application/json`。

| 方法与路径 | 行为 |
| --- | --- |
| `GET /api/characters` · `POST /api/characters` | 列出／创建角色，创建接收 `name`、`description`、可选 `greeting`。 |
| `GET C` · `PUT C` · `DELETE C` | 读／编辑／删除角色。 |
| `GET C/threads` · `POST C/threads` | 列出剧情线；用 `{name}` 新建，返回概要。 |
| `GET T` · `DELETE T` | 读剧情线元数据（不含聊天明细）／删除该线。 |
| `GET M?before=…&limit=60` | 返回 `{messages,start,total,revision}`；省略 `before` 获取最新页。 |
| `POST M` · `POST M/stream` | `{message,revision?}`；JSON 或 SSE。 |
| `PATCH M/:index` · `DELETE M/:index?revision=…` | `{text,revision}` 单条编辑；DELETE 从目标开始截断。序号从 0 开始。 |
| `POST M/regenerate` · `POST M/regenerate/stream` | `{revision}`；JSON 或 SSE 重抽最后一条助手回复。 |
| `DELETE T/session` | 清空本线当前 Agent 的消息和续聊引用，不影响其他线或其他 Agent。 |
| `POST C/messages` · `POST C/messages/stream` · `DELETE C/session` | 保留原路径及数据形状，作用于兼容线。 |
| `GET /api/health` · `GET /api/plugins/ui` | 当前 Agent／已注册的插件 UI。 |

SSE 请求与普通 JSON 请求共享安全校验。开流前可返回普通 4xx JSON；开流后保持 HTTP 200，使用 `text/event-stream; charset=utf-8` 和 `X-Request-Id`。

| 事件 | 数据 |
| --- | --- |
| `delta` | `{text}`：仅供预览。 |
| `done` | `{sessionId,messages,updatedAt,provider}`，剧情线路径另带 `threadId,revision,total`。正常发送的 `messages` 是本轮两条，重抽只含新助手回复。 |
| `error` | `{error,code,requestId,status}`：流内失败，不提交。 |

插件生命周期、权限与 UI 接入见[插件指南](plugin-dev.md)。
