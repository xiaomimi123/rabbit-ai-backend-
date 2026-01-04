# MaxMind GeoLite2 离线数据库集成指南

## 📋 概述

MaxMind GeoLite2 是免费的 IP 地理位置数据库，可以完全替代在线 API，避免速率限制问题。

**优势**：
- ✅ 完全免费（需要注册账号）
- ✅ 无速率限制
- ✅ 本地查询，速度快
- ✅ 数据准确度高
- ✅ 可离线使用

**劣势**：
- ⚠️ 需要定期更新数据库文件（每周更新）
- ⚠️ 数据库文件较大（约 50-100 MB）
- ⚠️ 需要注册 MaxMind 账号获取下载链接

---

## 🚀 快速开始

### 步骤 1: 注册 MaxMind 账号

1. 访问 https://www.maxmind.com/en/geolite2/signup
2. 注册免费账号
3. 登录后，访问 https://www.maxmind.com/en/accounts/current/license-key
4. 创建 License Key（用于自动下载数据库）

### 步骤 2: 安装依赖

```bash
cd rabbit-ai-backend
npm install maxmind
npm install --save-dev @types/maxmind
```

### 步骤 3: 下载数据库文件

**方式 A: 手动下载（推荐首次使用）**

1. 访问 https://www.maxmind.com/en/accounts/current/geoip/downloads
2. 下载 `GeoLite2-City.mmdb`（包含国家和城市信息）
3. 将文件保存到 `rabbit-ai-backend/data/GeoLite2-City.mmdb`

**方式 B: 自动下载（推荐生产环境）**

使用提供的脚本自动下载和更新数据库（见下方"自动更新脚本"部分）

### 步骤 4: 配置环境变量

在 `.env` 文件中添加：

```env
# MaxMind GeoLite2 配置
MAXMIND_LICENSE_KEY=your_license_key_here
MAXMIND_DB_PATH=./data/GeoLite2-City.mmdb
# 可选：是否启用自动更新（每周更新一次）
MAXMIND_AUTO_UPDATE=true
```

### 步骤 5: 修改代码

代码已自动集成，只需确保：
1. 数据库文件存在
2. 环境变量配置正确

---

## 📁 目录结构

```
rabbit-ai-backend/
├── data/
│   └── GeoLite2-City.mmdb          # GeoLite2 数据库文件
├── scripts/
│   └── update-geolite2.ts          # 自动更新数据库脚本
├── src/
│   └── services/
│       └── analytics.ts            # 已集成 GeoLite2
└── .env                             # 环境变量配置
```

---

## 🔧 实现细节

### 1. 代码集成

`analytics.ts` 已修改为：
- 优先使用 GeoLite2 离线数据库
- 如果数据库文件不存在，降级到在线 API
- 查询结果仍会保存到 `ip_geo_cache` 表（用于缓存）

### 2. 自动更新脚本

`scripts/update-geolite2.ts` 脚本功能：
- 每周自动下载最新的 GeoLite2 数据库
- 下载前检查文件是否已是最新版本
- 支持手动触发更新

### 3. 数据库文件管理

- 数据库文件存储在 `data/` 目录
- 建议添加到 `.gitignore`（文件较大，不需要版本控制）
- 生产环境通过脚本自动下载

---

## 📝 使用说明

### 手动更新数据库

```bash
# 使用 npm script
npm run update-geolite2

# 或直接运行
npx tsx scripts/update-geolite2.ts
```

### 检查数据库文件

```bash
# 检查文件是否存在
ls -lh data/GeoLite2-City.mmdb

# 检查文件大小（应该约 50-100 MB）
du -h data/GeoLite2-City.mmdb
```

### 验证集成

1. 启动后端服务
2. 访问前端页面，触发访问统计
3. 检查日志，应该看到：
   ```
   [Analytics] ✅ Using GeoLite2 database for IP xxx.xxx.xxx.xxx
   ```

---

## ⚙️ 环境变量说明

| 变量名 | 说明 | 必需 | 默认值 |
|--------|------|------|--------|
| `MAXMIND_LICENSE_KEY` | MaxMind License Key | 是 | - |
| `MAXMIND_DB_PATH` | 数据库文件路径 | 否 | `./data/GeoLite2-City.mmdb` |
| `MAXMIND_AUTO_UPDATE` | 是否启用自动更新 | 否 | `false` |

---

## 🔄 自动更新机制

### 方式 1: 使用 cron 任务（推荐）

在服务器上设置每周更新一次：

```bash
# 编辑 crontab
crontab -e

# 添加以下行（每周一凌晨 2 点更新）
0 2 * * 1 cd /path/to/rabbit-ai-backend && npm run update-geolite2
```

### 方式 2: 使用 Node.js 定时任务

在 `index.ts` 中添加：

```typescript
// 每周更新一次 GeoLite2 数据库
if (config.maxmindAutoUpdate) {
  setInterval(async () => {
    try {
      const { updateGeoLite2Database } = await import('./scripts/update-geolite2.js');
      await updateGeoLite2Database();
    } catch (e) {
      console.error('[GeoLite2] Auto-update failed:', e);
    }
  }, 7 * 24 * 60 * 60 * 1000); // 7 天
}
```

---

## 🐛 故障排查

### 问题 1: 数据库文件不存在

**症状**：日志显示 `GeoLite2 database not found, falling back to API`

**解决**：
1. 检查 `MAXMIND_DB_PATH` 环境变量
2. 确保数据库文件存在
3. 运行 `npm run update-geolite2` 下载数据库

### 问题 2: License Key 无效

**症状**：下载脚本报错 `Invalid license key`

**解决**：
1. 检查 `MAXMIND_LICENSE_KEY` 环境变量
2. 登录 MaxMind 账号，确认 License Key 正确
3. 重新生成 License Key（如果过期）

### 问题 3: 查询结果不准确

**症状**：IP 地理位置信息错误

**解决**：
1. 更新数据库文件（可能数据过期）
2. 检查 IP 地址是否正确（IPv4 vs IPv6）
3. 某些 IP 可能确实无法定位（如 VPN、代理）

---

## 📊 性能对比

| 指标 | 在线 API | GeoLite2 离线 |
|------|---------|---------------|
| 查询速度 | 200-500ms | < 1ms |
| 速率限制 | 有（每月 1000 次） | 无 |
| 网络依赖 | 是 | 否 |
| 数据准确性 | 高 | 高 |
| 成本 | 免费（有限制） | 免费（无限制） |

---

## 🔐 安全建议

1. **不要提交数据库文件到 Git**
   - 添加到 `.gitignore`：
     ```
     data/GeoLite2-City.mmdb
     data/*.mmdb
     ```

2. **保护 License Key**
   - 不要提交到代码仓库
   - 使用环境变量管理
   - 定期轮换 License Key

3. **定期更新数据库**
   - 建议每周更新一次
   - 使用自动更新脚本
   - 监控更新失败情况

---

## 📚 参考资源

- MaxMind GeoLite2 官网：https://dev.maxmind.com/geoip/geoip2/geolite2/
- MaxMind Node.js SDK：https://github.com/maxmind/MaxMind-DB-Reader-nodejs
- 数据库下载页面：https://www.maxmind.com/en/accounts/current/geoip/downloads

---

## ✅ 检查清单

- [ ] 注册 MaxMind 账号
- [ ] 创建 License Key
- [ ] 安装 `maxmind` 包
- [ ] 配置环境变量
- [ ] 下载数据库文件
- [ ] 验证代码集成
- [ ] 测试 IP 查询功能
- [ ] 设置自动更新（可选）
- [ ] 添加到 `.gitignore`

---

**最后更新**: 2025-01-XX  
**维护者**: Cursor AI Assistant

