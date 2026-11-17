# Novel Bridge backend

Node.js 24 + Express 5 + PostgreSQL。Hindsight 0.9.2 的 API 合同已验证；数据库与 Hindsight 由管理员独立部署。本服务启动时仅在专用数据库创建 `nb_*` 表，不应连接现有业务数据库。

```sh
npm ci
npm test
npm start
```

必需环境变量：

| 变量 | 含义 |
| --- | --- |
| DATABASE_URL | Bridge 专用 PostgreSQL 连接串 |
| GATEWAY_SECRET | 至少 24 字符的随机内部令牌 |
| PUBLIC_ORIGIN | 酒馆 HTTPS 源地址，不带尾部斜线 |
| HINDSIGHT_URL / HINDSIGHT_API_KEY | 私网 Hindsight API 地址与密钥 |
| CPA_BASE_URL / CPA_API_KEY | OpenAI 兼容接口地址与密钥；地址通常含 `/v1` |
| CPA_MODEL | 支持 JSON 输出和 reasoning_effort 的模型 ID；默认 `gpt-5.6-luna`，需按实际接口可用模型配置 |
| EXPORT_ROOT | 持久化 Markdown 导出目录，容器用户 UID 1000 可写 |
| PORT | 默认 3100 |

可选超时：`RECALL_TIMEOUT_MS=90000`、`ANALYSIS_TIMEOUT_MS=300000`、`OPERATION_TIMEOUT_MS=15000`。

将后端保持在私网，通过已认证的同源反向代理连接。Caddy 必须覆盖 `X-Novel-User` 为认证用户名，并覆盖 `X-Novel-Gateway` 为内部令牌。不得把后端端口直接暴露到公网。示意配置：

```caddyfile
your-tavern.example {
    basic_auth {
        writer PASSWORD_HASH
    }
    handle /novel-bridge/api/* {
        reverse_proxy novel-bridge:3100 {
            header_up X-Novel-User {http.auth.user.id}
            header_up X-Novel-Gateway "{$NOVEL_GATEWAY_SECRET}"
        }
    }
    handle {
        reverse_proxy sillytavern:8000 {
            flush_interval -1
        }
    }
}
```

`NOVEL_GATEWAY_SECRET` 是 Caddy 进程的环境变量，值须与后端 `GATEWAY_SECRET` 一致。`PASSWORD_HASH` 使用 Caddy 生成的密码哈希替换。已有站点应保留原有认证与其他配置。内部用户名允许字母、数字、点、下划线、`@`、连字符，首位须字母或数字。所有写入还校验精确 Origin 和 JSON Content-Type。

Hindsight 使用每部小说一个 bank，只有作者定稿才提交 `async retain`。同章修订使用固定 document ID 和替换模式；SQL 版本、标签及来源会再次过滤召回结果。分析只接收已过滤上下文，不执行无范围限制的 reflect。

PostgreSQL 是主数据，保存不可变定稿、设定历史和持久化同步任务；请做定期备份并验证恢复。Markdown 导出是可重建副本，不能替代数据库备份。导出文件不会覆盖已有不同内容。

集成测试会清空测试数据库内的项目表。只允许显式测试数据库名 `novel_bridge_test` 或 `novel_bridge_test_<小写字母数字>`：

```sh
TEST_DATABASE_URL=postgresql://test_user:test_password@localhost/novel_bridge_test npm run test:integration
```

测试覆盖并发/幂等定稿、事务回滚、用户隔离、CSRF、早期修订失效、过期上下文、版本来源过滤、未知状态重试、丢失回执、双 worker、磁盘失败和上游非法 JSON。
