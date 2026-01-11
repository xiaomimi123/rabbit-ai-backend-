# ======================================================
# Rabbit AI - 生产环境自动验证脚本
# ======================================================
# 功能：
# 1. 等待Render服务唤醒
# 2. 调用API验证收益计算
# 3. 判断修复是否生效
# ======================================================

Write-Host ""
Write-Host "═══════════════════════════════════════════════════════════" -ForegroundColor Cyan
Write-Host "  🔍 Rabbit AI - 生产环境收益验证工具" -ForegroundColor White
Write-Host "═══════════════════════════════════════════════════════════" -ForegroundColor Cyan
Write-Host ""

# 配置
$TestAddress = "0x9897f1f7ee7c1c443e28a52fe80ed514cf65eefe"
$ApiBase = "https://rabbit-ai-backend.onrender.com"
$MaxRetries = 10
$RetryDelay = 10 # 秒

Write-Host "📋 配置信息:" -ForegroundColor Yellow
Write-Host "  测试用户: $TestAddress" -ForegroundColor Gray
Write-Host "  API地址: $ApiBase" -ForegroundColor Gray
Write-Host "  最大重试: $MaxRetries 次" -ForegroundColor Gray
Write-Host ""

# ======================================================
# 步骤1: 等待服务唤醒
# ======================================================

Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" -ForegroundColor DarkGray
Write-Host "步骤 1/3: 唤醒Render服务" -ForegroundColor Cyan
Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" -ForegroundColor DarkGray
Write-Host ""

$ServiceAwake = $false

for ($i = 1; $i -le $MaxRetries; $i++) {
    Write-Host "  [尝试 $i/$MaxRetries] 正在连接服务..." -ForegroundColor Yellow -NoNewline
    
    try {
        $response = Invoke-WebRequest -Uri "$ApiBase/" -Method GET -TimeoutSec 30 -ErrorAction Stop
        Write-Host " ✅ 成功" -ForegroundColor Green
        $ServiceAwake = $true
        break
    } catch {
        if ($i -lt $MaxRetries) {
            Write-Host " ⏳ 等待中..." -ForegroundColor Gray
            Write-Host "     (Render Free Plan首次请求需要15-30秒唤醒)" -ForegroundColor DarkGray
            Start-Sleep -Seconds $RetryDelay
        } else {
            Write-Host " ❌ 失败" -ForegroundColor Red
        }
    }
}

if (-not $ServiceAwake) {
    Write-Host ""
    Write-Host "❌ 错误: 无法连接到Render服务" -ForegroundColor Red
    Write-Host ""
    Write-Host "可能原因:" -ForegroundColor Yellow
    Write-Host "  1. Render服务正在部署中（需要3-5分钟）" -ForegroundColor Gray
    Write-Host "  2. 网络连接问题" -ForegroundColor Gray
    Write-Host "  3. 服务配置错误" -ForegroundColor Gray
    Write-Host ""
    Write-Host "建议操作:" -ForegroundColor Yellow
    Write-Host "  1. 访问 Render Dashboard 检查部署状态" -ForegroundColor Gray
    Write-Host "     https://dashboard.render.com/" -ForegroundColor DarkGray
    Write-Host "  2. 等待几分钟后重新运行此脚本" -ForegroundColor Gray
    Write-Host ""
    exit 1
}

Write-Host ""
Write-Host "✅ 服务已唤醒！" -ForegroundColor Green
Write-Host ""
Start-Sleep -Seconds 2

# ======================================================
# 步骤2: 调用收益API
# ======================================================

Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" -ForegroundColor DarkGray
Write-Host "步骤 2/3: 获取用户收益数据" -ForegroundColor Cyan
Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" -ForegroundColor DarkGray
Write-Host ""

$EarningsUrl = "$ApiBase/api/user/earnings?address=$TestAddress"

Write-Host "  API地址: $EarningsUrl" -ForegroundColor Gray
Write-Host "  正在请求..." -ForegroundColor Yellow

try {
    $data = Invoke-RestMethod -Uri $EarningsUrl -Method GET -TimeoutSec 30 -ErrorAction Stop
    Write-Host "  ✅ 数据获取成功！" -ForegroundColor Green
    Write-Host ""
} catch {
    Write-Host "  ❌ API调用失败！" -ForegroundColor Red
    Write-Host ""
    Write-Host "错误信息: $($_.Exception.Message)" -ForegroundColor Red
    Write-Host ""
    exit 1
}

# 显示用户数据
Write-Host "📊 用户基本信息:" -ForegroundColor Yellow
Write-Host "  钱包地址: $($TestAddress.Substring(0,6))...$($TestAddress.Substring($TestAddress.Length-4))" -ForegroundColor White
Write-Host "  RAT余额: $($data.balance.ToString('N2')) RAT" -ForegroundColor White
Write-Host "  VIP等级: VIP $($data.currentTier)" -ForegroundColor White
Write-Host "  日利率: $($data.dailyRate)%" -ForegroundColor White
Write-Host "  已过时间: $([math]::Round($data.daysElapsed, 4)) 天" -ForegroundColor White
Write-Host "  当前收益: $([double]$data.pendingUsdt) USDT" -ForegroundColor White
Write-Host ""

# ======================================================
# 步骤3: 验证计算结果
# ======================================================

Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" -ForegroundColor DarkGray
Write-Host "步骤 3/3: 验证收益计算" -ForegroundColor Cyan
Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" -ForegroundColor DarkGray
Write-Host ""

# 提取数据
$balance = $data.balance
$dailyRate = $data.dailyRate
$pendingUsdt = [double]$data.pendingUsdt
$daysElapsed = $data.daysElapsed

# 计算预期值
$RAT_PRICE = 0.01
$expectedDailyEarnings = $balance * $RAT_PRICE * ($dailyRate / 100)
$expectedEarnings = $expectedDailyEarnings * $daysElapsed
$actualDailyEarnings = $pendingUsdt / $daysElapsed

# 修复前的计算（错误）
$earningsBefore = $balance * $RAT_PRICE * ($dailyRate / 100 / 100) * $daysElapsed

Write-Host "💰 收益对比:" -ForegroundColor Yellow
Write-Host "  预期日收益: $([math]::Round($expectedDailyEarnings, 2)) USDT/天" -ForegroundColor White
Write-Host "  实际日收益: $([math]::Round($actualDailyEarnings, 2)) USDT/天" -ForegroundColor White
Write-Host ""
Write-Host "  预期累计收益: $([math]::Round($expectedEarnings, 6)) USDT" -ForegroundColor White
Write-Host "  实际累计收益: $([math]::Round($pendingUsdt, 6)) USDT" -ForegroundColor White
Write-Host ""

# 计算误差
$errorRate = [math]::Abs($actualDailyEarnings - $expectedDailyEarnings) / $expectedDailyEarnings
Write-Host "  误差率: $([math]::Round($errorRate * 100, 2))%" -ForegroundColor $(if ($errorRate -lt 0.05) { "Green" } else { "Red" })
Write-Host ""

# 修复前后对比
Write-Host "📈 修复前后对比:" -ForegroundColor Yellow
Write-Host "  修复前（错误）: $([math]::Round($earningsBefore, 6)) USDT" -ForegroundColor Red
Write-Host "  修复后（当前）: $([math]::Round($pendingUsdt, 6)) USDT" -ForegroundColor Green
Write-Host "  收益增长: $([math]::Round($pendingUsdt / $earningsBefore, 2))x" -ForegroundColor Cyan
Write-Host ""

# ======================================================
# 验证结果
# ======================================================

Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" -ForegroundColor DarkGray
Write-Host "✅ 验证结果" -ForegroundColor Cyan
Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" -ForegroundColor DarkGray
Write-Host ""

$allChecksPassed = $true
$tolerance = 0.05 # 5% 容差

# 检查1: 日利率格式
Write-Host "检查项 1: 日利率显示格式" -ForegroundColor Yellow
if ($dailyRate -eq 4) {
    Write-Host "  ✅ 通过 - 日利率为整数 $dailyRate%" -ForegroundColor Green
} else {
    Write-Host "  ❌ 失败 - 日利率应该是 4，实际是 $dailyRate" -ForegroundColor Red
    $allChecksPassed = $false
}
Write-Host ""

# 检查2: 收益计算准确性
Write-Host "检查项 2: 收益计算准确性" -ForegroundColor Yellow
if ($errorRate -lt $tolerance) {
    Write-Host "  ✅ 通过 - 误差率 $([math]::Round($errorRate * 100, 2))% < $($tolerance * 100)%" -ForegroundColor Green
} else {
    Write-Host "  ❌ 失败 - 误差率 $([math]::Round($errorRate * 100, 2))% >= $($tolerance * 100)%" -ForegroundColor Red
    $allChecksPassed = $false
}
Write-Host ""

# 检查3: 收益增长倍数
Write-Host "检查项 3: 修复效果" -ForegroundColor Yellow
$improvement = $pendingUsdt / $earningsBefore
if ($improvement -ge 90 -and $improvement -le 110) {
    Write-Host "  ✅ 通过 - 收益增长 $([math]::Round($improvement, 2))x（约100倍）" -ForegroundColor Green
} else {
    Write-Host "  ⚠️  警告 - 收益增长 $([math]::Round($improvement, 2))x（预期约100倍）" -ForegroundColor Yellow
}
Write-Host ""

# 最终结果
Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" -ForegroundColor DarkGray

if ($allChecksPassed) {
    Write-Host ""
    Write-Host "  🎉 恭喜！所有检查均通过！" -ForegroundColor Green -BackgroundColor Black
    Write-Host ""
    Write-Host "✅ 修复成功！VIP日利率计算已恢复正常！" -ForegroundColor Green
    Write-Host ""
    Write-Host "核心验证点:" -ForegroundColor Yellow
    Write-Host "  ✅ RAT价格固定为 0.01 USDT" -ForegroundColor White
    Write-Host "  ✅ 日利率显示正确（整数）" -ForegroundColor White
    Write-Host "  ✅ 收益计算准确（误差 < 5%）" -ForegroundColor White
    Write-Host "  ✅ 修复后收益增加约 100 倍" -ForegroundColor White
    Write-Host ""
    Write-Host "下一步行动:" -ForegroundColor Yellow
    Write-Host "  1. 截图保存验证结果" -ForegroundColor Gray
    Write-Host "  2. 通知受影响用户" -ForegroundColor Gray
    Write-Host "  3. 监控用户反馈" -ForegroundColor Gray
    Write-Host "  4. 评估历史收益补发方案" -ForegroundColor Gray
    Write-Host ""
    exit 0
} else {
    Write-Host ""
    Write-Host "  ⚠️  警告：部分检查未通过" -ForegroundColor Red -BackgroundColor Black
    Write-Host ""
    Write-Host "❌ 修复可能未完全生效！" -ForegroundColor Red
    Write-Host ""
    Write-Host "建议操作:" -ForegroundColor Yellow
    Write-Host "  1. 检查 Render 部署日志" -ForegroundColor Gray
    Write-Host "     https://dashboard.render.com/" -ForegroundColor DarkGray
    Write-Host "  2. 确认最新代码已推送" -ForegroundColor Gray
    Write-Host "     git log --oneline -n 1" -ForegroundColor DarkGray
    Write-Host "  3. 必要时手动触发重新部署" -ForegroundColor Gray
    Write-Host "  4. 查看数据库VIP配置" -ForegroundColor Gray
    Write-Host "     SELECT * FROM vip_tiers;" -ForegroundColor DarkGray
    Write-Host ""
    exit 1
}

