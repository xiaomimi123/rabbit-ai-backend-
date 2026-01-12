# 测试后端服务健康状态
Write-Host "=====================================" -ForegroundColor Cyan
Write-Host "测试后端服务健康状态" -ForegroundColor Cyan
Write-Host "=====================================" -ForegroundColor Cyan
Write-Host ""

# 测试 /health 端点
Write-Host "1. 测试 /health 端点..." -ForegroundColor Yellow
try {
    $response = Invoke-RestMethod -Uri "https://rabbit-ai-backend-latest.onrender.com/health" -Method Get
    Write-Host "   OK 健康检查通过！" -ForegroundColor Green
    $response | ConvertTo-Json | Write-Host
} catch {
    Write-Host "   NG 健康检查失败！" -ForegroundColor Red
    Write-Host "   错误: $($_.Exception.Message)" -ForegroundColor Red
}

Write-Host ""

# 测试 /api/mining/verify-claim 端点
Write-Host "2. 测试 /api/mining/verify-claim 端点..." -ForegroundColor Yellow
$body = @{
    address = "0x539b1201ce9b5f026309ae82e594d69472e8c271"
    txHash = "0x936995f3ea34bd20a574bf5fbc2421810a6b4d762c0cbd6bf1a183ed1fb4bfc1"
    referrer = "0x0000000000000000000000000000000000000000"
} | ConvertTo-Json

try {
    $response = Invoke-RestMethod -Uri "https://rabbit-ai-backend-latest.onrender.com/api/mining/verify-claim" -Method Post -ContentType "application/json" -Body $body
    Write-Host "   OK verify-claim 端点正常！" -ForegroundColor Green
    $response | ConvertTo-Json -Depth 100 | Write-Host
} catch {
    Write-Host "   NG verify-claim 端点失败！" -ForegroundColor Red
    Write-Host "   错误: $($_.Exception.Message)" -ForegroundColor Red
    
    if ($_.Exception.Response) {
        Write-Host "   HTTP 状态码: $($_.Exception.Response.StatusCode.value__)" -ForegroundColor Red
    }
}

Write-Host ""
Write-Host "=====================================" -ForegroundColor Cyan

