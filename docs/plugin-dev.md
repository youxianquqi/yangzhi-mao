# 插件开发与启停

Write 参考 [Cordis 的上下文与可逆效果](https://github.com/cordiverse/cordis)，但不依赖 Cordis。插件默认关闭，不安装包、不扫描目录。以本地 ESM 编写，在项目 `plugins/<id>/` 中放入 `plugin.json` 和入口。可从 [`plugins/_template`](../plugins/_template/) 复制，替换目录、manifest 和组件名。

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
| `provide(name, impl)` / `inject(name)` | `agent` 为 `{id, run}`，run 可带 `.stream`；`storage` 支持角色存储、可选的剧情线子存储、命名空间和旧字段读取。注入和替换敏感槽位须声明相应 `provide:agent` 或 `provide:storage`。最后成功加载的替换生效；卸载回退到前一个实现。 |
| `on(event, handler)` | 需 `hooks`。见下表。监听器的错误单独记录，不替换正常结果。 |
| `storage.namespace(pluginId)` | 需 `storage` 且只能打开自己的 ID。异步 `get(key)`、`set(key,value,signal?)`、`delete(key)`。数据为 JSON；字符串键使用安全短名，不是路径。 |
| `migration.readCharacterField(id, field)` | 需 `migrate`。只读旧记录的非核心字段，不能读取活跃或未启用的历史。 |
| `routes.register(method, resource, handler)` | 需 `routes`。受控路径 `/api/plugins/<pluginId>/<resource>/<role-uuid>`；支持 GET、POST、PUT、DELETE。处理函数接收 `{id,body,signal}`，返回 JSON。与核心共用 Host／Origin 和 JSON 限制，不能挂任意 Express 中间件。 |
| `ui.registerSlot(slot, {tag,entry,style?})` | 需 `ui` 且 manifest 声明插槽，只公开已注册的同目录 JS 和可选 CSS 文件。 |
| `onDispose(fn)` / `signal` | 注册逆序清理（也可从 apply 返回清理函数）；卸载时撤销路由、钩子、槽位和服务，scope 的 signal 中止。插件自己的定时器、网络请求等应响应它。 |

| 事件 | 参数与时机 |
| --- | --- |
| `beforePrompt` | 开始调用 Agent 前：`{characterId,threadId,character,message,sessionId,signal}`。可返回 JSON，内核以 `{pluginId,data}` 附加到 Agent 输入，不修改核心提示规则或聊天存档。 |
| `onDelta` | `{characterId,threadId,text}`，预览片段，尽力通知；慢监听器可能跳过片段，不阻塞回复。 |
| `afterTurn` | `{characterId,threadId,sessionId}`，整轮已提交。 |
| `onSessionReset` | `{characterId,threadId,sessionId:null}`，重置已提交。 |

## Web Components

浏览器模块用 `customElements.define()` 注册组件；用 `attachShadow({mode:'open'})` 隔离样式。宿主在当前角色实例上设置 `character-id` 和 `thread-id` 属性：`sidebar` 每个注册项一个；`message-actions` 仅给已提交的消息挂载，另外提供只读的 `.message`（`role,text,index`，其中 `index` 是剧情线中的绝对零基序号）。组件可用 `observedAttributes` 随角色变更刷新，用 `disconnectedCallback` 停止自己的请求或监听。组件名称需用插件 ID 作前缀。

CSS 通过注册的同源文件加载；在 Shadow DOM 里加 `<link rel="stylesheet">`，路径可用 `new URL('./sidebar.css', import.meta.url)`。样式可继承宿主的 `--text`、`--panel`、`--border`、`--accent` 等主题 Token（以[样式表](../public/styles.css)为准）。不要拼接 HTML；用 `createElement` 和 `textContent`。Shadow DOM 只隔离样式，同源脚本并不隔离权限。

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
- 线索本按角色存储，角色下各线共享笔记；`beforePrompt` 仅在新远端会话首轮附加笔记。
- `persona-guard` 每轮附加用户人设（最多 2000 字符）与软提示，`noTakeover`、`noRepetition` 默认启用，可单独关闭。不检查或改写输出，也不保证模型遵守。
- Antigravity 插件依赖已登录的 `agy`，可配 `bin`、`timeoutMs`，也兼容 `AGY_BIN`、`AGY_TIMEOUT_MS`。仍要求 CLI 确认会话级严格工具权限，不自动降级。
- 去掉配置项或将 `enabled` 设为 `false` 后重启并刷新页面。宿主测试或嵌入时可用 `kernel.unregister(id)` 或 `kernel.dispose()`；没有浏览器卸载接口，也没有文件监听热重载。卸载不会抹去已保存的角色、线索或历史，浏览器应刷新以移除已经加载的插件脚本。
- 结构化日志含 `plugin_failed`、阶段和错误码，不含模型密钥或提示词。异步故障隔离不会阻止恶意原生插件阻塞或退出 Node 进程。只启用你信任的代码。
