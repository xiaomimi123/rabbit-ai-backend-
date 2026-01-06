# 🧪 后端 API 测试指南 - 能量配置功能

**测试日期**: 2026-01-06  
**测试目标**: 验证能量配置动态调整功能  
**当前状态**: ⚠️ 需要配置环境变量

---

## 📋 测试前准备

### 步骤 1: 配置环境变量

后端服务需要 `.env` 文件。请按照以下步骤操作：

#### 方法 A: 获取 Supabase 凭证（推荐）

1. 打开 Supabase Dashboard: https://supabase.com/dashboard/project/ejbdlxhphonydibcenrv
2. 点击左侧菜单 "Project Settings" → "API"
3. 找到以下信息：
   - **Project URL**: `https://ejbdlxhphonydibcenrv.supabase.co`
   - **service_role (secret)**: 点击右侧眼睛图标显示完整key

#### 方法 B: 使用现有配置（如果已经部署过）

如果后端已经在生产环境运行，你可以从那里复制 `.env` 文件。

---

### 步骤 2: 创建 .env 文件

在 `rabbit-ai-backend/` 目录下创建 `.env` 文件，最小配置如下：

```bash
# 必需配置
PORT=8080
NODE_ENV=development

# Supabase（从 Dashboard 获取）
SUPABASE_URL=https://ejbdlxhphonydibcenrv.supabase.co
SUPABASE_SERVICE_ROLE_KEY=<从 Supabase Dashboard 复制>

# BSC RPC（使用公共节点测试）
BSC_RPC_URLS=https://bsc-dataseed1.binance.org/,https://bsc-dataseed2.binance.org/

# 智能合约地址（从现有配置复制）
AIRDROP_CONTRACT=0x16B7a2e6eD9a0Ace9495b80eF0A5D0e3f72aCD7c
RAT_TOKEN_CONTRACT=0x03853d1B9a6DEeCE10ADf0EE20D836f06aFca47B
USDT_CONTRACT=0x55d398326f99059fF775485246999027B3197955

# 管理员配置
ADMIN_API_KEY=test-admin-key-123456

# 可选配置
LOG_LEVEL=info
CORS_ORIGINS=*
```

---

### 步骤 3: 启动后端服务

```bash
cd rabbit-ai-backend
npm run build    # 编译 TypeScript
npm start        # 启动服务
```

**预期输出**:
```
[startup] ✅ Server listening on http://localhost:8080
[startup] ✅ Swagger API documentation available at /docs
```

---

## 🧪 API 测试计划

### 测试 1: 获取能量配置

**请求**:
```bash
curl -X GET http://localhost:8080/api/admin/energy-config \
  -H "Authorization: Bearer test-admin-key-123456"
```

**预期响应** (HTTP 200):
```json
{
  "ok": true,
  "configs": [
    {
      "key": "claim_referrer_first",
      "value": 3,
      "description": "推荐人首次邀请获得的能量（1管道+2首邀）",
      "updatedAt": "2026-01-06T..."
    },
    {
      "key": "claim_referrer_repeat",
      "value": 1,
      "description": "推荐人非首次邀请获得的能量（仅管道）",
      "updatedAt": "2026-01-06T..."
    },
    {
      "key": "claim_self_reward",
      "value": 1,
      "description": "用户领取空投自己获得的能量",
      "updatedAt": "2026-01-06T..."
    },
    {
      "key": "withdraw_energy_ratio",
      "value": 10,
      "description": "提现能量消耗比例：1 USDT = N Energy",
      "updatedAt": "2026-01-06T..."
    }
  ]
}
```

---

### 测试 2: 更新能量配置

**请求**:
```bash
curl -X POST http://localhost:8080/api/admin/energy-config/update \
  -H "Authorization: Bearer test-admin-key-123456" \
  -H "Content-Type: application/json" \
  -d '{
    "key": "withdraw_energy_ratio",
    "value": 15,
    "reason": "测试动态配置"
  }'
```

**预期响应** (HTTP 200):
```json
{
  "ok": true,
  "oldValue": 10,
  "newValue": 15,
  "message": "配置已更新: withdraw_energy_ratio = 15"
}
```

---

### 测试 3: 验证配置已更新

**请求**:
```bash
curl -X GET http://localhost:8080/api/admin/energy-config \
  -H "Authorization: Bearer test-admin-key-123456"
```

**验证点**:
- `withdraw_energy_ratio` 的值应该是 `15`（已更新）
- 其他配置值保持不变

---

### 测试 4: 查看配置历史

**请求**:
```bash
curl -X GET "http://localhost:8080/api/admin/energy-config/history?limit=10" \
  -H "Authorization: Bearer test-admin-key-123456"
```

**预期响应** (HTTP 200):
```json
{
  "ok": true,
  "history": [
    {
      "id": "uuid...",
      "key": "withdraw_energy_ratio",
      "oldValue": 10,
      "newValue": 15,
      "changedBy": "admin",
      "changeReason": "测试动态配置",
      "createdAt": "2026-01-06T..."
    }
  ]
}
```

---

### 测试 5: 清除配置缓存

**请求**:
```bash
curl -X POST http://localhost:8080/api/admin/energy-config/clear-cache \
  -H "Authorization: Bearer test-admin-key-123456"
```

**预期响应** (HTTP 200):
```json
{
  "ok": true,
  "message": "配置缓存已清除"
}
```

---

### 测试 6: 验证权限控制

**请求**（不带 Token）:
```bash
curl -X GET http://localhost:8080/api/admin/energy-config
```

**预期响应** (HTTP 401):
```json
{
  "ok": false,
  "code": "UNAUTHORIZED",
  "message": "Admin key required"
}
```

---

### 测试 7: 验证数据验证

**请求**（无效值）:
```bash
curl -X POST http://localhost:8080/api/admin/energy-config/update \
  -H "Authorization: Bearer test-admin-key-123456" \
  -H "Content-Type: application/json" \
  -d '{
    "key": "withdraw_energy_ratio",
    "value": -5
  }'
```

**预期响应** (HTTP 400):
```json
{
  "ok": false,
  "code": "INVALID_REQUEST",
  "message": "提现能量比例必须在 1-100 之间"
}
```

---

## 🔍 业务逻辑验证

### 验证 1: 提现能量扣除

**步骤**:
1. 将 `withdraw_energy_ratio` 设置为 `20`
2. 查看后端日志
3. 模拟用户提现 `1 USDT`

**预期日志**:
```
[applyWithdraw] 🔋 提现 1 USDT 需要 20 Energy (比例: 20)
```

**验证方法**:
```sql
-- 在 Supabase SQL Editor 执行
SELECT energy_total, energy_locked 
FROM users 
WHERE address = '0x用户地址'
LIMIT 1;
```

**预期**: `energy_locked` 增加了 `20`

---

### 验证 2: 领取空投能量奖励

**步骤**:
1. 将能量奖励配置修改为：
   - `claim_self_reward = 2`
   - `claim_referrer_first = 5`
   - `claim_referrer_repeat = 2`
2. 模拟新用户领取空投（有推荐人）
3. 查看后端日志

**预期日志**:
```
[verifyClaim] ⚡ 使用动态能量配置: { claimSelfReward: 2, claimReferrerFirst: 5, claimReferrerRepeat: 2 }
[process_claim_energy] 用户 0x... 获得能量: 2
[process_claim_energy] 推荐人 0x... 首次邀请，获得能量: 5
```

**验证方法**:
```sql
-- 查询能量值变化
SELECT 
  address,
  energy_total,
  invite_count
FROM users
WHERE address IN ('0x用户地址', '0x推荐人地址');
```

**预期**:
- 用户 `energy_total` 增加 `2`
- 推荐人 `energy_total` 增加 `5`（首次）或 `2`（非首次）
- 推荐人 `invite_count` 增加 `1`（首次）

---

## ✅ 测试检查清单

### 数据库层
- [ ] `energy_config` 表存在且有6条记录
- [ ] `energy_config_history` 表存在
- [ ] `process_claim_energy` 函数支持动态参数

### API 层
- [ ] GET `/api/admin/energy-config` 正常返回
- [ ] POST `/api/admin/energy-config/update` 正常更新
- [ ] GET `/api/admin/energy-config/history` 正常返回
- [ ] POST `/api/admin/energy-config/clear-cache` 正常执行
- [ ] 权限验证正常工作（无Token返回401）
- [ ] 数据验证正常工作（无效值返回400）

### 业务逻辑层
- [ ] 提现使用动态配置计算能量消耗
- [ ] 领取空投使用动态配置计算能量奖励
- [ ] 日志输出显示正确的配置值
- [ ] 数据库记录的能量值符合配置

### 缓存机制
- [ ] 配置修改后60秒内返回缓存值
- [ ] 清除缓存后立即生效
- [ ] 缓存不影响配置更新

---

## 🎯 快速测试脚本

创建文件 `rabbit-ai-backend/test-energy-config.sh`：

```bash
#!/bin/bash

# 配置
API_BASE="http://localhost:8080"
ADMIN_TOKEN="test-admin-key-123456"

echo "🧪 开始测试能量配置 API..."
echo ""

# 测试 1: 获取配置
echo "1️⃣ 测试获取配置..."
curl -s -X GET "$API_BASE/api/admin/energy-config" \
  -H "Authorization: Bearer $ADMIN_TOKEN" | jq .
echo ""

# 测试 2: 更新配置
echo "2️⃣ 测试更新配置..."
curl -s -X POST "$API_BASE/api/admin/energy-config/update" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"key":"withdraw_energy_ratio","value":15,"reason":"自动化测试"}' | jq .
echo ""

# 测试 3: 验证更新
echo "3️⃣ 验证配置已更新..."
curl -s -X GET "$API_BASE/api/admin/energy-config" \
  -H "Authorization: Bearer $ADMIN_TOKEN" | jq '.configs[] | select(.key=="withdraw_energy_ratio")'
echo ""

# 测试 4: 查看历史
echo "4️⃣ 查看配置历史..."
curl -s -X GET "$API_BASE/api/admin/energy-config/history?limit=5" \
  -H "Authorization: Bearer $ADMIN_TOKEN" | jq .
echo ""

# 测试 5: 清除缓存
echo "5️⃣ 清除配置缓存..."
curl -s -X POST "$API_BASE/api/admin/energy-config/clear-cache" \
  -H "Authorization: Bearer $ADMIN_TOKEN" | jq .
echo ""

echo "✅ 测试完成！"
```

运行测试：
```bash
chmod +x test-energy-config.sh
./test-energy-config.sh
```

---

## 🚨 常见问题

### Q1: 服务启动失败 - Missing env: SUPABASE_URL
**解决**: 请按照"步骤1: 配置环境变量"创建 `.env` 文件

### Q2: API 返回 401 Unauthorized
**解决**: 检查 Authorization header 是否正确，Token 需要匹配 `.env` 中的 `ADMIN_API_KEY`

### Q3: 配置更新后没有生效
**解决**: 
1. 检查后端日志是否有错误
2. 等待60秒（缓存过期）
3. 或者调用清除缓存 API

### Q4: 数据库连接失败
**解决**: 检查 `SUPABASE_URL` 和 `SUPABASE_SERVICE_ROLE_KEY` 是否正确

---

## 📝 下一步

测试完成后：
1. ✅ 标记 TODO "测试后端 API 接口" 为完成
2. 📋 继续前端实施（补充 API 调用函数）
3. 📋 添加路由和菜单
4. 📋 测试前端页面

---

**文档创建时间**: 2026-01-06  
**状态**: 等待环境配置  
**下一步**: 配置 `.env` 文件并启动服务

