# 安全政策

Write 是本机单用户应用，不支持将服务暴露到公网，也不应部署在共享系统账号下。不要共享模型凭据、CLI 登录或真实聊天存档。

服务绑定 `127.0.0.1`，保留 Host／Origin 校验和 CSP。默认 Codex 以只读沙箱运行并关闭工具；可选 Antigravity 插件要求严格会话级权限。CLI 不经过 shell；这些限制不能作为将服务公开到公网的理由。

插件仅在白名单启用后加载。Node 插件与 Write 同权限，浏览器插件是同源脚本；能力声明、命名空间和 Shadow DOM 不是隔离恶意代码的沙箱。只启用已审查的代码。HTTP 模型插件会向已配置端点发送当前剧情线、当前 Agent 的聊天历史和启用插件提供的上下文（角色公用线索、用户人设等）；密钥留在环境变量，不进存档、URL 或日志。

## 私下报告

- 如果仓库已启用私密漏洞报告，请在 GitHub 的 **Security and quality → Report a vulnerability** 提交；参见[GitHub 报告指南](https://docs.github.com/en/code-security/how-tos/report-and-fix-vulnerabilities/report-privately)。
- 如果未启用，请仅通过公开 Issue 询问维护者的私密联系渠道，不要附上漏洞细节、复现材料或个人数据。
- 在私密报告中提供受影响的版本或提交、系统与 CLI 版本、影响范围及使用合成数据的最小复现。不要附上真实凭证、聊天存档、完整环境变量或 CLI 原始日志。
