# Write

Write 是一个仅在本机运行的角色聊天应用：原生 HTML/CSS/JavaScript、Node.js、Express 5、Codex CLI 和本地 JSON。无需前端构建、数据库或独立转接服务。

## 快速开始

安装 Node.js 22 或更新版本，并在同一系统用户下安装和登录 Codex CLI。

```powershell
cd F:\Code\Write
codex login status
# 未登录时运行 codex login
npm ci
npm start
```

在浏览器打开 [http://127.0.0.1:3210](http://127.0.0.1:3210)。新建角色并发送消息；成功的对话保存后，重启服务仍可续聊。「新开会话」只清空 Write 中该角色的历史和会话绑定，不会删除 Codex 自己的记录。

### 可选环境变量

| 变量 | 用途 |
| --- | --- |
| `PORT` | 本机端口，默认 `3210`。例如：`$env:PORT = '3211'`。 |
| `DATA_DIR` | 更改数据目录。默认项目内的 `data/`；自定义目录建议放在版本库外。 |
| `CODEX_BIN` | 显式指定 Codex 可执行文件的绝对路径。Windows 用 `.exe`，不用 `.cmd`。未指定时，Windows 优先选择原生 `codex.exe`，再尝试可识别的 npm 启动器。 |
| `CODEX_TIMEOUT_MS` | 单轮 Codex 调用的超时，默认 120000 毫秒（可设为 1000–600000）。 |

如果找不到 CLI 或登录失效，请先在启动 Write 的同一终端验证 `codex login status`。装有多个版本时，用 `CODEX_BIN` 固定想使用的那个。Write 不读取或保存你的 API Key，也不执行登录。

## 项目结构

| 路径 | 职责 |
| --- | --- |
| `server.js` | 本机 HTTP 服务、请求校验与错误响应。 |
| `src/chat.js`、`src/storage.js` | 角色与对话规则、本地存档。 |
| `src/agents/codex.js` | Codex 进程启动、结构化结果解析与会话续聊。 |
| `public/` | 单页聊天界面。 |
| `test/`、`fixtures/` | 回归测试与模拟 CLI。 |

## 开发和验证

```sh
npm run check
npm test
```

第一条命令检查 JavaScript 语法，第二条运行回归测试。测试不需要 Codex 登录、不调用模型、不消耗额度；推送到启用了 GitHub Actions 的仓库后，CI 会在 Windows 和 Linux 上执行同样的检查。想验证真实接入时，手动发两条不含敏感数据的消息，并在两轮之间重启 Write。

`GET /api/health` 只确认本机服务在运行，不检查 Codex 是否安装或登录。接口错误会返回错误码和请求 ID；排障时可用请求 ID 对照终端日志，无需复制聊天或 CLI 原始输出。

## 数据与权限

- 角色、聊天和会话 ID 保存到 `DATA_DIR/characters/`（默认 `data/characters/`）。角色设定和聊天内容会交给 Codex 服务处理，并非离线推理。
- 服务只绑定 `127.0.0.1`；Codex 在专用目录中以只读沙箱运行；接入层关闭内置 shell、搜索、apps、hooks 和本地图片工具，且不加载用户的 Codex 配置文件，但继续使用 CLI 已有的登录。应用不以提示词代替权限控制。请勿把端口映射到公网、在共享系统账户下启动，或将真实聊天存档、登录文件与凭证纳入版本控制。
- 一个角色绑定一个 Codex 会话。仅完整成功的轮次进入 Write 的聊天记录；超时或失败时不会自动重试。若 Codex 已接收请求，失败后其会话也可能已发生变化。
