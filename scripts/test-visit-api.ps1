# 访问统计 API 测试脚本 (PowerShell)
# 用于直接测试后端 API 是否正常工作

param(
    [string]$ApiUrl = "https://rabbit-ai-backend.onrender.com/api/analytics/visit"
)

Write-Host "🧪 测试访问统计 API" -ForegroundColor Cyan
Write-Host "API URL: $ApiUrl" -ForegroundColor Gray
Write-Host ""

# 测试 1: 基本请求（无钱包地址）
Write-Host "📝 测试 1: 基本请求（无钱包地址）" -ForegroundColor Yellow
$timestamp = [DateTimeOffset]::Now.ToUnixTimeSeconds()
$body1 = @{
    pagePath = "/"
    walletAddress = $null
    referrer = $null
    language = "zh"
    isMobile = $false
    sessionId = "test_manual_$timestamp"
} | ConvertTo-Json

try {
    $headers1 = @{
        "Origin" = "https://rabbitdifi.com"
        "User-Agent" = "Mozilla/5.0"
    }
    $response1 = Invoke-RestMethod -Uri $ApiUrl -Method Post -ContentType "application/json" -Headers $headers1 -Body $body1
    Write-Host "✅ 响应: " -ForegroundColor Green -NoNewline
    Write-Host ($response1 | ConvertTo-Json -Compress)
} catch {
    Write-Host "❌ 错误: $_" -ForegroundColor Red
    Write-Host "HTTP Status: $($_.Exception.Response.StatusCode.value__)" -ForegroundColor Red
}

Write-Host ""
Write-Host ""

# 测试 2: 带钱包地址的请求
Write-Host "📝 测试 2: 带钱包地址的请求" -ForegroundColor Yellow
$timestamp2 = [DateTimeOffset]::Now.ToUnixTimeSeconds()
$body2 = @{
    pagePath = "/"
    walletAddress = "0x1234567890123456789012345678901234567890"
    referrer = $null
    language = "en"
    isMobile = $true
    sessionId = "test_wallet_$timestamp2"
} | ConvertTo-Json

try {
    $headers2 = @{
        "Origin" = "https://rabbitdifi.com"
        "User-Agent" = "Mozilla/5.0"
    }
    $response2 = Invoke-RestMethod -Uri $ApiUrl -Method Post -ContentType "application/json" -Headers $headers2 -Body $body2
    Write-Host "✅ 响应: " -ForegroundColor Green -NoNewline
    Write-Host ($response2 | ConvertTo-Json -Compress)
} catch {
    Write-Host "❌ 错误: $_" -ForegroundColor Red
    Write-Host "HTTP Status: $($_.Exception.Response.StatusCode.value__)" -ForegroundColor Red
}

Write-Host ""
Write-Host ""

# 测试 3: 检查 Rate Limit（快速连续请求）
Write-Host "📝 测试 3: Rate Limit 检查（快速连续请求）" -ForegroundColor Yellow
for ($i = 1; $i -le 3; $i++) {
    Write-Host "Request $i:" -ForegroundColor Gray
    $timestamp3 = [DateTimeOffset]::Now.ToUnixTimeSeconds()
    $body3 = @{
        pagePath = "/"
        walletAddress = $null
        referrer = $null
        language = "zh"
        isMobile = $false
        sessionId = "test_ratelimit_${timestamp3}_$i"
    } | ConvertTo-Json

    try {
        $headers3 = @{
            "Origin" = "https://rabbitdifi.com"
            "User-Agent" = "Mozilla/5.0"
        }
        $response3 = Invoke-RestMethod -Uri $ApiUrl -Method Post -ContentType "application/json" -Headers $headers3 -Body $body3
        Write-Host "  ✅ 响应: " -ForegroundColor Green -NoNewline
        Write-Host ($response3 | ConvertTo-Json -Compress)
    } catch {
        Write-Host "  ❌ 错误: $_" -ForegroundColor Red
        Write-Host "  HTTP Status: $($_.Exception.Response.StatusCode.value__)" -ForegroundColor Red
    }
    Write-Host ""
    Start-Sleep -Milliseconds 500
}

Write-Host ""
Write-Host "✅ 测试完成！" -ForegroundColor Green
Write-Host ""
Write-Host "📊 下一步：" -ForegroundColor Cyan
Write-Host "1. 检查后端日志，应该看到：" -ForegroundColor Gray
Write-Host "   - [Analytics API] Client IP: ..." -ForegroundColor Gray
Write-Host "   - [Analytics API] Rate limit check: ..." -ForegroundColor Gray
Write-Host "   - [Analytics API] Recording visit: ..." -ForegroundColor Gray
Write-Host ""
Write-Host "2. 检查数据库：" -ForegroundColor Gray
Write-Host '   SELECT * FROM page_visits ORDER BY created_at DESC LIMIT 5;' -ForegroundColor Gray

