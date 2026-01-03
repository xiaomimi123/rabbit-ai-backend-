-- 创建页面访问记录表
-- 用于记录用户访问前端的统计信息（IP、国家、时间等）
-- 执行时间: 2025-01-XX

-- 1. 创建 page_visits 表
CREATE TABLE IF NOT EXISTS public.page_visits (
  id BIGSERIAL PRIMARY KEY,
  ip_address INET,                    -- IP 地址
  country VARCHAR(100),                -- 国家名称（如：China）
  country_code VARCHAR(2),             -- 国家代码（如：CN）
  city VARCHAR(100),                    -- 城市（可选）
  user_agent TEXT,                     -- 浏览器信息
  page_path VARCHAR(255),               -- 访问的页面路径
  wallet_address VARCHAR(42),          -- 钱包地址（如果已连接）
  referrer VARCHAR(255),                -- 来源（推荐人地址或外部来源）
  language VARCHAR(10),                 -- 用户选择的语言
  is_mobile BOOLEAN DEFAULT FALSE,      -- 是否移动设备
  session_id VARCHAR(64),              -- 会话ID（用于去重）
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 2. 创建索引以优化查询性能
CREATE INDEX IF NOT EXISTS idx_page_visits_created_at ON public.page_visits(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_page_visits_country ON public.page_visits(country);
CREATE INDEX IF NOT EXISTS idx_page_visits_country_code ON public.page_visits(country_code);
CREATE INDEX IF NOT EXISTS idx_page_visits_wallet_address ON public.page_visits(wallet_address) WHERE wallet_address IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_page_visits_session_id ON public.page_visits(session_id);

-- 3. 添加注释
COMMENT ON TABLE public.page_visits IS '页面访问记录表，用于统计用户访问前端的相关信息';
COMMENT ON COLUMN public.page_visits.ip_address IS '访问者的 IP 地址';
COMMENT ON COLUMN public.page_visits.country IS '国家名称（从 IP 地理位置服务获取）';
COMMENT ON COLUMN public.page_visits.country_code IS '国家代码（ISO 3166-1 alpha-2）';
COMMENT ON COLUMN public.page_visits.city IS '城市名称（可选）';
COMMENT ON COLUMN public.page_visits.user_agent IS '浏览器 User-Agent 信息';
COMMENT ON COLUMN public.page_visits.page_path IS '访问的页面路径';
COMMENT ON COLUMN public.page_visits.wallet_address IS '钱包地址（如果用户已连接钱包）';
COMMENT ON COLUMN public.page_visits.referrer IS '来源（推荐人地址或外部来源）';
COMMENT ON COLUMN public.page_visits.language IS '用户选择的语言';
COMMENT ON COLUMN public.page_visits.is_mobile IS '是否移动设备';
COMMENT ON COLUMN public.page_visits.session_id IS '会话ID（用于去重，同一会话只记录一次）';

