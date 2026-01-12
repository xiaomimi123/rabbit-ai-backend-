# PowerShell 版本 - 手动验证用户空投领取
# 用户: 0x539b1201ce9b5f026309ae82e594d69472e8c271
# 交易哈希: 0x936995f3ea34bd20a574bf5fbc2421810a6b4d762c0cbd6bf1a183ed1fb4bfc1

Write-Host "=========================================" -ForegroundColor Cyan
Write-Host "手动验证空投领取交易" -ForegroundColor Cyan
Write-Host "=========================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "用户地址: 0x539b1201ce9b5f026309ae82e594d69472e8c271" -ForegroundColor Yellow
Write-Host "交易哈希: 0x936995f3ea34bd20a574bf5fbc2421810a6b4d762c0cbd6bf1a183ed1fb4bfc1" -ForegroundColor Yellow
Write-Host ""
Write-Host "正在调用验证接口..." -ForegroundColor Green
Write-Host ""

$body = @{
    address = "0x539b1201ce9b5f026309ae82e594d69472e8c271"
    txHash = "0x936995f3ea34bd20a574bf5fbc2421810a6b4d762c0cbd6bf1a183ed1fb4bfc1"
    referrer = "0x0000000000000000000000000000000000000000"
} | ConvertTo-Json

try {
    $response = Invoke-RestMethod -Uri "https://rabbit-ai-backend-latest.onrender.com/api/mining/verify-claim" `
        -Method Post `
        -ContentType "application/json" `
        -Body $body
    
    Write-Host "✅ 验证成功！" -ForegroundColor Green
    Write-Host ""
    Write-Host "响应数据:" -ForegroundColor Cyan
    $response | ConvertTo-Json -Depth 10 | Write-Host
    
} catch {
    Write-Host "❌ 验证失败！" -ForegroundColor Red
    Write-Host ""
    Write-Host "错误信息:" -ForegroundColor Red
    Write-Host $_.Exception.Message
    
    if ($_.ErrorDetails.Message) {
        Write-Host ""
        Write-Host "详细错误:" -ForegroundColor Red
        $_.ErrorDetails.Message | Write-Host
    }
}

Write-Host ""
Write-Host "=========================================" -ForegroundColor Cyan
Write-Host "验证完成！" -ForegroundColor Cyan
Write-Host "=========================================" -ForegroundColor Cyan

