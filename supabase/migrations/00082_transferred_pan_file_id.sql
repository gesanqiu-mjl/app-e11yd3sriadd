-- 给转存基线表加「网盘文件 id」列：清理同集旧版本时只删本订阅自己转存过的文件
--
-- 背景（真实事故：账号 gesanqiu / 醉梦）：
--   分享方更新了源文件（同名、体积变了）→ presentInDir 判定「同名不同体积 = 另一个版本」
--   → 把新版又转存了一份。目录里同一集就堆了 2~4 个文件（旧版 + 新版）。
--   手动删掉旧版也没用：下一轮目录里再没有同体积文件能证明「已存在」，
--   会被判成缺失、又转回来，永远删不掉。
--
-- 为什么需要这一列：
--   清理旧版本时必须能区分「这个文件是本订阅转存上去的」和「这是用户自己放在那儿的」。
--   否则用户自己收藏的同集 4K 会被订阅转的 1080p 顶掉而误删（数据安全问题）。
--   基线里记录转存成功时返回的网盘 fileId，清理时只在这些 id 里挑，绝不碰用户的文件。
--
-- 说明：老数据这一列是 NULL（历史转存没有回传 fileId），这些条目不会被当作
--       「本订阅的文件」参与删除，属于偏保守的方向 —— 可能少删，但不会误删。

alter table public.subscription_transferred
  add column if not exists pan_file_id text;

comment on column public.subscription_transferred.pan_file_id is
  '转存时网盘返回的文件 id；用于「同集旧版本清理」时确认该文件属于本订阅，避免误删用户自己的文件';

create index if not exists idx_subscription_transferred_pan_file_id
  on public.subscription_transferred (subscription_id, pan_file_id)
  where pan_file_id is not null;
