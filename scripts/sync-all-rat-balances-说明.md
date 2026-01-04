# RAT 余额全量同步脚本使用说明

## ⚠️ 重要提示

**此脚本建议在服务器上运行**，而不是在本地开发环境运行，原因：

1. **环境变量配置**：服务器上的环境变量已经正确配置，无需担心编码问题
2. **RPC 连接**：服务器上的 RPC 连接更稳定，不会受到本地网络限制
3. **数据安全**：避免在本地环境暴露生产数据库凭证

---

## 🚀 在服务器上运行（推荐）

### 方式 1: 通过 Render 控制台运行

1. 登录 Render Dashboard
2. 进入你的后端服务
3. 打开 "Shell" 或 "Logs" 标签
4. 运行以下命令：

```bash
cd /opt/render/project/src
npx tsx scripts/sync-all-rat-balances.ts
```

### 方式 2: 通过 SSH 连接服务器

```bash
# 连接到服务器
ssh your-server

# 进入项目目录
cd /path/to/rabbit-ai-backend

# 运行脚本
npx tsx scripts/sync-all-rat-balances.ts
```

---

## 💻 在本地运行（仅用于测试）

如果你必须在本地运行，请确保：

1. **环境变量已正确配置**：
   - `SUPABASE_URL`
   - `SUPABASE_SERVICE_ROLE_KEY`
   - `BSC_RPC_URLS`
   - `RAT_TOKEN_CONTRACT`

2. **设置临时环境变量**（PowerShell）：
```powershell
$env:RAT_TOKEN_CONTRACT="0x03853d1B9a6DEeCE10ADf0EE20D836f06aFca47B"
npx tsx scripts/sync-all-rat-balances.ts
```

3. **检查 `.env` 文件编码**：
   - 确保 `.env` 文件使用 UTF-8 编码
   - 避免在 `.env` 文件中使用中文注释（可能导致编码问题）

---

## 📊 脚本功能

- ✅ 查询所有用户
- ✅ 批量查询链上 RAT 余额（每批 50 个用户）
- ✅ 更新数据库中的 `rat_balance_wei` 字段
- ✅ 显示进度和统计信息
- ✅ 自动重试失败的 RPC 请求

---

## ⏱️ 预计执行时间

- **用户数量**: 取决于数据库中的用户数量
- **每批处理时间**: 约 2-5 秒（取决于 RPC 响应速度）
- **总时间**: 用户数量 ÷ 50 × 3 秒

例如：1000 个用户 ≈ 60 秒

---

## 🔍 故障排查

### 问题 1: "Cannot convert argument to a ByteString"

**原因**：环境变量中包含非 ASCII 字符（可能是中文注释）

**解决**：
1. 检查 `.env` 文件，确保没有中文注释
2. 确保 `.env` 文件使用 UTF-8 编码
3. **推荐**：在服务器上运行脚本（服务器环境变量通常不会有编码问题）

### 问题 2: "RAT_TOKEN_CONTRACT 环境变量未配置"

**解决**：
```powershell
# PowerShell
$env:RAT_TOKEN_CONTRACT="0x03853d1B9a6DEeCE10ADf0EE20D836f06aFca47B"
```

### 问题 3: "获取用户列表失败"

**原因**：Supabase 连接问题或环境变量编码问题

**解决**：
1. 检查 `SUPABASE_URL` 和 `SUPABASE_SERVICE_ROLE_KEY` 是否正确
2. 在服务器上运行脚本（避免本地环境变量编码问题）

---

## ✅ 验证同步结果

同步完成后，可以通过以下 SQL 查询验证：

```sql
-- 查看已同步的用户数量
SELECT COUNT(*) 
FROM users 
WHERE rat_balance_updated_at IS NOT NULL;

-- 查看最近同步的用户
SELECT address, rat_balance_wei, rat_balance_updated_at
FROM users
WHERE rat_balance_updated_at IS NOT NULL
ORDER BY rat_balance_updated_at DESC
LIMIT 10;
```

---

**最后更新**: 2025-01-XX

