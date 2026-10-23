import React, { useEffect, useRef, useState } from 'react';
import { Loader2, Upload, Trash2, Clock, ShieldCheck, KeyRound, Eye, EyeOff, Crown, HardDrive } from 'lucide-react';
import { toast } from 'sonner';
import AppLayout from '@/components/layouts/AppLayout';
import PageMeta from '@/components/common/PageMeta';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Progress } from '@/components/ui/progress';
import { useAuth } from '@/contexts/AuthContext';
import { updateMyProfile, validateUsername, applySourceOwner, fetchMySourceOwnerStatus } from '@/services/api';
import { uploadAvatar } from '@/lib/uploadAvatar';
import type { MySourceOwnerStatus as OwnerStatus } from '@/types/index';
import StagingPage from '@/pages/StagingPage';

/** 「账号」只展示用户名部分：内建账号是 xxx@miaoda.com 形式，个人中心不展示邮箱域名 */
function accountNameOf(email?: string | null): string {
  if (!email) return '—';
  const local = email.split('@')[0];
  return local || email;
}

/** 源主申请时间：只展示到分钟，够用且不冗长 */
function formatTime(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

export default function ProfilePage() {
  const { profile, user, refreshProfile, changePassword } = useAuth();
  const [username, setUsername] = useState(profile?.username || '');
  const [savingName, setSavingName] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState(0);
  const fileRef = useRef<HTMLInputElement>(null);

  // 修改密码
  const [currentPwd, setCurrentPwd] = useState('');
  const [newPwd, setNewPwd] = useState('');
  const [confirmPwd, setConfirmPwd] = useState('');
  const [showPwd, setShowPwd] = useState(false);
  const [changingPwd, setChangingPwd] = useState(false);

  // 源主申请
  const [ownerStatusRow, setOwnerStatusRow] = useState<OwnerStatus | null>(null);
  const [loadingOwner, setLoadingOwner] = useState(true);
  const [ownerEditing, setOwnerEditing] = useState(false);
  const [ownerNote, setOwnerNote] = useState('');
  const [ownerDisplayNameInput, setOwnerDisplayNameInput] = useState('');
  const [applyingOwner, setApplyingOwner] = useState(false);

  const ownerStatus = ownerStatusRow?.status ?? 'none';
  /** 订阅源里展示的名字：优先自定义源主名，其次账号用户名 */
  const ownerDisplayName = ownerStatusRow?.display_name || profile?.username || '源主';

  useEffect(() => {
    setUsername(profile?.username || '');
  }, [profile?.username]);

  /** 拉取我的源主申请状态（失败静默：源主是附加功能，不该让整个个人中心报错） */
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const row = await fetchMySourceOwnerStatus();
        if (!cancelled) {
          setOwnerStatusRow(row);
          setOwnerDisplayNameInput(row.display_name || '');
        }
      } catch {
        if (!cancelled) setOwnerStatusRow(null);
      } finally {
        if (!cancelled) setLoadingOwner(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  async function handleApplyOwner() {
    setApplyingOwner(true);
    try {
      const r = await applySourceOwner({ note: ownerNote, displayName: ownerDisplayNameInput });
      const row = await fetchMySourceOwnerStatus();
      setOwnerStatusRow(row);
      setOwnerDisplayNameInput(row.display_name || '');
      setOwnerEditing(false);
      setOwnerNote('');
      toast.success(r.message || '申请已提交');
    } catch (e) {
      toast.error((e as Error).message || '提交申请失败');
    } finally {
      setApplyingOwner(false);
    }
  }

  const isAdmin = profile?.role === 'admin';
  const avatarUrl = profile?.avatar_url || null;
  const initial = (profile?.username || '用').charAt(0).toUpperCase();

  /** 会员/有效期文案 */
  const expiryText = (() => {
    if (isAdmin) return '管理员 · 永久有效';
    const expires = profile?.membership_expires_at;
    if (!expires) return '未设置';
    const expired = new Date(expires).getTime() <= Date.now();
    return expired ? `已过期（${new Date(expires).toLocaleDateString()}）` : `至 ${new Date(expires).toLocaleDateString()}`;
  })();

  async function handlePickAvatar(file: File) {
    if (!user?.id) {
      toast.error('未登录，无法上传头像');
      return;
    }
    setUploading(true);
    setProgress(0);
    try {
      const { url, size } = await uploadAvatar(file, user.id, setProgress);
      await updateMyProfile(user.id, { avatar_url: url });
      await refreshProfile();
      toast.success(`头像已更新（${(size / 1024).toFixed(0)} KB）`);
    } catch (e) {
      toast.error((e as Error).message || '头像上传失败');
    } finally {
      setUploading(false);
      setProgress(0);
    }
  }

  async function handleRemoveAvatar() {
    if (!user?.id) return;
    setUploading(true);
    try {
      await updateMyProfile(user.id, { avatar_url: null });
      await refreshProfile();
      toast.success('已移除头像');
    } catch (e) {
      toast.error((e as Error).message || '操作失败');
    } finally {
      setUploading(false);
    }
  }

  async function handleSaveUsername() {
    if (!user?.id) return;
    const err = validateUsername(username);
    if (err) {
      toast.error(err);
      return;
    }
    const next = username.trim();
    if (next === profile?.username) {
      toast.info('用户名没有变化');
      return;
    }
    setSavingName(true);
    try {
      await updateMyProfile(user.id, { username: next });
      await refreshProfile();
      toast.success('用户名已更新，下次登录请使用新用户名');
    } catch (e) {
      toast.error((e as Error).message || '保存失败，请重试');
    } finally {
      setSavingName(false);
    }
  }

  /** 修改密码：本地先把格式类问题拦掉，旧密码校验交给 AuthContext */
  async function handleChangePassword() {
    if (!currentPwd || !newPwd || !confirmPwd) {
      toast.info('请把三个密码输入框都填完整');
      return;
    }
    if (newPwd.length < 6) {
      toast.info('新密码至少 6 位');
      return;
    }
    if (newPwd === currentPwd) {
      toast.info('新密码不能与当前密码相同');
      return;
    }
    if (newPwd !== confirmPwd) {
      toast.info('两次输入的新密码不一致');
      return;
    }

    setChangingPwd(true);
    try {
      const { error } = await changePassword(currentPwd, newPwd);
      if (error) throw error;
      setCurrentPwd('');
      setNewPwd('');
      setConfirmPwd('');
      toast.success('密码已修改，下次登录请使用新密码');
    } catch (e) {
      toast.error((e as Error).message || '修改密码失败，请重试');
    } finally {
      setChangingPwd(false);
    }
  }

  return (
    <AppLayout>
      <PageMeta
        title="个人中心 - 网盘推广工具"
        description="修改头像、用户名与登录密码，查看账号与会员状态。"
        keywords="个人中心, 修改头像, 修改用户名, 修改密码, 更换密码, 账号设置"
      />

      <div className="p-4 md:p-6">
        <div className="mx-auto max-w-3xl space-y-4">
          <div>
            <h1 className="text-lg font-bold text-foreground">个人中心</h1>
            <p className="mt-0.5 text-xs text-muted-foreground">在这里修改你的头像、用户名与登录密码</p>
          </div>

          {/* 头像 */}
          <div className="rounded-xl border border-border bg-card p-5 md:p-6">
            <h2 className="text-sm font-semibold text-foreground">头像</h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              支持 JPG / PNG / WEBP / GIF，超过 1MB 自动压缩；上传后会自动方正裁剪
            </p>

            <div className="mt-4 flex items-center gap-5">
              <div className="h-20 w-20 shrink-0 overflow-hidden rounded-full bg-primary/15 ring-1 ring-border">
                {avatarUrl ? (
                  <img src={avatarUrl} alt="头像" className="h-full w-full object-cover" />
                ) : (
                  <span className="flex h-full w-full items-center justify-center text-2xl font-bold text-primary">
                    {initial}
                  </span>
                )}
              </div>
              <div className="flex flex-col items-start gap-2">
                <Button
                  size="sm"
                  onClick={() => fileRef.current?.click()}
                  disabled={uploading}
                  className="h-9 gap-1.5"
                >
                  {uploading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />}
                  {avatarUrl ? '更换头像' : '上传头像'}
                </Button>
                {avatarUrl && (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => void handleRemoveAvatar()}
                    disabled={uploading}
                    className="h-8 gap-1.5 text-xs text-muted-foreground hover:text-destructive"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                    移除头像
                  </Button>
                )}
              </div>
            </div>

            {uploading && <Progress value={progress} className="mt-4 h-1.5" />}

            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void handlePickAvatar(f);
                e.target.value = '';
              }}
            />
          </div>

          {/* 账号信息 */}
          <div className="rounded-xl border border-border bg-card p-5 md:p-6">
            <h2 className="text-sm font-semibold text-foreground">账号信息</h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              用户名用于登录，修改后请使用新用户名登录
            </p>

            <div className="mt-4 max-w-sm space-y-1.5">
              <Label htmlFor="profile-username" className="text-xs text-foreground">
                用户名
              </Label>
              <div className="flex items-center gap-2">
                <Input
                  id="profile-username"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  placeholder="字母、数字或下划线"
                  className="h-10 bg-input border-border"
                />
                <Button
                  size="sm"
                  onClick={() => void handleSaveUsername()}
                  disabled={savingName || username.trim() === (profile?.username || '')}
                  className="h-10 shrink-0 gap-1.5"
                >
                  {savingName && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                  保存
                </Button>
              </div>
              <p className="text-[11px] text-muted-foreground">
                仅支持字母、数字、下划线，长度 2-20 位
              </p>
            </div>

            <div className="mt-5 grid grid-cols-1 gap-3 border-t border-border pt-4 text-xs sm:grid-cols-3">
              <div>
                <div className="text-muted-foreground">账号</div>
                <div className="mt-0.5 truncate font-medium text-foreground">{accountNameOf(profile?.email)}</div>
              </div>
              <div>
                <div className="text-muted-foreground">角色</div>
                <div className="mt-0.5 font-medium text-foreground">{isAdmin ? '管理员' : '普通用户'}</div>
              </div>
              <div>
                <div className="flex items-center gap-1 text-muted-foreground">
                  <Clock className="h-3 w-3" />
                  有效期
                </div>
                <div className="mt-0.5 font-medium text-foreground">{expiryText}</div>
              </div>
            </div>
          </div>

          {/* 源主申请 */}
          <div className="rounded-xl border border-border bg-card p-5 md:p-6">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 className="flex items-center gap-1.5 text-sm font-semibold text-foreground">
                  <Crown className="h-4 w-4 text-primary" />
                  源主
                  {ownerStatus === 'approved' && (
                    <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-medium text-primary">
                      已认证
                    </span>
                  )}
                </h2>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  通过后，你「更新中」的资源会出现在其他用户的内置订阅源中
                </p>
              </div>
              {!loadingOwner && ownerStatus !== 'approved' && (
                <Button
                  size="sm"
                  onClick={() => setOwnerEditing((v) => !v)}
                  disabled={ownerStatus === 'pending'}
                  className="h-9 shrink-0 gap-1.5"
                >
                  {ownerStatus === 'pending' ? (
                    <>
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      审核中
                    </>
                  ) : (
                    <>
                      <Crown className="h-3.5 w-3.5" />
                      {ownerStatus === 'rejected' ? '重新申请' : '申请成为源主'}
                    </>
                  )}
                </Button>
              )}
            </div>

            {/* 状态说明 */}
            {!loadingOwner && ownerStatus === 'approved' && (
              <div className="mt-4 rounded-lg border border-border bg-muted/40 p-3 text-xs text-muted-foreground">
                你已是源主，订阅源里会展示「<span className="font-medium text-foreground">{ownerDisplayName}</span>」
                名下更新中的资源。
                {ownerStatusRow?.apply_note && (
                  <div className="mt-2 border-t border-border pt-2">
                    申请理由：{ownerStatusRow.apply_note}
                  </div>
                )}
              </div>
            )}

            {!loadingOwner && ownerStatus === 'pending' && (
              <div className="mt-4 rounded-lg border border-border bg-muted/40 p-3 text-xs text-muted-foreground">
                申请已提交，管理员审核通过后生效。
                {ownerStatusRow?.created_at && (
                  <div className="mt-1">申请时间：{formatTime(ownerStatusRow.created_at)}</div>
                )}
              </div>
            )}

            {!loadingOwner && ownerStatus === 'rejected' && (
              <div className="mt-4 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-xs text-muted-foreground">
                申请未通过
                {ownerStatusRow?.review_note && (
                  <div className="mt-1">原因：{ownerStatusRow.review_note}</div>
                )}
              </div>
            )}

            {/* 申请表 */}
            {ownerEditing && (
              <div className="mt-4 space-y-3 border-t border-border pt-4">
                <div className="max-w-sm space-y-1.5">
                  <Label htmlFor="owner-display-name" className="text-xs text-foreground">
                    源主名称（可选）
                  </Label>
                  <Input
                    id="owner-display-name"
                    value={ownerDisplayNameInput}
                    onChange={(e) => setOwnerDisplayNameInput(e.target.value)}
                    placeholder={profile?.username || '留空则使用账号用户名'}
                    className="h-10 bg-input border-border"
                  />
                  <p className="text-[11px] text-muted-foreground">
                    订阅源里其他用户看到的名字
                  </p>
                </div>
                <div className="max-w-sm space-y-1.5">
                  <Label htmlFor="owner-note" className="text-xs text-foreground">
                    申请理由
                  </Label>
                  <Textarea
                    id="owner-note"
                    value={ownerNote}
                    onChange={(e) => setOwnerNote(e.target.value)}
                    placeholder="简单介绍一下你的资源来源与更新情况"
                    rows={3}
                    className="bg-input border-border"
                  />
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    size="sm"
                    onClick={() => void handleApplyOwner()}
                    disabled={applyingOwner}
                    className="h-9 gap-1.5"
                  >
                    {applyingOwner && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                    提交申请
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setOwnerEditing(false)}
                    className="h-9"
                  >
                    取消
                  </Button>
                </div>
              </div>
            )}
          </div>

          {/* 修改密码 */}
          <div className="rounded-xl border border-border bg-card p-5 md:p-6">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 className="flex items-center gap-1.5 text-sm font-semibold text-foreground">
                  <KeyRound className="h-4 w-4 text-primary" />
                  修改密码
                </h2>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  需要先验证当前密码；修改成功后，下次登录请使用新密码
                </p>
              </div>
              <button
                type="button"
                onClick={() => setShowPwd((v) => !v)}
                className="flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              >
                {showPwd ? <EyeOff className="h-3 w-3" /> : <Eye className="h-3 w-3" />}
                {showPwd ? '隐藏' : '显示'}
              </button>
            </div>

            <div className="mt-4 grid max-w-lg grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="space-y-1.5 sm:col-span-2">
                <Label htmlFor="pwd-current" className="text-xs text-foreground">
                  当前密码
                </Label>
                <Input
                  id="pwd-current"
                  type={showPwd ? 'text' : 'password'}
                  value={currentPwd}
                  onChange={(e) => setCurrentPwd(e.target.value)}
                  placeholder="请输入当前使用的密码"
                  autoComplete="current-password"
                  className="h-10 bg-input border-border"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="pwd-new" className="text-xs text-foreground">
                  新密码
                </Label>
                <Input
                  id="pwd-new"
                  type={showPwd ? 'text' : 'password'}
                  value={newPwd}
                  onChange={(e) => setNewPwd(e.target.value)}
                  placeholder="至少 6 位"
                  autoComplete="new-password"
                  className="h-10 bg-input border-border"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="pwd-confirm" className="text-xs text-foreground">
                  确认新密码
                </Label>
                <Input
                  id="pwd-confirm"
                  type={showPwd ? 'text' : 'password'}
                  value={confirmPwd}
                  onChange={(e) => setConfirmPwd(e.target.value)}
                  placeholder="再输入一次新密码"
                  autoComplete="new-password"
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void handleChangePassword();
                  }}
                  className="h-10 bg-input border-border"
                />
              </div>
            </div>

            <Button
              size="sm"
              onClick={() => void handleChangePassword()}
              disabled={changingPwd}
              className="mt-4 h-10 gap-1.5"
            >
              {changingPwd ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <KeyRound className="h-3.5 w-3.5" />}
              确认修改
            </Button>
          </div>

          {/* 暂存空间 */}
          <div className="rounded-xl border border-border bg-card p-5 md:p-6">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 className="flex items-center gap-1.5 text-sm font-semibold text-foreground">
                  <HardDrive className="h-4 w-4 text-primary" />
                  暂存空间
                </h2>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  把光鸭网盘分享链接里的资源转存到这里，按容量管理自己的暂存文件
                </p>
              </div>
            </div>
            <div className="mt-4 space-y-4">
              <StagingPage />
            </div>
          </div>

          <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <ShieldCheck className="h-3.5 w-3.5" />
            修改仅作用于你自己的账号；角色、会员与功能权限由管理员设置，个人中心不可修改
          </p>
        </div>
      </div>
    </AppLayout>
  );
}
