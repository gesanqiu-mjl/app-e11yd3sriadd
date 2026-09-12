import React, { useEffect, useState, useCallback } from 'react';
import { Users, Film, History, Shield, ShieldOff, Loader2, Search, Ticket, Copy, CheckCheck, RefreshCw, Clock, Crown, Settings, Megaphone } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import AppLayout from '@/components/layouts/AppLayout';
import PageMeta from '@/components/common/PageMeta';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { toast } from 'sonner';
import {
  fetchAllProfiles,
  fetchAllResources,
  fetchAllHistory,
  updateProfileRole,
  updateProfileStatus,
  updateProfileMembership,
  fetchInviteCodes,
  createInviteCode,
  revokeInviteCode,
} from '@/services/api';
import type { Profile, AdminResource, AdminHistory, UserRole, InviteCode } from '@/types/index';
import LoginConfigTab from '@/components/LoginConfigTab';
import AnnouncementTab from '@/components/AnnouncementTab';

const MEMBERSHIP_OPTIONS = [
  { value: '7', label: '7 天' },
  { value: '30', label: '30 天' },
  { value: '90', label: '90 天' },
  { value: '365', label: '365 天' },
  { value: '3650', label: '10 年' },
  { value: '-1', label: '永久（无期限）' },
];

function fmtDate(iso: string) {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export default function AdminPage() {
  const { profile } = useAuth();

  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [resources, setResources] = useState<AdminResource[]>([]);
  const [history, setHistory] = useState<AdminHistory[]>([]);
  const [loading, setLoading] = useState(true);

  // 邀请码 state
  const [inviteCodes, setInviteCodes] = useState<InviteCode[]>([]);
  const [inviteLoading, setInviteLoading] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [genMembershipDays, setGenMembershipDays] = useState('30');
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [revokeTarget, setRevokeTarget] = useState<InviteCode | null>(null);
  const [revoking, setRevoking] = useState(false);

  // 会员管理 state
  const [membershipTarget, setMembershipTarget] = useState<Profile | null>(null);
  const [membershipDays, setMembershipDays] = useState('30');
  const [membershipSaving, setMembershipSaving] = useState(false);

  const [userFilter, setUserFilter] = useState('all');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');

  const [confirm, setConfirm] = useState<{ type: 'role' | 'status'; target: Profile } | null>(null);
  const [acting, setActing] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [p, r] = await Promise.all([fetchAllProfiles(), fetchAllResources()]);
      setProfiles(p);
      setResources(r);
    } catch {
      toast.error('加载数据失败，请重试');
    } finally {
      setLoading(false);
    }
  }, []);

  const loadInviteCodes = useCallback(async () => {
    setInviteLoading(true);
    try {
      const codes = await fetchInviteCodes();
      setInviteCodes(codes);
    } catch {
      toast.error('加载邀请码失败');
    } finally {
      setInviteLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { loadInviteCodes(); }, [loadInviteCodes]);

  async function loadHistory() {
    try {
      const h = await fetchAllHistory(startDate || undefined, endDate || undefined);
      setHistory(h);
    } catch {
      toast.error('加载历史记录失败');
    }
  }

  useEffect(() => {
    loadHistory();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [startDate, endDate]);

  async function handleGenerateCode() {
    setGenerating(true);
    try {
      const code = await createInviteCode(Number(genMembershipDays));
      if (code) {
        setInviteCodes((prev) => [code, ...prev]);
        toast.success(`邀请码 ${code.code} 已生成（会员 ${genMembershipDays === '-1' ? '永久' : genMembershipDays + ' 天'}）`);
      }
    } catch {
      toast.error('生成邀请码失败');
    } finally {
      setGenerating(false);
    }
  }

  async function handleSetMembership() {
    if (!membershipTarget) return;
    setMembershipSaving(true);
    try {
      await updateProfileMembership(membershipTarget.id, Number(membershipDays));
      toast.success(`已为「${membershipTarget.username || '该用户'}」设置会员${membershipDays === '-1' ? '（永久）' : ' ' + membershipDays + ' 天'}`);
      setMembershipTarget(null);
      await load();
    } catch {
      toast.error('设置会员失败，请重试');
    } finally {
      setMembershipSaving(false);
    }
  }

  async function handleCopyCode(code: InviteCode) {
    try {
      await navigator.clipboard.writeText(code.code);
      setCopiedId(code.id);
      setTimeout(() => setCopiedId(null), 2000);
    } catch {
      toast.error('复制失败，请手动复制');
    }
  }

  async function handleRevoke() {
    if (!revokeTarget) return;
    setRevoking(true);
    try {
      await revokeInviteCode(revokeTarget.id);
      setInviteCodes((prev) => prev.map((c) => c.id === revokeTarget.id ? { ...c, is_revoked: true } : c));
      toast.success('邀请码已撤销');
    } catch {
      toast.error('撤销失败，请重试');
    } finally {
      setRevoking(false);
      setRevokeTarget(null);
    }
  }

  async function handleConfirm() {
    if (!confirm) return;
    setActing(true);
    try {
      if (confirm.type === 'role') {
        const next: UserRole = confirm.target.role === 'admin' ? 'user' : 'admin';
        await updateProfileRole(confirm.target.id, next);
        toast.success(next === 'admin' ? '已设为管理员' : '已设为普通用户');
      } else {
        const next = confirm.target.status === 'active' ? 'disabled' : 'active';
        await updateProfileStatus(confirm.target.id, next);
        toast.success(next === 'active' ? '已启用账号' : '已禁用账号');
      }
      await load();
    } catch {
      toast.error('操作失败，请重试');
    } finally {
      setActing(false);
      setConfirm(null);
    }
  }

  function getCodeStatus(c: InviteCode): { label: string; color: string } {
    if (c.is_revoked) return { label: '已撤销', color: 'text-destructive' };
    if (c.used_by) return { label: '已使用', color: 'text-muted-foreground' };
    return { label: '未使用', color: 'text-secondary' };
  }

  if (profile?.role !== 'admin') {
    return (
      <AppLayout>
        <PageMeta
          title="系统管理后台 - 账号权限与系统配置"
          description="管理后台，支持用户角色权限配置、会员有效期管理、邀请码生成与系统登录配置。"
          keywords="管理后台, 用户管理, 角色权限, 邀请码, 系统配置"
        />
        <div className="flex items-center justify-center h-[60vh]">
          <div className="text-center">
            <ShieldOff className="h-10 w-10 text-muted-foreground mx-auto mb-3" />
            <p className="text-sm text-muted-foreground">无权访问管理后台</p>
          </div>
        </div>
      </AppLayout>
    );
  }

  const filteredResources = userFilter === 'all'
    ? resources
    : resources.filter((r) => r.owner_id === userFilter);
  const filteredHistory = userFilter === 'all'
    ? history
    : history.filter((h) => h.user_id === userFilter);

  const usedByName = (usedById: string | null) => {
    if (!usedById) return null;
    return profiles.find((p) => p.id === usedById)?.username ?? '已注销用户';
  };

  return (
    <AppLayout>
      <PageMeta
        title="系统管理后台 - 账号权限与系统配置管理"
        description="管理后台，支持用户角色权限配置、会员有效期管理、邀请码生成与系统登录配置。"
        keywords="管理后台, 用户管理, 角色权限, 邀请码, 系统配置"
      />
      <div className="p-4 md:p-8 max-w-7xl mx-auto">
        <div className="flex items-center gap-2.5 mb-6">
          <span className="flex items-center justify-center w-8 h-8 rounded-lg bg-primary/10 shrink-0">
            <Shield className="h-4 w-4 text-primary" />
          </span>
          <div>
            <h1 className="font-serif text-xl font-bold text-foreground">管理后台</h1>
            <p className="text-xs text-muted-foreground">管理系统用户、资源与修改记录</p>
          </div>
        </div>

        <Tabs defaultValue="users" className="w-full">
          <TabsList className="bg-muted h-9 flex-wrap gap-y-1">
            <TabsTrigger value="users" className="text-xs gap-1.5 data-[state=active]:bg-card">
              <Users className="h-3.5 w-3.5" /> 用户管理
            </TabsTrigger>
            <TabsTrigger value="invites" className="text-xs gap-1.5 data-[state=active]:bg-card">
              <Ticket className="h-3.5 w-3.5" /> 邀请码
            </TabsTrigger>
            <TabsTrigger value="resources" className="text-xs gap-1.5 data-[state=active]:bg-card">
              <Film className="h-3.5 w-3.5" /> 全部资源
            </TabsTrigger>
            <TabsTrigger value="history" className="text-xs gap-1.5 data-[state=active]:bg-card">
              <History className="h-3.5 w-3.5" /> 修改历史
            </TabsTrigger>
            <TabsTrigger value="login-config" className="text-xs gap-1.5 data-[state=active]:bg-card">
              <Settings className="h-3.5 w-3.5" /> 登录页设置
            </TabsTrigger>
            <TabsTrigger value="announcements" className="text-xs gap-1.5 data-[state=active]:bg-card">
              <Megaphone className="h-3.5 w-3.5" /> 公告管理
            </TabsTrigger>
          </TabsList>

          {/* 用户管理 */}
          <TabsContent value="users" className="mt-4">
            <div className="rounded-xl border border-border bg-card overflow-hidden">
              <div className="w-full max-w-full overflow-x-auto bg-card [&>div]:max-w-full">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="whitespace-nowrap">用户名</TableHead>
                      <TableHead className="whitespace-nowrap">角色</TableHead>
                      <TableHead className="whitespace-nowrap">会员状态</TableHead>
                      <TableHead className="whitespace-nowrap">状态</TableHead>
                      <TableHead className="whitespace-nowrap">注册时间</TableHead>
                      <TableHead className="whitespace-nowrap text-right">操作</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {loading ? (
                      <TableRow>
                        <TableCell colSpan={6} className="text-center py-12 text-sm text-muted-foreground">
                          <Loader2 className="h-4 w-4 animate-spin inline mr-2" />加载中…
                        </TableCell>
                      </TableRow>
                    ) : profiles.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={6} className="text-center py-12 text-sm text-muted-foreground">
                          暂无用户
                        </TableCell>
                      </TableRow>
                    ) : (
                      profiles.map((p) => {
                        const isActive = p.role === 'admin' || (p.membership_expires_at ? new Date(p.membership_expires_at).getTime() > Date.now() : false);
                        return (
                          <TableRow key={p.id}>
                            <TableCell className="whitespace-nowrap font-medium text-foreground">
                              {p.username || p.email || '—'}
                              {p.id === profile?.id && <span className="ml-1.5 text-xs text-muted-foreground">(我)</span>}
                            </TableCell>
                            <TableCell className="whitespace-nowrap">
                              {p.role === 'admin' ? (
                                <Badge className="bg-primary/15 text-primary border-0 hover:bg-primary/15">管理员</Badge>
                              ) : (
                                <Badge variant="secondary" className="bg-muted text-muted-foreground border-0 hover:bg-muted">普通用户</Badge>
                              )}
                            </TableCell>
                            <TableCell className="whitespace-nowrap">
                              {p.role === 'admin' ? (
                                <span className="text-xs text-primary">永久</span>
                              ) : isActive ? (
                                <span className="text-xs text-secondary">有效期至 {new Date(p.membership_expires_at as string).toLocaleDateString()}</span>
                              ) : (
                                <span className="text-xs text-destructive">已过期</span>
                              )}
                            </TableCell>
                            <TableCell className="whitespace-nowrap">
                              {p.status === 'active' ? (
                                <span className="text-xs text-secondary">正常</span>
                              ) : (
                                <span className="text-xs text-destructive">已禁用</span>
                              )}
                            </TableCell>
                            <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                              {fmtDate(p.created_at)}
                            </TableCell>
                            <TableCell className="whitespace-nowrap text-right">
                              <div className="flex justify-end gap-1.5 flex-wrap">
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  className="h-7 text-xs text-muted-foreground hover:text-foreground hover:bg-muted gap-1"
                                  onClick={() => {
                                    setMembershipTarget(p);
                                    setMembershipDays('30');
                                  }}
                                  disabled={p.role === 'admin'}
                                >
                                  <Crown className="h-3.5 w-3.5" />会员
                                </Button>
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  className="h-7 text-xs text-muted-foreground hover:text-foreground hover:bg-muted"
                                  onClick={() => setConfirm({ type: 'role', target: p })}
                                  disabled={p.id === profile?.id}
                                >
                                  {p.role === 'admin' ? '设为普通用户' : '设为管理员'}
                                </Button>
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  className={`h-7 text-xs hover:bg-muted ${p.status === 'active' ? 'text-destructive hover:text-destructive' : 'text-secondary hover:text-secondary'}`}
                                  onClick={() => setConfirm({ type: 'status', target: p })}
                                  disabled={p.id === profile?.id}
                                >
                                  {p.status === 'active' ? '禁用' : '启用'}
                                </Button>
                              </div>
                            </TableCell>
                          </TableRow>
                        );
                      })
                    )}
                  </TableBody>
                </Table>
              </div>
            </div>
          </TabsContent>

          {/* 邀请码管理 */}
          <TabsContent value="invites" className="mt-4">
            <div className="flex items-center justify-between mb-4 gap-3 flex-wrap">
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Ticket className="h-4 w-4 shrink-0" />
                <span>共 {inviteCodes.length} 个邀请码，未使用 {inviteCodes.filter((c) => !c.used_by && !c.is_revoked).length} 个</span>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-8 text-xs text-muted-foreground hover:text-foreground hover:bg-muted gap-1.5"
                  onClick={loadInviteCodes}
                  disabled={inviteLoading}
                >
                  <RefreshCw className={`h-3.5 w-3.5 ${inviteLoading ? 'animate-spin' : ''}`} />
                  刷新
                </Button>
                <Select value={genMembershipDays} onValueChange={setGenMembershipDays}>
                  <SelectTrigger className="w-28 h-8 bg-input border-border text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {MEMBERSHIP_OPTIONS.map((o) => (
                      <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Button
                  size="sm"
                  className="h-8 text-xs bg-primary text-primary-foreground hover:bg-primary/90 gap-1.5"
                  onClick={handleGenerateCode}
                  disabled={generating}
                >
                  {generating ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Ticket className="h-3.5 w-3.5" />}
                  生成邀请码
                </Button>
              </div>
            </div>
            <div className="rounded-xl border border-border bg-card overflow-hidden">
              <div className="w-full max-w-full overflow-x-auto bg-card [&>div]:max-w-full">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="whitespace-nowrap">邀请码</TableHead>
                      <TableHead className="whitespace-nowrap">会员时长</TableHead>
                      <TableHead className="whitespace-nowrap">状态</TableHead>
                      <TableHead className="whitespace-nowrap">使用者</TableHead>
                      <TableHead className="whitespace-nowrap">使用时间</TableHead>
                      <TableHead className="whitespace-nowrap">生成时间</TableHead>
                      <TableHead className="whitespace-nowrap text-right">操作</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {inviteLoading ? (
                      <TableRow>
                        <TableCell colSpan={7} className="text-center py-12 text-sm text-muted-foreground">
                          <Loader2 className="h-4 w-4 animate-spin inline mr-2" />加载中…
                        </TableCell>
                      </TableRow>
                    ) : inviteCodes.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={7} className="text-center py-12 text-sm text-muted-foreground">
                          暂无邀请码，点击「生成邀请码」创建
                        </TableCell>
                      </TableRow>
                    ) : (
                      inviteCodes.map((c) => {
                        const { label, color } = getCodeStatus(c);
                        const isCopied = copiedId === c.id;
                        return (
                          <TableRow key={c.id}>
                            <TableCell className="whitespace-nowrap font-mono font-bold text-foreground tracking-widest">
                              {c.code}
                            </TableCell>
                            <TableCell className="whitespace-nowrap text-sm text-muted-foreground">
                              {c.membership_days} 天
                            </TableCell>
                            <TableCell className="whitespace-nowrap">
                              <span className={`text-xs ${color}`}>{label}</span>
                            </TableCell>
                            <TableCell className="whitespace-nowrap text-sm text-muted-foreground">
                              {usedByName(c.used_by) ?? '—'}
                            </TableCell>
                            <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                              {c.used_at ? fmtDate(c.used_at) : '—'}
                            </TableCell>
                            <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                              {fmtDate(c.created_at)}
                            </TableCell>
                            <TableCell className="whitespace-nowrap text-right">
                              <div className="flex justify-end gap-1.5">
                                {!c.used_by && !c.is_revoked && (
                                  <>
                                    <Button
                                      variant="ghost"
                                      size="sm"
                                      className="h-7 text-xs text-muted-foreground hover:text-foreground hover:bg-muted gap-1"
                                      onClick={() => handleCopyCode(c)}
                                    >
                                      {isCopied ? <CheckCheck className="h-3.5 w-3.5 text-secondary" /> : <Copy className="h-3.5 w-3.5" />}
                                      {isCopied ? '已复制' : '复制'}
                                    </Button>
                                    <Button
                                      variant="ghost"
                                      size="sm"
                                      className="h-7 text-xs text-destructive hover:text-destructive hover:bg-muted"
                                      onClick={() => setRevokeTarget(c)}
                                    >
                                      撤销
                                    </Button>
                                  </>
                                )}
                              </div>
                            </TableCell>
                          </TableRow>
                        );
                      })
                    )}
                  </TableBody>
                </Table>
              </div>
            </div>
          </TabsContent>

          {/* 全部资源 */}
          <TabsContent value="resources" className="mt-4">
            <div className="flex flex-col md:flex-row md:items-center gap-3 mb-4">
              <div className="flex items-center gap-2 min-w-0">
                <Search className="h-4 w-4 text-muted-foreground shrink-0" />
                <span className="text-sm text-muted-foreground">共 {filteredResources.length} 条资源</span>
              </div>
              <Select value={userFilter} onValueChange={setUserFilter}>
                <SelectTrigger className="w-full md:w-48 h-9 bg-input border-border">
                  <SelectValue placeholder="按用户筛选" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">全部用户</SelectItem>
                  {profiles.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.username || '未命名'}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="rounded-xl border border-border bg-card overflow-hidden">
              <div className="w-full max-w-full overflow-x-auto bg-card [&>div]:max-w-full">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="whitespace-nowrap">资源名称</TableHead>
                      <TableHead className="whitespace-nowrap">集数</TableHead>
                      <TableHead className="whitespace-nowrap">所属用户</TableHead>
                      <TableHead className="whitespace-nowrap">链接</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filteredResources.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={4} className="text-center py-12 text-sm text-muted-foreground">
                          暂无资源
                        </TableCell>
                      </TableRow>
                    ) : (
                      filteredResources.map((r) => (
                        <TableRow key={r.id}>
                          <TableCell className="whitespace-nowrap max-w-xs truncate font-medium text-foreground">
                            {r.name || '—'}
                          </TableCell>
                          <TableCell className="whitespace-nowrap text-sm">{r.episode_count}</TableCell>
                          <TableCell className="whitespace-nowrap text-sm text-muted-foreground">
                            {r.owner_name || '—'}
                          </TableCell>
                          <TableCell className="whitespace-nowrap max-w-xs">
                            {r.link ? (
                              <a href={r.link} target="_blank" rel="noreferrer" className="text-xs text-primary hover:underline truncate inline-block max-w-[200px] align-bottom">
                                {r.link}
                              </a>
                            ) : '—'}
                          </TableCell>
                        </TableRow>
                      ))
                    )}
                  </TableBody>
                </Table>
              </div>
            </div>
          </TabsContent>

          {/* 修改历史 */}
          <TabsContent value="history" className="mt-4">
            <div className="flex flex-col md:flex-row md:items-center gap-3 mb-4">
              <Select value={userFilter} onValueChange={setUserFilter}>
                <SelectTrigger className="w-full md:w-48 h-9 bg-input border-border">
                  <SelectValue placeholder="按用户筛选" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">全部用户</SelectItem>
                  {profiles.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.username || '未命名'}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <div className="flex items-center gap-2">
                <Input
                  type="date"
                  value={startDate}
                  onChange={(e) => setStartDate(e.target.value)}
                  className="w-36 h-9 bg-input border-border text-sm"
                />
                <span className="text-xs text-muted-foreground">至</span>
                <Input
                  type="date"
                  value={endDate}
                  onChange={(e) => setEndDate(e.target.value)}
                  className="w-36 h-9 bg-input border-border text-sm"
                />
              </div>
            </div>
            <div className="rounded-xl border border-border bg-card overflow-hidden">
              <div className="w-full max-w-full overflow-x-auto bg-card [&>div]:max-w-full">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="whitespace-nowrap">修改时间</TableHead>
                      <TableHead className="whitespace-nowrap">用户</TableHead>
                      <TableHead className="whitespace-nowrap">资源名称</TableHead>
                      <TableHead className="whitespace-nowrap">字段</TableHead>
                      <TableHead className="whitespace-nowrap">原值</TableHead>
                      <TableHead className="whitespace-nowrap">新值</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filteredHistory.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={6} className="text-center py-12 text-sm text-muted-foreground">
                          暂无修改记录
                        </TableCell>
                      </TableRow>
                    ) : (
                      filteredHistory.map((h) => (
                        <TableRow key={h.id}>
                          <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                            {fmtDate(h.changed_at)}
                          </TableCell>
                          <TableCell className="whitespace-nowrap text-sm">{h.username || '—'}</TableCell>
                          <TableCell className="whitespace-nowrap max-w-xs truncate text-sm">{h.resource_name || '—'}</TableCell>
                          <TableCell className="whitespace-nowrap text-sm">{h.field_label}</TableCell>
                          <TableCell className="whitespace-nowrap max-w-[140px] truncate text-sm text-muted-foreground">{h.old_value || '空'}</TableCell>
                          <TableCell className="whitespace-nowrap max-w-[140px] truncate text-sm text-primary">{h.new_value || '空'}</TableCell>
                        </TableRow>
                      ))
                    )}
                  </TableBody>
                </Table>
              </div>
            </div>
          </TabsContent>

          {/* 登录页设置 */}
          <TabsContent value="login-config" className="mt-4">
            <div className="rounded-xl border border-border bg-card p-4 md:p-6">
              <LoginConfigTab />
            </div>
          </TabsContent>
          <TabsContent value="announcements" className="mt-4">
            <AnnouncementTab />
          </TabsContent>
        </Tabs>
      </div>

      {/* 用户操作确认弹窗 */}
      <AlertDialog open={!!confirm} onOpenChange={(o) => !o && setConfirm(null)}>
        <AlertDialogContent className="max-w-[calc(100%-2rem)] md:max-w-md bg-card border-border">
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirm?.type === 'role'
                ? confirm.target.role === 'admin' ? '设为普通用户？' : '设为管理员？'
                : confirm?.target.status === 'active' ? '禁用该账号？' : '启用该账号？'}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirm?.type === 'status' && confirm.target.status === 'active'
                ? `禁用后「${confirm.target.username || '该用户'}」将无法登录系统。`
                : `确认对「${confirm?.target.username || '该用户'}」执行此操作？`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleConfirm}
              disabled={acting}
              className="bg-primary text-primary-foreground hover:bg-primary/90"
            >
              {acting && <Loader2 className="h-4 w-4 animate-spin mr-1.5" />}
              确认
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* 撤销邀请码确认弹窗 */}
      <AlertDialog open={!!revokeTarget} onOpenChange={(o) => !o && setRevokeTarget(null)}>
        <AlertDialogContent className="max-w-[calc(100%-2rem)] md:max-w-md bg-card border-border">
          <AlertDialogHeader>
            <AlertDialogTitle>撤销邀请码？</AlertDialogTitle>
            <AlertDialogDescription>
              邀请码 <span className="font-mono font-bold">{revokeTarget?.code}</span> 撤销后将无法被使用，此操作不可恢复。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleRevoke}
              disabled={revoking}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {revoking && <Loader2 className="h-4 w-4 animate-spin mr-1.5" />}
              确认撤销
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* 设置会员时长弹窗 */}
      <Dialog open={!!membershipTarget} onOpenChange={(o) => !o && setMembershipTarget(null)}>
        <DialogContent className="max-w-[calc(100%-2rem)] md:max-w-md bg-card border-border">
          <DialogHeader>
            <DialogTitle>设置会员时长</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              为「{membershipTarget?.username || '该用户'}」设置会员有效期，到期后编辑功能将被锁定。
            </p>
            <div className="space-y-1.5">
              <Label className="text-sm text-foreground">会员时长</Label>
              <Select value={membershipDays} onValueChange={setMembershipDays}>
                <SelectTrigger className="h-9 bg-input border-border">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {MEMBERSHIP_OPTIONS.map((o) => (
                    <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setMembershipTarget(null)} className="border-border text-muted-foreground hover:text-foreground hover:bg-muted">
              取消
            </Button>
            <Button onClick={handleSetMembership} disabled={membershipSaving} className="bg-primary text-primary-foreground hover:bg-primary/90 gap-1.5">
              {membershipSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Clock className="h-4 w-4" />}
              确认设置
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </AppLayout>
  );
}
