# MaxMind GeoLite2 快速开始指南

## 🚀 5 步完成集成

### 步骤 1: 安装依赖

```bash
cd rabbit-ai-backend
npm install
```

这会自动安装 `maxmind` 包。

### 步骤 2: 注册 MaxMind 账号并获取 License Key

1. 访问：https://www.maxmind.com/en/geolite2/signup
2. 注册免费账号
3. 登录后访问：https://www.maxmind.com/en/accounts/current/license-key
4. 创建 License Key（复制保存）

### 步骤 3: 配置环境变量

在 `.env` 文件中添加：

```env
MAXMIND_LICENSE_KEY=你的_license_key_这里
MAXMIND_DB_PATH=./data/GeoLite2-City.mmdb
```

### 步骤 4: 下载数据库文件

**方式 A: 使用自动脚本（推荐）**

```bash
npm run update-geolite2
```

**方式 B: 手动下载**

1. 访问：https://www.maxmind.com/en/accounts/current/geoip/downloads
2. 下载 `GeoLite2-City.tar.gz`
3. 解压后，将 `GeoLite2-City.mmdb` 放到 `data/` 目录

### 步骤 5: 验证

1. 启动后端服务
2. 访问前端页面，触发访问统计
3. 检查日志，应该看到：
   ```
   [Analytics] ✅ GeoLite2 database loaded from ./data/GeoLite2-City.mmdb
   [Analytics] ✅ Using GeoLite2 database for IP xxx.xxx.xxx.xxx
   ```

## ✅ 完成！

现在你的系统已经使用离线 GeoIP 数据库，不再受 API 速率限制影响。

## 📝 后续维护

### 定期更新数据库（建议每周一次）

```bash
npm run update-geolite2
```

或设置自动更新（在 `index.ts` 中已集成，设置 `MAXMIND_AUTO_UPDATE=true` 即可）。

## 🐛 常见问题

**Q: 数据库文件在哪里？**  
A: 默认在 `rabbit-ai-backend/data/GeoLite2-City.mmdb`

**Q: 文件大小是多少？**  
A: 约 50-100 MB

**Q: 需要提交到 Git 吗？**  
A: 不需要，已添加到 `.gitignore`

**Q: 如果数据库文件不存在会怎样？**  
A: 系统会自动降级到在线 API（但会有速率限制）

**Q: 如何检查数据库是否加载成功？**  
A: 查看启动日志，应该看到 `✅ GeoLite2 database loaded`

---

**详细文档**: 查看 `MaxMind_GeoLite2集成指南.md`

