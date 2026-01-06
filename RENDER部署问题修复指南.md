# Render 部署问题修复指南

**问题**: `Error: Cannot find module '/opt/render/project/src/dist/index.js'`

**原因**: Build 阶段没有正确执行，导致 `dist` 目录没有生成

---

## 🔧 修复步骤

### 1️⃣ 检查 Render 配置

登录 Render Dashboard → 选择你的服务 → Settings → Build & Deploy

**确认以下配置**:

| 配置项 | 正确值 | 说明 |
|--------|--------|------|
| **Build Command** | `npm ci && npm run build` | 安装依赖并构建 |
| **Start Command** | `npm run start` | 启动服务 |
| **Root Directory** | ` ` (空白) | 根目录 |

---

### 2️⃣ 手动触发重新部署

1. 进入 Render Dashboard
2. 选择你的后端服务
3. 点击右上角 **"Manual Deploy"** → **"Clear build cache & deploy"**
4. 等待部署完成（约3-5分钟）

---

### 3️⃣ 查看部署日志

部署时，你应该看到类似这样的日志：

```bash
==> Building...
==> Running 'npm ci && npm run build'

# 安装依赖
added 200 packages in 15s

# 构建 TypeScript
> rabbit-ai-backend@0.1.0 build
> tsc -p tsconfig.json

# 构建成功
✓ TypeScript compilation complete

==> Build successful!

==> Starting server...
==> Running 'npm run start'

> rabbit-ai-backend@0.1.0 start
> node dist/index.js

[启动] Rabbit AI Backend Server
[启动] ✅ Connected to Supabase
[启动] ✅ Server running on port 10000
```

---

## ❌ 如果仍然失败

### 方案A: 修改 package.json（推荐）

如果 Render 构建仍然失败，可以修改 `package.json` 的 `start` 脚本，添加构建步骤：

```json
{
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "start": "npm run build && node dist/index.js",
    "start:prod": "node dist/index.js"
  }
}
```

然后在 Render 设置：
- **Build Command**: `npm ci`
- **Start Command**: `npm run start`

### 方案B: 使用预构建脚本

添加 `postinstall` 脚本自动构建：

```json
{
  "scripts": {
    "postinstall": "npm run build",
    "build": "tsc -p tsconfig.json",
    "start": "node dist/index.js"
  }
}
```

Render 设置：
- **Build Command**: `npm ci`
- **Start Command**: `npm run start`

---

## 🔍 诊断步骤

### 1. 检查 TypeScript 编译是否有错误

在本地运行：
```bash
cd rabbit-ai-backend
npm run build
```

如果有错误，先修复 TypeScript 编译错误。

### 2. 检查 dist 目录是否生成

构建成功后，应该能看到：
```
rabbit-ai-backend/
  ├── dist/
  │   ├── index.js
  │   ├── api/
  │   ├── services/
  │   └── ...
```

### 3. 本地测试启动

```bash
npm run start
```

如果本地能启动，说明代码没问题，是 Render 配置问题。

---

## 🚀 快速修复（临时方案）

如果急需修复，可以临时使用以下方案：

**修改 package.json**:
```json
{
  "scripts": {
    "start": "tsc -p tsconfig.json && node dist/index.js"
  }
}
```

**Render 配置**:
- **Build Command**: `npm ci`
- **Start Command**: `npm run start`

这样每次启动都会先构建，虽然不是最优方案，但能保证服务启动。

---

## ✅ 验证修复

修复后，Render 日志应该显示：

```bash
==> Starting server...
[启动] Rabbit AI Backend Server
[启动] ✅ Connected to Supabase
[启动] ✅ Server running on port 10000
Service is live
```

然后测试 API：
```bash
curl https://你的后端域名/api/health
```

应该返回：
```json
{
  "status": "ok",
  "timestamp": "2026-01-07T..."
}
```

---

## 📝 推荐的最终配置

### Render Dashboard 配置
- **Build Command**: `npm ci && npm run build`
- **Start Command**: `npm run start`
- **Node Version**: 18 或 20 (推荐)

### package.json 配置
```json
{
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "start": "node dist/index.js",
    "dev": "tsx src/index.ts"
  }
}
```

---

## 🆘 如果问题持续

1. **检查 Render 日志**，看是否有其他错误信息
2. **检查 TypeScript 编译**，确保本地构建成功
3. **清除 Render 缓存**，重新部署
4. **联系我**，我帮你进一步诊断 💚

---

**创建时间**: 2026-01-07  
**问题**: MODULE_NOT_FOUND  
**状态**: 待修复

