# 贡献指南

先阅读 [AGENTS.md](AGENTS.md) 的四条开发约定；模块职责、写入边界和流式协议见[架构说明](docs/architecture.md)。

## 本地验证

需要 Node.js 22 或更新版本：

```sh
npm ci
npm run check
npm test
```

检查包含 Node 语法检查和仅做静态分析的 `tsc --noEmit`。新扩展写在插件里，不在核心添加业务分支。测试使用临时存档、回环地址、模拟 HTTP 和 CLI；安装依赖后不必联网、安装真实 Agent 或登录账号。若要手动验证真实 Agent，请用测试角色和不含个人信息的剧情。

## 提交变更

- 保持改动聚焦；新增可观察行为时补相应的回归测试，不用真实模型作测试判定。
- 更改 HTTP、会话或存档时，检查旧单线记录、剧情线隔离、修订冲突及取消／失败不落盘；同步文档及 [CHANGELOG 的 Unreleased](CHANGELOG.md#unreleased)。
- 在 PR 中列出实际运行的检查，并说明对数据格式、安全边界和常规启动方式的影响。
- 请勿提交 `data/`、聊天记录、账号凭证或未经清理的 Agent 输出。一般问题可使用 Issue 模板；安全问题遵循[安全报告流程](SECURITY.md)。
