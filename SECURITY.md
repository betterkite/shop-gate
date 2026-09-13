# 安全问题报告

请不要在公开 Issue、Pull Request、聊天记录或日志中发布 API key、密码、Cookie、访问令牌、个人数据或可复现的漏洞细节。

仓库公开后，优先通过 GitHub 的 Private Vulnerability Reporting / Security Advisories 提交安全问题；在该入口启用前，可以先提交不包含敏感细节的维护者联系请求，并说明安全问题的影响范围、受影响版本和安全的复现方式。

收到报告后，维护者会确认范围、评估影响、准备修复和回归测试，并在适合公开时发布修复说明。报告者不应在修复发布前公开漏洞利用代码或敏感样本。

本项目的本地配置应使用 `.env.local`。提交前请运行秘密扫描，并确认 `git diff --cached` 中没有任何凭据。
