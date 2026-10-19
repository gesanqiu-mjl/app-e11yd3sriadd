-- ============================================================
-- 资源新增/更新 → 自动生成短链（归属资源所有者），并提供给 API 查询
--
-- 背景：短链此前只在三种时机产生：①「短链管理」页手动创建 ②批量发帖（batch-post）按需创建
--       ③调 shortlink-api 时创建。**资源库里新增一条资源不会自动有短链**，
--       外部程序（插件/脚本）也因此没法「按资源」直接取到短链。
--
-- 本迁移做的事：
--   1) public.short_code_rand(prefix, len)      —— 与前端/函数同一套字符集生成短码
--   2) public.short_pan_prefix(url)             —— 光鸭 g / 夸克 q / 其它 x
--   3) public.ensure_short_links_for_resource() —— 给一个资源补齐缺失的短链（同账号同链接复用，幂等）
--   4) 触发器 resources_auto_short_links        —— resources 插入 / links|name 更新后自动补齐
--   5) 一次性回填现有资源的短链
--
-- 归属：短链属于**资源所有者**（user_id = resources.owner_id），点击统计算在资源主账号上；
--       其它账号要「自己的短链」可通过 shortlink-api 的 /resource 接口按调用方账号生成。
--
-- 安全性：ensure_short_links_for_resource 是 security definer 但只按资源所有者写自己名下短链，
--         不读任何其它用户数据；触发器里吞掉异常 —— 短链只是附送能力，绝不能影响资源写入。
-- ============================================================

-- ── 1. 短码生成（字符集与 src/services/shortlinks.ts 保持一致：去掉易混字符）──
create or replace function public.short_code_rand(p_prefix text default '', p_len integer default 6)
returns text
language plpgsql
volatile
as $$
declare
  v_alpha constant text := 'abcdefghjkmnpqrstuvwxyz23456789';
  v_out text := coalesce(p_prefix, '');
  v_n integer := greatest(1, coalesce(p_len, 6) - length(coalesce(p_prefix, '')));
  i integer;
begin
  for i in 1..v_n loop
    v_out := v_out || substr(v_alpha, 1 + floor(random() * length(v_alpha))::integer, 1);
  end loop;
  return v_out;
end;
$$;

comment on function public.short_code_rand(text, integer) is
  '生成短码（默认总长 6，前缀占位后补随机字符），字符集与前端一致';

-- ── 2. 网盘前缀 ──
create or replace function public.short_pan_prefix(p_url text)
returns text
language sql
immutable
as $$
  select case
    when coalesce(p_url, '') ilike '%guangya%' then 'g'
    when coalesce(p_url, '') ilike '%quark%'  then 'q'
    else 'x'
  end;
$$;

comment on function public.short_pan_prefix(text) is '按目标链接判断短码前缀：光鸭 g / 夸克 q / 其它 x';

-- ── 3. 给一个资源补齐短链（幂等：同账号同目标已有就跳过）──
create or replace function public.ensure_short_links_for_resource(p_resource_id uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  r public.resources%rowtype;
  l jsonb;
  v_url text;
  v_code text;
  v_cnt integer := 0;
  v_guard integer;
begin
  select * into r from public.resources where id = p_resource_id;
  if not found or r.owner_id is null then
    return 0;
  end if;

  for l in select * from jsonb_array_elements(coalesce(r.links, '[]'::jsonb)) loop
    v_url := btrim(coalesce(l ->> 'url', ''));
    -- 只处理 http(s) 链接
    if v_url = '' or v_url !~* '^https?://' then
      continue;
    end if;
    -- 同账号同目标已有短链 → 跳过（顺带把 resource_id / 标题补上，便于按资源查询）
    if exists (select 1 from public.short_links s where s.user_id = r.owner_id and s.target_url = v_url) then
      update public.short_links s
         set resource_id = coalesce(s.resource_id, r.id),
             title       = case when coalesce(s.title, '') = '' then r.name else s.title end,
             updated_at  = now()
       where s.user_id = r.owner_id and s.target_url = v_url;
      continue;
    end if;

    v_guard := 0;
    loop
      v_guard := v_guard + 1;
      v_code := public.short_code_rand(public.short_pan_prefix(v_url));
      begin
        insert into public.short_links (user_id, code, title, target_url, pan_name, resource_id)
        values (
          r.owner_id,
          v_code,
          coalesce(nullif(btrim(r.name), ''), v_url),
          v_url,
          nullif(btrim(coalesce(l ->> 'pan_name', '')), ''),
          r.id
        );
        v_cnt := v_cnt + 1;
        exit;
      exception
        when unique_violation then
          -- 短码撞车 → 换一个再试；连续 5 次失败说明异常，直接抛出（由触发器记录 warning）
          if v_guard >= 5 then
            raise;
          end if;
      end;
    end loop;
  end loop;

  return v_cnt;
end;
$$;

comment on function public.ensure_short_links_for_resource(uuid) is
  '为某条资源补齐缺失的短链（归属资源所有者，幂等），返回本次新建条数';

revoke all on function public.ensure_short_links_for_resource(uuid) from public, anon, authenticated;
grant execute on function public.ensure_short_links_for_resource(uuid) to service_role;

-- ── 4. 触发器：资源写入后自动补齐 ──
create or replace function public.trg_resources_auto_short_links()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  begin
    perform public.ensure_short_links_for_resource(new.id);
  exception when others then
    -- 短链失败不影响资源写入（只记 warning，便于排查）
    raise warning 'auto short link failed for resource %: %', new.id, sqlerrm;
  end;
  return new;
end;
$$;

drop trigger if exists resources_auto_short_links on public.resources;
create trigger resources_auto_short_links
after insert or update of links, name on public.resources
for each row
execute function public.trg_resources_auto_short_links();

-- ── 5. 回填现有资源（每资源每链接一条，幂等可重复执行）──
do $$
declare
  r record;
  total integer := 0;
begin
  for r in select id from public.resources loop
    total := total + public.ensure_short_links_for_resource(r.id);
  end loop;
  raise notice '回填完成：新建短链 % 条', total;
end $$;

-- 自检：资源链接总数 vs 已覆盖的短链条数（同账号同链接去重后）
select (select count(*) from public.short_links where resource_id is not null) as short_links_with_resource,
       (select count(*) from public.short_links) as short_links_total,
       (select count(distinct (r.owner_id, btrim(l ->> 'url')))
          from public.resources r
          cross join lateral jsonb_array_elements(coalesce(r.links, '[]'::jsonb)) as l
         where btrim(coalesce(l ->> 'url', '')) ~* '^https?://') as resource_links_total;
