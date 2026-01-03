#!/bin/bash

# 访问统计 API 测试脚本
# 用于直接测试后端 API 是否正常工作

API_URL="${1:-https://rabbit-ai-backend.onrender.com/api/analytics/visit}"

echo "🧪 测试访问统计 API"
echo "API URL: $API_URL"
echo ""

# 测试 1: 基本请求（无钱包地址）
echo "📝 测试 1: 基本请求（无钱包地址）"
curl -X POST "$API_URL" \
  -H "Content-Type: application/json" \
  -H "Origin: https://rabbitdifi.com" \
  -H "User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" \
  -d '{
    "pagePath": "/",
    "walletAddress": null,
    "referrer": null,
    "language": "zh",
    "isMobile": false,
    "sessionId": "test_manual_'$(date +%s)'"
  }' \
  -w "\nHTTP Status: %{http_code}\n" \
  -s

echo ""
echo ""

# 测试 2: 带钱包地址的请求
echo "📝 测试 2: 带钱包地址的请求"
curl -X POST "$API_URL" \
  -H "Content-Type: application/json" \
  -H "Origin: https://rabbitdifi.com" \
  -H "User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" \
  -d '{
    "pagePath": "/",
    "walletAddress": "0x1234567890123456789012345678901234567890",
    "referrer": null,
    "language": "en",
    "isMobile": true,
    "sessionId": "test_wallet_'$(date +%s)'"
  }' \
  -w "\nHTTP Status: %{http_code}\n" \
  -s

echo ""
echo ""

# 测试 3: 检查 Rate Limit（快速连续请求）
echo "📝 测试 3: Rate Limit 检查（快速连续请求）"
for i in {1..3}; do
  echo "请求 $i:"
  curl -X POST "$API_URL" \
    -H "Content-Type: application/json" \
    -H "Origin: https://rabbitdifi.com" \
    -H "User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" \
    -d '{
      "pagePath": "/",
      "walletAddress": null,
      "referrer": null,
      "language": "zh",
      "isMobile": false,
      "sessionId": "test_ratelimit_'$(date +%s)'_'$i'"
    }' \
    -w "\nHTTP Status: %{http_code}\n" \
    -s
  echo ""
  sleep 0.5
done

echo ""
echo "✅ 测试完成！"
echo ""
echo "📊 下一步："
echo "1. 检查后端日志，应该看到："
echo "   - [Analytics API] Client IP: ..."
echo "   - [Analytics API] Rate limit check: ..."
echo "   - [Analytics API] Recording visit: ..."
echo ""
echo "2. 检查数据库："
echo "   SELECT * FROM page_visits ORDER BY created_at DESC LIMIT 5;"

