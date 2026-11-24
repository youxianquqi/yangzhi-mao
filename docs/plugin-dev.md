# 插件开发与启停

Write 参考 [Cordis 的上下文与可逆效果](https://github.com/cordiverse/cordis)，但不依赖 Cordis。插件默认关闭，不安装包、不扫描目录。网页只列出发行版固定的内置插件以及本机白名单已有的有效 ID，不会扫描其他目录。以本地 ESM 编写，在项目 `plugins/<id>/` 中放入 `plugin.json` 和入口。可从 [`plugins/_template`](../plugins/_template/) 复制，替换目录、manifest 和组件名。

```json
{
  "id": "my-sidebar",
  "name": "My Sidebar",
  "version": "0.1.0",
  "entry": "index.js",
  "slots": ["sidebar"],
  "permissions": ["ui"]
}
```

`id` 与目录一致，用小写字母、数字和连接号；`entry` 是同目录 JS 文件名。声明的权限只约束 `ctx` API，不会限制 Node.js 代码直接使用系统资源。入口不要在 import 阶段启动任务或产生副作用；放进 `apply`，及时登记清理。初始化失败时内核撤回已经登记的托管效果。

```js
/** @param {import('../../src/kernel.js').PluginContext} ctx */
export function apply(ctx) {
    ctx.ui.registerSlot('sidebar', { tag: 'my-sidebar-panel', entry: 'sidebar.js' });
    // ctx.onDispose(() => clearInterval(timer));
}
```

## ctx 契约

| API | 用法／限制 |
| --- | --- |
| `provide(name, impl)` / `inject(name)` | `agent` 为 `{id, run}`，run 可带 `.stream`；`storage` 支持角色存储、可选的剧情线子存储、命名空间和旧字段读取。注入和替换敏感槽位须声明相应 `provide:agent` 或 `provide:storage`。最后成功加载的替换生效；卸载回退到前一个实现。可用 `overrides` 显式展示该服务的接管；旧 manifest 中合法的 provide 调用仍兼容。 |
| `on(event, handler)` | 需 `hooks`。见下表。监听器的错误单独记录，不替换正常结果。 |
| `storage.namespace(pluginId)` | 需 `storage` 且只能打开自己的 ID。异步 `get(key)`、`set(key,value,signal?)`、`delete(key)`。数据为 JSON；字符串键使用安全短名，不是路径。 |
| `migration.readCharacterField(id, field)` | 需 `migrate`。只读旧记录的非核心字段，不能读取活跃或未启用的历史。 |
| `routes.register(method, resource, handler)` | 需 `routes`。受控路径 `/api/plugins/<pluginId>/<resource>/<role-uuid>`；支持 GET、POST、PUT、DELETE。处理函数接收 `{id,body,signal}`，返回 JSON。与核心共用 Host／Origin 和 JSON 限制，不能挂任意 Express 中间件。 |
| `ui.registerSlot(slot, {tag,entry,style?})` | 需 `ui` 且 manifest 声明插槽，只公开已注册的同目录 JS 和可选 CSS 文件。 |
| `onDispose(fn)` / `signal` | 注册逆序清理（也可从 apply 返回清理函数）；卸载时撤销路由、钩子、槽位和服务，scope 的 signal 中止。插件自己的定时器、网络请求等应响应它。 |

| 事件 | 参数与时机 |
| --- | --- |
| `beforePrompt` | 开始调用 Agent 前：`{characterId,threadId,character,message,sessionId,stateless,signal}`。可返回 JSON，内核以 `{pluginId,data}` 附加到 Agent 输入，不修改核心提示规则或聊天存档。 |
| `onDelta` | `{characterId,threadId,text}`，预览片段，尽力通知；慢监听器可能跳过片段，不阻塞回复。 |
| `afterTurn` | `{characterId,threadId,sessionId}`，整轮已提交。 |
| `onSessionReset` | `{characterId,threadId,sessionId:null}`，重置已提交。 |

## Web Components

浏览器模块用 `customElements.define()` 注册组件；用 `attachShadow({mode:'open'})` 隔离样式。宿主在当前角色实例上设置 `character-id` 和 `thread-id` 属性：`sidebar` 每个注册项一个；`message-actions` 仅给已提交的消息挂载，另外提供只读的 `.message`（`role,text,index`，其中 `index` 是剧情线中的绝对零基序号）。组件可用 `observedAttributes` 随角色变更刷新，用 `disconnectedCallback` 停止自己的请求或监听。组件名称需用插件 ID 作前缀。

CSS 通过注册的同源文件加载；在 Shadow DOM 里加 `<link rel="stylesheet">`，路径可用 `new URL('./sidebar.css', import.meta.url)`。样式可继承宿主的 `--text`、`--panel`、`--border`、`--accent` 等主题 Token（以[样式表](../public/styles.css)为准）。不要拼接 HTML；用 `createElement` 和 `textContent`。Shadow DOM 只隔离样式，同源脚本并不隔离权限。

### 工具栏扩展与角色卡

`toolbar` 是增补插槽，不替换设置与帮助；即使没有选择角色也会挂载。工具可通过正常的同源 API 创建角色，成功后从组件发送冒泡、可穿过 Shadow DOM 的 `write-character-created`（`detail` 为已创建角色的 ID），宿主将刷新角色列表。

内置 `card-importer` 默认关闭。在网页设置启用后，从顶栏导入 [Character Card V2](https://github.com/malfoyslastname/character-card-spec-v2/blob/main/spec_v2.md)／SillyTavern JSON 或含 `chara` 文本块的 PNG。PNG 限 10 MiB，JSON／解码卡内容限 1 MiB；浏览器在本机解析，只把预览确认后的角色名称、设定和开场白提交到既有角色接口，不上传原图。人物志、系统提示、附件和扩展字段不会导入。

## 配置与卸载

将已审查的目录放入 `plugins/`，在 `DATA_DIR/plugins.json` 中显式启用。例如：

```json
{
  "plugins": {
    "story-clues": { "enabled": true },
    "agent-openai-compat": {
      "enabled": true,
      "config": {
        "baseUrl": "https://api.openai.com/v1",
        "model": "填入可用模型名",
        "apiKeyEnv": "OPENAI_API_KEY"
      }
    },
    "persona-guard": {
      "enabled": true,
      "config": { "persona": "我是一名侦探，自己决定行动。", "noTakeover": true, "noRepetition": true }
    },
    "agent-antigravity": { "enabled": false }
  }
}
```

- 模型插件会对 `baseUrl` 追加 `/chat/completions`。DeepSeek 可配置 `https://api.deepseek.com`，Ollama 可配置 `http://127.0.0.1:11434/v1`。HTTPS 或回环 HTTP，不跟随重定向。设 `apiKeyEnv` 时填环境变量名，不在文件里填密钥；本机无鉴权可省略。可选 `timeoutMs`（1000–600000）。此插件会发送该 Agent 下保存的历史、角色、当前消息和钩子上下文；改指另一服务前先按需重置历史。
- 线索本按剧情线保存。原角色的旧笔记仍可在默认线读取，新增剧情线互不共享。兼容 HTTP Agent 声明 `stateless: true`，每轮会重新读取最新已保存的阶段摘要与线索；有状态 CLI 只在开启远端会话时注入。
- `persona-guard` 每轮附加用户人设（最多 2000 字符）与软提示，`noTakeover`、`noRepetition` 默认启用，可单独关闭。不检查或改写输出，也不保证模型遵守。
- Antigravity 插件依赖已登录的 `agy`，可配 `bin`、`timeoutMs`，也兼容 `AGY_BIN`、`AGY_TIMEOUT_MS`。仍要求 CLI 确认会话级严格工具权限，不自动降级。
- 网页设置可热启停固定的内置插件，也可停用已在白名单中的插件。手动修改白名单后须重启；宿主可用 `kernel.unregister(id)` 或 `kernel.dispose()` 。卸载不会抹去已保存的角色、线索或历史。浏览器不会清出已加载的模块；组件应在断开时停止自己的副作用，必要时刷新页面。
- 结构化日志含 `plugin_failed`、阶段和错误码，不含模型密钥或提示词。异步故障隔离不会阻止恶意原生插件阻塞或退出 Node 进程。只启用你信任的代码。

## 接管或隐藏默认能力

manifest 可增加可选数组 `"overrides": ["agent", "thread-selector"]`、`"hides": ["character-sidebar"]`。仅支持下列命名默认能力，不可接管本机监听、Host／Origin、CSP、宿主锁、安全模式或设置与帮助入口。

| 能力 | 覆盖要求 | 可隐藏 |
| --- | --- | --- |
| `agent`、`storage` | 声明对应 `provide:*` 权限并调用 `ctx.provide()`，不得提供空值。替换存储应遵守原子提交和取消契约。 | 否 |
| `character-sidebar`、`thread-selector`、`main-view` | 声明 `ui` 权限和对应 `slots`，并将替代组件注册到同名插槽。 | 是 |

一个插件不能同时在两个数组里声明同一能力。普通 `sidebar` 插槽仍用于添加面板，不会接管默认角色选择器。多插件竞争时，最后成功激活者生效，日志用 `SLOT_CONFLICT` 标记槽位和双方 ID；停用后恢复仍活动的上一个实现，没有替换时恢复默认。替代模块加载失败时默认界面仍可用。角色和剧情线替代选择器可发送冒泡、可穿过 Shadow DOM 的 `write-select-character` 或 `write-select-thread` 事件，`detail` 为目标 ID。

遇到插件故障，先停止服务，再以 `SAFE_MODE=1` 启动（PowerShell：`$env:SAFE_MODE='1'; npm start`；macOS/Linux：`SAFE_MODE=1 npm start`）。此时不导入任何白名单插件，设置页仍可保存开关；关闭有问题的插件后，清除变量并重新启动。

## 如何借助 AI 自行配置其他兼容模型或 CLI 插件

- 普通用户只需在网页设置中选 DeepSeek 或 MiniMax，填入官网 API Key。模型调用会将角色信息、当前消息和必要上下文发送到配置的模型端点。连接测试只访问该预设允许的官方域和数字回环地址，不发送存档。
- 进阶配置时，把供应商的公开 API 文档和本指南交给 AI，不要交出真正的密钥或存档。可提示：「请根据这份文档为 Write 配置支持 Chat Completions SSE 的 `agent-openai-compat`，注明准确的 Base URL、模型名和密钥环境变量名，只输出 `plugins.json` 片段与离线测试方式。」先检查地址是否可信，再配置环境变量。
- Codex 仍可用：先自行安装并登录，再设置 `WRITE_AGENT=codex` 后启动；Antigravity 使用现有的 `agent-antigravity` 插件。要写其他 CLI 插件，请 AI 按 `AgentAdapter` 契约及 `plugins/_template` 起草，保持直接启动进程、禁用工具和只读沙箱，并用本地假的 CLI 测试取消、超时和完整结束。不要启用不支持严格权限的适配器。
