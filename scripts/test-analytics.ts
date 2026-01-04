// 测试访问统计 API
// 使用方法: npx tsx scripts/test-analytics.ts

import fetch from 'node-fetch';

const API_BASE = process.env.API_BASE_URL || 'http://localhost:3000';

async function testAnalytics() {
  console.log('🧪 测试访问统计 API...\n');
  
  const testData = {
    pagePath: '/test',
    walletAddress: null,
    referrer: null,
    language: 'zh',
    isMobile: false,
    sessionId: `test_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
  };
  
  console.log('📤 发送请求:', {
    url: `${API_BASE}/api/analytics/visit`,
    data: testData,
  });
  
  try {
    const response = await fetch(`${API_BASE}/api/analytics/visit`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Test-Script/1.0',
        'CF-Connecting-IP': '8.8.8.8', // 测试 IP
      },
      body: JSON.stringify(testData),
    });
    
    const result = await response.json();
    
    console.log('\n📥 响应:', {
      status: response.status,
      statusText: response.statusText,
      result,
    });
    
    if (result.ok) {
      console.log('\n✅ 测试成功！访问记录已保存');
    } else {
      console.log('\n❌ 测试失败:', result.message);
    }
  } catch (error: any) {
    console.error('\n❌ 请求失败:', error.message);
  }
}

testAnalytics();

