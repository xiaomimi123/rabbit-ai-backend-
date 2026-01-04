# BSC RPC 使用率监控功能技术需求文档

## 📋 功能概述

在后端管理页面添加 BSC RPC URL 使用率监控功能，帮助管理员：
1. 实时查看各 RPC 节点的使用情况
2. 监控 RPC 节点的健康状态
3. 配置和更换 RPC 连接
4. 设置续费提醒

---

## 🔍 现有 RPC 使用情况分析

### 当前实现
- **RPC 配置**: 通过环境变量 `BSC_RPC_URLS`（逗号分隔的多个 URL）
- **RPC 池**: 使用 `RpcPool` 类管理多个 RPC 提供者（`src/infra/rpcPool.ts`）
- **轮询机制**: 当前实现简单的轮询切换（`rotate()` 方法）
- **错误处理**: 有超时保护（8-10秒），在 indexer 中错误时切换 RPC
- **使用位置**: 
  - `src/index.ts`: 创建 RpcPool，提供 `getProvider()` 函数
  - `src/api/routes/*.ts`: 各个路由通过 `deps.getProvider()` 获取 RPC
  - `src/services/*.ts`: 服务层直接使用传入的 `provider` 参数

### 需要改进的地方
- ❌ 没有使用率统计（不知道哪个 RPC 用了多少次）
- ❌ 没有节点健康状态监控（不知道哪个 RPC 是否正常）
- ❌ 没有续费提醒功能（不知道什么时候到期）
- ❌ 无法在管理页面配置 RPC 节点（需要修改环境变量并重启）
- ❌ 没有智能负载均衡（只是简单轮询）

---

## 🎯 功能需求

### 1. RPC 使用率统计

#### 1.1 实时使用率
- **请求总数**: 每个 RPC 节点的总请求数
- **成功请求数**: 成功响应的请求数
- **失败请求数**: 失败的请求数（超时、错误等）
- **成功率**: 成功请求数 / 总请求数
- **平均响应时间**: 每个 RPC 节点的平均响应时间
- **当前使用率**: 当前时间段内的请求频率

#### 1.2 历史统计
- **按时间段统计**: 每小时、每天、每周的使用情况
- **峰值时间**: 识别使用高峰期
- **趋势分析**: 使用率变化趋势

#### 1.3 错误统计
- **错误类型**: 超时、网络错误、速率限制等
- **错误频率**: 每种错误的出现频率
- **最后错误时间**: 最后一次错误的时间

---

### 2. RPC 节点管理

#### 2.1 节点列表
- **节点信息**: URL、名称、类型（付费/免费）、状态（启用/禁用）
- **使用优先级**: 设置节点的使用优先级
- **自动切换**: 节点失败时自动切换到备用节点

#### 2.2 节点配置
- **添加节点**: 添加新的 RPC URL
- **编辑节点**: 修改节点信息（URL、名称等）
- **删除节点**: 删除不再使用的节点
- **启用/禁用**: 临时禁用某个节点

#### 2.3 节点测试
- **连接测试**: 测试节点是否可用
- **性能测试**: 测试节点的响应时间
- **速率限制测试**: 测试节点的速率限制

---

### 3. 续费提醒

#### 3.1 提醒配置
- **续费日期**: 设置每个付费节点的续费日期
- **提醒时间**: 提前多少天提醒（如：提前 7 天）
- **提醒方式**: 邮件、系统通知等

#### 3.2 提醒显示
- **仪表盘显示**: 在管理后台首页显示即将到期的节点
- **列表显示**: 在 RPC 管理页面显示所有节点的续费状态
- **警告提示**: 过期或即将过期的节点显示警告

---

## 🏗️ 技术实现方案

### 方案 A: 轻量级实现（推荐）⭐

#### 实现方式
1. **内存统计**: 使用内存存储 RPC 使用统计（重启后重置）
2. **简单数据库表**: 存储 RPC 节点配置和续费信息
3. **中间件拦截**: 在 RPC 调用前后记录统计信息

#### 优点
- ✅ 实现简单，开发快速
- ✅ 性能影响小
- ✅ 不需要额外的存储服务

#### 缺点
- ⚠️ 统计数据在服务重启后会丢失
- ⚠️ 无法查看长期历史数据

#### 实现难度: ⭐⭐ (中等)

---

### 方案 B: 完整实现

#### 实现方式
1. **数据库表**: 创建 `rpc_usage_logs` 表记录每次 RPC 调用
2. **统计聚合**: 定期聚合统计数据
3. **缓存优化**: 使用 Redis 缓存统计数据

#### 优点
- ✅ 数据持久化，可查看历史
- ✅ 支持复杂查询和分析
- ✅ 可扩展性强

#### 缺点
- ⚠️ 实现复杂，开发时间长
- ⚠️ 需要额外的数据库存储
- ⚠️ 可能影响性能（大量日志写入）

#### 实现难度: ⭐⭐⭐⭐ (较难)

---

### 方案 C: 混合方案（推荐用于生产环境）⭐

#### 实现方式
1. **实时统计**: 使用内存存储（方案 A）
2. **关键数据持久化**: 只记录关键事件（错误、超时等）
3. **定期聚合**: 每小时聚合一次统计数据到数据库

#### 优点
- ✅ 平衡性能和功能
- ✅ 保留关键历史数据
- ✅ 性能影响可控

#### 缺点
- ⚠️ 实现复杂度中等

#### 实现难度: ⭐⭐⭐ (中等偏难)

---

## 📊 数据库设计

### 表 1: `rpc_nodes` (RPC 节点配置)

```sql
CREATE TABLE rpc_nodes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  url TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'free', -- 'free' | 'paid'
  priority INTEGER NOT NULL DEFAULT 0, -- 优先级（数字越小优先级越高）
  is_enabled BOOLEAN NOT NULL DEFAULT true,
  renewal_date DATE, -- 续费日期（仅付费节点）
  reminder_days INTEGER DEFAULT 7, -- 提前提醒天数
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_rpc_nodes_enabled ON rpc_nodes(is_enabled, priority);
```

### 表 2: `rpc_usage_stats` (RPC 使用统计 - 可选)

```sql
CREATE TABLE rpc_usage_stats (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  node_id UUID NOT NULL REFERENCES rpc_nodes(id),
  hour TIMESTAMPTZ NOT NULL, -- 统计的小时
  total_requests INTEGER NOT NULL DEFAULT 0,
  success_requests INTEGER NOT NULL DEFAULT 0,
  failed_requests INTEGER NOT NULL DEFAULT 0,
  timeout_requests INTEGER NOT NULL DEFAULT 0,
  avg_response_time_ms INTEGER, -- 平均响应时间（毫秒）
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(node_id, hour)
);

CREATE INDEX idx_rpc_usage_stats_node_hour ON rpc_usage_stats(node_id, hour DESC);
```

### 表 3: `rpc_errors` (RPC 错误记录 - 可选)

```sql
CREATE TABLE rpc_errors (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  node_id UUID NOT NULL REFERENCES rpc_nodes(id),
  error_type TEXT NOT NULL, -- 'timeout' | 'network_error' | 'rate_limit' | 'other'
  error_message TEXT,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_rpc_errors_node_time ON rpc_errors(node_id, occurred_at DESC);
```

---

## 🔧 实现步骤

### 阶段 1: 基础功能（方案 A）

#### 1.1 创建 RPC 节点配置表
- 创建 `rpc_nodes` 表
- 迁移现有 RPC URL 到数据库

#### 1.2 实现 RPC 调用拦截
- 创建 RPC 调用包装器
- 记录每次调用的统计信息（内存）

#### 1.3 实现统计 API
- `GET /api/admin/rpc/stats` - 获取实时统计
- `GET /api/admin/rpc/nodes` - 获取节点列表

#### 1.4 实现管理 API
- `POST /api/admin/rpc/nodes` - 添加节点
- `PUT /api/admin/rpc/nodes/:id` - 更新节点
- `DELETE /api/admin/rpc/nodes/:id` - 删除节点
- `POST /api/admin/rpc/nodes/:id/test` - 测试节点

#### 1.5 前端页面
- RPC 管理页面
- 实时统计显示
- 节点配置表单

**预计工作量**: 2-3 天

---

### 阶段 2: 续费提醒功能

#### 2.1 续费提醒逻辑
- 检查即将到期的节点
- 生成提醒信息

#### 2.2 提醒 API
- `GET /api/admin/rpc/renewal-reminders` - 获取续费提醒

#### 2.3 前端显示
- 仪表盘显示即将到期的节点
- 续费提醒列表

**预计工作量**: 1 天

---

### 阶段 3: 数据持久化（方案 C）

#### 3.1 创建统计表
- 创建 `rpc_usage_stats` 表
- 创建 `rpc_errors` 表

#### 3.2 实现定期聚合
- 每小时聚合统计数据
- 记录错误信息

#### 3.3 历史数据查询
- `GET /api/admin/rpc/stats/history` - 获取历史统计

**预计工作量**: 2 天

---

## 📈 技术难点分析

### 难点 1: RPC 调用拦截 ⭐⭐⭐

**问题**: 需要在所有 RPC 调用处添加统计逻辑，但现有代码中 RPC 调用分散在多个地方

**现有代码结构**:
- `RpcPool` 类只负责轮询，不记录统计
- `getProvider()` 返回原始的 `JsonRpcProvider`
- 各个服务直接使用 `provider`，没有统一入口

**解决方案**:
- **方案 A（推荐）**: 创建 `RpcProviderWrapper` 类，包装 `JsonRpcProvider`，拦截所有方法调用
  ```typescript
  class RpcProviderWrapper extends ethers.providers.Provider {
    private stats: RpcStats;
    async call(...args) {
      const start = Date.now();
      try {
        const result = await this.provider.call(...args);
        this.recordSuccess(Date.now() - start);
        return result;
      } catch (error) {
        this.recordError(error);
        throw error;
      }
    }
  }
  ```
- **方案 B**: 修改 `RpcPool` 类，添加统计功能
- **方案 C**: 在 `getProvider()` 中返回包装后的 Provider

**实现难度**: ⭐⭐⭐ (中等偏难，需要仔细处理所有 RPC 方法)

---

### 难点 2: 性能影响 ⭐⭐⭐

**问题**: 统计记录可能影响 RPC 调用性能

**解决方案**:
- 使用异步记录（不阻塞主流程）
- 批量写入数据库
- 使用内存缓存减少数据库查询

**实现难度**: ⭐⭐⭐ (中等偏难)

---

### 难点 3: 多节点负载均衡 ⭐⭐⭐

**问题**: 需要实现智能的节点选择和切换

**解决方案**:
- 根据优先级和健康状态选择节点
- 失败时自动切换到备用节点
- 记录节点健康状态

**实现难度**: ⭐⭐⭐ (中等偏难)

---

### 难点 4: 实时统计更新 ⭐⭐

**问题**: 前端需要实时显示统计数据

**解决方案**:
- 使用 WebSocket 或 Server-Sent Events
- 或者前端定期轮询（简单方案）

**实现难度**: ⭐⭐ (中等)

---

## 🎨 前端界面设计

### 页面 1: RPC 节点管理

**布局**:
```
┌─────────────────────────────────────────┐
│  RPC 节点管理                           │
├─────────────────────────────────────────┤
│  [添加节点] [刷新统计]                  │
├─────────────────────────────────────────┤
│  节点列表:                               │
│  ┌──────────────────────────────────┐ │
│  │ URL | 名称 | 类型 | 状态 | 操作    │ │
│  ├──────────────────────────────────┤ │
│  │ ... | ... | 付费 | ✅ | [编辑][测试]│ │
│  └──────────────────────────────────┘ │
├─────────────────────────────────────────┤
│  实时统计:                               │
│  ┌──────────────────────────────────┐ │
│  │ 节点 | 请求数 | 成功率 | 响应时间  │ │
│  ├──────────────────────────────────┤ │
│  │ ... | 1234 | 98.5% | 245ms       │ │
│  └──────────────────────────────────┘ │
└─────────────────────────────────────────┘
```

### 页面 2: 续费提醒

**布局**:
```
┌─────────────────────────────────────────┐
│  续费提醒                                │
├─────────────────────────────────────────┤
│  ⚠️ 即将到期 (7天内):                   │
│  ┌──────────────────────────────────┐ │
│  │ 节点名称 | 到期日期 | 剩余天数     │ │
│  ├──────────────────────────────────┤ │
│  │ NodeReal | 2026-01-10 | 7 天      │ │
│  └──────────────────────────────────┘ │
└─────────────────────────────────────────┘
```

---

## 📝 API 设计

### 1. 获取 RPC 统计

```typescript
GET /api/admin/rpc/stats

Response:
{
  ok: true,
  nodes: [
    {
      id: string,
      url: string,
      name: string,
      type: 'free' | 'paid',
      stats: {
        totalRequests: number,
        successRequests: number,
        failedRequests: number,
        successRate: number, // 百分比
        avgResponseTime: number, // 毫秒
        lastErrorTime: string | null,
        lastErrorType: string | null
      }
    }
  ]
}
```

### 2. 获取节点列表

```typescript
GET /api/admin/rpc/nodes

Response:
{
  ok: true,
  nodes: [
    {
      id: string,
      url: string,
      name: string,
      type: 'free' | 'paid',
      priority: number,
      isEnabled: boolean,
      renewalDate: string | null,
      reminderDays: number
    }
  ]
}
```

### 3. 添加节点

```typescript
POST /api/admin/rpc/nodes

Body:
{
  url: string,
  name: string,
  type: 'free' | 'paid',
  priority?: number,
  renewalDate?: string, // YYYY-MM-DD
  reminderDays?: number
}

Response:
{
  ok: true,
  node: { ... }
}
```

### 4. 更新节点

```typescript
PUT /api/admin/rpc/nodes/:id

Body:
{
  url?: string,
  name?: string,
  type?: 'free' | 'paid',
  priority?: number,
  isEnabled?: boolean,
  renewalDate?: string,
  reminderDays?: number
}

Response:
{
  ok: true,
  node: { ... }
}
```

### 5. 测试节点

```typescript
POST /api/admin/rpc/nodes/:id/test

Response:
{
  ok: true,
  success: boolean,
  responseTime: number, // 毫秒
  error?: string
}
```

### 6. 获取续费提醒

```typescript
GET /api/admin/rpc/renewal-reminders

Response:
{
  ok: true,
  reminders: [
    {
      nodeId: string,
      nodeName: string,
      renewalDate: string,
      daysRemaining: number,
      status: 'expired' | 'warning' | 'normal'
    }
  ]
}
```

---

## 🔍 实现难度评估

### 总体难度: ⭐⭐⭐ (中等偏难)

### 各模块难度

| 模块 | 难度 | 说明 |
|------|------|------|
| 数据库设计 | ⭐ | 简单，标准表结构 |
| RPC 调用拦截 | ⭐⭐ | 需要重构现有 RPC 调用逻辑 |
| 统计记录 | ⭐⭐ | 需要异步记录，避免性能影响 |
| 管理 API | ⭐ | 标准的 CRUD 操作 |
| 前端页面 | ⭐⭐ | 需要实时更新统计 |
| 续费提醒 | ⭐ | 简单的日期计算和提醒逻辑 |
| 负载均衡 | ⭐⭐⭐ | 需要实现智能节点选择 |

---

## 💡 推荐实现方案

### 阶段 1: MVP（最小可行产品）

**功能**:
- ✅ RPC 节点配置管理（增删改查）
- ✅ 基础统计（内存存储，实时显示）
- ✅ 节点测试功能
- ✅ 续费提醒（基础版）

**实现时间**: 4-5 天

**技术方案**: 方案 A（轻量级实现）

**关键实现点**:
1. 创建 `RpcProviderWrapper` 包装所有 RPC 调用
2. 修改 `RpcPool` 返回包装后的 Provider
3. 在内存中维护统计信息（Map<url, Stats>）
4. 创建数据库表存储节点配置
5. 实现管理 API 和前端页面

---

### 阶段 2: 完整功能

**功能**:
- ✅ 数据持久化（历史统计）
- ✅ 错误记录和分析
- ✅ 智能负载均衡（根据健康状态和响应时间选择节点）
- ✅ 高级续费提醒（邮件通知等）

**实现时间**: 6-8 天

**技术方案**: 方案 C（混合方案）

**关键实现点**:
1. 每小时聚合统计数据到数据库
2. 记录所有错误到 `rpc_errors` 表
3. 实现智能节点选择算法（健康分数 = 成功率 × 响应时间权重）
4. 集成邮件通知服务（可选）

---

## 📋 实施检查清单

### 数据库
- [ ] 创建 `rpc_nodes` 表
- [ ] 创建 `rpc_usage_stats` 表（可选）
- [ ] 创建 `rpc_errors` 表（可选）
- [ ] 迁移现有 RPC URL 到数据库

### 后端
- [ ] 创建 RPC 包装器服务
- [ ] 实现统计记录逻辑
- [ ] 实现管理 API
- [ ] 实现续费提醒逻辑

### 前端
- [ ] RPC 管理页面
- [ ] 统计展示组件
- [ ] 节点配置表单
- [ ] 续费提醒组件

### 测试
- [ ] 单元测试
- [ ] 集成测试
- [ ] 性能测试

---

## 🎯 总结

### 推荐方案
**方案 C（混合方案）** - 平衡功能和性能

### 实现优先级
1. **P0**: RPC 节点管理、基础统计
2. **P1**: 续费提醒
3. **P2**: 数据持久化、历史统计

### 预计工作量
- **MVP**: 3-4 天
- **完整功能**: 5-7 天

### 技术难点
- RPC 调用拦截和统计记录
- 性能优化（避免影响主流程）
- 智能负载均衡

---

---

## 📊 总结

### 核心价值
1. **可视化监控**: 实时了解 RPC 使用情况，及时发现性能问题
2. **成本控制**: 通过续费提醒避免服务中断
3. **灵活配置**: 无需重启服务即可管理 RPC 节点
4. **智能优化**: 根据健康状态自动选择最佳节点

### 实现优先级
1. **P0（必须）**: RPC 节点管理、基础统计、续费提醒
2. **P1（重要）**: 数据持久化、错误记录
3. **P2（可选）**: 智能负载均衡、邮件通知

### 技术风险
- ⚠️ **RPC 包装器实现**: 需要覆盖所有 ethers.js Provider 方法
- ⚠️ **性能影响**: 统计记录不能影响主流程性能
- ⚠️ **向后兼容**: 确保现有代码无需大幅修改

### 建议实施路径
1. **第一步**: 实现 MVP（4-5 天），验证核心功能
2. **第二步**: 根据使用反馈优化（1-2 天）
3. **第三步**: 实现完整功能（6-8 天）

---

**文档生成时间**: 2026-01-03  
**建议方案**: 方案 C（混合方案）  
**实现难度**: ⭐⭐⭐ (中等偏难)  
**预计工作量**: 
- MVP: 4-5 天
- 完整功能: 6-8 天

