# sub2api-guard

每分钟检查 sub2api 第 34 组账号。只读 PostgreSQL，通过 sub2api v0.2.23 管理 API 调整容量和调度。

- 只检查启用、可调度、未删除的母账号。关闭后的账号需要管理员手动恢复调度。
- 近 10 分钟至少 20 次请求，且指定的上游错误占比达到 5%，就将容量降 1。只统计上次调整之后的请求，每次调整后等至少 10 分钟再降。
- 容量已经是 1 或更低时，考虑关闭调度。每轮最多关闭一个账号，关闭后至少保留 4 个可用账号。临时停调度、限流或过载尚未解除的账号不算可用。
- 距上次调整至少 30 分钟，且近 30 分钟错误率低于 1%，就将容量加 1。无请求也算健康。默认上限为 3，可用 `MAX_OVERRIDES` 覆盖个别账号的上限。管理员手动设到上限以上的账号不调整。
- 设置 `BARK_URL` 后，关闭调度或因可用账号不足而保留调度时推送。每个账号的保留提醒每小时最多一次。每轮决策和错误输出为 JSON，各账号的摘要每 10 分钟最多输出一次。

## 部署

在已运行 sub2api 的服务器上，将仓库放在独立目录。Compose 使用已有的 `sub2api-deploy_sub2api-network`，服务无需开放端口。

```sh
cp .env.example .env
```

编辑 `.env`，设置 `DATABASE_URL`，例如 `postgres://guard:密码@sub2api-postgres:5432/sub2api`。建议使用只授予所需表 SELECT 权限的用户。所有阈值及默认值见 `.env.example`。

```sh
docker compose up -d --build
docker compose logs -f sub2api-guard
```

默认 `DRY_RUN=1`，记录决策和调整时间，模拟容量与调度变化，不调用 API 或 Bark。模拟的容量与调度在进程重启时从数据库重新读取，调整时间仍留在状态文件里。

确认日志后，在 sub2api 管理后台 → 设置 → Admin API Key 获取密钥。将 `ADMIN_API_KEY` 填入 `.env`，把 `DRY_RUN` 改为 `0`，并将 `STATE_FILE` 改为 `/data/live-state.json`，让实跑使用独立的调整记录。再运行 `docker compose up -d`。
