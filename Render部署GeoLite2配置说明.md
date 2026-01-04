# Render 部署 GeoLite2 配置说明

## 📋 概述

在 Render 上部署时，GeoLite2 数据库文件不会自动存在（因为已在 `.gitignore` 中）。需要在构建时自动下载数据库文件。

---

## ✅ 必需的环境变量

在 Render Dashboard 的 **Environment** 标签页中添加以下环境变量：

### 1. `MAXMIND_LICENSE_KEY` ⚠️ **必需**

**说明**：MaxMind License Key，用于自动下载 GeoLite2 数据库

**获取方式**：
1. 访问 https://www.maxmind.com/en/geolite2/signup 注册免费账号
2. 登录后访问 https://www.maxmind.com/en/accounts/current/license-key
3. 创建 License Key（复制保存）

**示例值**：
```
MAXMIND_LICENSE_KEY=your_license_key_here_1234567890
```

---

### 2. `MAXMIND_DB_PATH` ⚠️ **可选**（建议设置）

**说明**：GeoLite2 数据库文件路径

**默认值**：`./data/GeoLite2-City.mmdb`

**建议值**：
```
MAXMIND_DB_PATH=./data/GeoLite2-City.mmdb
```

**注意**：如果使用默认值，可以不设置此环境变量。

---

### 3. `MAXMIND_AUTO_UPDATE` ⚠️ **可选**

**说明**：是否启用自动更新（每周更新一次）

**默认值**：`false`

**建议值**：
```
MAXMIND_AUTO_UPDATE=false
```

**注意**：如果设置为 `true`，服务启动后会自动更新数据库（需要 License Key）。

---

## 🔧 构建命令配置

在 Render Dashboard 的 **Settings** 标签页中，修改 **Build Command**：

### 当前构建命令（需要修改）

```
npm install --include=dev && npm run build
```

### 修改后的构建命令（推荐）

```
npm install --include=dev && npm run build && npm run update-geolite2 || true
```

**说明**：
- `npm run update-geolite2`：自动下载 GeoLite2 数据库
- `|| true`：即使下载失败也不影响构建（避免构建失败）

### 或者（更安全的方式）

```
npm install --include=dev && npm run build && (npm run update-geolite2 || echo "Warning: GeoLite2 download failed, but build continues")
```

---

## 📝 完整配置步骤

### 步骤 1: 添加环境变量

在 Render Dashboard → Your Service → Environment：

1. 点击 **Add Environment Variable**
2. 添加 `MAXMIND_LICENSE_KEY`，值为你的 License Key
3. （可选）添加 `MAXMIND_DB_PATH`，值为 `./data/GeoLite2-City.mmdb`
4. （可选）添加 `MAXMIND_AUTO_UPDATE`，值为 `false`

### 步骤 2: 修改构建命令

在 Render Dashboard → Your Service → Settings：

1. 找到 **Build Command**
2. 修改为：
   ```
   npm install --include=dev && npm run build && npm run update-geolite2 || true
   ```
3. 保存更改

### 步骤 3: 重新部署

1. 点击 **Manual Deploy** → **Deploy latest commit**
2. 等待构建完成
3. 检查构建日志，应该看到：
   ```
   🚀 Starting GeoLite2 database update...
   📥 Downloading GeoLite2-City database...
   ✅ Download completed
   📦 Extracting archive...
   ✅ Extraction completed
   ✅ Database updated: ./data/GeoLite2-City.mmdb
   📊 Database size: 60.xx MB
   🎉 GeoLite2 database update completed successfully!
   ```

### 步骤 4: 验证服务启动

检查服务日志，应该看到：
```
[Analytics] ✅ GeoLite2 database loaded successfully from ./data/GeoLite2-City.mmdb
```

---

## ⚠️ 注意事项

### 1. 数据库文件存储

- Render 的磁盘是**临时的**，每次重新部署都会清空
- 因此需要在**每次构建时**下载数据库文件
- 数据库文件大小约 60 MB，下载时间约 10-30 秒

### 2. 构建时间

- 添加数据库下载后，构建时间会增加约 10-30 秒
- 这是正常的，因为需要下载和解压数据库文件

### 3. License Key 安全

- ⚠️ **不要**将 License Key 提交到 Git 仓库
- ⚠️ **只**在 Render Dashboard 的环境变量中设置
- ⚠️ License Key 泄露可能导致数据库下载额度被滥用

### 4. 下载失败处理

- 如果下载失败（网络问题、License Key 无效等），构建会继续（因为使用了 `|| true`）
- 服务启动时会记录错误日志：
  ```
  [Analytics] ❌ GeoLite2 database not found at ./data/GeoLite2-City.mmdb
  ```
- 此时 IP 地理位置查询会返回空值（不影响主流程）

---

## 🔍 故障排查

### 问题 1: 构建时下载失败

**症状**：构建日志显示 `Failed to update GeoLite2 database`

**可能原因**：
1. `MAXMIND_LICENSE_KEY` 未设置或无效
2. 网络问题（Render 无法访问 MaxMind 服务器）
3. 磁盘空间不足

**解决方法**：
1. 检查 `MAXMIND_LICENSE_KEY` 是否正确设置
2. 验证 License Key 是否有效（登录 MaxMind 账号检查）
3. 检查构建日志中的详细错误信息

### 问题 2: 服务启动时数据库未加载

**症状**：日志显示 `GeoLite2 database not found`

**可能原因**：
1. 构建时下载失败
2. 数据库文件路径不正确
3. 文件权限问题

**解决方法**：
1. 检查构建日志，确认数据库是否成功下载
2. 验证 `MAXMIND_DB_PATH` 环境变量是否正确
3. 检查服务日志中的完整错误信息

### 问题 3: 查询失败

**症状**：IP 地理位置查询返回空值

**可能原因**：
1. 数据库文件损坏
2. IP 地址不在数据库中（某些 IP 可能无法定位）
3. 数据库版本过旧

**解决方法**：
1. 重新部署（会重新下载数据库）
2. 检查日志中的错误信息
3. 验证 IP 地址格式是否正确

---

## 📊 环境变量总结

| 变量名 | 必需 | 默认值 | 说明 |
|--------|------|--------|------|
| `MAXMIND_LICENSE_KEY` | ✅ 是 | - | MaxMind License Key（用于下载数据库） |
| `MAXMIND_DB_PATH` | ❌ 否 | `./data/GeoLite2-City.mmdb` | 数据库文件路径 |
| `MAXMIND_AUTO_UPDATE` | ❌ 否 | `false` | 是否启用自动更新 |

---

## ✅ 检查清单

部署前确认：

- [ ] 已注册 MaxMind 账号
- [ ] 已创建 License Key
- [ ] 已在 Render 添加 `MAXMIND_LICENSE_KEY` 环境变量
- [ ] 已修改构建命令，包含 `npm run update-geolite2`
- [ ] 已重新部署服务
- [ ] 构建日志显示数据库下载成功
- [ ] 服务日志显示数据库加载成功

---

## 🚀 快速配置模板

### Render 环境变量配置

```
MAXMIND_LICENSE_KEY=your_license_key_here
MAXMIND_DB_PATH=./data/GeoLite2-City.mmdb
MAXMIND_AUTO_UPDATE=false
```

### Render 构建命令

```
npm install --include=dev && npm run build && npm run update-geolite2 || true
```

---

**最后更新**: 2025-01-XX  
**维护者**: Cursor AI Assistant

