-- 文件夹模式放开到夸克
--
-- 背景：原来触发器 enforce_folder_mode_pan 强制「不是光鸭 → folder_mode 一律置 false」，
-- 所以夸克订阅勾了「文件夹模式」等于没勾（边缘函数里的 sharePan === "guangya" 只是第二道门槛）。
--
-- 实测（分享 b24dfd9437e4）：夸克 sharepage/save 传「目录」可以整存，
--   · 落地的是一个同名文件夹 ✓
--   · 子目录结构完整保留 ✓
--   · 目标目录根下**不产生平铺副本** ✓（比光鸭还干净）
-- 因此放开到 quark 是安全的；其它网盘仍强制关闭。

create or replace function public.enforce_folder_mode_pan()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.pan not in ('guangya', 'quark') then
    new.folder_mode := false;
  end if;
  return new;
end
$$;

comment on function public.enforce_folder_mode_pan() is
  '文件夹模式支持光鸭与夸克；其它网盘一律置 false';
