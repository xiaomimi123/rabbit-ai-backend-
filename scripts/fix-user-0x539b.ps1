# 手动修复用户 0x539b 的空投领取问题
# 用户地址: 0x539b1201ce9b5f026309ae82e594d69472e8c271
# 交易哈希: 0x936995f3ea34bd20a574bf5fbc2421810a6b4d762c0cbd6bf1a183ed1fb4bfc1

$ApiUrl = "https://rabbit-ai-backend-latest.onrender.com/api/mining/verify-claim"
$Address = "0x539b1201ce9b5f026309ae82e594d69472e8c271"
$TxHash = "0x936995f3ea34bd20a574bf5fbc2421810a6b4d762c0cbd6bf1a183ed1fb4bfc1"
$Referrer = "0x0000000000000000000000000000000000000000"

Write-Host "=====================================" -ForegroundColor Cyan
Write-Host "手动修复用户 0x539b 空投领取数据" -ForegroundColor Cyan
Write-Host "=====================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "用户地址: $Address" -ForegroundColor Yellow
Write-Host "交易哈希: $TxHash" -ForegroundColor Yellow
Write-Host "API URL: $ApiUrl" -ForegroundColor Yellow
Write-Host ""
Write-Host "正在发送验证请求..." -ForegroundColor Cyan

$body = @{
    address = $Address
    txHash = $TxHash
    referrer = $Referrer
} | ConvertTo-Json

try {
    $response = Invoke-RestMethod -Uri $ApiUrl -Method Post -ContentType "application/json" -Body $body
    Write-Host ""
    Write-Host "✅ 验证成功！" -ForegroundColor Green
    Write-Host ""
    Write-Host "响应数据:" -ForegroundColor Green
    $response | ConvertTo-Json -Depth 100 | Write-Host
    Write-Host ""
    Write-Host "=====================================" -ForegroundColor Green
    Write-Host "✅ 用户 0x539b 已成功修复！" -ForegroundColor Green
    Write-Host "=====================================" -ForegroundColor Green
    Write-Host ""
    Write-Host "请在管理后台检查用户能量值是否已更新。" -ForegroundColor Yellow
} catch {
    Write-Host ""
    Write-Host "❌ 验证失败！" -ForegroundColor Red
    Write-Host ""
    Write-Host "错误信息:" -ForegroundColor Red
    Write-Host $_.Exception.Message -ForegroundColor Red
    Write-Host ""
    
    if ($_.Exception.Response) {
        try {
            $reader = [System.IO.StreamReader]::new($_.Exception.Response.GetResponseStream())
            $responseText = $reader.ReadToEnd()
            Write-Host "详细响应:" -ForegroundColor Red
            $responseText | Write-Host -ForegroundColor Red
        } catch {
            Write-Host "无法读取详细响应" -ForegroundColor Red
        }
    }
    
    Write-Host ""
    Write-Host "=====================================" -ForegroundColor Red
    Write-Host "❌ 修复失败！请检查后端服务状态。" -ForegroundColor Red
    Write-Host "=====================================" -ForegroundColor Red
}

