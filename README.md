# 影视资源追踪与多盘同步管理系统

影视资源更新追踪、多网盘自动同步与多平台发布管理系统。支持剧集更新追踪、多平台发布、多盘链接管理、一键回填与链接失效检测。

## 技术栈

Vite、TypeScript、React、Supabase、Tailwind CSS

## 目录结构

```
├── public/          # 静态资源
├── src/             # 前端源码
│   ├── components/  # 组件
│   ├── contexts/    # React Context（鉴权等）
│   ├── db/          # Supabase 客户端配置
│   ├── hooks/       # 通用 Hook
│   ├── lib/         # 工具库
│   ├── pages/       # 页面
│   ├── services/    # 数据交互
│   └── types/       # 类型定义
├── supabase/
│   ├── migrations/  # 数据库迁移
│   ├── functions/   # Edge Functions
│   └── schema.sql   # 完整数据库结构
├── index.html
├── package.json
└── vite.config.ts
```

## 环境变量

在项目根目录创建 `.env`：

| 变量 | 说明 |
|---|---|
| `VITE_SUPABASE_URL` | Supabase 项目 URL（如 `https://<ref>.supabase.co`） |
| `VITE_SUPABASE_ANON_KEY` | Supabase anon 公钥 |

## 本地开发

环境要求：Node.js ≥ 20、npm ≥ 10（或 pnpm）

```bash
npm install      # 安装依赖
npm run dev      # 启动开发服务器
```

## 构建

```bash
npm run build    # 产物输出到 dist/
```

## 后端（Supabase）

- 数据库结构：直接执行 `supabase/schema.sql`（完整幂等结构），或按顺序执行 `supabase/migrations/`。
- Edge Functions：位于 `supabase/functions/`，使用 `supabase functions deploy <name>` 部署。
- Storage 桶：需创建 `covers`、`login-assets` 并设为 public。

### 站点凭据云端存储与自动重登

各站点（鸭影 / 聚影 / 栖影 / 帧影 / 不太灵 / 盘链 / 123社区 / 观影）的登录凭据会加密存入
`site_credentials` 表，用户登录本应用后前端自动巡检已绑定站点，**会话失效时用云端凭据自动重新登录**，
减少同步失败。部署要求：

```bash
supabase secrets set SITE_CRED_KEY=<32 字节随机串>   # 加密密钥，务必保存好
supabase functions deploy site-credential
```

- 加密：pgcrypto 对称加密，数据库只存密文；密钥仅存在于 Edge Function 环境变量 `SITE_CRED_KEY`。
  前端即便被攻破也读不到密文（`secret_enc` 未授权给 authenticated 角色），换密钥等于作废旧凭据。
- 自动重登能力：鸭影（refresh + 账密）、聚影、栖影（未开两步验证时）、帧影可全自动；
  不太灵 / 盘链登录需图形验证码、123社区 / 观影仅支持 Cookie，巡检时会提示手动重新登录。
- 同步兜底：资源同步命中「会话失效」错误码时，会先自动重登再重试一次，仍失败才报错。

### 订阅转存（RSS / 网页更新页 → 网盘转存 → 自动入库）

「订阅转存」页可配置订阅源（RSS / 网页更新页），服务端定时抓取其中的光鸭 / 夸克分享链接，
用云端加密保存的网盘 Cookie 转存到自己的网盘，并自动写入「我的资源」（进已更新面板）。

```bash
supabase secrets set SITE_CRED_KEY=<32 字节随机串>     # 凭据加密密钥（与站点凭据共用）
supabase secrets set SUBSCRIPTION_SECRET=<随机串>       # 定时任务共享密钥
supabase functions deploy subscription-run --no-verify-jwt
```

- 定时任务：pg_cron **每分钟**触发 `subscription-run-1min`，函数再按每个订阅的「检查时间」（`interval_minutes`，
  最小 1 分钟）判断是否到点；到点就探测一次链接，发现新增文件即转存到该订阅的目标目录。
  同一订阅上一轮未跑完时不会重复执行（`run_lock_at` 执行锁，超时 10 分钟自动失效）。
- 绑定资源：订阅里可**指定「资源管理」中的某条资源**（不指定则按剧名自动匹配）。转存到新文件后：
  集数对齐成**分享里最大的集号**（例：分享里最大 `S01E03` → 资源集数就是 3；
  **不按文件数**——同一集常有 1080p/4K 两个版本，文件数会翻倍；解析不出集号时才退回按文件数），
  同时把资源名里的「第N集」一起改掉（「无可替代 更新至第1集…」→「更新至第3集…」），
  写变更记录并登记一条 `resource_sync_queue`，由服务端 worker（`resource-sync-worker`，
  pg_cron 每分钟触发）**无人值守**把变更推到各站点（会话失效时用云端凭据自动重登一次再重试，
  失败记录原因并重试最多 5 次）；前端打开「资源管理」页时仍会补推一次作为兜底。
- 光鸭凭证：**推荐「扫码授权」**（网盘账号卡片上点「扫码授权」）：走官方设备码流程
  （`/v1/auth/device/code` → 轮询 `/v1/auth/token`），换回的令牌是发给**官方 client_id** 的，
  之后可长期自动续期。也保留「填入令牌」方式（粘贴浏览器 localStorage 里的 refresh_token）。
  关键约束：**续期必须用官方硬编码的 client_id `aMe-8VSlkrbQXpUR`**（官方插件注明「勿改」）——
  光鸭账号网关按 client_id 路由，带浏览器那套 `credentials_<其它 client_id>` 去续期会被判成
  未知客户端、直接返回 `404 not_found`，表现就是「用着用着就提示续期失败（原因：not found）」。
  另外 access_token 会按 `expires_at` **主动续期**，轮换后的 refresh_token 一并保存。
- 解析在服务端完成：支持 RSS / Atom 与**静态**网页；纯 JS 动态渲染的页面抓不到，需要给 RSS。
- 光鸭：**填入令牌绑定**（Client ID + Refresh Token，Access Token 可选；令牌加密存储、过期自动 refresh）。
  令牌取自光鸭官网登录后浏览器本机存储：localStorage 的 `credentials_<client_id>` 里的
  `refresh_token`（界面支持把整段 JSON 粘进去自动拆分）。保存时会立即用 refresh_token 换一次
  access_token 做校验，因此**只填 Refresh Token 即可**。
  转存走开放平台 `/userres/v1/get_share_access_token → get_share_page_files_list → restore_share`。
  可选环境变量 `GUANGYA_CLIENT_ID` / `GUANGYA_SDK_VERSION`。

  > 请求头按官方服务端实现（《光鸭接入机器插件-优化版》）对齐：业务域必须带
  > `Authorization` / `X-Client-Id` / `X-Client-Version: 0.0.1` / `X-Sdk-Version: 9.0.2` / `X-Protocol-Version: 301`，
  > 缺了会被判 `401 + code=117「无效token」`；`did` / `dt` 是早期推测的头，官方客户端并不发送，已移除。
  >
  > **重要（部署依赖）**：光鸭的所有请求都必须经由**数据库侧 pg_net 代理**发出，原因有两个——
  > ① Supabase Edge 在境外，直连光鸭整体超时；② PostgreSQL 的 `http` 扩展其 `http_header()`
  > 实测完全无效（自定义请求头发不出去，导致接口一律 117）。因此需要两个数据库函数：
  > `guangya_http_send()`（入队，返回请求 id）与 `guangya_http_result()`（取回响应），
  > 定义见 `supabase/migrations/00049_guangya_proxy_use_pg_net.sql` 与
  > `supabase/migrations/00050_guangya_http_send_result.sql`，并确保启用了 `pg_net` 扩展。
- 夸克：粘贴 Cookie，转存走分享保存流程（`sharepage/token → detail → save → share/create`）。
- 光鸭开放平台暂无「创建分享」接口，因此光鸭转存后不生成自己的分享链接，入库沿用源分享链接
  （文件已实际落到你的网盘，源链接失效不影响已转存内容）。
- 未绑定网盘账号、或源链接网盘与目标网盘不一致时，不转存，直接用源分享链接入库，并在条目上标注原因（流程不中断）。
- `x-subscription-secret` 为定时任务专用鉴权；用户侧调用仍校验登录态 JWT。

### 开放接口（API 管理）

管理后台「API 管理」可创建 API Key，供第三方程序**实时**读取「更新中 / 已更新」与「已完结」资源。
每个密钥绑定一个归属账号，**接口只返回该账号自己名下的资源**，不能查询全站或其他账号的数据。
接口直连数据库、不做缓存，资源在「资源管理」中被修改或标记完结后，下一次调用即返回最新数据
（支持 `since=1h` / `since=7d` 等参数做增量拉取，`last_changed_at` 为最近一次修改时间）。
接口为 `resource-api`，用 `X-API-Key` 鉴权、不需要登录，因此部署时必须关闭平台层 JWT 校验：

```bash
supabase functions deploy resource-api --no-verify-jwt
```

（已写入 `supabase/config.toml` 的 `[functions.resource-api] verify_jwt = false`，用 CLI 部署可自动生效。）
接口地址与参数说明见管理后台「API 管理 → 开放接口文档」。

另一个写入接口是**批量发帖（自动发帖脚本）** `batch-post`：POST + 本系统登录态 JWT（不是 X-API-Key），
调用方必须已开通批量发帖权限（管理员在后台授予）。请求体为 `{ site, payload, useShortLink }`，
`site` 支持 7 个站点：`pinglian / xnsite / ya / framehdr / mukaku / jying / hdhaven`。

`useShortLink`（短链开关，由调用方自行选择）：

- `true` → 发帖正文里的网盘链接替换成该链接自己的短链（光鸭短码带前缀 `g`、夸克带 `q`，便于区分）；
- `false` → 完全按原样推送原始网盘链接（不开启短链时用这个）；
- 不传 → 用账号默认（管理员开、其它账号关）。别名 `shortLink` / `use_short_link` 同样识别。

约束与兜底：短链**只替换「发给站点的正文」**，本应用资源库与站点绑定关系**始终保存原始网盘链接**
（保证后续增量同步可用）；短链生成失败**自动回退原链**，绝不影响发帖成败；短链按**调用账号**创建并复用，不跨账号。
部署时保持默认 JWT 校验（**不要**加 `--no-verify-jwt`）。字段与错误码详见「开放接口文档」第 8 节。

短链本身另有一个**独立接口** `shortlink-api`（用 `X-API-Key` 鉴权，不需要登录态 JWT，也**不具备发帖能力**）：
只想把网盘链接换成短链时用它，短链按密钥归属账号创建并复用。支持三种入参
（`url` 单条 / `urls` 多条 / `text` 整段正文自动替换）、`mode=path|short`、`prefix`、`channel`、
`extract_code`、`expires_at`、`reuse`，另有 `GET /me` 自检与 `GET /list` 列表。公开接口必须关闭平台层
JWT 校验（已写入 `config.toml`：`[functions.shortlink-api] verify_jwt = false`），说明见「开放接口文档」第 9 节。

**资源与短链的联动**（迁移 `00071_auto_short_links_for_resources.sql`）：

- 资源新增、或 `links` / 名称更新后，数据库触发器会**自动**为该资源的每条网盘链接补一条短链
  （归属资源所有者，同账号同链接幂等复用，`resource_id` / 标题一并记上；触发器失败只记日志，绝不影响资源写入）；
- `GET|POST /shortlink-api/resource` 支持按 `id` / `name` / `url` / `since` 查资源对应的短链，
  返回的是**调用方账号**名下的短链（缺失即补生成，`ensure=false` 可只查不补）；
- `GET /shortlink-api/list` 增加 `resource_id` / `only_resource` / `since` 过滤，便于脚本增量轮询。

## 代码检查

```bash
npm run lint
```
