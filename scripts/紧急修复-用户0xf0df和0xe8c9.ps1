# 紧急修复脚本 - 用户 0xf0df 和 0xe8c9
# 功能：手动调用后端 API 来索引这2个交易

$ErrorActionPreference = "Stop"

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  紧急修复脚本 - 补充用户领取记录" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

# 配置
$BACKEND_URL = "https://rabbit-ai-backend-latest.onrender.com"  # 请替换为您的实际后端域名
$API_ENDPOINT = "$BACKEND_URL/api/admin/indexer/manual-index"

# 交易哈希列表
$transactions = @(
    @{
        hash = "0xc2a961b00b39d8b779f23286617f699d2d4a7fa87f9d5b5e2a0f9c4d77b4cab0"
        description = "交易 1"
    },
    @{
        hash = "0x1b38954d8c02c16702bf9d4cf513e95bd4e4d4ad872614fdd53c0f473a9c6c37"
        description = "交易 2"
    }
)

Write-Host "即将处理 $($transactions.Count) 个交易..." -ForegroundColor Yellow
Write-Host "后端 API: $API_ENDPOINT" -ForegroundColor Gray
Write-Host ""

$successCount = 0
$errorCount = 0

foreach ($tx in $transactions) {
    Write-Host "-----------------------------------" -ForegroundColor Gray
    Write-Host "处理 $($tx.description)" -ForegroundColor White
    Write-Host "哈希: $($tx.hash)" -ForegroundColor Gray
    
    try {
        $body = @{
            txHash = $tx.hash
        } | ConvertTo-Json
        
        Write-Host "正在调用 API..." -ForegroundColor Gray
        
        $response = Invoke-RestMethod -Uri $API_ENDPOINT `
            -Method Post `
            -Body $body `
            -ContentType "application/json" `
            -TimeoutSec 60
        
        Write-Host "✅ 成功！" -ForegroundColor Green
        Write-Host "响应: $($response | ConvertTo-Json -Depth 5)" -ForegroundColor Gray
        $successCount++
        
        # 等待2秒，避免过快请求
        Start-Sleep -Seconds 2
    }
    catch {
        Write-Host "❌ 失败：$($_.Exception.Message)" -ForegroundColor Red
        
        if ($_.Exception.Response) {
            $reader = [System.IO.StreamReader]::new($_.Exception.Response.GetResponseStream())
            $responseBody = $reader.ReadToEnd()
            Write-Host "错误详情: $responseBody" -ForegroundColor Red
        }
        
        $errorCount++
    }
    
    Write-Host ""
}

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  修复完成" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "成功: $successCount" -ForegroundColor Green
Write-Host "失败: $errorCount" -ForegroundColor $(if ($errorCount -gt 0) { "Red" } else { "Gray" })
Write-Host ""

if ($successCount -gt 0) {
    Write-Host "🎉 修复成功！" -ForegroundColor Green
    Write-Host ""
    Write-Host "下一步：验证修复效果" -ForegroundColor Yellow
    Write-Host "请在 Supabase Dashboard 中运行以下 SQL：" -ForegroundColor Yellow
    Write-Host ""
    Write-Host @"
SELECT 
  address,
  energy_total,
  ROUND(CAST(rat_balance_wei AS NUMERIC) / 1e18, 2) AS rat_balance,
  updated_at
FROM users
WHERE LOWER(address) IN (
  LOWER('0xf0dfddd1d74138280916d86702f3c1c66171045b'),
  LOWER('0xe8c903de963a446c661071251762d328420ccd19')
)
ORDER BY address;
"@ -ForegroundColor Cyan
}

Write-Host ""
Write-Host "按任意键退出..."
$null = $Host.UI.RawUI.ReadKey("NoEcho,IncludeKeyDown")

