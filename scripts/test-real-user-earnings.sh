#!/bin/bash

# 真实用户收益计算测试脚本
# 用途：在生产环境验证实际用户的收益计算
# 运行方式：bash scripts/test-real-user-earnings.sh

echo "═══════════════════════════════════════════════════════════"
echo "🔍 真实用户收益计算验证"
echo "═══════════════════════════════════════════════════════════"
echo ""

# 测试用户地址
TEST_USER="0x9897f1f7ee7c1c443e28a52fe80ed514cf65eefe"

echo "📋 测试用户: $TEST_USER"
echo ""

# 获取API URL（需要根据实际环境修改）
API_URL="${API_URL:-https://rabbit-ai-backend.onrender.com}"

echo "🌐 API地址: $API_URL"
echo ""

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "步骤 1: 查询用户收益"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# 调用API查询用户收益
RESPONSE=$(curl -s "$API_URL/api/user/earnings?address=$TEST_USER")

echo "API响应:"
echo "$RESPONSE" | jq '.'

# 提取关键数据
PENDING_USDT=$(echo "$RESPONSE" | jq -r '.pendingUsdt')
DAILY_RATE=$(echo "$RESPONSE" | jq -r '.dailyRate')
BALANCE=$(echo "$RESPONSE" | jq -r '.balance')
CURRENT_TIER=$(echo "$RESPONSE" | jq -r '.currentTier')

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "步骤 2: 验证收益计算"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

echo "💰 用户数据:"
echo "  RAT余额: $BALANCE RAT"
echo "  VIP等级: VIP $CURRENT_TIER"
echo "  日利率: $DAILY_RATE%"
echo "  可提现收益: $PENDING_USDT USDT"
echo ""

# 计算预期日收益
if [ "$CURRENT_TIER" = "2" ]; then
  EXPECTED_DAILY=$(echo "scale=2; $BALANCE * 0.01 * 0.04" | bc)
  echo "📊 预期日收益: $EXPECTED_DAILY USDT/天"
  echo ""
  
  # 验证日利率
  if [ "$DAILY_RATE" = "4" ]; then
    echo "✅ 日利率正确: 4%"
  else
    echo "❌ 日利率错误: 应该是4%，实际是$DAILY_RATE%"
  fi
  
  # 验证收益是否合理（假设距离上次提现1小时）
  HOURLY_EARNINGS=$(echo "scale=6; $EXPECTED_DAILY / 24" | bc)
  echo "  预期小时收益: $HOURLY_EARNINGS USDT/小时"
  
  # 判断实际收益是否在合理范围内（1-24小时）
  MIN_EARNINGS=$HOURLY_EARNINGS
  MAX_EARNINGS=$EXPECTED_DAILY
  
  echo ""
  echo "🔍 收益合理性验证:"
  echo "  最小合理值（1小时）: $MIN_EARNINGS USDT"
  echo "  最大合理值（24小时）: $MAX_EARNINGS USDT"
  echo "  实际收益: $PENDING_USDT USDT"
  
  # 使用bc进行浮点数比较
  if (( $(echo "$PENDING_USDT >= $MIN_EARNINGS" | bc -l) )) && (( $(echo "$PENDING_USDT <= $MAX_EARNINGS" | bc -l) )); then
    echo "  状态: ✅ 合理"
  else
    echo "  状态: ⚠️ 可能异常，请人工检查"
  fi
fi

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "步骤 3: 对比修复前后"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# 计算修复前的收益（错误版本）
EARNINGS_BEFORE=$(echo "scale=6; $BALANCE * 0.01 * 0.04 / 100" | bc)
EARNINGS_AFTER=$(echo "scale=6; $BALANCE * 0.01 * 0.04" | bc)

echo "📈 修复效果对比（按1天计算）:"
echo "  修复前（错误）: $EARNINGS_BEFORE USDT/天"
echo "  修复后（正确）: $EARNINGS_AFTER USDT/天"
echo "  增长倍数: 100x"
echo ""

echo "═══════════════════════════════════════════════════════════"
echo "✅ 测试完成"
echo "═══════════════════════════════════════════════════════════"

