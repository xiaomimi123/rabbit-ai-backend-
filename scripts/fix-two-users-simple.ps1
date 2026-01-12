# 修复两个用户的能量值

$ApiUrl = "https://rabbit-ai-backend-latest.onrender.com/api/mining/verify-claim"

Write-Host "修复用户 1: 0x539b..." -ForegroundColor Cyan

$body1 = @{
    address = "0x539b1201ce9b5f026309ae82e594d69472e8c271"
    txHash = "0x936995f3ea34bd20a574bf5fbc2421810a6b4d762c0cbd6bf1a183ed1fb4bfc1"
    referrer = "0x0000000000000000000000000000000000000000"
} | ConvertTo-Json

try {
    $response1 = Invoke-RestMethod -Uri $ApiUrl -Method Post -ContentType "application/json" -Body $body1
    Write-Host "用户 1 修复成功！" -ForegroundColor Green
    $response1 | ConvertTo-Json
}
catch {
    Write-Host "用户 1 修复失败: $($_.Exception.Message)" -ForegroundColor Red
}

Write-Host ""
Write-Host "修复用户 2: 0xe5f6..." -ForegroundColor Cyan

$body2 = @{
    address = "0xe5f6ad1aa7b513a0228331ca2aa6eeea444854d5"
    txHash = "0x16fc914aed1e13f75e3d33d8adacb6c2c59d4e488d056c3637a3a0fd3b2328a1"
    referrer = "0x0000000000000000000000000000000000000000"
} | ConvertTo-Json

try {
    $response2 = Invoke-RestMethod -Uri $ApiUrl -Method Post -ContentType "application/json" -Body $body2
    Write-Host "用户 2 修复成功！" -ForegroundColor Green
    $response2 | ConvertTo-Json
}
catch {
    Write-Host "用户 2 修复失败: $($_.Exception.Message)" -ForegroundColor Red
}

Write-Host ""
Write-Host "修复完成！" -ForegroundColor Cyan

