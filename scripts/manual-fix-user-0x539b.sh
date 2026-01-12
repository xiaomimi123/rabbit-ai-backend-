#!/bin/bash

# 手动修复用户 0x539b1201ce9b5f026309ae82e594d69472e8c271
# 交易哈希: 0x936995f3ea34bd20a574bf5fbc2421810a6b4d762c0cbd6bf1a183ed1fb4bfc1

API_URL="https://rabbit-ai-backend-latest.onrender.com/api/admin/indexer/manual-index"
ADMIN_API_KEY="your_admin_api_key_here"  # 请替换为实际的管理员 API 密钥

TX_HASH="0x936995f3ea34bd20a574bf5fbc2421810a6b4d762c0cbd6bf1a183ed1fb4bfc1"

echo "开始手动索引交易: $TX_HASH"
echo "API URL: $API_URL"

curl -X POST "$API_URL" \
     -H "Content-Type: application/json" \
     -H "x-admin-api-key: $ADMIN_API_KEY" \
     -d "{
           \"txHash\": \"$TX_HASH\"
         }" | json_pp

echo ""
echo "✅ 手动索引完成！"
echo "请检查用户能量值是否已更新。"

