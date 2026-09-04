# Security

本服务只监听 loopback，并且只接受 Framework 注入的 System Key。
它不持有、不请求、也不存储任何上游凭证：第一版只访问**公开** Hugging Face repo
与公开的 Package Registry。

⚠ 已知边界（不隐瞒）：Framework 自身的
`DELETE /api/assets/<id>/payload` 仍可被有 write 权限的调用方直接调用，
**绕过本服务的引用护栏**。本服务不会替你挡住那条路径。

发现问题请通过 Termux-OS Framework 仓库的安全联络渠道反馈。
