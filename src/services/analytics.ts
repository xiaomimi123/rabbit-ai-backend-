import { supabase } from '../infra/supabase.js';
import { ethers } from 'ethers';

// IP 地理位置接口
interface GeoLocation {
  country?: string | null;
  countryCode?: string | null;
  city?: string | null;
}

// 🟢 修复4: 获取客户端真实 IP 地址（支持 Cloudflare + Vercel）
export function getClientIp(req: any): string | null {
  // 优先级：CF-Connecting-IP > X-Forwarded-For > X-Real-IP > req.ip
  // 注意：Cloudflare 会设置 CF-Connecting-IP，这是最可靠的
  
  const headers = {
    'cf-connecting-ip': req.headers['cf-connecting-ip'],
    'x-forwarded-for': req.headers['x-forwarded-for'],
    'x-real-ip': req.headers['x-real-ip'],
    'req.ip': req.ip,
  };
  
  console.log('[getClientIp] Checking headers:', headers);
  
  // 1. 优先读取 Cloudflare 的真实 IP（最可靠）
  const cfIp = req.headers['cf-connecting-ip'];
  if (cfIp) {
    const ip = Array.isArray(cfIp) ? cfIp[0] : cfIp;
    // 验证不是 Cloudflare 内部 IP
    if (ip && !ip.startsWith('172.67.') && !ip.startsWith('172.64.')) {
      console.log('[getClientIp] ✅ Using CF-Connecting-IP:', ip);
      return ip.trim();
    } else {
      console.log('[getClientIp] ⚠️ CF-Connecting-IP is Cloudflare internal IP, skipping:', ip);
    }
  }

  // 2. 读取 X-Forwarded-For（可能被多个代理设置）
  const xForwardedFor = req.headers['x-forwarded-for'];
  if (xForwardedFor) {
    const ips = Array.isArray(xForwardedFor) ? xForwardedFor[0] : xForwardedFor;
    // X-Forwarded-For 格式：client, proxy1, proxy2
    // 取第一个 IP（真实客户端 IP）
    const firstIp = ips.split(',')[0].trim();
    // 验证不是本地 IP 或 Cloudflare IP
    if (firstIp && 
        firstIp !== '127.0.0.1' && 
        firstIp !== '::1' &&
        !firstIp.startsWith('172.67.') && 
        !firstIp.startsWith('172.64.')) {
      return firstIp;
    }
  }

  // 3. 读取 X-Real-IP（某些代理会设置）
  const xRealIp = req.headers['x-real-ip'];
  if (xRealIp) {
    const ip = Array.isArray(xRealIp) ? xRealIp[0] : xRealIp;
    if (ip && 
        ip !== '127.0.0.1' && 
        ip !== '::1' &&
        !ip.startsWith('172.67.') && 
        !ip.startsWith('172.64.')) {
      return ip.trim();
    }
  }

  // 4. 最后使用 req.ip（Fastify 自动解析）
  const reqIp = req.ip;
  if (reqIp && 
      reqIp !== '127.0.0.1' && 
      reqIp !== '::1' &&
      !reqIp.startsWith('172.67.') && 
      !reqIp.startsWith('172.64.')) {
    return reqIp;
  }

  // 如果所有方法都失败，返回 null（记录警告）
  console.warn('[Analytics] ⚠️ Failed to get real client IP, all methods returned invalid IP');
  return null;
}

// 🟢 修复2: Rate Limit 检查（简单实现：使用数据库记录）
// 限制同一 IP 在 1 分钟内只能发 1 次统计请求
export async function checkRateLimit(ip: string): Promise<{ allowed: boolean; reason?: string }> {
  try {
    // 查询最近 1 分钟内是否有来自该 IP 的访问记录
    const oneMinuteAgo = new Date(Date.now() - 60 * 1000).toISOString();
    
    const { count, error } = await supabase
      .from('page_visits')
      .select('*', { count: 'exact', head: true })
      .eq('ip_address', ip)
      .gte('created_at', oneMinuteAgo);

    if (error) {
      console.warn(`[Analytics] Failed to check rate limit for IP ${ip}:`, error);
      // 如果查询失败，允许请求（避免误杀）
      return { allowed: true };
    }

    // 如果 1 分钟内有记录，拒绝请求
    if (count && count > 0) {
      return { 
        allowed: false, 
        reason: `Rate limit exceeded: ${count} requests in the last minute` 
      };
    }

    return { allowed: true };
  } catch (error: any) {
    console.warn(`[Analytics] Error checking rate limit:`, error?.message || error);
    // 如果出错，允许请求（避免误杀）
    return { allowed: true };
  }
}

// 🟢 修复1: IP 地理位置缓存 - 先从数据库查询，避免重复调用 API
async function getGeoLocationFromCache(ip: string): Promise<GeoLocation | null> {
  try {
    const { data, error } = await supabase
      .from('ip_geo_cache')
      .select('country, country_code, city')
      .eq('ip_address', ip)
      .maybeSingle();

    if (error) {
      console.warn(`[Analytics] Failed to query IP cache for ${ip}:`, error);
      return null;
    }

    if (data) {
      return {
        country: data.country || null,
        countryCode: data.country_code || null,
        city: data.city || null,
      };
    }

    return null;
  } catch (error: any) {
    console.warn(`[Analytics] Error querying IP cache:`, error?.message || error);
    return null;
  }
}

// 🟢 修复1: 保存 IP 地理位置到缓存
async function saveGeoLocationToCache(ip: string, geo: GeoLocation): Promise<void> {
  try {
    const { error } = await supabase
      .from('ip_geo_cache')
      .upsert({
        ip_address: ip,
        country: geo.country || null,
        country_code: geo.countryCode || null,
        city: geo.city || null,
        updated_at: new Date().toISOString(),
      }, {
        onConflict: 'ip_address',
      });

    if (error) {
      console.warn(`[Analytics] Failed to save IP cache for ${ip}:`, error);
    }
  } catch (error: any) {
    console.warn(`[Analytics] Error saving IP cache:`, error?.message || error);
  }
}

// 使用免费 IP 地理位置 API 获取国家信息（带缓存）
async function getGeoLocation(ip: string): Promise<GeoLocation> {
  // 🟢 修复1: 先从缓存查询
  const cached = await getGeoLocationFromCache(ip);
  if (cached) {
    console.log(`[Analytics] ✅ Using cached geo location for IP ${ip}`);
    return cached;
  }

  // 缓存未命中，调用 API
  try {
    // 使用 ipapi.co 免费 API（每月 1000 次请求）
    // ⚠️ 注意：由于有缓存，实际调用次数会大幅减少
    const response = await fetch(`https://ipapi.co/${ip}/json/`, {
      headers: {
        'User-Agent': 'RabbitAI-Backend/1.0'
      },
      // 🟢 添加超时保护（5秒）
      signal: AbortSignal.timeout(5000),
    });

    if (!response.ok) {
      // 429 表示额度用完，记录警告但不抛出错误
      if (response.status === 429) {
        console.error(`[Analytics] ⚠️ IP API rate limit exceeded (429) for ${ip}. Consider upgrading to paid plan or using offline GeoIP database.`);
        return {};
      }
      throw new Error(`IP API returned ${response.status}`);
    }

    const data = await response.json() as {
      country_name?: string;
      country_code?: string;
      city?: string;
    };
    
    const geo: GeoLocation = {
      country: data.country_name || null,
      countryCode: data.country_code || null,
      city: data.city || null,
    };

    // 🟢 修复1: 保存到缓存
    await saveGeoLocationToCache(ip, geo);
    
    return geo;
  } catch (error: any) {
    // 超时或网络错误
    if (error.name === 'AbortError' || error.name === 'TimeoutError') {
      console.warn(`[Analytics] IP API timeout for ${ip}, skipping fallback`);
      return {};
    }

    console.warn(`[Analytics] Failed to get geo location for IP ${ip}:`, error?.message || error);
    
    // ⚠️ 注意：ip-api.com 免费版不支持 HTTPS，且可能不稳定
    // 如果主服务失败，尝试备用服务（但不推荐长期使用）
    try {
      const fallbackResponse = await fetch(`https://ip-api.com/json/${ip}?fields=status,country,countryCode,city`, {
        headers: {
          'User-Agent': 'RabbitAI-Backend/1.0'
        },
        signal: AbortSignal.timeout(5000),
      });

      if (fallbackResponse.ok) {
        const fallbackData = await fallbackResponse.json() as {
          status?: string;
          country?: string;
          countryCode?: string;
          city?: string;
        };
        if (fallbackData.status === 'success') {
          const geo: GeoLocation = {
            country: fallbackData.country || null,
            countryCode: fallbackData.countryCode || null,
            city: fallbackData.city || null,
          };
          // 保存到缓存
          await saveGeoLocationToCache(ip, geo);
          return geo;
        }
      }
    } catch (fallbackError) {
      console.warn(`[Analytics] Fallback IP API also failed:`, fallbackError);
    }

    // 如果所有 API 都失败，返回空值（不影响主流程）
    return {};
  }
}

// 记录页面访问
export async function recordPageVisit(data: {
  ip: string | null;
  userAgent: string | null;
  pagePath: string;
  walletAddress?: string | null;
  referrer?: string | null;
  language?: string;
  isMobile?: boolean;
  sessionId: string;
}): Promise<{ ok: boolean; id?: number }> {
  try {
    // 如果 IP 为空，无法记录地理位置
    if (!data.ip) {
      console.warn('[Analytics] IP address is missing, skipping geo location lookup');
    }

    // 获取地理位置信息（异步，不阻塞）
    let geoLocation: GeoLocation = {};
    if (data.ip) {
      try {
        geoLocation = await getGeoLocation(data.ip);
      } catch (error) {
        console.warn('[Analytics] Geo location lookup failed, continuing without it:', error);
      }
    }

    // 验证钱包地址格式
    let walletAddress = null;
    if (data.walletAddress && ethers.utils.isAddress(data.walletAddress)) {
      walletAddress = data.walletAddress.toLowerCase();
    }

    // 🟢 修复：确保 session_id 不为空（数据库要求）
    const sessionId = data.sessionId || `session_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    
    const insertData = {
      ip_address: data.ip || null,
      country: geoLocation.country || null,
      country_code: geoLocation.countryCode || null,
      city: geoLocation.city || null,
      user_agent: data.userAgent || null,
      page_path: data.pagePath || '/',
      wallet_address: walletAddress,
      referrer: data.referrer || null,
      language: data.language || null,
      is_mobile: data.isMobile || false,
      session_id: sessionId,
      created_at: new Date().toISOString(),
    };
    
    // 插入数据库
    console.log('[Analytics] 📝 Inserting page visit:', {
      ip: data.ip,
      pagePath: data.pagePath,
      walletAddress: walletAddress,
      sessionId: sessionId,
      country: geoLocation.country,
      insertData: JSON.stringify(insertData, null, 2),
    });
    
    const { data: inserted, error } = await supabase
      .from('page_visits')
      .insert(insertData)
      .select('id')
      .single();

    if (error) {
      console.error('[Analytics] ❌ Failed to insert page visit:', error);
      console.error('[Analytics] Error code:', error.code);
      console.error('[Analytics] Error message:', error.message);
      console.error('[Analytics] Error details:', JSON.stringify(error, null, 2));
      console.error('[Analytics] Insert data was:', JSON.stringify(insertData, null, 2));
      throw error;
    }

    if (!inserted || !inserted.id) {
      console.error('[Analytics] ❌ Insert succeeded but no ID returned');
      console.error('[Analytics] Insert result:', inserted);
      return { ok: false };
    }

    console.log('[Analytics] ✅ Page visit inserted successfully:', { id: inserted.id });
    return { ok: true, id: inserted.id };
  } catch (error: any) {
    console.error('[Analytics] Error recording page visit:', error);
    // 不抛出错误，避免影响前端用户体验
    return { ok: false };
  }
}

// 获取访问统计（管理员使用）
export async function getVisitStats(params: {
  startDate?: string;
  endDate?: string;
  country?: string;
  limit?: number;
  offset?: number;
}) {
  let query = supabase
    .from('page_visits')
    .select('*', { count: 'exact' })
    .order('created_at', { ascending: false });

  // 时间范围筛选
  if (params.startDate) {
    query = query.gte('created_at', params.startDate);
  }
  if (params.endDate) {
    query = query.lte('created_at', params.endDate);
  }

  // 国家筛选
  if (params.country) {
    query = query.eq('country', params.country);
  }

  // 分页
  const limit = params.limit || 50;
  const offset = params.offset || 0;
  query = query.range(offset, offset + limit - 1);

  const { data, error, count } = await query;

  if (error) {
    console.error('[Analytics] Failed to get visit stats:', error);
    throw error;
  }

  return {
    ok: true,
    items: data || [],
    total: count || 0,
  };
}

// 获取访问统计摘要（总访问量、国家分布等）
export async function getVisitSummary(params?: {
  startDate?: string;
  endDate?: string;
}) {
  try {
    // 1. 总访问量（考虑时间范围）
    let totalQuery = supabase.from('page_visits').select('*', { count: 'exact', head: true });
    if (params?.startDate) {
      totalQuery = totalQuery.gte('created_at', params.startDate);
    }
    if (params?.endDate) {
      totalQuery = totalQuery.lte('created_at', params.endDate);
    }
    const { count: totalVisits, error: countError } = await totalQuery;
    if (countError) throw countError;

    // 2. 今日访问量（不考虑时间范围参数，始终统计今天）
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const { count: todayVisits, error: todayError } = await supabase
      .from('page_visits')
      .select('*', { count: 'exact', head: true })
      .gte('created_at', todayStart.toISOString());
    if (todayError) throw todayError;

    // 3. 国家分布（前 10 名，考虑时间范围）
    let countryQuery = supabase
      .from('page_visits')
      .select('country, country_code')
      .not('country', 'is', null);
    if (params?.startDate) {
      countryQuery = countryQuery.gte('created_at', params.startDate);
    }
    if (params?.endDate) {
      countryQuery = countryQuery.lte('created_at', params.endDate);
    }
    const { data: countryData, error: countryError } = await countryQuery;
    if (countryError) throw countryError;

    // 统计国家分布
    const countryMap = new Map<string, { name: string; code: string; count: number }>();
    (countryData || []).forEach((visit: any) => {
      const country = visit.country || 'Unknown';
      const code = visit.country_code || 'XX';
      const key = `${country}_${code}`;
      const current = countryMap.get(key) || { name: country, code, count: 0 };
      current.count++;
      countryMap.set(key, current);
    });

    const countryDistribution = Array.from(countryMap.values())
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);

    // 4. 已连接钱包的访问量（考虑时间范围）
    let walletQuery = supabase
      .from('page_visits')
      .select('*', { count: 'exact', head: true })
      .not('wallet_address', 'is', null);
    if (params?.startDate) {
      walletQuery = walletQuery.gte('created_at', params.startDate);
    }
    if (params?.endDate) {
      walletQuery = walletQuery.lte('created_at', params.endDate);
    }
    const { count: walletVisits, error: walletError } = await walletQuery;
    if (walletError) throw walletError;

    return {
      ok: true,
      totalVisits: totalVisits || 0,
      todayVisits: todayVisits || 0,
      walletVisits: walletVisits || 0,
      countryDistribution,
    };
  } catch (error: any) {
    console.error('[Analytics] Failed to get visit summary:', error);
    throw error;
  }
}

