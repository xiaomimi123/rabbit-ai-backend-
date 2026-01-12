# =====================================
# 紧急修复两个用户的能量值
# =====================================

$Users = @(
    @{
        Address = "0x539b1201ce9b5f026309ae82e594d69472e8c271"
        TxHash = "0x936995f3ea34bd20a574bf5fbc2421810a6b4d762c0cbd6bf1a183ed1fb4bfc1"
        Referrer = "0x0000000000000000000000000000000000000000"
    },
    @{
        Address = "0xe5f6ad1aa7b513a0228331ca2aa6eeea444854d5"
        TxHash = "0x16fc914aed1e13f75e3d33d8adacb6c2c59d4e488d056c3637a3a0fd3b2328a1"
        Referrer = "0x0000000000000000000000000000000000000000"
    }
)

$ApiUrl = "https://rabbit-ai-backend-latest.onrender.com/api/mining/verify-claim"

Write-Host "=====================================" -ForegroundColor Cyan
Write-Host "🔧 紧急修复两个用户的能量值" -ForegroundColor Cyan
Write-Host "=====================================" -ForegroundColor Cyan
Write-Host ""

foreach ($User in $Users) {
    Write-Host "-------------------------------------" -ForegroundColor Yellow
    Write-Host "用户地址: $($User.Address)" -ForegroundColor White
    Write-Host "交易哈希: $($User.TxHash)" -ForegroundColor White
    Write-Host ""
    Write-Host "正在发送验证请求..." -ForegroundColor Yellow

    $body = @{
        address = $User.Address
        txHash = $User.TxHash
        referrer = $User.Referrer
    } | ConvertTo-Json

    try {
        $response = Invoke-RestMethod -Uri $ApiUrl -Method Post -ContentType "application/json" -Body $body -TimeoutSec 30
        Write-Host "✅ 验证成功！" -ForegroundColor Green
        Write-Host "响应数据:" -ForegroundColor Green
        $response | ConvertTo-Json -Depth 5 | Write-Host -ForegroundColor Green
        Write-Host ""
    } catch {
        Write-Host "❌ 验证失败！" -ForegroundColor Red
        Write-Host "错误信息: $($_.Exception.Message)" -ForegroundColor Red
        
        if ($_.Exception.Response) {
            Write-Host "HTTP 状态码: $($_.Exception.Response.StatusCode.value__)" -ForegroundColor Red
            try {
                $reader = [System.IO.StreamReader]::new($_.Exception.Response.GetResponseStream())
                $detailedResponse = $reader.ReadToEnd()
                Write-Host "详细响应: " -ForegroundColor Red
                $detailedResponse | ConvertFrom-Json | ConvertTo-Json -Depth 5 | Write-Host -ForegroundColor Red
            } catch {
                Write-Host "无法读取详细响应" -ForegroundColor Red
            }
        }
        Write-Host ""
    }

    Write-Host "等待 2 秒后继续..." -ForegroundColor Gray
    Start-Sleep -Seconds 2
}

Write-Host "=====================================" -ForegroundColor Cyan
Write-Host "修复完成！请检查数据库确认能量值是否已更新。" -ForegroundColor Cyan
Write-Host "=====================================" -ForegroundColor Cyan

