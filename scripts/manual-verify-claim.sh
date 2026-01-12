#!/bin/bash

# 手动验证用户空投领取
# 用户: 0x539b1201ce9b5f026309ae82e594d69472e8c271
# 交易哈希: 0x936995f3ea34bd20a574bf5fbc2421810a6b4d762c0cbd6bf1a183ed1fb4bfc1

echo "========================================="
echo "手动验证空投领取交易"
echo "========================================="
echo ""
echo "用户地址: 0x539b1201ce9b5f026309ae82e594d69472e8c271"
echo "交易哈希: 0x936995f3ea34bd20a574bf5fbc2421810a6b4d762c0cbd6bf1a183ed1fb4bfc1"
echo ""
echo "正在调用验证接口..."
echo ""

curl -X POST https://rabbit-ai-backend-latest.onrender.com/api/mining/verify-claim \
  -H "Content-Type: application/json" \
  -d '{
    "address": "0x539b1201ce9b5f026309ae82e594d69472e8c271",
    "txHash": "0x936995f3ea34bd20a574bf5fbc2421810a6b4d762c0cbd6bf1a183ed1fb4bfc1",
    "referrer": "0x0000000000000000000000000000000000000000"
  }' | jq '.'

echo ""
echo "========================================="
echo "验证完成！"
echo "========================================="

