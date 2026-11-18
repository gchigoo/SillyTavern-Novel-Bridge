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
| EXPORT_ROOT | 持久化导出目录：手动章节 Markdown、自动消息 JSON；容器用户 UID 1000 可写 |
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

手动章节使用每部小说一个 `novel-<uuid>` bank，作者定稿才提交 `async retain`。同章修订使用固定 document ID 和替换模式；SQL 版本、标签及来源会再次过滤召回结果。手动分析只接收已过滤上下文，不执行无范围限制的 reflect。

自动聊天使用独立的 `chat-<uuid>` bank 与 `nb_chat_*` 表。消息先以内容哈希暂存，再通过带 `expectedEpoch` 的完整有序清单原子切换有效版本并插入 outbox；暂存对象本身不被索引。重复清单幂等，冲突清单返回 409。现有手动章节表不做数据转换或覆盖。启动时会增量创建新表，升级前备份数据库与导出目录。

自动模式接口（同样受网关身份与 Origin 校验保护）：

| 方法与路径（前缀 `/novel-bridge/api`） | 用途 |
| --- | --- |
| POST `/chats` | 以客户端 UUID 和聊天绑定哈希幂等创建记忆库 |
| GET `/chats/:vault` | 当前清单、epoch 和各状态任务数 |
| POST `/chats/:vault/stage` | 校验哈希并暂存原文；每批最多 20 条 |
| POST `/chats/:vault/sync` | 原子提交当前清单与删除标记 |
| POST `/chats/:vault/context` | 按当前 epoch 召回；支持排除正被续写/重抽的消息 |
| POST `/chats/:vault/retry` | 重试暂停或失败任务，保留未确认操作的 UUID |

每条消息有固定 `message-<uuid>` document ID，修订以 `update_mode: replace` 入库；删除标记调用 Hindsight 的 [删除 document 接口](https://docs.hindsight.vectorize.io/api-reference/delete-document/)。同条消息的旧操作未确认完成时，新版本和删除任务不能越过它；状态不明时复用持久化 operation ID。独立 advisory lock 保证只有一个聊天 worker 提交任务。即使索引仍在更新，召回也只接受当前有效、已完成索引且来源/版本/标签完整匹配的事实。自动库关闭 observations、temporal 和 graph 检索，避免使用无当前消息来源的推演信息。

PostgreSQL 是主数据，保存不可变定稿、设定历史和持久化同步任务；请做定期备份并验证恢复。Markdown 导出是可重建副本，不能替代数据库备份。导出文件不会覆盖已有不同内容。

集成测试会清空测试数据库内的项目表。只允许显式测试数据库名 `novel_bridge_test` 或 `novel_bridge_test_<小写字母数字>`：

```sh
TEST_DATABASE_URL=postgresql://test_user:test_password@localhost/novel_bridge_test npm run test:integration
```

测试覆盖并发/幂等定稿与聊天清单、事务回滚、用户隔离、CSRF、早期修订失效、过期上下文、版本来源过滤、未知状态重试、丢失回执、删除与旧 retain 的顺序、双 worker、磁盘失败和上游非法 JSON。集成脚本串行运行两套测试，避免并发 DDL。
