# rabbit-ai-backend (Render Web Service + Supabase)

本目录是**独立后端工程**（建议单独上传到 Git 仓库：`rabbit-ai-backend`）。

部署目标：
- Render **一个 Web Service**
  - 提供 Fastify API：`/api/*`
  - 同进程后台跑 Indexer（监听 BSC AIRDROP 事件 → 写 Supabase）
- 数据库存储：Supabase Postgres（service role 写入）

接口规范与数据表：
- 接口：参考前端仓库文档 `docs/backend-integration.md`
- Supabase SQL：本仓库 `db/supabase.sql`（从前端仓库 `docs/supabase-setup.md` 同步）

---

## 1) 本地启动（仅用于开发）

1. 安装依赖

```bash
npm install
```

2. 配置环境变量

复制 `env.example` 为 `.env.local`，并填入真实值。

> 注意：本仓库不生成 `.env.local` 文件，你自行创建即可。

3. 构建与启动

```bash
npm run build
npm run start
```

健康检查：
- `GET /api/health`

---

## 2) Render 部署（单 Web Service）

Render 配置建议：
- Build Command：`npm ci && npm run build`
- Start Command：`npm run start`
- Health Check Path：`/api/health`

必须的环境变量：见 `env.example`

---

## 3) 进程模型（关键）

`src/index.ts` 会：
1) 启动 Fastify 监听 `PORT`
2) 后台启动 indexer loop（不会阻塞 HTTP）

---

## 4) Supabase 安全

后端使用 `SUPABASE_SERVICE_ROLE_KEY` 访问数据库：
- 该 key **永不下发给前端**
- 建议 Supabase 业务表开启 RLS（即使 service role 可绕过，RLS 也能防误配）


