-- 管理员也应该只能看到自己的资源和历史，不需要全量访问策略
-- 删除后，管理员登录会走 Owner 策略（owner_id = uid()），与普通用户行为一致
DROP POLICY IF EXISTS "Admin full access resources" ON resources;
DROP POLICY IF EXISTS "Admin full access history" ON change_history;
-- profiles 表管理员全量访问保留（用于用户管理后台，不涉及资源数据）