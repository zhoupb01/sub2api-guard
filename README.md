<img src="web/src/icon.png" width="96" alt="">

# sub2api-guard

定时检查 sub2api 第 34 组账号，默认每分钟一次。只读 PostgreSQL，通过 sub2api v0.2.23 管理 API 调整容量、优先级和调度。

- 只检查启用、可调度、未删除的母账号。守护程序关闭的账号，12 小时后自动恢复调度，容量不变。管理员手动关闭的账号不会恢复。
- 近 10 分钟至少 20 次请求，且指定的上游错误占比达到 5%，就将容量降 1。只统计上次调整之后的请求，每次调整后等至少 10 分钟再降。降容量时优先级数值加 1，让账号排得更靠后。
- 容量已经是 1 或更低时，考虑关闭调度。每轮最多关闭一个账号，关闭后至少保留 4 个可用账号。临时停调度、限流或过载尚未解除的账号不算可用。
- 距上次调整至少 30 分钟，且近 30 分钟错误率低于 1%，就将容量加 1。守护程序调低的优先级还没还清时，健康窗口内的请求数至少要达到状态页的「最少请求」才算健康。其余账号无请求也算健康。默认上限为 3，可在状态页为单个账号设置上限。每次加容量时还回一档优先级，到上限时还清。已达到或超过上限的账号健康后也会还清，记录为 `restore_priority`。优先级最低还到 0。步长设成 0 后不再新增降级，到上限时仍会还清。
- 在状态页的设置里填写 Bark URL 后，关闭调度、恢复调度或因可用账号不足而保留调度时推送。留空则不推送。每个账号的保留提醒每小时最多一次。每轮决策和错误输出为 JSON，各账号的摘要每 10 分钟最多输出一次。调整时间、关闭时间和决策记录存在 SQLite 文件 `GUARD_DB`（默认 `/data/guard.db`），演练和实跑分开记录，重启后状态页仍显示最近 200 条。降容量、加容量和恢复优先级的决策会记录优先级调整前后的数值。
- 状态页可以手动调整并发数、负载因子、优先级和调度。需要在状态页的设置里填 Admin API Key，演练模式下也会真的修改。手动改并发数后，守护程序等冷却结束再调整。手动修改优先级会将该数值设为新基准。手动关闭的账号不会自动恢复。状态页还能查看各账号近 1 小时、24 小时或 7 天的请求、匹配错误和决策记录。

## 部署

在已运行 sub2api 和 Traefik 的服务器上，将仓库放在独立目录。Compose 加入已有的 `sub2api-deploy_sub2api-network` 和 `proxy` 网络，不发布宿主机端口。在 `.env` 设置状态页域名 `GUARD_HOST`，并将它的 DNS 指向 Traefik 所在的服务器。

在 `.env` 设置共享密码 `WEB_PASSWORD`，然后访问 `https://<GUARD_HOST>` 登录。会话有效期为 30 天。更换密码并重建容器后，所有人都需要重新登录。密码留空时，状态页不启动，守护循环继续运行。

```sh
cp .env.example .env
```

编辑 `.env`，设置 `DATABASE_URL`，例如 `postgres://guard:密码@sub2api-postgres:5432/sub2api`。建议使用只授予所需表 SELECT 权限的用户。阈值、错误匹配词、检查间隔、Bark URL 和测试分组名在状态页的设置里修改，保存在 `GUARD_DB`，演练和实跑共用。检查间隔可设为 10 至 3600 秒，保存后按上一轮开始时间重算下一轮。升级后，请在状态页填入原来通过环境变量设置的自定义值，例如原 `MAX_OVERRIDES` 和 `ERROR_PATTERNS` 的内容。

镜像在本机构建，推送到自己的镜像仓库，服务器只拉取，不构建。在 `.env` 设置仓库路径 `REGISTRY`，例如 `registry.cn-hangzhou.aliyuncs.com/你的命名空间`。

在本机，首次先登录仓库，然后用同一个 `REGISTRY` 构建并推送。默认标签是 `latest`，也可以写 `./deploy/push.sh v1`。默认构建 `linux/amd64`，服务器是 ARM 时设置 `DOCKER_PLATFORM=linux/arm64`。

```sh
docker login registry.cn-hangzhou.aliyuncs.com
REGISTRY=registry.cn-hangzhou.aliyuncs.com/你的命名空间 ./deploy/push.sh
```

服务器只需要 `docker-compose.yml`、`.env` 和 `data/`。首次也要 `docker login`，然后拉取并启动。推送了非 `latest` 的标签时，在服务器的 `.env` 设置相同的 `IMAGE_TAG`。

```sh
docker compose pull
docker compose up -d
docker compose logs -f sub2api-guard
```

默认 `DRY_RUN=1`，记录决策和调整时间，模拟容量、优先级与调度变化，不调用 API 或 Bark。重启后从 sub2api 重新读取容量和调度。调整时间和待还的优先级增量保存在 `GUARD_DB`。

确认日志后，在 sub2api 管理后台 → 设置 → Admin API Key 获取密钥，填到守护程序状态页的设置里。将 `.env` 里的 `DRY_RUN` 改为 `0`，再在服务器运行 `docker compose up -d`。

升级后，请在守护程序状态页的设置里填入 Admin API Key 和 Probe API Key。密钥存在 `GUARD_DB`，演练和实跑共用，保存后无需重启。实跑模式在填入 Admin API Key 前不做任何决策，也不调整账号。

## 本地开发

用 `bun run src/main.ts` 启动后端，用 `bunx vite --config web/vite.config.ts` 启动前端开发页面。

## 测试单个账号

在状态页的设置里填入 Admin API Key 和 Probe API Key 后，可以在「提示词测试」里运行测试。页面会显示进度和结果，也可以取消。容器正常停止时，守护程序会取消正在跑的测试，等它恢复账号的原调度状态和分组后再退出。

命令行脚本从 `GUARD_DB` 读取状态页保存的密钥和测试分组名。Admin API Key 需要全权限，Probe API Key 使用测试专用的普通用户密钥（`sk-…`）。在 `.env` 设置 `SUB2API_URL`。测试分组名默认为「账号测试」，可在状态页的设置里修改。脚本会创建专属 OpenAI 分组（若已存在，请确保它是测试专用分组），并把测试密钥绑定到该组。

```sh
docker compose exec sub2api-guard bun run src/probe.ts --model gpt-6.1-sol --prompt "你好，请介绍一下自己" 135 146 149
```

脚本按顺序把账号临时加入测试分组，测完后移出测试分组并恢复原调度状态（保留账号原有分组）。一次只运行一个测试进程。支持 `--repeat n`，默认每个账号请求一次。也可以把提示词放在 `./data/prompt.txt`，用 `--prompt-file /data/prompt.txt` 代替 `--prompt`。测试无需 `DATABASE_URL`，适用于按分组调度的标准模式和默认的 1 秒调度轮询间隔。

## 许可

[MIT](LICENSE)
