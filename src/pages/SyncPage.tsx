import React, { useState, useEffect, useCallback } from 'react';
import {
  RefreshCw, Link2, Unlink, Loader2, Pencil, Trash2, UploadCloud, Info, Tv2, Drama,
  User, Award, CalendarCheck, HardDrive, Star, LogIn,
} from 'lucide-react';
import AppLayout from '@/components/layouts/AppLayout';
import PageMeta from '@/components/common/PageMeta';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { toast } from 'sonner';
import {
  getPinglianBinding, loginPinglian, unbindPinglian,
  loadPanLinks, updatePanLink, deletePanLink,
  getXnBinding, bindXnCookie, unbindXn,
  loadXnShares, editXnShare, delXnShare,
  XN_COOKIE_EXPIRED_CODE,
  getYaBinding, bindYaAccount, unbindYa,
  fetchYaShareRecords, yaGetAccountStatus,
  YA_EXPIRED_CODE,
  getFramehdrBinding, bindFramehdrCookie, unbindFramehdr, loginFramehdr,
  loadFramehdrLinks, editFramehdrLink, deleteFramehdrLink,
  FRAMEHDR_COOKIE_EXPIRED_CODE,
  getPanfxBinding, bindPanfxCookie, unbindPanfx, loadPanfxPosts,
  PANFX_COOKIE_EXPIRED_CODE,
  getMukakuStatus, fetchMukakuCaptcha, bindMukaku, unbindMukaku,
  fetchMukakuResources, searchMukakuMovies, getMukakuMovieDetail,
  addMukakuResource, updateMukakuResource, deleteMukakuResource,
  MUKAKU_TOKEN_EXPIRED_CODE,
} from '@/services/api';
import type {
  PinglianBinding, PinglianLink, XnBinding, XnShare, YaBinding, YaLink,
  YaAccountStatus, FramehdrBinding, FramehdrLink, PanfxBinding,
  MukakuBinding, MukakuCaptcha, MukakuWpResource, MukakuMovie,
} from '@/types/index';

const PINGLIAN_EXPIRED_CODE = 'PINGLIAN_COOKIE_EXPIRED';

function AccountStat({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className="rounded-lg bg-muted/40 p-3 text-center min-w-0">
      <div className="flex items-center justify-center gap-1 text-[11px] text-muted-foreground mb-1">
        {icon}
        <span className="truncate">{label}</span>
      </div>
      <div className="text-sm font-semibold text-foreground truncate">{value}</div>
    </div>
  );
}
const PAN_TYPES = [
  { value: 'quark', label: '夸克' },
  { value: 'aliyun', label: '阿里云盘' },
  { value: 'baidu', label: '百度网盘' },
  { value: '123', label: '123 网盘' },
  { value: 'mobile', label: '移动云盘' },
  { value: 'tianyi', label: '天翼云盘' },
  { value: '115', label: '115 网盘' },
  { value: 'uc', label: 'UC 网盘' },
  { value: 'xunlei', label: '迅雷云盘' },
  { value: 'weiyun', label: '微云' },
  { value: 'lanzou', label: '蓝奏云' },
  { value: 'jianguoyun', label: '坚果云' },
  { value: 'pikpak', label: 'PikPak' },
  { value: 'guangya', label: '光雅' },
  { value: 'others', label: '其他' },
];

const XN_DIRIDS = [
  { value: 'all', label: '全部' },
  { value: '1', label: '电影' },
  { value: '2', label: '剧集' },
  { value: '3', label: '动漫' },
];

function fmtDate(iso?: string | null) {
  if (!iso) return '—';
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// ─── 盘链标签页 ─────────────────────────────────────────────
function PinglianTab() {
  const [binding, setBinding] = useState<PinglianBinding | null>(null);
  const [bindingLoading, setBindingLoading] = useState(true);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [binding_, setBinding_] = useState(false);
  const [links, setLinks] = useState<PinglianLink[]>([]);
  const [listLoading, setListLoading] = useState(false);
  const [editTarget, setEditTarget] = useState<PinglianLink | null>(null);
  const [editTitle, setEditTitle] = useState('');
  const [editUrl, setEditUrl] = useState('');
  const [editPwd, setEditPwd] = useState('');
  const [editType, setEditType] = useState('quark');
  const [editSaving, setEditSaving] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<PinglianLink | null>(null);
  const [deleting, setDeleting] = useState(false);

  const loadBinding = useCallback(async () => {
    setBindingLoading(true);
    try {
      const info = await getPinglianBinding();
      setBinding(info);
    } catch { toast.error('加载绑定信息失败'); }
    finally { setBindingLoading(false); }
  }, []);

  const loadLinks = useCallback(async () => {
    setListLoading(true);
    try {
      const data = await loadPanLinks();
      setLinks(data);
    } catch (e) {
      const err = e as Error & { code?: string };
      if (err.code === PINGLIAN_EXPIRED_CODE) {
        toast.error('盘链登录已过期，请重新登录盘链账号');
        setBinding((b) => b ? { ...b, status: 'expired' } : b);
      } else {
        toast.error(err.message || '加载发布记录失败');
      }
    } finally { setListLoading(false); }
  }, []);

  useEffect(() => { loadBinding(); }, [loadBinding]);
  useEffect(() => {
    if (binding?.status === 'active') loadLinks();
    else setLinks([]);
  }, [binding?.status, loadLinks]);

  async function handleBind() {
    if (!username.trim() || !password) { toast.error('请输入盘链账号和密码'); return; }
    setBinding_(true);
    try {
      await loginPinglian(username.trim(), password);
      toast.success('盘链账号登录成功，资源更新时将自动同步');
      setUsername('');
      setPassword('');
      await loadBinding();
    } catch (e) {
      toast.error((e as Error).message || '登录失败，请检查账号密码');
    } finally { setBinding_(false); }
  }

  async function handleUnbind() {
    setBinding_(true);
    try {
      await unbindPinglian();
      toast.success('已解绑');
      setBinding(null);
      setLinks([]);
    } catch { toast.error('解绑失败'); }
    finally { setBinding_(false); }
  }

  function openEdit(link: PinglianLink) {
    setEditTarget(link);
    setEditTitle(link.title);
    setEditUrl(link.url);
    setEditPwd(link.password ?? '');
    setEditType(link.pan_type || 'quark');
  }

  async function handleSaveEdit() {
    if (!editTarget) return;
    if (!editTitle.trim() || !editUrl.trim()) { toast.error('标题和链接不能为空'); return; }
    setEditSaving(true);
    try {
      await updatePanLink({
        link_id: editTarget.id,
        link_title: editTitle.trim(),
        link_url: editUrl.trim(),
        link_password: editPwd.trim(),
        pan_type: editType,
      });
      toast.success('更新成功');
      setEditTarget(null);
      await loadLinks();
    } catch (e) {
      const err = e as Error & { code?: string };
      if (err.code === PINGLIAN_EXPIRED_CODE) {
        toast.error('盘链登录已过期，请重新绑定 Cookie');
        setBinding((b) => b ? { ...b, status: 'expired' } : b);
      } else { toast.error(err.message || '更新失败'); }
    } finally { setEditSaving(false); }
  }

  async function handleDelete() {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await deletePanLink(deleteTarget.id);
      toast.success('已删除');
      setDeleteTarget(null);
      await loadLinks();
    } catch (e) {
      const err = e as Error & { code?: string };
      if (err.code === PINGLIAN_EXPIRED_CODE) {
        toast.error('盘链登录已过期，请重新绑定 Cookie');
        setBinding((b) => b ? { ...b, status: 'expired' } : b);
      } else { toast.error(err.message || '删除失败'); }
    } finally { setDeleting(false); }
  }

  const isBound = binding?.status === 'active';
  const isExpired = binding?.status === 'expired';

  return (
    <div className="space-y-6">
      {/* 绑定区 */}
      <div className="rounded-xl border border-border bg-card p-4 md:p-6">
        <div className="flex items-center justify-between mb-4 gap-3 flex-wrap">
          <div className="flex items-center gap-2">
            <Link2 className="h-4 w-4 text-primary shrink-0" />
            <h2 className="font-serif text-base font-bold text-foreground">盘链账号绑定</h2>
          </div>
          {bindingLoading ? (
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
          ) : isBound ? (
            <Badge className="bg-secondary/15 text-secondary border-0 hover:bg-secondary/15">已绑定 · 正常</Badge>
          ) : isExpired ? (
            <Badge className="bg-destructive/15 text-destructive border-0 hover:bg-destructive/15">已过期</Badge>
          ) : (
            <Badge variant="secondary" className="bg-muted text-muted-foreground border-0">未绑定</Badge>
          )}
        </div>

        {isBound && (
          <div className="mb-4 p-3 rounded-lg bg-muted/60 text-xs text-muted-foreground">
            盘链账号「{binding?.username || '未知'}」正常（最近检测：{fmtDate(binding?.last_check_at)}）
          </div>
        )}
        {isExpired && (
          <div className="mb-4 p-3 rounded-lg bg-destructive/10 text-xs text-destructive">
            盘链登录已过期，请重新输入账号密码登录。
          </div>
        )}

        <div className="space-y-3">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label className="text-sm text-foreground">盘链账号</Label>
              <Input
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="pinglian.lol 账号"
                autoComplete="username"
                className="h-9 px-3 text-sm bg-input border-border focus-visible:ring-primary/40"
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-sm text-foreground">密码</Label>
              <Input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="pinglian.lol 密码"
                autoComplete="current-password"
                className="h-9 px-3 text-sm bg-input border-border focus-visible:ring-primary/40"
              />
            </div>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <Button onClick={handleBind} disabled={binding_}
              className="h-9 bg-primary text-primary-foreground hover:bg-primary/90 gap-1.5">
              {binding_ ? <Loader2 className="h-4 w-4 animate-spin" /> : <LogIn className="h-4 w-4" />}
              {isBound || isExpired ? '重新登录' : '登录绑定'}
            </Button>
            {(isBound || isExpired) && (
              <Button variant="outline" onClick={handleUnbind} disabled={binding_}
                className="h-9 border-border text-muted-foreground hover:text-foreground hover:bg-muted gap-1.5">
                <Unlink className="h-4 w-4" />解绑
              </Button>
            )}
          </div>
        </div>
        <div className="mt-4 flex items-start gap-2 p-3 rounded-lg bg-muted/40 text-xs text-muted-foreground">
          <Info className="h-3.5 w-3.5 shrink-0 mt-0.5" />
          <span>输入你在 pinglian.lol 的<strong>账号和密码</strong>即可完成绑定，服务端会安全地模拟登录并保存会话，<strong>密码不会落库</strong>。会话过期后只需重新输入密码登录一次即可恢复。</span>
        </div>
      </div>

      {/* 发布记录区 */}
      {isBound && (
        <div className="rounded-xl border border-border bg-card overflow-hidden">
          <div className="flex items-center justify-between px-4 md:px-6 py-4 border-b border-border gap-3 flex-wrap">
            <div className="flex items-center gap-2 min-w-0">
              <UploadCloud className="h-4 w-4 text-muted-foreground shrink-0" />
              <h2 className="font-serif text-base font-bold text-foreground">站点发布记录</h2>
              <span className="text-xs text-muted-foreground">{links.length} 条</span>
            </div>
            <Button variant="ghost" size="sm" onClick={loadLinks} disabled={listLoading}
              className="h-8 text-xs text-muted-foreground hover:text-foreground hover:bg-muted gap-1.5">
              <RefreshCw className={`h-3.5 w-3.5 ${listLoading ? 'animate-spin' : ''}`} />刷新
            </Button>
          </div>
          {listLoading ? (
            <div className="py-16 text-center text-sm text-muted-foreground">
              <Loader2 className="h-5 w-5 animate-spin inline mr-2" />加载中…
            </div>
          ) : links.length === 0 ? (
            <div className="py-16 text-center text-sm text-muted-foreground">暂无发布记录</div>
          ) : (
            <div className="w-full max-w-full overflow-x-auto bg-card">
              <table className="w-full min-w-max text-sm">
                <thead>
                  <tr className="border-b border-border bg-card">
                    <th className="px-4 py-3 text-left text-xs font-semibold text-muted-foreground whitespace-nowrap min-w-48">标题</th>
                    <th className="px-4 py-3 text-left text-xs font-semibold text-muted-foreground whitespace-nowrap min-w-16">网盘</th>
                    <th className="px-4 py-3 text-left text-xs font-semibold text-muted-foreground whitespace-nowrap min-w-40">链接</th>
                    <th className="px-4 py-3 text-left text-xs font-semibold text-muted-foreground whitespace-nowrap">更新时间</th>
                    <th className="px-4 py-3 text-right text-xs font-semibold text-muted-foreground whitespace-nowrap">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {links.map((link) => (
                    <tr key={link.id} className="border-b border-border/50 hover:bg-muted/20">
                      <td className="px-4 py-3 whitespace-nowrap font-medium text-foreground max-w-xs truncate">{link.title || '—'}</td>
                      <td className="px-4 py-3 whitespace-nowrap">
                        <Badge variant="secondary" className="bg-muted text-muted-foreground border-0 text-xs">
                          {PAN_TYPES.find((t) => t.value === link.pan_type)?.label ?? link.pan_type}
                        </Badge>
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap max-w-xs">
                        {link.url ? (
                          <a href={link.url} target="_blank" rel="noreferrer"
                            className="text-xs text-primary hover:underline truncate inline-block max-w-[200px] align-bottom">
                            {link.url}
                          </a>
                        ) : '—'}
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap text-xs text-muted-foreground">{fmtDate(link.updated_at)}</td>
                      <td className="px-4 py-3 whitespace-nowrap text-right">
                        <div className="flex justify-end gap-1.5">
                          <Button variant="ghost" size="sm" onClick={() => openEdit(link)}
                            className="h-7 text-xs text-muted-foreground hover:text-foreground hover:bg-muted gap-1">
                            <Pencil className="h-3.5 w-3.5" />修改
                          </Button>
                          <Button variant="ghost" size="sm" onClick={() => setDeleteTarget(link)}
                            className="h-7 text-xs text-destructive hover:text-destructive hover:bg-muted">
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* 编辑弹窗 */}
      <Dialog open={!!editTarget} onOpenChange={(o) => !o && setEditTarget(null)}>
        <DialogContent className="max-w-[calc(100%-2rem)] md:max-w-lg bg-card border-border">
          <DialogHeader><DialogTitle>修改发布记录</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label className="text-sm text-foreground">标题</Label>
              <Input value={editTitle} onChange={(e) => setEditTitle(e.target.value)}
                placeholder="如：XX剧 更新至第20集"
                className="h-9 px-3 text-sm bg-input border-border focus-visible:ring-primary/40" />
            </div>
            <div className="space-y-1.5">
              <Label className="text-sm text-foreground">网盘链接</Label>
              <Input value={editUrl} onChange={(e) => setEditUrl(e.target.value)}
                placeholder="新的网盘分享链接"
                className="h-9 px-3 text-sm bg-input border-border focus-visible:ring-primary/40" />
            </div>
            <div className="space-y-1.5">
              <Label className="text-sm text-foreground">提取码（可选）</Label>
              <Input value={editPwd} onChange={(e) => setEditPwd(e.target.value)}
                placeholder="无则留空"
                className="h-9 px-3 text-sm bg-input border-border focus-visible:ring-primary/40" />
            </div>
            <div className="space-y-1.5">
              <Label className="text-sm text-foreground">网盘类型</Label>
              <Select value={editType} onValueChange={setEditType}>
                <SelectTrigger className="h-9 bg-input border-border"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {PAN_TYPES.map((t) => <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditTarget(null)}
              className="border-border text-muted-foreground hover:text-foreground hover:bg-muted">取消</Button>
            <Button onClick={handleSaveEdit} disabled={editSaving}
              className="bg-primary text-primary-foreground hover:bg-primary/90 gap-1.5">
              {editSaving && <Loader2 className="h-4 w-4 animate-spin" />}保存
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={!!deleteTarget} onOpenChange={(o) => !o && setDeleteTarget(null)}>
        <AlertDialogContent className="max-w-[calc(100%-2rem)] md:max-w-md bg-card border-border">
          <AlertDialogHeader>
            <AlertDialogTitle>删除发布记录？</AlertDialogTitle>
            <AlertDialogDescription>
              删除后「{deleteTarget?.title}」将从盘链站点移除，此操作不可恢复。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction onClick={handleDelete} disabled={deleting}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90">
              {deleting && <Loader2 className="h-4 w-4 animate-spin mr-1.5" />}确认删除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

// ─── 观影站点标签页 ──────────────────────────────────────────
function XnSiteTab() {
  const [binding, setBinding] = useState<XnBinding | null>(null);
  const [bindingLoading, setBindingLoading] = useState(true);
  const [cookie, setCookie] = useState('');
  const [remark, setRemark] = useState('');
  const [binding_, setBinding_] = useState(false);

  const [shares, setShares] = useState<XnShare[]>([]);
  const [listLoading, setListLoading] = useState(false);
  const [dirid, setDirid] = useState('all');
  const [search, setSearch] = useState('');

  const [editTarget, setEditTarget] = useState<XnShare | null>(null);
  const [editTitle, setEditTitle] = useState('');
  const [editUrl, setEditUrl] = useState('');
  const [editPwd, setEditPwd] = useState('');
  const [editIs, setEditIs] = useState('1');
  const [editSaving, setEditSaving] = useState(false);

  const [deleteTarget, setDeleteTarget] = useState<XnShare | null>(null);
  const [deleting, setDeleting] = useState(false);

  const handleExpired = useCallback(() => {
    toast.error('观影站点登录已过期，请重新绑定 Cookie');
    setBinding((b) => b ? { ...b, status: 'expired' } : b);
  }, []);

  const loadBinding = useCallback(async () => {
    setBindingLoading(true);
    try {
      const info = await getXnBinding();
      setBinding(info);
      if (info?.remark) setRemark(info.remark);
    } catch { toast.error('加载观影站点绑定信息失败'); }
    finally { setBindingLoading(false); }
  }, []);

  const loadShares = useCallback(async () => {
    setListLoading(true);
    try {
      const { list } = await loadXnShares({
        dirid: dirid === 'all' ? '' : dirid,
        search: search.trim(),
      });
      setShares(list);
    } catch (e) {
      const err = e as Error & { code?: string };
      if (err.code === XN_COOKIE_EXPIRED_CODE) handleExpired();
      else toast.error(err.message || '加载分享记录失败');
    } finally { setListLoading(false); }
  }, [dirid, search, handleExpired]);

  useEffect(() => { loadBinding(); }, [loadBinding]);
  useEffect(() => {
    if (binding?.status === 'active') loadShares();
    else setShares([]);
  }, [binding?.status, loadShares]);

  async function handleBind() {
    if (!cookie.trim()) { toast.error('请粘贴站点 Cookie'); return; }
    setBinding_(true);
    try {
      await bindXnCookie(cookie.trim(), remark.trim());
      toast.success('绑定成功');
      setCookie('');
      await loadBinding();
    } catch { toast.error('绑定失败，请检查 Cookie 是否正确'); }
    finally { setBinding_(false); }
  }

  async function handleUnbind() {
    setBinding_(true);
    try {
      await unbindXn();
      toast.success('已解绑');
      setBinding(null);
      setShares([]);
    } catch { toast.error('解绑失败'); }
    finally { setBinding_(false); }
  }

  function openEdit(share: XnShare) {
    setEditTarget(share);
    setEditTitle(share.title ?? '');
    setEditUrl(share.url ?? '');
    setEditPwd('');
    setEditIs(share.status === 1 ? '1' : '0');
  }

  async function handleSaveEdit() {
    if (!editTarget) return;
    if (!editTitle.trim() || !editUrl.trim()) { toast.error('标题和链接不能为空'); return; }
    setEditSaving(true);
    try {
      await editXnShare({
        id: editTarget.id,
        title: editTitle.trim(),
        panurl: editUrl.trim(),
        panpw: editPwd.trim(),
        is: Number(editIs),
      });
      toast.success('更新成功');
      setEditTarget(null);
      await loadShares();
    } catch (e) {
      const err = e as Error & { code?: string };
      if (err.code === XN_COOKIE_EXPIRED_CODE) handleExpired();
      else toast.error(err.message || '更新失败');
    } finally { setEditSaving(false); }
  }

  async function handleDelete() {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await delXnShare(deleteTarget.id);
      toast.success('已删除');
      setDeleteTarget(null);
      await loadShares();
    } catch (e) {
      const err = e as Error & { code?: string };
      if (err.code === XN_COOKIE_EXPIRED_CODE) handleExpired();
      else toast.error(err.message || '删除失败');
    } finally { setDeleting(false); }
  }

  const isBound = binding?.status === 'active';
  const isExpired = binding?.status === 'expired';

  return (
    <div className="space-y-6">
      {/* 绑定区 */}
      <div className="rounded-xl border border-border bg-card p-4 md:p-6">
        <div className="flex items-center justify-between mb-4 gap-3 flex-wrap">
          <div className="flex items-center gap-2">
            <Tv2 className="h-4 w-4 text-primary shrink-0" />
            <h2 className="font-serif text-base font-bold text-foreground">观影站点账号绑定</h2>
          </div>
          {bindingLoading ? (
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
          ) : isBound ? (
            <Badge className="bg-secondary/15 text-secondary border-0 hover:bg-secondary/15">已绑定 · 正常</Badge>
          ) : isExpired ? (
            <Badge className="bg-destructive/15 text-destructive border-0 hover:bg-destructive/15">已过期</Badge>
          ) : (
            <Badge variant="secondary" className="bg-muted text-muted-foreground border-0">未绑定</Badge>
          )}
        </div>

        {isBound && (
          <div className="mb-4 p-3 rounded-lg bg-muted/60 text-xs text-muted-foreground">
            观影站点账号正常（最近检测：{fmtDate(binding?.last_check_at)}）
            {binding?.remark && <span className="ml-2">备注：{binding.remark}</span>}
          </div>
        )}
        {isExpired && (
          <div className="mb-4 p-3 rounded-lg bg-destructive/10 text-xs text-destructive">
            观影站点登录已过期，请重新粘贴 Cookie 绑定。
          </div>
        )}

        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label className="text-sm text-foreground">站点 Cookie</Label>
            <Textarea
              value={cookie}
              onChange={(e) => setCookie(e.target.value)}
              placeholder="粘贴整串 Cookie（需含 PHPSESSID=xxx）"
              className="min-h-20 px-3 text-xs bg-input border-border focus-visible:ring-primary/40 font-mono"
            />
          </div>
          <div className="space-y-1.5">
            <Label className="text-sm text-foreground">备注（可选）</Label>
            <Input value={remark} onChange={(e) => setRemark(e.target.value)} placeholder="如：主账号"
              className="h-9 px-3 text-sm bg-input border-border focus-visible:ring-primary/40" />
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <Button onClick={handleBind} disabled={binding_}
              className="h-9 bg-primary text-primary-foreground hover:bg-primary/90 gap-1.5">
              {binding_ ? <Loader2 className="h-4 w-4 animate-spin" /> : <Link2 className="h-4 w-4" />}
              {isBound || isExpired ? '重新绑定' : '绑定账号'}
            </Button>
            {(isBound || isExpired) && (
              <Button variant="outline" onClick={handleUnbind} disabled={binding_}
                className="h-9 border-border text-muted-foreground hover:text-foreground hover:bg-muted gap-1.5">
                <Unlink className="h-4 w-4" />解绑
              </Button>
            )}
          </div>
        </div>
        <div className="mt-4 flex items-start gap-2 p-3 rounded-lg bg-muted/40 text-xs text-muted-foreground">
          <Info className="h-3.5 w-3.5 shrink-0 mt-0.5" />
          <span>
            获取 Cookie：浏览器登录站点 → F12 → Network → 点击任意 <code className="bg-muted px-1 rounded">/res/</code> 请求 →
            Headers → Request Headers → 复制整串 Cookie（含 PHPSESSID=xxx）粘贴到上方。
            注意：该 Cookie 为 Session 级，浏览器关闭后可能失效，请及时重新绑定。
          </span>
        </div>
      </div>

      {/* 分享记录区 */}
      {isBound && (
        <div className="rounded-xl border border-border bg-card overflow-hidden">
          <div className="flex items-center justify-between px-4 md:px-6 py-4 border-b border-border gap-3 flex-wrap">
            <div className="flex items-center gap-2 min-w-0">
              <UploadCloud className="h-4 w-4 text-muted-foreground shrink-0" />
              <h2 className="font-serif text-base font-bold text-foreground">我的分享记录</h2>
              <span className="text-xs text-muted-foreground">{shares.length} 条</span>
            </div>
            <div className="flex items-center gap-2 shrink-0 flex-wrap">
              {/* 分类筛选 */}
              <Select value={dirid} onValueChange={setDirid}>
                <SelectTrigger className="h-8 w-20 text-xs bg-input border-border">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {XN_DIRIDS.map((d) => <SelectItem key={d.value} value={d.value}>{d.label}</SelectItem>)}
                </SelectContent>
              </Select>
              {/* 搜索 */}
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && loadShares()}
                placeholder="搜索标题…"
                className="h-8 w-32 text-xs bg-input border-border focus-visible:ring-primary/40"
              />
              <Button variant="ghost" size="sm" onClick={loadShares} disabled={listLoading}
                className="h-8 text-xs text-muted-foreground hover:text-foreground hover:bg-muted gap-1.5">
                <RefreshCw className={`h-3.5 w-3.5 ${listLoading ? 'animate-spin' : ''}`} />刷新
              </Button>
            </div>
          </div>

          {listLoading ? (
            <div className="py-16 text-center text-sm text-muted-foreground">
              <Loader2 className="h-5 w-5 animate-spin inline mr-2" />加载中…
            </div>
          ) : shares.length === 0 ? (
            <div className="py-16 text-center text-sm text-muted-foreground">暂无分享记录</div>
          ) : (
            <div className="w-full max-w-full overflow-x-auto bg-card">
              <table className="w-full min-w-max text-sm">
                <thead>
                  <tr className="border-b border-border bg-card">
                    <th className="px-4 py-3 text-left text-xs font-semibold text-muted-foreground whitespace-nowrap min-w-48">标题</th>
                    <th className="px-4 py-3 text-left text-xs font-semibold text-muted-foreground whitespace-nowrap">绑定作品</th>
                    <th className="px-4 py-3 text-left text-xs font-semibold text-muted-foreground whitespace-nowrap min-w-40">链接</th>
                    <th className="px-4 py-3 text-left text-xs font-semibold text-muted-foreground whitespace-nowrap">发布时间</th>
                    <th className="px-4 py-3 text-left text-xs font-semibold text-muted-foreground whitespace-nowrap">状态</th>
                    <th className="px-4 py-3 text-right text-xs font-semibold text-muted-foreground whitespace-nowrap">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {shares.map((share) => (
                    <tr key={share.id} className="border-b border-border/50 hover:bg-muted/20">
                      <td className="px-4 py-3 whitespace-nowrap font-medium text-foreground max-w-xs truncate">
                        {share.title || '—'}
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap text-xs text-muted-foreground">
                        {share.tname || share.atitle || '—'}
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap max-w-xs">
                        {share.url ? (
                          <a href={share.url} target="_blank" rel="noreferrer"
                            className="text-xs text-primary hover:underline truncate inline-block max-w-[180px] align-bottom">
                            {share.url}
                          </a>
                        ) : '—'}
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap text-xs text-muted-foreground">{share.time || '—'}</td>
                      <td className="px-4 py-3 whitespace-nowrap">
                        <Badge variant="secondary"
                          className={`text-xs border-0 ${share.status === 1 ? 'bg-secondary/15 text-secondary' : 'bg-muted text-muted-foreground'}`}>
                          {share.status === 1 ? '开启' : '关闭'}
                        </Badge>
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap text-right">
                        <div className="flex justify-end gap-1.5">
                          <Button variant="ghost" size="sm" onClick={() => openEdit(share)}
                            className="h-7 text-xs text-muted-foreground hover:text-foreground hover:bg-muted gap-1">
                            <Pencil className="h-3.5 w-3.5" />修改
                          </Button>
                          <Button variant="ghost" size="sm" onClick={() => setDeleteTarget(share)}
                            className="h-7 text-xs text-destructive hover:text-destructive hover:bg-muted">
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* 编辑弹窗 */}
      <Dialog open={!!editTarget} onOpenChange={(o) => !o && setEditTarget(null)}>
        <DialogContent className="max-w-[calc(100%-2rem)] md:max-w-lg bg-card border-border">
          <DialogHeader><DialogTitle>修改分享记录</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label className="text-sm text-foreground">标题</Label>
              <Input value={editTitle} onChange={(e) => setEditTitle(e.target.value)}
                placeholder="如：XX剧 更新至第20集"
                className="h-9 px-3 text-sm bg-input border-border focus-visible:ring-primary/40" />
            </div>
            <div className="space-y-1.5">
              <Label className="text-sm text-foreground">网盘链接</Label>
              <Input value={editUrl} onChange={(e) => setEditUrl(e.target.value)}
                placeholder="新的网盘分享链接"
                className="h-9 px-3 text-sm bg-input border-border focus-visible:ring-primary/40" />
            </div>
            <div className="space-y-1.5">
              <Label className="text-sm text-foreground">提取码（可选）</Label>
              <Input value={editPwd} onChange={(e) => setEditPwd(e.target.value)}
                placeholder="无则留空"
                className="h-9 px-3 text-sm bg-input border-border focus-visible:ring-primary/40" />
            </div>
            <div className="space-y-1.5">
              <Label className="text-sm text-foreground">显示状态</Label>
              <Select value={editIs} onValueChange={setEditIs}>
                <SelectTrigger className="h-9 bg-input border-border"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="1">开启（公开可见）</SelectItem>
                  <SelectItem value="0">关闭（隐藏）</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditTarget(null)}
              className="border-border text-muted-foreground hover:text-foreground hover:bg-muted">取消</Button>
            <Button onClick={handleSaveEdit} disabled={editSaving}
              className="bg-primary text-primary-foreground hover:bg-primary/90 gap-1.5">
              {editSaving && <Loader2 className="h-4 w-4 animate-spin" />}保存
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={!!deleteTarget} onOpenChange={(o) => !o && setDeleteTarget(null)}>
        <AlertDialogContent className="max-w-[calc(100%-2rem)] md:max-w-md bg-card border-border">
          <AlertDialogHeader>
            <AlertDialogTitle>删除分享记录？</AlertDialogTitle>
            <AlertDialogDescription>
              删除后「{deleteTarget?.title}」将从观影站点移除，此操作不可恢复。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction onClick={handleDelete} disabled={deleting}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90">
              {deleting && <Loader2 className="h-4 w-4 animate-spin mr-1.5" />}确认删除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

// ─── 鸭影臻藏标签页 ──────────────────────────────────────────
function YaSiteTab() {
  const [binding, setBinding] = useState<YaBinding | null>(null);
  const [bindingLoading, setBindingLoading] = useState(true);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [remark, setRemark] = useState('');
  const [binding_, setBinding_] = useState(false);

  const [records, setRecords] = useState<{ id: string; link_title: string | null; link_url: string | null; created_at: string }[]>([]);
  const [listLoading, setListLoading] = useState(false);
  const [account, setAccount] = useState<YaAccountStatus | null>(null);

  const loadBinding = useCallback(async () => {
    setBindingLoading(true);
    try {
      const info = await getYaBinding();
      setBinding(info);
      if (info?.remark) setRemark(info.remark);
    } catch { toast.error('加载鸭影臻藏绑定信息失败'); }
    finally { setBindingLoading(false); }
  }, []);

  const loadRecords = useCallback(async () => {
    setListLoading(true);
    try {
      const data = await fetchYaShareRecords();
      setRecords(data);
    } catch (e) {
      const err = e as Error & { code?: string };
      if (err.code === YA_EXPIRED_CODE) {
        setBinding((b) => b ? { ...b, status: 'expired' } : b);
      }
      toast.error(err.message || '加载分享记录失败');
      setRecords([]);
    } finally { setListLoading(false); }
  }, []);

  const loadAccount = useCallback(async () => {
    try {
      const info = await yaGetAccountStatus();
      setAccount(info);
    } catch (e) {
      const err = e as Error & { code?: string };
      if (err.code === YA_EXPIRED_CODE) setBinding((b) => (b ? { ...b, status: 'expired' } : b));
    }
  }, []);

  useEffect(() => { loadBinding(); }, [loadBinding]);
  useEffect(() => { if (binding?.status === 'active') loadRecords(); }, [binding?.status, loadRecords]);
  useEffect(() => { if (binding?.status === 'active') loadAccount(); }, [binding?.status, loadAccount]);

  async function handleBind() {
    if (!username.trim() || !password.trim()) { toast.error('请填写鸭影臻藏站点账号和密码'); return; }
    setBinding_(true);
    try {
      await bindYaAccount(username.trim(), password.trim(), remark.trim());
      toast.success('绑定成功');
      setUsername('');
      setPassword('');
      await loadBinding();
    } catch (e) {
      const err = e as Error & { code?: string };
      toast.error(err.code === YA_EXPIRED_CODE ? '账号或密码错误，或登录已失效' : '绑定失败，请检查账号密码');
    } finally { setBinding_(false); }
  }

  async function handleUnbind() {
    setBinding_(true);
    try {
      await unbindYa();
      toast.success('已解绑');
      setBinding(null);
      setRecords([]);
      setAccount(null);
    } catch { toast.error('解绑失败'); }
    finally { setBinding_(false); }
  }

  const isBound = binding?.status === 'active';
  const isExpired = binding?.status === 'expired';

  return (
    <div className="space-y-6">
      {/* 绑定区 */}
      <div className="rounded-xl border border-border bg-card p-4 md:p-6">
        <div className="flex items-center justify-between mb-4 gap-3 flex-wrap">
          <div className="flex items-center gap-2">
            <Drama className="h-4 w-4 text-primary shrink-0" />
            <h2 className="font-serif text-base font-bold text-foreground">鸭影臻藏站点账号绑定</h2>
          </div>
          {bindingLoading ? (
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
          ) : isBound ? (
            <Badge className="bg-secondary/15 text-secondary border-0 hover:bg-secondary/15">已绑定 · 正常</Badge>
          ) : isExpired ? (
            <Badge className="bg-destructive/15 text-destructive border-0 hover:bg-destructive/15">已过期</Badge>
          ) : (
            <Badge variant="secondary" className="bg-muted text-muted-foreground border-0">未绑定</Badge>
          )}
        </div>

        {isBound && (
          <div className="mb-4 p-3 rounded-lg bg-muted/60 text-xs text-muted-foreground">
            鸭影臻藏站点凭证正常（最近检测：{fmtDate(binding?.last_check_at)}）
            {binding?.remark && <span className="ml-2">备注：{binding.remark}</span>}
          </div>
        )}
        {isExpired && (
          <div className="mb-4 p-3 rounded-lg bg-destructive/10 text-xs text-destructive">
            鸭影臻藏站点凭证已失效，请重新登录站点获取新凭证并粘贴绑定。
          </div>
        )}

        <div className="space-y-3">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label className="text-sm text-foreground">鸭影臻藏站点账号</Label>
              <Input value={username} onChange={(e) => setUsername(e.target.value)}
                placeholder="鸭影臻藏站点用户名"
                className="h-9 px-3 text-sm bg-input border-border focus-visible:ring-primary/40" />
            </div>
            <div className="space-y-1.5">
              <Label className="text-sm text-foreground">密码</Label>
              <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)}
                placeholder="鸭影臻藏站点登录密码"
                className="h-9 px-3 text-sm bg-input border-border focus-visible:ring-primary/40" />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label className="text-sm text-foreground">备注（可选）</Label>
            <Input value={remark} onChange={(e) => setRemark(e.target.value)} placeholder="如：主账号"
              className="h-9 px-3 text-sm bg-input border-border focus-visible:ring-primary/40" />
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <Button onClick={handleBind} disabled={binding_}
              className="h-9 bg-primary text-primary-foreground hover:bg-primary/90 gap-1.5">
              {binding_ ? <Loader2 className="h-4 w-4 animate-spin" /> : <Link2 className="h-4 w-4" />}
              {isBound || isExpired ? '重新绑定' : '绑定账号'}
            </Button>
            {(isBound || isExpired) && (
              <Button variant="outline" onClick={handleUnbind} disabled={binding_}
                className="h-9 border-border text-muted-foreground hover:text-foreground hover:bg-muted gap-1.5">
                <Unlink className="h-4 w-4" />解绑
              </Button>
            )}
          </div>
        </div>
        <div className="mt-4 flex items-start gap-2 p-3 rounded-lg bg-muted/40 text-xs text-muted-foreground">
          <Info className="h-3.5 w-3.5 shrink-0 mt-0.5" />
          <span>绑定后，下方将展示该账号所分享的网盘资源记录与账号信息；账号密码仅用于服务端登录，不会暴露给浏览器。</span>
        </div>
      </div>

      {/* 账号信息（我的网盘统计 / 追更） */}
      {isBound && account && (
        <div className="rounded-xl border border-border bg-card p-4 md:p-6">
          <div className="flex items-center gap-2 mb-4">
            <User className="h-4 w-4 text-primary shrink-0" />
            <h2 className="font-serif text-base font-bold text-foreground">账号信息</h2>
            {account.member_level_label && (
              <Badge className="bg-secondary/15 text-secondary border-0 hover:bg-secondary/15">{account.member_level_label}</Badge>
            )}
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-3">
            <AccountStat icon={<User className="h-3 w-3" />} label="用户名" value={account.username ?? '—'} />
            <AccountStat icon={<Award className="h-3 w-3" />} label="积分" value={String(account.points ?? 0)} />
            <AccountStat icon={<CalendarCheck className="h-3 w-3" />} label="连续签到" value={`${account.consecutive_check_ins ?? 0} 天`} />
            <AccountStat icon={<Star className="h-3 w-3" />} label="最近签到" value={account.last_check_in ?? '—'} />
          </div>
          <div className="grid grid-cols-3 gap-3 mb-4">
            <AccountStat icon={<HardDrive className="h-3 w-3" />} label="网盘总数" value={String(account.pan_stats?.total_drive ?? 0)} />
            <AccountStat icon={<HardDrive className="h-3 w-3" />} label="磁力总数" value={String(account.pan_stats?.total_magnet ?? 0)} />
            <AccountStat icon={<HardDrive className="h-3 w-3" />} label="今日发布" value={String(account.pan_stats?.today_drive ?? 0)} />
          </div>
          {account.tracking && account.tracking.length > 0 && (
            <div>
              <p className="text-xs font-medium text-muted-foreground mb-2">我的追更</p>
              <div className="flex flex-wrap gap-2">
                {account.tracking.map((t) => (
                  <Badge key={t.video_id} variant="secondary" className="bg-muted text-muted-foreground border-0 gap-1">
                    <span className="truncate max-w-40">{t.title}</span>
                    {t.update_day && <span className="text-[10px] opacity-70 shrink-0">{t.update_day}</span>}
                  </Badge>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* 网盘分享记录 */}
      {isBound && (
        <div className="rounded-xl border border-border bg-card overflow-hidden">
          <div className="flex items-center justify-between px-4 md:px-6 py-4 border-b border-border gap-3 flex-wrap">
            <div className="flex items-center gap-2 min-w-0">
              <UploadCloud className="h-4 w-4 text-muted-foreground shrink-0" />
              <h2 className="font-serif text-base font-bold text-foreground">网盘分享记录</h2>
              <span className="text-xs text-muted-foreground">{records.length} 条</span>
            </div>
            <Button variant="ghost" size="sm" onClick={loadRecords} disabled={listLoading}
              className="h-8 text-xs text-muted-foreground hover:text-foreground hover:bg-muted gap-1.5">
              <RefreshCw className={`h-3.5 w-3.5 ${listLoading ? 'animate-spin' : ''}`} />刷新
            </Button>
          </div>

          {listLoading ? (
            <div className="py-16 text-center text-sm text-muted-foreground">
              <Loader2 className="h-5 w-5 animate-spin inline mr-2" />加载中…
            </div>
          ) : records.length === 0 ? (
            <div className="py-16 text-center text-sm text-muted-foreground">暂无网盘分享记录</div>
          ) : (
            <div className="w-full max-w-full overflow-x-auto bg-card">
              <table className="w-full min-w-max text-sm">
                <thead>
                  <tr className="border-b border-border bg-card">
                    <th className="px-4 py-3 text-left text-xs font-semibold text-muted-foreground whitespace-nowrap min-w-48">资源名称</th>
                    <th className="px-4 py-3 text-left text-xs font-semibold text-muted-foreground whitespace-nowrap min-w-40">资源链接</th>
                  </tr>
                </thead>
                <tbody>
                  {records.map((rec) => (
                    <tr key={rec.id} className="border-b border-border/50 hover:bg-muted/20">
                      <td className="px-4 py-3 whitespace-nowrap font-medium text-foreground max-w-xs truncate">{rec.link_title || '—'}</td>
                      <td className="px-4 py-3 whitespace-nowrap max-w-xs">
                        {rec.link_url ? (
                          <a href={rec.link_url} target="_blank" rel="noreferrer"
                            className="text-xs text-primary hover:underline truncate inline-block max-w-[200px] align-bottom">
                            {rec.link_url}
                          </a>
                        ) : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── 帧影站点标签页 ──────────────────────────────────────────
function FramehdrSiteTab() {
  const [binding, setBinding] = useState<FramehdrBinding | null>(null);
  const [bindingLoading, setBindingLoading] = useState(true);
  const [cookie, setCookie] = useState('');
  const [remark, setRemark] = useState('');
  const [binding_, setBinding_] = useState(false);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [loggingIn, setLoggingIn] = useState(false);

  const [links, setLinks] = useState<FramehdrLink[]>([]);
  const [listLoading, setListLoading] = useState(false);
  const [editTarget, setEditTarget] = useState<FramehdrLink | null>(null);
  const [editTitle, setEditTitle] = useState('');
  const [editUrl, setEditUrl] = useState('');
  const [editPwd, setEditPwd] = useState('');
  const [editDesc, setEditDesc] = useState('');
  const [editSaving, setEditSaving] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<FramehdrLink | null>(null);
  const [deleting, setDeleting] = useState(false);

  const handleExpired = useCallback(() => {
    toast.error('帧影站点登录已过期，请重新绑定 Cookie');
    setBinding((b) => b ? { ...b, status: 'expired' } : b);
  }, []);

  const loadBinding = useCallback(async () => {
    setBindingLoading(true);
    try {
      const info = await getFramehdrBinding();
      setBinding(info);
      if (info?.remark) setRemark(info.remark);
    } catch { toast.error('加载帧影站点绑定信息失败'); }
    finally { setBindingLoading(false); }
  }, []);

  const loadLinks = useCallback(async () => {
    setListLoading(true);
    try {
      const data = await loadFramehdrLinks();
      setLinks(data);
    } catch (e) {
      const err = e as Error & { code?: string };
      if (err.code === FRAMEHDR_COOKIE_EXPIRED_CODE) handleExpired();
      else toast.error(err.message || '加载帧影站点发布记录失败');
    } finally { setListLoading(false); }
  }, [handleExpired]);

  useEffect(() => { loadBinding(); }, [loadBinding]);
  useEffect(() => {
    if (binding?.status === 'active') loadLinks();
    else setLinks([]);
  }, [binding?.status, loadLinks]);

  async function handleBind() {
    if (!cookie.trim()) { toast.error('请粘贴帧影站点 Cookie'); return; }
    setBinding_(true);
    try {
      await bindFramehdrCookie(cookie.trim(), remark.trim());
      toast.success('绑定成功');
      setCookie('');
      await loadBinding();
    } catch { toast.error('绑定失败，请检查 Cookie 是否正确'); }
    finally { setBinding_(false); }
  }

  async function handleLogin() {
    if (!username.trim() || !password) { toast.error('请输入帧影账号和密码'); return; }
    setLoggingIn(true);
    try {
      await loginFramehdr(username.trim(), password);
      toast.success('账号密码登录成功，会话已保存');
      setUsername('');
      setPassword('');
      await loadBinding();
    } catch (e) {
      toast.error((e as Error).message || '登录失败，请检查账号密码');
    } finally { setLoggingIn(false); }
  }

  async function handleUnbind() {
    setBinding_(true);
    try {
      await unbindFramehdr();
      toast.success('已解绑');
      setBinding(null);
      setLinks([]);
    } catch { toast.error('解绑失败'); }
    finally { setBinding_(false); }
  }

  function openEdit(link: FramehdrLink) {
    setEditTarget(link);
    setEditTitle(link.title);
    setEditUrl(link.url);
    setEditPwd(link.extract_code ?? '');
    setEditDesc('');
  }

  async function handleSaveEdit() {
    if (!editTarget) return;
    if (!editTitle.trim() || !editUrl.trim()) { toast.error('标题和链接不能为空'); return; }
    setEditSaving(true);
    try {
      await editFramehdrLink({
        id: editTarget.id,
        name: editTitle.trim(),
        url: editUrl.trim(),
        password: editPwd.trim(),
        description: editDesc.trim(),
      });
      toast.success('更新成功');
      setEditTarget(null);
      await loadLinks();
    } catch (e) {
      const err = e as Error & { code?: string };
      if (err.code === FRAMEHDR_COOKIE_EXPIRED_CODE) handleExpired();
      else toast.error(err.message || '更新失败');
    } finally { setEditSaving(false); }
  }

  async function handleDelete() {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await deleteFramehdrLink(deleteTarget.id);
      toast.success('已删除');
      setDeleteTarget(null);
      await loadLinks();
    } catch (e) {
      const err = e as Error & { code?: string };
      if (err.code === FRAMEHDR_COOKIE_EXPIRED_CODE) handleExpired();
      else toast.error(err.message || '删除失败');
    } finally { setDeleting(false); }
  }

  const isBound = binding?.status === 'active';
  const isExpired = binding?.status === 'expired';

  return (
    <div className="space-y-6">
      {/* 绑定区 */}
      <div className="rounded-xl border border-border bg-card p-4 md:p-6">
        <div className="flex items-center justify-between mb-4 gap-3 flex-wrap">
          <div className="flex items-center gap-2">
            <Link2 className="h-4 w-4 text-primary shrink-0" />
            <h2 className="font-serif text-base font-bold text-foreground">帧影站点账号绑定</h2>
          </div>
          {bindingLoading ? (
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
          ) : isBound ? (
            <Badge className="bg-secondary/15 text-secondary border-0 hover:bg-secondary/15">已绑定 · 正常</Badge>
          ) : isExpired ? (
            <Badge className="bg-destructive/15 text-destructive border-0 hover:bg-destructive/15">已过期</Badge>
          ) : (
            <Badge variant="secondary" className="bg-muted text-muted-foreground border-0">未绑定</Badge>
          )}
        </div>

        {isBound && (
          <div className="mb-4 p-3 rounded-lg bg-muted/60 text-xs text-muted-foreground">
            帧影站点账号正常（最近检测：{fmtDate(binding?.last_check_at)}）
            {binding?.remark && <span className="ml-2">备注：{binding.remark}</span>}
          </div>
        )}
        {isExpired && (
          <div className="mb-4 p-3 rounded-lg bg-destructive/10 text-xs text-destructive">
            帧影站点登录已过期，请重新粘贴 Cookie 绑定。
          </div>
        )}

        <Tabs defaultValue="password" className="w-full">
          <TabsList className="w-full bg-muted border border-border h-9 mb-3">
            <TabsTrigger value="password"
              className="flex-1 text-xs data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm">
              账号密码登录（推荐）
            </TabsTrigger>
            <TabsTrigger value="cookie"
              className="flex-1 text-xs data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm">
              手动粘贴 Cookie
            </TabsTrigger>
          </TabsList>
          <TabsContent value="password" className="mt-0">
            <div className="space-y-3">
              <div className="space-y-1.5">
                <Label className="text-sm text-foreground">帧影账号</Label>
                <Input
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  placeholder="输入 framehdr.com 账号"
                  className="h-9 px-3 text-sm bg-input border-border focus-visible:ring-primary/40"
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-sm text-foreground">密码</Label>
                <Input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') handleLogin(); }}
                  placeholder="输入帧影站点密码（仅用于登录，不保存）"
                  className="h-9 px-3 text-sm bg-input border-border focus-visible:ring-primary/40"
                />
              </div>
              <div className="flex items-center gap-2 flex-wrap">
                <Button onClick={handleLogin} disabled={loggingIn}
                  className="h-9 bg-primary text-primary-foreground hover:bg-primary/90 gap-1.5">
                  {loggingIn ? <Loader2 className="h-4 w-4 animate-spin" /> : <LogIn className="h-4 w-4" />}
                  {isBound || isExpired ? '重新登录' : '登录并绑定'}
                </Button>
                {(isBound || isExpired) && (
                  <Button variant="outline" onClick={handleUnbind} disabled={binding_}
                    className="h-9 border-border text-muted-foreground hover:text-foreground hover:bg-muted gap-1.5">
                    <Unlink className="h-4 w-4" />解绑
                  </Button>
                )}
              </div>
              <p className="text-[11px] text-muted-foreground leading-relaxed">
                服务端模拟登录帧影站点并保存会话，密码不会保存到数据库。若连续失败 5 次账号会被锁定。
              </p>
            </div>
          </TabsContent>
          <TabsContent value="cookie" className="mt-0">
            <div className="space-y-3">
              <div className="space-y-1.5">
                <Label className="text-sm text-foreground">帧影站点 Cookie</Label>
                <Textarea
                  value={cookie}
                  onChange={(e) => setCookie(e.target.value)}
                  placeholder="粘贴 framehdr.com 的完整 Cookie（含 wangpan_session 等 HttpOnly 项）"
                  className="min-h-20 px-3 text-xs bg-input border-border focus-visible:ring-primary/40 font-mono"
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-sm text-foreground">备注（可选）</Label>
                <Input
                  value={remark}
                  onChange={(e) => setRemark(e.target.value)}
                  placeholder="如：主账号"
                  className="h-9 px-3 text-sm bg-input border-border focus-visible:ring-primary/40"
                />
              </div>
              <div className="flex items-center gap-2 flex-wrap">
                <Button onClick={handleBind} disabled={binding_}
                  className="h-9 bg-primary text-primary-foreground hover:bg-primary/90 gap-1.5">
                  {binding_ ? <Loader2 className="h-4 w-4 animate-spin" /> : <Link2 className="h-4 w-4" />}
                  {isBound || isExpired ? '重新绑定' : '绑定账号'}
                </Button>
                {(isBound || isExpired) && (
                  <Button variant="outline" onClick={handleUnbind} disabled={binding_}
                    className="h-9 border-border text-muted-foreground hover:text-foreground hover:bg-muted gap-1.5">
                    <Unlink className="h-4 w-4" />解绑
                  </Button>
                )}
              </div>
            </div>
          </TabsContent>
        </Tabs>
        <div className="mt-4 flex items-start gap-2 p-3 rounded-lg bg-muted/40 text-xs text-muted-foreground">
          <Info className="h-3.5 w-3.5 shrink-0 mt-0.5" />
          <span>获取 Cookie：Chrome 打开 framehdr.com 登录 → F12 → Network → 刷新 → 点击任意 /user/ 请求 → Headers → Request Headers → 复制完整 Cookie（必须含 HttpOnly 项，document.cookie 读不到）。</span>
        </div>
      </div>

      {/* 发布记录区 */}
      {isBound && (
        <div className="rounded-xl border border-border bg-card overflow-hidden">
          <div className="flex items-center justify-between px-4 md:px-6 py-4 border-b border-border gap-3 flex-wrap">
            <div className="flex items-center gap-2 min-w-0">
              <UploadCloud className="h-4 w-4 text-muted-foreground shrink-0" />
              <h2 className="font-serif text-base font-bold text-foreground">站点发布记录</h2>
              <span className="text-xs text-muted-foreground">{links.length} 条</span>
            </div>
            <Button variant="ghost" size="sm" onClick={loadLinks} disabled={listLoading}
              className="h-8 text-xs text-muted-foreground hover:text-foreground hover:bg-muted gap-1.5">
              <RefreshCw className={`h-3.5 w-3.5 ${listLoading ? 'animate-spin' : ''}`} />刷新
            </Button>
          </div>
          {listLoading ? (
            <div className="py-16 text-center text-sm text-muted-foreground">
              <Loader2 className="h-5 w-5 animate-spin inline mr-2" />加载中…
            </div>
          ) : links.length === 0 ? (
            <div className="py-16 text-center text-sm text-muted-foreground">暂无发布记录</div>
          ) : (
            <div className="w-full max-w-full overflow-x-auto bg-card">
              <table className="w-full min-w-max text-sm">
                <thead>
                  <tr className="border-b border-border bg-card">
                    <th className="px-4 py-3 text-left text-xs font-semibold text-muted-foreground whitespace-nowrap min-w-48">标题</th>
                    <th className="px-4 py-3 text-left text-xs font-semibold text-muted-foreground whitespace-nowrap min-w-24">网盘</th>
                    <th className="px-4 py-3 text-left text-xs font-semibold text-muted-foreground whitespace-nowrap min-w-40">链接</th>
                    <th className="px-4 py-3 text-left text-xs font-semibold text-muted-foreground whitespace-nowrap">发布时间</th>
                    <th className="px-4 py-3 text-right text-xs font-semibold text-muted-foreground whitespace-nowrap">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {links.map((link) => (
                    <tr key={link.id} className="border-b border-border/50 hover:bg-muted/20">
                      <td className="px-4 py-3 whitespace-nowrap font-medium text-foreground max-w-xs truncate">{link.title || '—'}</td>
                      <td className="px-4 py-3 whitespace-nowrap">
                        <Badge variant="secondary" className="bg-muted text-muted-foreground border-0 text-xs">
                          {link.drive_name || '—'}
                        </Badge>
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap max-w-xs">
                        {link.url ? (
                          <a href={link.url} target="_blank" rel="noreferrer"
                            className="text-xs text-primary hover:underline truncate inline-block max-w-[200px] align-bottom">
                            {link.url}
                          </a>
                        ) : '—'}
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap text-xs text-muted-foreground">{link.created_at ?? '—'}</td>
                      <td className="px-4 py-3 whitespace-nowrap text-right">
                        <div className="flex justify-end gap-1.5">
                          <Button variant="ghost" size="sm" onClick={() => openEdit(link)}
                            className="h-7 text-xs text-muted-foreground hover:text-foreground hover:bg-muted gap-1">
                            <Pencil className="h-3.5 w-3.5" />修改
                          </Button>
                          <Button variant="ghost" size="sm" onClick={() => setDeleteTarget(link)}
                            className="h-7 text-xs text-destructive hover:text-destructive hover:bg-muted">
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* 编辑弹窗 */}
      <Dialog open={!!editTarget} onOpenChange={(o) => !o && setEditTarget(null)}>
        <DialogContent className="max-w-[calc(100%-2rem)] md:max-w-lg bg-card border-border">
          <DialogHeader><DialogTitle>修改发布记录</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label className="text-sm text-foreground">标题</Label>
              <Input value={editTitle} onChange={(e) => setEditTitle(e.target.value)}
                placeholder="如：XX剧 更新至第20集"
                className="h-9 px-3 text-sm bg-input border-border focus-visible:ring-primary/40" />
            </div>
            <div className="space-y-1.5">
              <Label className="text-sm text-foreground">网盘链接</Label>
              <Input value={editUrl} onChange={(e) => setEditUrl(e.target.value)}
                placeholder="新的网盘分享链接"
                className="h-9 px-3 text-sm bg-input border-border focus-visible:ring-primary/40" />
            </div>
            <div className="space-y-1.5">
              <Label className="text-sm text-foreground">提取码（可选）</Label>
              <Input value={editPwd} onChange={(e) => setEditPwd(e.target.value)}
                placeholder="无则留空"
                className="h-9 px-3 text-sm bg-input border-border focus-visible:ring-primary/40" />
            </div>
            <div className="space-y-1.5">
              <Label className="text-sm text-foreground">描述（可选）</Label>
              <Input value={editDesc} onChange={(e) => setEditDesc(e.target.value)}
                placeholder="资源描述（可选）"
                className="h-9 px-3 text-sm bg-input border-border focus-visible:ring-primary/40" />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditTarget(null)}
              className="border-border text-muted-foreground hover:text-foreground hover:bg-muted">取消</Button>
            <Button onClick={handleSaveEdit} disabled={editSaving}
              className="bg-primary text-primary-foreground hover:bg-primary/90 gap-1.5">
              {editSaving && <Loader2 className="h-4 w-4 animate-spin" />}保存
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={!!deleteTarget} onOpenChange={(o) => !o && setDeleteTarget(null)}>
        <AlertDialogContent className="max-w-[calc(100%-2rem)] md:max-w-md bg-card border-border">
          <AlertDialogHeader>
            <AlertDialogTitle>删除发布记录？</AlertDialogTitle>
            <AlertDialogDescription>
              删除后「{deleteTarget?.title}」将从帧影站点移除，此操作不可恢复。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction onClick={handleDelete} disabled={deleting}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90">
              {deleting && <Loader2 className="h-4 w-4 animate-spin mr-1.5" />}确认删除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

// ─── 123社区（123panfx.com）标签页 ───────────────────────────
function PanfxSiteTab() {
  const [binding, setBinding] = useState<PanfxBinding | null>(null);
  const [loadingBinding, setLoadingBinding] = useState(true);
  const [cookie, setCookie] = useState('');
  const [remark, setRemark] = useState('');
  const [saving, setSaving] = useState(false);
  const [checking, setChecking] = useState(false);

  // 帖子记录
  const [posts, setPosts] = useState<import('@/types/index').PanfxPost[]>([]);
  const [listLoading, setListLoading] = useState(false);
  const [search, setSearch] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<import('@/types/index').PanfxPost | null>(null);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    getPanfxBinding()
      .then((b) => { setBinding(b); return b; })
      .then((b) => { if (b?.status === 'active') loadPosts(); })
      .catch(() => setBinding(null))
      .finally(() => setLoadingBinding(false));
  }, []);

  async function loadPosts() {
    setListLoading(true);
    try {
      const data = await loadPanfxPosts();
      setPosts(data);
    } catch (e) {
      const err = e as Error & { code?: string };
      if (err.code === PANFX_COOKIE_EXPIRED_CODE) {
        setBinding((prev) => prev ? { ...prev, status: 'expired' } : prev);
        toast.error('123社区 Cookie 已失效，请重新绑定');
      } else {
        toast.error(err.message || '加载帖子记录失败');
      }
    } finally { setListLoading(false); }
  }

  const isBound = !!binding && binding.status === 'active';
  const isExpired = !!binding && binding.status === 'expired';

  const filteredPosts = posts.filter((p) => {
    const q = search.trim().toLowerCase();
    return !q || (p.subject ?? '').toLowerCase().includes(q);
  });

  async function handleBind() {
    if (!cookie.trim()) { toast.error('请粘贴 Cookie'); return; }
    if (!/bbs_token\s*=/i.test(cookie)) { toast.error('Cookie 格式不正确，缺少 bbs_token'); return; }
    setSaving(true);
    try {
      await bindPanfxCookie(cookie.trim(), remark);
      const b = { status: 'active' as const, last_check_at: new Date().toISOString(), remark: remark || null };
      setBinding(b);
      toast.success('123社区账号绑定成功');
      setCookie('');
      loadPosts();
    } catch (e) {
      toast.error('绑定失败：' + ((e as Error).message || '请重试'));
    } finally { setSaving(false); }
  }

  async function handleUnbind() {
    setSaving(true);
    try {
      await unbindPanfx();
      setBinding(null);
      setPosts([]);
      toast.success('已解绑 123社区账号');
    } catch { toast.error('解绑失败'); }
    finally { setSaving(false); }
  }

  async function handleCheck() {
    setChecking(true);
    try {
      const { data: sessionData } = await (await import('@/db/supabase')).supabase.auth.getSession();
      if (!sessionData?.session) throw new Error('请先登录');
      const res = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/panfx-proxy?action=check`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${sessionData.session.access_token}`, 'Content-Type': 'application/json' },
          body: '{}',
        }
      );
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.ok) {
        setBinding((prev) => prev ? { ...prev, status: 'active', last_check_at: new Date().toISOString() } : prev);
        toast.success('Cookie 有效' + (data.username ? `（${data.username}）` : ''));
      } else {
        setBinding((prev) => prev ? { ...prev, status: 'expired' } : prev);
        toast.error('Cookie 已失效，请重新绑定');
      }
    } catch (e) { toast.error('验证失败：' + ((e as Error).message || '')); }
    finally { setChecking(false); }
  }

  async function handleDelete() {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      const { data: sessionData } = await (await import('@/db/supabase')).supabase.auth.getSession();
      if (!sessionData?.session) throw new Error('请先登录');
      const res = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/panfx-proxy?action=del&tid=${deleteTarget.tid}`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${sessionData.session.access_token}`, 'Content-Type': 'application/json' },
          body: '{}',
        }
      );
      if (!res.ok) { const d = await res.json().catch(() => ({})); throw new Error(d?.error || '删除失败'); }
      setPosts((prev) => prev.filter((p) => p.tid !== deleteTarget.tid));
      toast.success(`已删除帖子：${deleteTarget.subject || `tid#${deleteTarget.tid}`}`);
      setDeleteTarget(null);
    } catch (e) { toast.error('删除失败：' + ((e as Error).message || '')); }
    finally { setDeleting(false); }
  }

  if (loadingBinding) {
    return <div className="py-12 text-center text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin inline mr-2" />加载中…</div>;
  }

  return (
    <div className="space-y-6">
      {/* ── 账号绑定卡片 ── */}
      <div className="rounded-xl border border-border bg-card p-4 md:p-6">
        <div className="flex items-center justify-between mb-4 gap-3 flex-wrap">
          <div className="flex items-center gap-2">
            <Tv2 className="h-4 w-4 text-primary shrink-0" />
            <h2 className="font-serif text-base font-bold text-foreground">123社区账号绑定</h2>
          </div>
          <div className="flex items-center gap-2">
            {isBound ? (
              <Badge className="bg-secondary/15 text-secondary border-0 hover:bg-secondary/15">已绑定 · 正常</Badge>
            ) : isExpired ? (
              <Badge className="bg-destructive/15 text-destructive border-0 hover:bg-destructive/15">已过期</Badge>
            ) : (
              <Badge variant="secondary" className="bg-muted text-muted-foreground border-0">未绑定</Badge>
            )}
            {(isBound || isExpired) && (
              <Button variant="ghost" size="sm" onClick={handleCheck} disabled={checking}
                className="h-7 text-xs text-muted-foreground hover:text-foreground gap-1 px-2">
                {checking ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}验证
              </Button>
            )}
          </div>
        </div>

        {isBound && (
          <div className="mb-4 p-3 rounded-lg bg-muted/60 text-xs text-muted-foreground">
            123社区账号 Cookie 正常（最近检测：{binding?.last_check_at ? new Date(binding.last_check_at).toLocaleString('zh-CN') : '—'}）
            {binding?.remark && <span className="ml-2">备注：{binding.remark}</span>}
          </div>
        )}
        {isExpired && (
          <div className="mb-4 p-3 rounded-lg bg-destructive/10 text-xs text-destructive">
            123社区 Cookie 已失效，请重新粘贴绑定。
          </div>
        )}

        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label className="text-sm text-foreground">站点 Cookie</Label>
            <Textarea value={cookie} onChange={(e) => setCookie(e.target.value)}
              placeholder="粘贴 123panfx.com 的完整 Cookie（须含 bbs_token 和 bbs_sid）"
              className="min-h-20 px-3 text-xs bg-input border-border focus-visible:ring-primary/40 font-mono" />
          </div>
          <div className="space-y-1.5">
            <Label className="text-sm text-foreground">备注（可选）</Label>
            <Input value={remark} onChange={(e) => setRemark(e.target.value)} placeholder="如：主账号"
              className="h-9 px-3 text-sm bg-input border-border focus-visible:ring-primary/40" />
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <Button onClick={handleBind} disabled={saving}
              className="h-9 bg-primary text-primary-foreground hover:bg-primary/90 gap-1.5">
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Link2 className="h-4 w-4" />}
              {isBound || isExpired ? '重新绑定' : '绑定账号'}
            </Button>
            {(isBound || isExpired) && (
              <Button variant="outline" onClick={handleUnbind} disabled={saving}
                className="h-9 border-border text-muted-foreground hover:text-foreground hover:bg-muted gap-1.5">
                <Unlink className="h-4 w-4" />解绑
              </Button>
            )}
          </div>
        </div>

        <div className="mt-4 flex items-start gap-2 p-3 rounded-lg bg-muted/40 text-xs text-muted-foreground">
          <Info className="h-3.5 w-3.5 shrink-0 mt-0.5" />
          <span>
            获取 Cookie：Chrome 打开 123panfx.com 并登录 → F12 → Network → 刷新页面 → 点击任意请求
            → Request Headers → 复制完整 Cookie（必须含 bbs_sid HttpOnly 项，
            document.cookie 读不到，需从 Network 面板复制）。
          </span>
        </div>
      </div>

      {/* ── 我的帖子记录 ── */}
      {isBound && (
        <div className="rounded-xl border border-border bg-card overflow-hidden">
          <div className="flex items-center justify-between px-4 md:px-6 py-4 border-b border-border gap-3 flex-wrap">
            <div className="flex items-center gap-2 min-w-0">
              <UploadCloud className="h-4 w-4 text-muted-foreground shrink-0" />
              <h2 className="font-serif text-base font-bold text-foreground">我的帖子记录</h2>
              <span className="text-xs text-muted-foreground">{posts.length} 条</span>
            </div>
            <div className="flex items-center gap-2 shrink-0 flex-wrap">
              <Input value={search} onChange={(e) => setSearch(e.target.value)}
                placeholder="搜索标题…"
                className="h-8 w-36 text-xs bg-input border-border focus-visible:ring-primary/40" />
              <Button variant="ghost" size="sm" onClick={loadPosts} disabled={listLoading}
                className="h-8 text-xs text-muted-foreground hover:text-foreground hover:bg-muted gap-1.5">
                <RefreshCw className={`h-3.5 w-3.5 ${listLoading ? 'animate-spin' : ''}`} />刷新
              </Button>
            </div>
          </div>

          {listLoading ? (
            <div className="py-16 text-center text-sm text-muted-foreground">
              <Loader2 className="h-5 w-5 animate-spin inline mr-2" />加载中…
            </div>
          ) : filteredPosts.length === 0 ? (
            <div className="py-16 text-center text-sm text-muted-foreground">
              {search ? `未找到「${search}」相关帖子` : '暂无帖子记录'}
            </div>
          ) : (
            <div className="w-full max-w-full overflow-x-auto bg-card">
              <table className="w-full min-w-max text-sm">
                <thead>
                  <tr className="border-b border-border bg-card">
                    <th className="px-4 py-3 text-left text-xs font-semibold text-muted-foreground whitespace-nowrap min-w-52">标题</th>
                    <th className="px-4 py-3 text-left text-xs font-semibold text-muted-foreground whitespace-nowrap">回复</th>
                    <th className="px-4 py-3 text-left text-xs font-semibold text-muted-foreground whitespace-nowrap">浏览</th>
                    <th className="px-4 py-3 text-left text-xs font-semibold text-muted-foreground whitespace-nowrap">发布时间</th>
                    <th className="px-4 py-3 text-right text-xs font-semibold text-muted-foreground whitespace-nowrap">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredPosts.map((post) => {
                    const date = post.create_date
                      ? new Date(Number(post.create_date) * 1000).toLocaleDateString('zh-CN')
                      : '—';
                    const url = `https://www.123panfx.com/thread-${post.tid}-1-1.html`;
                    return (
                      <tr key={post.tid} className="border-b border-border/50 hover:bg-muted/20">
                        <td className="px-4 py-3 font-medium text-foreground max-w-xs truncate whitespace-nowrap">
                          <a href={url} target="_blank" rel="noreferrer"
                            className="hover:text-primary hover:underline transition-colors">
                            {post.subject || '—'}
                          </a>
                        </td>
                        <td className="px-4 py-3 whitespace-nowrap text-xs text-muted-foreground">{post.posts ?? '—'}</td>
                        <td className="px-4 py-3 whitespace-nowrap text-xs text-muted-foreground">{post.views ?? '—'}</td>
                        <td className="px-4 py-3 whitespace-nowrap text-xs text-muted-foreground">{date}</td>
                        <td className="px-4 py-3 whitespace-nowrap text-right">
                          <Button variant="ghost" size="sm" onClick={() => setDeleteTarget(post)}
                            className="h-7 text-xs text-destructive hover:text-destructive hover:bg-muted">
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* ── 删帖确认 ── */}
      <AlertDialog open={!!deleteTarget} onOpenChange={(o) => !o && setDeleteTarget(null)}>
        <AlertDialogContent className="max-w-[calc(100%-2rem)] md:max-w-md bg-card border-border">
          <AlertDialogHeader>
            <AlertDialogTitle>删除帖子？</AlertDialogTitle>
            <AlertDialogDescription>
              将从 123社区删除「{deleteTarget?.subject || `tid#${deleteTarget?.tid}`}」，此操作不可恢复。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction onClick={handleDelete} disabled={deleting}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90">
              {deleting && <Loader2 className="h-4 w-4 animate-spin mr-1.5" />}确认删除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

// ─── 不太灵站点 (web3.mukaku.com / MUKAKU) ───────────────────

function deriveMukakuPanLabel(link: string): string {
  const l = String(link || '').toLowerCase();
  if (l.includes('pan.baidu.com')) return '百度网盘';
  if (l.includes('aliyundrive.com') || l.includes('alipan.com')) return '阿里云盘';
  if (l.includes('pan.quark.cn')) return '夸克网盘';
  if (l.includes('115.com')) return '115网盘';
  if (l.includes('lanzou')) return '蓝奏云';
  if (l.includes('pan.xunlei.com')) return '迅雷云盘';
  if (l.includes('disk.uc.cn') || l.includes('drive.uc.cn')) return 'UC网盘';
  if (l.includes('123pan.com') || l.includes('123912.com')) return '123网盘';
  if (l.includes('cloud.189.cn')) return '天翼云盘';
  if (l.includes('guangyapan.com')) return '光雅网盘';
  return '其他网盘';
}

function MukakuSiteTab() {
  const [binding, setBinding] = useState<MukakuBinding | null>(null);
  const [loadingBinding, setLoadingBinding] = useState(true);

  // 绑定表单状态
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [captchaCode, setCaptchaCode] = useState('');
  const [captchaData, setCaptchaData] = useState<MukakuCaptcha | null>(null);
  const [captchaLoading, setCaptchaLoading] = useState(false);
  const [binding_, setBinding_] = useState(false);

  // 我的发布记录
  const [resources, setResources] = useState<MukakuWpResource[]>([]);
  const [loadingList, setLoadingList] = useState(false);
  const [searchSeed, setSearchSeed] = useState('');
  const [filterType, setFilterType] = useState('all');

  // 片源搜索与直接挂载
  const [searchMovieKw, setSearchMovieKw] = useState('');
  const [searchingMovies, setSearchingMovies] = useState(false);
  const [movies, setMovies] = useState<MukakuMovie[]>([]);
  const [hasSearched, setHasSearched] = useState(false);

  // 挂载弹窗
  const [attachDialogMovie, setAttachDialogMovie] = useState<MukakuMovie | null>(null);
  const [resolvingId, setResolvingId] = useState(false);
  const [resolvedMoviesId, setResolvedMoviesId] = useState<number | null>(null);
  const [attachSeedName, setAttachSeedName] = useState('');
  const [attachLink, setAttachLink] = useState('');
  const [attachCode, setAttachCode] = useState('');
  const [attaching, setAttaching] = useState(false);

  // 修改弹窗
  const [editItem, setEditItem] = useState<MukakuWpResource | null>(null);
  const [editSeedName, setEditSeedName] = useState('');
  const [editLink, setEditLink] = useState('');
  const [editCode, setEditCode] = useState('');
  const [savingEdit, setSavingEdit] = useState(false);

  // 删除弹窗
  const [deleteTarget, setDeleteTarget] = useState<MukakuWpResource | null>(null);
  const [deleting, setDeleting] = useState(false);

  const loadStatus = useCallback(async () => {
    setLoadingBinding(true);
    try {
      const res = await getMukakuStatus();
      setBinding(res);
    } catch {
      setBinding(null);
    } finally {
      setLoadingBinding(false);
    }
  }, []);

  const loadCaptcha = useCallback(async () => {
    setCaptchaLoading(true);
    try {
      const c = await fetchMukakuCaptcha();
      setCaptchaData(c);
      setCaptchaCode('');
    } catch (e) {
      toast.error((e as Error).message || '获取图形验证码失败，请重试');
    } finally {
      setCaptchaLoading(false);
    }
  }, []);

  const loadResources = useCallback(async () => {
    setLoadingList(true);
    try {
      const res = await fetchMukakuResources();
      setResources(res.items);
    } catch (e) {
      const err = e as Error & { code?: string };
      if (err.code === MUKAKU_TOKEN_EXPIRED_CODE) {
        setBinding((b) => (b ? { ...b, status: 'expired', valid: false } : b));
        toast.error('不太灵站点登录已过期，请重新填写验证码登录');
      } else {
        toast.error(err.message || '加载发布记录失败');
      }
    } finally {
      setLoadingList(false);
    }
  }, []);

  useEffect(() => {
    loadStatus();
  }, [loadStatus]);

  useEffect(() => {
    if (!binding || binding.status === 'expired') {
      loadCaptcha();
    } else if (binding.status === 'active') {
      loadResources();
    }
  }, [binding?.status, loadCaptcha, loadResources]);

  async function handleLogin() {
    if (!username.trim() || !password.trim()) {
      toast.error('请填写不太灵站点账号和密码');
      return;
    }
    if (!captchaData?.key) {
      toast.error('验证码尚未就绪，请点击刷新');
      loadCaptcha();
      return;
    }
    if (!captchaCode.trim()) {
      toast.error('请输入验证码图片中的计算结果');
      return;
    }

    setBinding_(true);
    try {
      await bindMukaku({
        username: username.trim(),
        password: password.trim(),
        code: captchaCode.trim(),
        key: captchaData.key,
      });
      toast.success('不太灵站点绑定成功！');
      setUsername('');
      setPassword('');
      setCaptchaCode('');
      await loadStatus();
      await loadResources();
    } catch (e) {
      const err = e as Error;
      toast.error(err.message || '登录绑定失败，请重试');
      loadCaptcha();
    } finally {
      setBinding_(false);
    }
  }

  async function handleUnbind() {
    setBinding_(true);
    try {
      await unbindMukaku();
      toast.success('已解除不太灵站点绑定');
      setBinding(null);
      setResources([]);
      loadCaptcha();
    } catch (e) {
      toast.error((e as Error).message || '解绑失败');
    } finally {
      setBinding_(false);
    }
  }

  async function handleSearchMovies(e?: React.FormEvent) {
    if (e) e.preventDefault();
    const q = searchMovieKw.trim();
    if (!q) {
      toast.error('请输入片名搜索');
      return;
    }
    setSearchingMovies(true);
    setHasSearched(true);
    try {
      const list = await searchMukakuMovies(q);
      setMovies(list);
    } catch (e) {
      const err = e as Error & { code?: string };
      if (err.code === MUKAKU_TOKEN_EXPIRED_CODE) {
        setBinding((b) => (b ? { ...b, status: 'expired', valid: false } : b));
        toast.error('登录态已失效，请重新登录');
      } else {
        toast.error(err.message || '搜索片源失败');
      }
    } finally {
      setSearchingMovies(false);
    }
  }

  async function handleOpenAttach(m: MukakuMovie) {
    setAttachDialogMovie(m);
    setAttachSeedName(m.title);
    setAttachLink('');
    setAttachCode('');
    setResolvedMoviesId(null);
    setResolvingId(true);
    try {
      const targetDoubId = m.doub_id || m.id;
      if (!targetDoubId) throw new Error('缺少豆瓣 ID');
      const detail = await getMukakuMovieDetail(targetDoubId);
      setResolvedMoviesId(detail.movies_id);
      if (detail.title && !m.title) setAttachSeedName(detail.title);
    } catch (e) {
      toast.error((e as Error).message || '无法获取影片主键，请重试');
    } finally {
      setResolvingId(false);
    }
  }

  async function handleSubmitAttach() {
    if (!resolvedMoviesId) {
      toast.error('尚未取得影片站内主键，无法挂载');
      return;
    }
    if (!attachSeedName.trim()) {
      toast.error('请填写资源标题');
      return;
    }
    if (!attachLink.trim()) {
      toast.error('请填写网盘分享链接');
      return;
    }

    setAttaching(true);
    try {
      const res = await addMukakuResource({
        movies_id: resolvedMoviesId,
        seed_name: attachSeedName.trim(),
        link: attachLink.trim(),
        code: attachCode.trim(),
      });
      toast.success('挂载发布成功！已添加至我的发布');
      setAttachDialogMovie(null);
      await loadResources();
    } catch (e) {
      const err = e as Error & { code?: string };
      if (err.code === MUKAKU_TOKEN_EXPIRED_CODE) {
        setBinding((b) => (b ? { ...b, status: 'expired', valid: false } : b));
        toast.error('登录态已失效，请重新登录');
      } else {
        toast.error(err.message || '挂载发布失败');
      }
    } finally {
      setAttaching(false);
    }
  }

  async function handleSaveEdit() {
    if (!editItem) return;
    if (!editSeedName.trim() || !editLink.trim()) {
      toast.error('资源标题和链接不能为空');
      return;
    }
    setSavingEdit(true);
    try {
      await updateMukakuResource({
        id: editItem.id,
        movies_id: editItem.movies_id,
        seed_name: editSeedName.trim(),
        link: editLink.trim(),
        code: editCode.trim(),
      });
      toast.success('修改成功！');
      setEditItem(null);
      await loadResources();
    } catch (e) {
      toast.error((e as Error).message || '修改失败');
    } finally {
      setSavingEdit(false);
    }
  }

  async function handleDelete() {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await deleteMukakuResource(deleteTarget.id);
      toast.success('已删除该条发布');
      setDeleteTarget(null);
      await loadResources();
    } catch (e) {
      toast.error((e as Error).message || '删除失败');
    } finally {
      setDeleting(false);
    }
  }

  const isBound = !!binding && binding.status === 'active';
  const isExpired = !!binding && binding.status === 'expired';

  const filteredResources = resources.filter((item) => {
    const q = searchSeed.trim().toLowerCase();
    const matchKw = !q || (item.seed_name ?? '').toLowerCase().includes(q) || (item.vod_name ?? '').toLowerCase().includes(q);
    const matchType = filterType === 'all' || (item.type ?? '').toLowerCase() === filterType.toLowerCase();
    return matchKw && matchType;
  });

  return (
    <div className="space-y-6">
      {/* 账号状态卡片 */}
      <div className="rounded-xl border border-border bg-card p-5 space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <span className="flex items-center justify-center w-7 h-7 rounded-lg bg-primary/10 text-primary shrink-0">
              <Tv2 className="h-4 w-4" />
            </span>
            <div>
              <div className="flex items-center gap-2">
                <span className="text-sm font-semibold text-foreground">不太灵影视站点</span>
                <span className="text-[11px] text-muted-foreground font-mono">(web3.mukaku.com)</span>
              </div>
              <p className="text-xs text-muted-foreground mt-0.5">
                支持片源搜索与一键直接挂载，免去先到站点发布的繁琐流程
              </p>
            </div>
          </div>
          <div>
            {loadingBinding ? (
              <Badge variant="outline" className="text-xs text-muted-foreground gap-1">
                <Loader2 className="h-3 w-3 animate-spin" /> 检测中…
              </Badge>
            ) : isBound ? (
              <Badge variant="outline" className="text-xs text-primary border-primary/30 bg-primary/5 gap-1.5 py-1 px-2.5">
                <span className="w-1.5 h-1.5 rounded-full bg-primary animate-pulse" />
                已绑定 ({binding.username || '已登录'})
              </Badge>
            ) : isExpired ? (
              <Badge variant="outline" className="text-xs text-destructive border-destructive/30 bg-destructive/5 gap-1.5 py-1 px-2.5">
                <span className="w-1.5 h-1.5 rounded-full bg-destructive" />
                登录已过期，请重新登录
              </Badge>
            ) : (
              <Badge variant="outline" className="text-xs text-muted-foreground gap-1.5 py-1 px-2.5">
                <span className="w-1.5 h-1.5 rounded-full bg-muted-foreground/40" />
                未绑定账号
              </Badge>
            )}
          </div>
        </div>

        {/* 未绑定或已过期时的登录绑定表单 */}
        {(!isBound || isExpired) && (
          <div className="rounded-lg border border-border bg-muted/30 p-4 space-y-4">
            <div className="flex items-start gap-2 text-xs text-muted-foreground">
              <Info className="h-4 w-4 shrink-0 mt-0.5 text-primary" />
              <span>
                不太灵站点登录采用<strong>图形算术验证码</strong>（如 16+7= 则输入 23），Token 有效期为 7 天。密码不落库，换取安全凭据后仅保存在服务端。
              </span>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">站点账号 / 用户名</Label>
                <Input
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  placeholder="输入 web3.mukaku.com 账号"
                  className="h-9 text-xs"
                  disabled={binding_}
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">站点密码</Label>
                <Input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="输入密码"
                  className="h-9 text-xs"
                  disabled={binding_}
                />
              </div>
            </div>

            <div className="flex flex-col sm:flex-row items-stretch sm:items-end gap-3">
              <div className="flex-1 space-y-1.5">
                <Label className="text-xs text-muted-foreground">图形算式验证码结果</Label>
                <div className="flex items-center gap-2">
                  <Input
                    value={captchaCode}
                    onChange={(e) => setCaptchaCode(e.target.value)}
                    placeholder="输入算式计算结果（如 23）"
                    className="h-9 text-xs flex-1"
                    disabled={binding_}
                  />
                  <div
                    onClick={loadCaptcha}
                    title="点击刷新验证码"
                    className="h-9 w-36 px-2 rounded-md border border-border bg-background flex items-center justify-center cursor-pointer hover:border-primary transition-colors shrink-0 overflow-hidden"
                  >
                    {captchaLoading ? (
                      <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                    ) : captchaData?.img ? (
                      <img src={captchaData.img} alt="算术验证码" className="h-7 w-auto object-contain" />
                    ) : (
                      <span className="text-[11px] text-muted-foreground flex items-center gap-1">
                        <RefreshCw className="h-3 w-3" /> 点击加载
                      </span>
                    )}
                  </div>
                </div>
              </div>

              <Button
                onClick={handleLogin}
                disabled={binding_ || captchaLoading}
                className="h-9 text-xs px-5 shrink-0 gap-1.5"
              >
                {binding_ ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <LogIn className="h-3.5 w-3.5" />}
                {isExpired ? '重新验证并登录' : '登录并绑定'}
              </Button>
            </div>
          </div>
        )}

        {/* 已绑定时的操作栏 */}
        {isBound && (
          <div className="flex flex-wrap items-center justify-between gap-2 pt-2 border-t border-border/50 text-xs">
            <span className="text-muted-foreground">
              当前账号：<strong className="text-foreground">{binding.username}</strong>
              {binding.token_expires_at && (
                <span className="ml-2 text-muted-foreground">
                  (有效至: {new Date(binding.token_expires_at).toLocaleDateString()})
                </span>
              )}
            </span>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={loadResources}
                disabled={loadingList}
                className="h-8 text-xs gap-1"
              >
                <RefreshCw className={`h-3.5 w-3.5 ${loadingList ? 'animate-spin' : ''}`} />
                刷新发布列表
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={handleUnbind}
                disabled={binding_}
                className="h-8 text-xs text-destructive hover:text-destructive hover:bg-destructive/10 gap-1"
              >
                <Unlink className="h-3.5 w-3.5" />
                解除绑定
              </Button>
            </div>
          </div>
        )}
      </div>

      {/* 搜索片源直接挂载资源 (核心能力) */}
      {isBound && (
        <div className="rounded-xl border border-border bg-card p-5 space-y-4">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <span className="flex items-center justify-center w-7 h-7 rounded-lg bg-primary/10 text-primary shrink-0">
                <UploadCloud className="h-4 w-4" />
              </span>
              <div>
                <h2 className="text-sm font-semibold text-foreground">搜索片源并直接挂载</h2>
                <p className="text-xs text-muted-foreground">搜索站点已有影片，填入网盘链接直接挂载发布</p>
              </div>
            </div>
          </div>

          <form onSubmit={handleSearchMovies} className="flex gap-2">
            <Input
              value={searchMovieKw}
              onChange={(e) => setSearchMovieKw(e.target.value)}
              placeholder="输入片名搜索不太灵站点片源（如：庆余年、死神…）"
              className="h-9 text-xs flex-1"
            />
            <Button type="submit" disabled={searchingMovies} className="h-9 text-xs px-4 gap-1.5 shrink-0">
              {searchingMovies ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Tv2 className="h-3.5 w-3.5" />}
              搜索片源
            </Button>
          </form>

          {/* 搜索结果 */}
          {searchingMovies ? (
            <div className="py-8 text-center text-xs text-muted-foreground">
              <Loader2 className="h-5 w-5 animate-spin mx-auto mb-2 text-primary" />
              正在检索不太灵站点片库…
            </div>
          ) : hasSearched && movies.length === 0 ? (
            <div className="py-6 text-center text-xs text-muted-foreground">
              未找到与「{searchMovieKw}」相关的影片，请更换关键词
            </div>
          ) : movies.length > 0 ? (
            <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3 max-h-80 overflow-y-auto pr-1">
              {movies.map((m, idx) => (
                <div
                  key={m.doub_id || m.id || idx}
                  className="rounded-lg border border-border p-3 flex gap-3 hover:border-primary/50 transition-colors bg-muted/20"
                >
                  {m.pic ? (
                    <img
                      src={m.pic}
                      alt={m.title}
                      className="w-14 h-20 object-cover rounded shrink-0 bg-muted"
                      onError={(e) => { (e.target as HTMLElement).style.display = 'none'; }}
                    />
                  ) : (
                    <div className="w-14 h-20 rounded bg-muted flex items-center justify-center shrink-0 text-muted-foreground text-[10px]">
                      无海报
                    </div>
                  )}
                  <div className="flex-1 min-w-0 flex flex-col justify-between">
                    <div>
                      <div className="text-xs font-semibold text-foreground truncate" title={m.title}>
                        {m.title}
                      </div>
                      <div className="text-[11px] text-muted-foreground mt-0.5 space-x-1.5">
                        {m.year && <span>{m.year}</span>}
                        {m.rate && <span className="text-primary font-medium">★ {m.rate}</span>}
                      </div>
                      {m.actors && (
                        <p className="text-[10px] text-muted-foreground line-clamp-1 mt-0.5">
                          {m.actors}
                        </p>
                      )}
                    </div>
                    <Button
                      size="sm"
                      onClick={() => handleOpenAttach(m)}
                      className="h-6 text-[11px] mt-2 px-2.5 self-start gap-1"
                    >
                      <Link2 className="h-3 w-3" />
                      挂载资源
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          ) : null}
        </div>
      )}

      {/* 我的发布记录管理 */}
      {isBound && (
        <div className="rounded-xl border border-border bg-card p-5 space-y-4">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <span className="flex items-center justify-center w-7 h-7 rounded-lg bg-primary/10 text-primary shrink-0">
                <HardDrive className="h-4 w-4" />
              </span>
              <div>
                <h2 className="text-sm font-semibold text-foreground">我的发布记录</h2>
                <p className="text-xs text-muted-foreground">
                  已在不太灵站点发布的资源，共 {resources.length} 条
                </p>
              </div>
            </div>

            <div className="flex items-center gap-2">
              <Select value={filterType} onValueChange={setFilterType}>
                <SelectTrigger className="h-8 text-xs w-28">
                  <SelectValue placeholder="网盘类型" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">全部网盘</SelectItem>
                  <SelectItem value="quark">夸克网盘</SelectItem>
                  <SelectItem value="baidu">百度网盘</SelectItem>
                  <SelectItem value="ali">阿里云盘</SelectItem>
                  <SelectItem value="115">115网盘</SelectItem>
                  <SelectItem value="123">123网盘</SelectItem>
                  <SelectItem value="uc">UC网盘</SelectItem>
                  <SelectItem value="xunlei">迅雷网盘</SelectItem>
                  <SelectItem value="tianyi">天翼云盘</SelectItem>
                </SelectContent>
              </Select>
              <Input
                value={searchSeed}
                onChange={(e) => setSearchSeed(e.target.value)}
                placeholder="筛选标题…"
                className="h-8 text-xs w-36"
              />
            </div>
          </div>

          {loadingList ? (
            <div className="py-10 text-center text-xs text-muted-foreground">
              <Loader2 className="h-5 w-5 animate-spin mx-auto mb-2 text-primary" />
              加载发布记录中…
            </div>
          ) : filteredResources.length === 0 ? (
            <div className="py-10 text-center text-xs text-muted-foreground">
              {resources.length === 0 ? '暂无发布记录，可通过上方搜索片源挂载发布' : '没有符合筛选条件的记录'}
            </div>
          ) : (
            <div className="border border-border rounded-lg divide-y divide-border overflow-hidden">
              {filteredResources.map((item) => (
                <div key={item.id} className="p-3 hover:bg-muted/30 transition-colors flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                  <div className="flex-1 min-w-0 space-y-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-xs font-semibold text-foreground break-all">
                        {item.seed_name || '未命名资源'}
                      </span>
                      {item.vod_name && (
                        <Badge variant="outline" className="text-[10px] text-muted-foreground">
                          [{item.vod_name}]
                        </Badge>
                      )}
                      <Badge variant="secondary" className="text-[10px] bg-primary/10 text-primary border-primary/20">
                        {deriveMukakuPanLabel(item.link || item.type || '')}
                      </Badge>
                      {item.code && (
                        <span className="text-[11px] text-muted-foreground">
                          提取码: <strong className="font-mono text-foreground">{item.code}</strong>
                        </span>
                      )}
                    </div>
                    <div className="text-[11px] text-muted-foreground truncate font-mono">
                      {item.link}
                    </div>
                  </div>

                  <div className="flex items-center gap-1.5 self-end sm:self-center shrink-0">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        setEditItem(item);
                        setEditSeedName(item.seed_name);
                        setEditLink(item.link);
                        setEditCode(item.code || '');
                      }}
                      className="h-7 text-xs px-2 gap-1"
                    >
                      <Pencil className="h-3 w-3" />
                      修改
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setDeleteTarget(item)}
                      className="h-7 text-xs text-destructive hover:text-destructive hover:bg-destructive/10 px-2 gap-1"
                    >
                      <Trash2 className="h-3 w-3" />
                      删除
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* 挂载弹窗 */}
      <Dialog open={!!attachDialogMovie} onOpenChange={(open) => !open && setAttachDialogMovie(null)}>
        <DialogContent className="max-w-[calc(100%-2rem)] md:max-w-lg">
          <DialogHeader>
            <DialogTitle className="text-sm font-semibold">挂载发布到不太灵站点</DialogTitle>
          </DialogHeader>

          {resolvingId ? (
            <div className="py-8 text-center text-xs text-muted-foreground">
              <Loader2 className="h-5 w-5 animate-spin mx-auto mb-2 text-primary" />
              正在获取影片内部主键…
            </div>
          ) : (
            <div className="space-y-3.5 py-1 text-xs">
              <div className="rounded-lg bg-muted/40 p-2.5">
                <span className="text-muted-foreground">目标影片：</span>
                <strong className="text-foreground">{attachDialogMovie?.title}</strong>
                {resolvedMoviesId && (
                  <span className="ml-2 text-muted-foreground font-mono">(ID: {resolvedMoviesId})</span>
                )}
              </div>

              <div className="space-y-1">
                <Label className="text-xs">资源标题</Label>
                <Input
                  value={attachSeedName}
                  onChange={(e) => setAttachSeedName(e.target.value)}
                  placeholder="如：庆余年第二季 4K 纯净版"
                  className="h-9 text-xs"
                />
              </div>

              <div className="space-y-1">
                <div className="flex items-center justify-between">
                  <Label className="text-xs">网盘分享链接</Label>
                  {attachLink && (
                    <span className="text-[11px] text-primary">
                      识别类型: {deriveMukakuPanLabel(attachLink)}
                    </span>
                  )}
                </div>
                <Input
                  value={attachLink}
                  onChange={(e) => setAttachLink(e.target.value)}
                  placeholder="https://pan.quark.cn/s/..."
                  className="h-9 text-xs font-mono"
                />
              </div>

              <div className="space-y-1">
                <Label className="text-xs">提取码（选填）</Label>
                <Input
                  value={attachCode}
                  onChange={(e) => setAttachCode(e.target.value)}
                  placeholder="如无则留空"
                  className="h-9 text-xs font-mono"
                />
              </div>
            </div>
          )}

          <DialogFooter className="gap-2">
            <Button variant="outline" size="sm" onClick={() => setAttachDialogMovie(null)}>
              取消
            </Button>
            <Button
              size="sm"
              disabled={attaching || resolvingId || !resolvedMoviesId}
              onClick={handleSubmitAttach}
              className="gap-1.5"
            >
              {attaching && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              确认挂载并发布
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 修改发布弹窗 */}
      <Dialog open={!!editItem} onOpenChange={(open) => !open && setEditItem(null)}>
        <DialogContent className="max-w-[calc(100%-2rem)] md:max-w-lg">
          <DialogHeader>
            <DialogTitle className="text-sm font-semibold">修改已发布资源</DialogTitle>
          </DialogHeader>

          <div className="space-y-3.5 py-1 text-xs">
            <div className="space-y-1">
              <Label className="text-xs">资源标题</Label>
              <Input
                value={editSeedName}
                onChange={(e) => setEditSeedName(e.target.value)}
                className="h-9 text-xs"
              />
            </div>

            <div className="space-y-1">
              <div className="flex items-center justify-between">
                <Label className="text-xs">网盘链接</Label>
                {editLink && (
                  <span className="text-[11px] text-primary">
                    识别类型: {deriveMukakuPanLabel(editLink)}
                  </span>
                )}
              </div>
              <Input
                value={editLink}
                onChange={(e) => setEditLink(e.target.value)}
                className="h-9 text-xs font-mono"
              />
            </div>

            <div className="space-y-1">
              <Label className="text-xs">提取码（选填）</Label>
              <Input
                value={editCode}
                onChange={(e) => setEditCode(e.target.value)}
                className="h-9 text-xs font-mono"
              />
            </div>
          </div>

          <DialogFooter className="gap-2">
            <Button variant="outline" size="sm" onClick={() => setEditItem(null)}>
              取消
            </Button>
            <Button size="sm" disabled={savingEdit} onClick={handleSaveEdit} className="gap-1.5">
              {savingEdit && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              保存修改
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 删除确认弹窗 */}
      <AlertDialog open={!!deleteTarget} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <AlertDialogContent className="max-w-[calc(100%-2rem)] md:max-w-lg">
          <AlertDialogHeader>
            <AlertDialogTitle className="text-sm">确认删除此发布资源？</AlertDialogTitle>
            <AlertDialogDescription className="text-xs">
              删除后，该条网盘资源将从不太灵站点移除：
              <br />
              <strong className="text-foreground">{deleteTarget?.seed_name}</strong>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="gap-2">
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              disabled={deleting}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {deleting && <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" />}
              确认删除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

// ─── 页面入口 ────────────────────────────────────────────────
export default function SyncPage() {
  return (
    <AppLayout>
      <PageMeta
        title="站点同步管理 - 多平台网盘资源自动化发布中心"
        description="多平台与站点同步管理，支持盘链、观影、鸭影、帧影等第三方影视社区的账号绑定与自动化片源同步。"
        keywords="站点同步, 网盘发布, 多平台同步, 鸭影臻藏, 资源分发"
      />
      <div className="p-4 md:p-8 max-w-5xl mx-auto">
        <div className="flex items-center gap-2.5 mb-6">
          <span className="flex items-center justify-center w-8 h-8 rounded-lg bg-primary/10 shrink-0">
            <RefreshCw className="h-4 w-4 text-primary" />
          </span>
          <div>
            <h1 className="font-serif text-xl font-bold text-foreground">资源站点同步</h1>
            <p className="text-xs text-muted-foreground">绑定站点账号，资源更新后同步发布</p>
          </div>
        </div>

        <Tabs defaultValue="pinglian">
          <TabsList className="mb-6 bg-muted border border-border h-9">
            <TabsTrigger value="pinglian"
              className="text-xs data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm">
              盘链站点
            </TabsTrigger>
            <TabsTrigger value="xnsite"
              className="text-xs data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm">
              观影站点
            </TabsTrigger>
            <TabsTrigger value="ya"
              className="text-xs data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm">
              鸭影臻藏站点
            </TabsTrigger>
            <TabsTrigger value="framehdr"
              className="text-xs data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm">
              帧影站点
            </TabsTrigger>
            <TabsTrigger value="panfx"
              className="text-xs data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm">
              123社区
            </TabsTrigger>
            <TabsTrigger value="mukaku"
              className="text-xs data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm">
              不太灵站点
            </TabsTrigger>
          </TabsList>
          <TabsContent value="pinglian"><PinglianTab /></TabsContent>
          <TabsContent value="xnsite"><XnSiteTab /></TabsContent>
          <TabsContent value="ya"><YaSiteTab /></TabsContent>
          <TabsContent value="framehdr"><FramehdrSiteTab /></TabsContent>
          <TabsContent value="panfx"><PanfxSiteTab /></TabsContent>
          <TabsContent value="mukaku"><MukakuSiteTab /></TabsContent>
        </Tabs>
      </div>
    </AppLayout>
  );
}
