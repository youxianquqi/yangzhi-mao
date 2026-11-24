# 安全政策

## 信任边界
* **本机单用户**：服务仅监听 `127.0.0.1` 并执行 Host / Origin、CSP 与只读 CLI 沙箱限制，仅限本机个人账号使用，请勿暴露公网或共享部署。
* **插件非沙箱**：插件须经 `plugins.json` 白名单启用，但服务端插件与主进程同权限、前端插件为同源脚本，请只启用你信任或已审查的代码。
* **出站与密钥**：使用 HTTP 模型时，当前角色、最近对话和插件提供的上下文会发送到配置的端点。网页保存的 API Key 独立写入 `DATA_DIR/secrets.json`（Unix `0o600`），不进入角色存档、日志或响应。官方端点可用更高优先级的环境变量；不要分享包含密钥的完整备份。

## 漏洞报告
* 优先在 GitHub 仓库的 **Security → Report a vulnerability** 私密提交（参见 [GitHub 私密报告指南](https://docs.github.com/en/code-security/how-tos/report-and-fix-vulnerabilities/report-privately)）。
* 若未开启私密报告，请先在 Issue 询问维护者的私密联系渠道，切勿公开漏洞细节或复现步骤。
* 报告时请提供版本号/提交哈希、环境信息及**脱敏/合成数据**的最小复现，勿附带真实密钥、聊天存档或完整环境变量。