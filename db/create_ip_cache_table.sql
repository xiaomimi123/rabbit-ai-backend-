-- 创建 IP 地理位置缓存表
-- 用于缓存 IP 地址的地理位置信息，避免重复调用 GeoIP API
-- 执行时间: 2025-01-XX

-- 1. 创建 ip_geo_cache 表
CREATE TABLE IF NOT EXISTS public.ip_geo_cache (
  ip_address INET PRIMARY KEY,        -- IP 地址（主键）
  country VARCHAR(100),                -- 国家名称
  country_code VARCHAR(2),             -- 国家代码（ISO 3166-1 alpha-2）
  city VARCHAR(100),                    -- 城市（可选）
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 2. 创建索引（IP 地址已经是主键，不需要额外索引）
-- 但可以添加更新时间索引，用于定期清理旧数据
CREATE INDEX IF NOT EXISTS idx_ip_geo_cache_updated_at ON public.ip_geo_cache(updated_at DESC);

-- 3. 添加注释
COMMENT ON TABLE public.ip_geo_cache IS 'IP 地理位置缓存表，用于缓存 IP 地址的地理位置信息，避免重复调用 GeoIP API';
COMMENT ON COLUMN public.ip_geo_cache.ip_address IS 'IP 地址（主键）';
COMMENT ON COLUMN public.ip_geo_cache.country IS '国家名称（从 IP 地理位置服务获取）';
COMMENT ON COLUMN public.ip_geo_cache.country_code IS '国家代码（ISO 3166-1 alpha-2）';
COMMENT ON COLUMN public.ip_geo_cache.city IS '城市名称（可选）';
COMMENT ON COLUMN public.ip_geo_cache.created_at IS '创建时间';
COMMENT ON COLUMN public.ip_geo_cache.updated_at IS '更新时间';

