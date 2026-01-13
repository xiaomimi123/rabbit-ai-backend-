# 🚨 紧急修复 - curl 命令

**2个交易哈希**：
1. `0xc2a961b00b39d8b779f23286617f699d2d4a7fa87f9d5b5e2a0f9c4d77b4cab0`
2. `0x1b38954d8c02c16702bf9d4cf513e95bd4e4d4ad872614fdd53c0f473a9c6c37`

---

## 方法1: 使用 curl (推荐 - 跨平台)

### 第一步：设置后端 URL

```bash
# 请替换为您的实际后端域名
BACKEND_URL="https://rabbit-ai-backend.onrender.com"
```

### 第二步：处理第一个交易

```bash
curl -X POST ${BACKEND_URL}/api/admin/indexer/manual-index \
  -H "Content-Type: application/json" \
  -d '{"txHash": "0xc2a961b00b39d8b779f23286617f699d2d4a7fa87f9d5b5e2a0f9c4d77b4cab0"}'
```

### 第三步：等待2秒，然后处理第二个交易

```bash
sleep 2

curl -X POST ${BACKEND_URL}/api/admin/indexer/manual-index \
  -H "Content-Type: application/json" \
  -d '{"txHash": "0x1b38954d8c02c16702bf9d4cf513e95bd4e4d4ad872614fdd53c0f473a9c6c37"}'
```

---

## 方法2: 使用 PowerShell (Windows)

### 交易 1:

```powershell
$BACKEND_URL = "https://rabbit-ai-backend-latest.onrender.com"

Invoke-RestMethod -Uri "$BACKEND_URL/api/admin/indexer/manual-index" `
  -Method Post `
  -Body '{"txHash": "0xc2a961b00b39d8b779f23286617f699d2d4a7fa87f9d5b5e2a0f9c4d77b4cab0"}' `
  -ContentType "application/json"
```

### 交易 2 (等待2秒后):

```powershell
Start-Sleep -Seconds 2

Invoke-RestMethod -Uri "$BACKEND_URL/api/admin/indexer/manual-index" `
  -Method Post `
  -Body '{"txHash": "0x1b38954d8c02c16702bf9d4cf513e95bd4e4d4ad872614fdd53c0f473a9c6c37"}' `
  -ContentType "application/json"
```

---

## 方法3: 使用 Postman / Insomnia

### 请求配置

- **Method**: POST
- **URL**: `https://你的后端域名.onrender.com/api/admin/indexer/manual-index`
- **Headers**: 
  - `Content-Type`: `application/json`

### 请求 1 Body (JSON):

```json
{
  "txHash": "0xc2a961b00b39d8b779f23286617f699d2d4a7fa87f9d5b5e2a0f9c4d77b4cab0"
}
```

### 请求 2 Body (JSON):

```json
{
  "txHash": "0x1b38954d8c02c16702bf9d4cf513e95bd4e4d4ad872614fdd53c0f473a9c6c37"
}
```

---

## 验证修复效果

修复完成后，在 **Supabase Dashboard** 中运行以下 SQL：

```sql
-- 检查用户能量是否更新
SELECT 
  address,
  energy_total,
  ROUND(CAST(rat_balance_wei AS NUMERIC) / 1e18, 2) AS rat_balance,
  updated_at
FROM users
WHERE LOWER(address) IN (
  LOWER('0xf0dfddd1d74138280916d86702f3c1c66171045b'),
  LOWER('0xe8c903de963a446c661071251762d328420ccd19')
)
ORDER BY address;

-- 检查 claims 记录是否创建
SELECT 
  tx_hash,
  address,
  ROUND(CAST(amount_wei AS NUMERIC) / 1e18, 2) AS amount_rat,
  block_number,
  block_time,
  created_at
FROM claims
WHERE LOWER(tx_hash) IN (
  LOWER('0xc2a961b00b39d8b779f23286617f699d2d4a7fa87f9d5b5e2a0f9c4d77b4cab0'),
  LOWER('0x1b38954d8c02c16702bf9d4cf513e95bd4e4d4ad872614fdd53c0f473a9c6c37')
)
ORDER BY block_number;
```

---

## 预期结果

### 修复前：
- 用户 `energy_total` = **0** ❌
- 数据库无 `claims` 记录 ❌

### 修复后：
- 用户 `energy_total` > **0** ✅
- 数据库有 `claims` 记录 ✅

---

## 故障排查

### 如果收到错误响应：

1. **404 Not Found**: 检查后端 URL 是否正确
2. **500 Internal Server Error**: 查看错误消息，可能是：
   - RPC 节点问题
   - 交易哈希无效
   - 数据库 RPC 函数内部错误

3. **如果返回 `{status: 'error'}`**: 
   - 这次会正确显示错误信息（我们刚修复了这个 bug！）
   - 将错误消息告诉我，我会提供进一步解决方案

---

## 注意事项

⚠️ **请确保使用正确的后端域名**！

常见的后端域名格式：
- `https://rabbit-ai-backend.onrender.com`
- `https://rabbit-ai-backend-latest.onrender.com`
- `https://你的项目名.onrender.com`

如果不确定，请在 Render Dashboard 中查看您的后端服务 URL。

