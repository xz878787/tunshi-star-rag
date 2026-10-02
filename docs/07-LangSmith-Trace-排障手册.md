# 07 · LangSmith Trace 排障手册

## 目标

本项目使用 LangChain 的自动 tracing 上报模型调用。服务正常启动不代表已经产生 trace：只有实际执行模型或 embedding 调用后，LangSmith 才会新增记录。

## Docker 配置

在项目根目录 `.env` 中配置：

```env
LANGSMITH_TRACING=true
LANGSMITH_API_KEY=你的_LangSmith_Key
LANGSMITH_PROJECT=tsxk-rag
```

不要把真实 API Key 提交到 Git、写入 Dockerfile 或贴到终端截图中。`.env` 会被 `.dockerignore` 排除；镜像内的应用依赖 Compose 注入变量。

`docker-compose.yml` 的 `app.environment` 必须包含：

```yaml
LANGSMITH_TRACING: ${LANGSMITH_TRACING}
LANGSMITH_API_KEY: ${LANGSMITH_API_KEY}
LANGSMITH_PROJECT: ${LANGSMITH_PROJECT}
```

修改 `.env` 或 Compose 配置后，重建 app 容器：

```powershell
docker compose up -d --force-recreate app
```

## 验证流程

1. 确认容器运行：`docker compose ps`。
2. 通过 Docker 对外暴露的应用地址发送一条真实问答请求。
3. 打开 LangSmith 的 `Tracing` 页面，查看名称与 `LANGSMITH_PROJECT` 完全一致的项目。
4. 刷新项目页，确认 Trace Count 增加并打开最新 run。

注意不要同时用本地 `pnpm start` 和 Docker 容器做验证。两者可能使用不同的环境变量；浏览器请求也可能打到另一个进程，造成「容器已重建但没有 trace」的误判。

## 安全检查容器变量

以下 PowerShell 命令只确认变量是否存在，不打印 API Key：

```powershell
docker inspect tsxkrag-app --format '{{range .Config.Env}}{{println .}}{{end}}' |
  Select-String -Pattern '^LANGSMITH_(TRACING|PROJECT|API_KEY)=' |
  ForEach-Object {
    if ($_ -match '^LANGSMITH_API_KEY=') { 'LANGSMITH_API_KEY=<present>' }
    else { $_ }
  }
```

预期至少看到：

```text
LANGSMITH_TRACING=true
LANGSMITH_PROJECT=tsxk-rag
LANGSMITH_API_KEY=<present>
```

## Trace Count 为 0

按以下顺序排查：

1. `LANGSMITH_TRACING` 必须是小写字符串 `true`。
2. LangSmith 页面中的项目名必须与 `LANGSMITH_PROJECT` 完全一致，包含拼写与连字符。
3. 必须在重建后的容器提供的应用中发送实际问题；仅启动服务不会上报 run。
4. 查看 `docker logs --tail 100 tsxkrag-app`，确认容器正常启动且没有模型调用错误。
5. 若 API Key 曾出现在截图、聊天记录或仓库中，先在 LangSmith 撤销该 Key、生成新 Key，再更新 `.env` 并重建容器。
