-- 确保管理员角色
UPDATE public.profiles SET role = 'admin' WHERE email = 'admin@miaoda.com';

-- 将历史无主数据归属到管理员
UPDATE public.resources SET owner_id = '76e9944e-0a30-42f2-9406-5906668195cb' WHERE owner_id IS NULL;
UPDATE public.change_history SET user_id = '76e9944e-0a30-42f2-9406-5906668195cb' WHERE user_id IS NULL;

-- 设为非空并设置默认值（新插入时自动填充当前用户）
ALTER TABLE public.resources ALTER COLUMN owner_id SET NOT NULL;
ALTER TABLE public.resources ALTER COLUMN owner_id SET DEFAULT auth.uid();
ALTER TABLE public.change_history ALTER COLUMN user_id SET NOT NULL;
ALTER TABLE public.change_history ALTER COLUMN user_id SET DEFAULT auth.uid();