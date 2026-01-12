Write-Host "Testing backend health..." -ForegroundColor Cyan

try {
    $response = Invoke-RestMethod -Uri "https://rabbit-ai-backend-latest.onrender.com/health" -Method Get
    Write-Host "Health check passed!" -ForegroundColor Green
    $response | ConvertTo-Json
} catch {
    Write-Host "Health check failed!" -ForegroundColor Red
    Write-Host $_.Exception.Message
}

