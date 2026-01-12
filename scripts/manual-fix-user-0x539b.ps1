# 手动修复用户 0x539b1201ce9b5f026309ae82e594d69472e8c271
# 交易哈希: 0x936995f3ea34bd20a574bf5fbc2421810a6b4d762c0cbd6bf1a183ed1fb4bfc1

$ApiUrl = "https://rabbit-ai-backend-latest.onrender.com/api/admin/indexer/manual-index"
$AdminApiKey = "your_admin_api_key_here"  # 请替换为实际的管理员 API 密钥

$TxHash = "0x936995f3ea34bd20a574bf5fbc2421810a6b4d762c0cbd6bf1a183ed1fb4bfc1"

Write-Host "开始手动索引交易: $TxHash" -ForegroundColor Cyan
Write-Host "API URL: $ApiUrl" -ForegroundColor Cyan

$body = @{
    txHash = $TxHash
} | ConvertTo-Json

$headers = @{
    "Content-Type" = "application/json"
    "x-admin-api-key" = $AdminApiKey
}

try {
    $response = Invoke-RestMethod -Uri $ApiUrl -Method Post -Headers $headers -Body $body
    Write-Host "✅ 手动索引成功！" -ForegroundColor Green
    $response | ConvertTo-Json -Depth 100 | Write-Host
    Write-Host ""
    Write-Host "请检查用户能量值是否已更新。" -ForegroundColor Yellow
} catch {
    Write-Host "❌ 手动索引失败！" -ForegroundColor Red
    Write-Host $_.Exception.Message -ForegroundColor Red
    if ($_.Exception.Response) {
        $_.Exception.Response.GetResponseStream() | ForEach-Object {
            $reader = New-Object System.IO.StreamReader($_)
            $reader.ReadToEnd() | ConvertFrom-Json | ConvertTo-Json -Depth 100 | Write-Host -ForegroundColor Red
        }
    }
}

