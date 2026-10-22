import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
  RefreshCw, Link2, Unlink, Loader2, Pencil, Trash2, UploadCloud, Info, Tv2,
  HardDrive, LogIn, ShieldAlert, Save, ShieldCheck, Radio,
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
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { toast } from 'sonner';
import {
  getXnBinding, bindXnCookie, unbindXn,
  loadXnShares, editXnShare, delXnShare,
  XN_COOKIE_EXPIRED_CODE,
  getFramehdrBinding, unbindFramehdr, loginFramehdr,
  loadFramehdrLinks, editFramehdrLink, deleteFramehdrLink,
  FRAMEHDR_COOKIE_EXPIRED_CODE,
  getPanfxBinding, bindPanfxCookie, unbindPanfx, loadPanfxPosts,
  PANFX_COOKIE_EXPIRED_CODE,
  getMukakuStatus, fetchMukakuCaptcha, bindMukaku, unbindMukaku,
  fetchMukakuResources, searchMukakuMovies, getMukakuMovieDetail,
  addMukakuResource, updateMukakuResource, deleteMukakuResource,
  MUKAKU_TOKEN_EXPIRED_CODE,
  getJyingBinding, loginJying, unbindJying, loadJyingShares,
  updateJyingShareLink, JYING_EXPIRED_CODE, revalidateJyingSession,
  getHdhavenBinding, unbindHdhaven, loadHdhavenShares, getHdhavenShareDetail,
  updateHdhavenShareLink, revalidateHdhavenSession,
  startHdhavenOAuth, loadHdhavenQuota, checkinHdhaven,
  HDHAVEN_EXPIRED_CODE, HDHAVEN_RATE_LIMITED_CODE,
  // 1号站点（开放 API 令牌型 + 站点账号登录）
  getSt1Binding, bindSt1Credential, unbindSt1, checkSt1,
  st1Categories, setSt1DefaultCategory, ST1_TOKEN_EXPIRED_CODE,
  st1Captcha, st1Login, st1MyResources, updateSt1Resource,
} from '@/services/api';
import BatchPostButton from '@/components/BatchPostButton';
import { PAN_TYPE_LABELS } from '@/lib/panUtils';
import { SITE_URLS, SITE_LABELS, siteHost, type SiteKey } from '@/lib/siteCredentials';
import type {
  XnBinding, XnShare,
  FramehdrBinding, FramehdrLink, PanfxBinding,
  MukakuBinding, MukakuCaptcha, MukakuWpResource, MukakuMovie,
  JyingBinding, JyingShareItem,
  HdhavenBinding, HdhavenShareItem,
  St1Binding,
} from '@/types/index';

/**
 * 站点网址：显示在每个「XX站点账号绑定」标题的后面。
 * 用户要知道该开哪个站才能拿 Cookie / 登录，之前只有「不太灵」一处挂了域名。
 */
function SiteUrlHint({ site }: { site: SiteKey }) {
  const url = SITE_URLS[site];
  if (!url) return null;
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer"
      onClick={(e) => e.stopPropagation()}
      className="rounded px-1.5 py-0.5 font-mono text-[11px] font-normal text-muted-foreground hover:text-primary hover:underline"
      title={`打开 ${SITE_LABELS[site]}：${url}`}
    >
      {siteHost(url)}
    </a>
  );
}

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
            <SiteUrlHint site="xn" />
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
            <BatchPostButton site="xnsite" disabled={binding_} />
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
              <table className="w-full table-fixed text-sm md:table-auto md:min-w-max">
                <thead>
                  <tr className="border-b border-border bg-card">
                    <th className="px-4 py-3 text-left text-xs font-semibold text-muted-foreground whitespace-nowrap md:min-w-48">标题</th>
                    <th className="hidden px-4 py-3 text-left text-xs font-semibold text-muted-foreground whitespace-nowrap md:table-cell">绑定作品</th>
                    <th className="hidden px-4 py-3 text-left text-xs font-semibold text-muted-foreground whitespace-nowrap md:table-cell md:min-w-40">链接</th>
                    <th className="hidden px-4 py-3 text-left text-xs font-semibold text-muted-foreground whitespace-nowrap md:table-cell">发布时间</th>
                    <th className="hidden px-4 py-3 text-left text-xs font-semibold text-muted-foreground whitespace-nowrap md:table-cell">状态</th>
                    <th className="hidden px-4 py-3 text-right text-xs font-semibold text-muted-foreground whitespace-nowrap md:table-cell">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {shares.map((share) => (
                    <tr key={share.id} className="border-b border-border/50 hover:bg-muted/20">
                      <td className="px-4 py-3 font-medium text-foreground break-words md:max-w-xs md:truncate md:whitespace-nowrap">
                        {share.title || '—'}
                        {/* 手机端：绑定作品 / 状态 / 链接 / 时间折到标题下方 */}
                        <div className="mt-1.5 space-y-1 md:hidden">
                          <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
                            <div className="flex flex-wrap items-center gap-2 text-[11px] font-normal text-muted-foreground">
                              <span>{share.tname || share.atitle || '—'}</span>
                              <Badge variant="secondary"
                                className={`text-[10px] h-4 px-1.5 border-0 ${share.status === 1 ? 'bg-secondary/15 text-secondary' : 'bg-muted text-muted-foreground'}`}>
                                {share.status === 1 ? '开启' : '关闭'}
                              </Badge>
                              <span>{share.time || '—'}</span>
                            </div>
                            {/* 手机端：操作跟在信息行右端，不单独占一列空着 */}
                            <div className="flex items-center gap-1">
                              <Button variant="ghost" size="sm" onClick={() => openEdit(share)}
                                className="h-7 px-2 text-xs font-normal text-muted-foreground hover:text-foreground hover:bg-muted gap-1">
                                <Pencil className="h-3.5 w-3.5" />修改
                              </Button>
                              <Button variant="ghost" size="sm" onClick={() => setDeleteTarget(share)}
                                className="h-7 px-2 text-xs font-normal text-destructive hover:text-destructive hover:bg-muted">
                                <Trash2 className="h-3.5 w-3.5" />
                              </Button>
                            </div>
                          </div>
                          {share.url ? (
                            <a href={share.url} target="_blank" rel="noreferrer"
                              className="block break-all text-[11px] font-normal text-primary hover:underline">
                              {share.url}
                            </a>
                          ) : null}
                        </div>
                      </td>
                      <td className="hidden px-4 py-3 whitespace-nowrap text-xs text-muted-foreground md:table-cell">
                        {share.tname || share.atitle || '—'}
                      </td>
                      <td className="hidden px-4 py-3 whitespace-nowrap max-w-xs md:table-cell">
                        {share.url ? (
                          <a href={share.url} target="_blank" rel="noreferrer"
                            className="text-xs text-primary hover:underline truncate inline-block max-w-[180px] align-bottom">
                            {share.url}
                          </a>
                        ) : '—'}
                      </td>
                      <td className="hidden px-4 py-3 whitespace-nowrap text-xs text-muted-foreground md:table-cell">{share.time || '—'}</td>
                      <td className="hidden px-4 py-3 whitespace-nowrap md:table-cell">
                        <Badge variant="secondary"
                          className={`text-xs border-0 ${share.status === 1 ? 'bg-secondary/15 text-secondary' : 'bg-muted text-muted-foreground'}`}>
                          {share.status === 1 ? '开启' : '关闭'}
                        </Badge>
                      </td>
                      <td className="hidden px-4 py-3 whitespace-nowrap text-right md:table-cell">
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
        <DialogContent className="max-w-[calc(100%-2rem)] md:max-w-lg max-h-[90dvh] overflow-y-auto bg-card border-border">
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

// ─── 帧影站点标签页 ──────────────────────────────────────────
function FramehdrSiteTab() {
  const [binding, setBinding] = useState<FramehdrBinding | null>(null);
  const [bindingLoading, setBindingLoading] = useState(true);
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
    toast.error('帧影站点登录已过期，请重新登录');
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

  async function handleLogin() {
    if (!username.trim() || !password) { toast.error('请输入帧影账号和密码'); return; }
    setLoggingIn(true);
    try {
      await loginFramehdr(username.trim(), password);
      toast.success('账号密码登录成功，会话已保存');
      setUsername('');
      setPassword('');
      await loadBinding();
      // 重新登录时 binding.status 仍是 active，上面的 useEffect 依赖未变化不会触发，
      // 这里显式刷新一次发布记录，避免「已登录但列表不更新」
      await loadLinks();
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
            <SiteUrlHint site="framehdr" />
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
            帧影站点登录已过期，请重新登录。
          </div>
        )}

        <div className="w-full">
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
                <BatchPostButton site="framehdr" disabled={binding_} />
              </div>
              <p className="text-[11px] text-muted-foreground leading-relaxed">
                服务端模拟登录帧影站点并保存会话，密码不会保存到数据库。若连续失败 5 次账号会被锁定。
              </p>
            </div>
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
              <table className="w-full table-fixed text-sm md:table-auto md:min-w-max">
                <thead>
                  <tr className="border-b border-border bg-card">
                    <th className="px-4 py-3 text-left text-xs font-semibold text-muted-foreground whitespace-nowrap md:min-w-48">标题</th>
                    <th className="hidden px-4 py-3 text-left text-xs font-semibold text-muted-foreground whitespace-nowrap md:table-cell md:min-w-24">网盘</th>
                    <th className="hidden px-4 py-3 text-left text-xs font-semibold text-muted-foreground whitespace-nowrap md:table-cell md:min-w-40">链接</th>
                    <th className="hidden px-4 py-3 text-left text-xs font-semibold text-muted-foreground whitespace-nowrap md:table-cell">发布时间</th>
                    <th className="hidden px-4 py-3 text-right text-xs font-semibold text-muted-foreground whitespace-nowrap md:table-cell">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {links.map((link) => (
                    <tr key={link.id} className="border-b border-border/50 hover:bg-muted/20">
                      <td className="px-4 py-3 font-medium text-foreground break-words md:max-w-xs md:truncate md:whitespace-nowrap">
                        {link.title || '—'}
                        {/* 手机端：网盘 / 链接 / 发布时间折到标题下方 */}
                        <div className="mt-1.5 space-y-1 md:hidden">
                          <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
                            <div className="flex flex-wrap items-center gap-2">
                              <Badge variant="secondary" className="bg-muted text-muted-foreground border-0 text-[10px] h-4 px-1.5">
                                {link.drive_name || '—'}
                              </Badge>
                              <span className="text-[11px] font-normal text-muted-foreground">{link.created_at ?? '—'}</span>
                            </div>
                            {/* 手机端：操作跟在信息行右端，不单独占一列空着 */}
                            <div className="flex items-center gap-1">
                              <Button variant="ghost" size="sm" onClick={() => openEdit(link)}
                                className="h-7 px-2 text-xs font-normal text-muted-foreground hover:text-foreground hover:bg-muted gap-1">
                                <Pencil className="h-3.5 w-3.5" />修改
                              </Button>
                              <Button variant="ghost" size="sm" onClick={() => setDeleteTarget(link)}
                                className="h-7 px-2 text-xs font-normal text-destructive hover:text-destructive hover:bg-muted">
                                <Trash2 className="h-3.5 w-3.5" />
                              </Button>
                            </div>
                          </div>
                          {link.url ? (
                            <a href={link.url} target="_blank" rel="noreferrer"
                              className="block break-all text-[11px] font-normal text-primary hover:underline">
                              {link.url}
                            </a>
                          ) : null}
                        </div>
                      </td>
                      <td className="hidden px-4 py-3 whitespace-nowrap md:table-cell">
                        <Badge variant="secondary" className="bg-muted text-muted-foreground border-0 text-xs">
                          {link.drive_name || '—'}
                        </Badge>
                      </td>
                      <td className="hidden px-4 py-3 whitespace-nowrap max-w-xs md:table-cell">
                        {link.url ? (
                          <a href={link.url} target="_blank" rel="noreferrer"
                            className="text-xs text-primary hover:underline truncate inline-block max-w-[200px] align-bottom">
                            {link.url}
                          </a>
                        ) : '—'}
                      </td>
                      <td className="hidden px-4 py-3 whitespace-nowrap text-xs text-muted-foreground md:table-cell">{link.created_at ?? '—'}</td>
                      <td className="hidden px-4 py-3 whitespace-nowrap text-right md:table-cell">
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
        <DialogContent className="max-w-[calc(100%-2rem)] md:max-w-lg max-h-[90dvh] overflow-y-auto bg-card border-border">
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

// ─── 1号站点（开放 API · pat_ 令牌）标签页 ─────────────────────
/** 站点 /categories 的返回结构不固定，统一解析成 {id, name}[] */
function parseSt1Categories(raw: unknown): Array<{ id: string; name: string }> {
  const r = (raw ?? {}) as { data?: unknown; items?: unknown; list?: unknown };
  const arr = Array.isArray(raw)
    ? raw
    : Array.isArray(r.data)
      ? (r.data as unknown[])
      : Array.isArray(r.items)
        ? (r.items as unknown[])
        : Array.isArray(r.list)
          ? (r.list as unknown[])
          : [];
  return arr
    .map((c) => {
      const o = (c ?? {}) as Record<string, unknown>;
      const id = o.id ?? o.category_id ?? o.cid;
      if (id === undefined || id === null) return null;
      return { id: String(id), name: String(o.name ?? o.title ?? o.label ?? id) };
    })
    .filter((x): x is { id: string; name: string } => !!x);
}

function St1SiteTab() {
  const [binding, setBinding] = useState<St1Binding | null>(null);
  const [loadingBinding, setLoadingBinding] = useState(true);
  const [baseUrl, setBaseUrl] = useState('');
  const [token, setToken] = useState('');
  const [saving, setSaving] = useState(false);
  const [checking, setChecking] = useState(false);
  const [cats, setCats] = useState<Array<{ id: string; name: string }>>([]);
  const [catLoading, setCatLoading] = useState(false);
  // 「我的已发布片源」列表与编辑
  const [mine, setMine] = useState<Array<Record<string, unknown>>>([]);
  const [mineLoading, setMineLoading] = useState(false);
  const [mineFiltered, setMineFiltered] = useState(true);
  const [mineScanned, setMineScanned] = useState(0);
  const [mineHint, setMineHint] = useState<string | null>(null);
  const [editItem, setEditItem] = useState<Record<string, unknown> | null>(null);
  const [editForm, setEditForm] = useState({ title: '', panUrl: '', panCode: '', content: '', categoryId: '' });
  const [editSaving, setEditSaving] = useState(false);
  // 站点账号密码登录（图形验证码）
  const [loginUser, setLoginUser] = useState('');
  const [loginPass, setLoginPass] = useState('');
  const [captchaCode, setCaptchaCode] = useState('');
  const [captchaSvg, setCaptchaSvg] = useState('');
  const [captchaLoading, setCaptchaLoading] = useState(false);
  const [loggingIn, setLoggingIn] = useState(false);

  const load = useCallback(async () => {
    setLoadingBinding(true);
    try {
      const b = await getSt1Binding();
      setBinding(b);
      if (b?.base_url) setBaseUrl(b.base_url);
    } catch { /* 未绑定或读取失败：按未绑定展示 */ }
    finally { setLoadingBinding(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const isBound = !!binding && binding.status === 'active';
  const isExpired = !!binding && binding.status === 'expired';

  async function handleBind() {
    if (!token.trim()) { toast.error('请填写站点「开放API」标签里生成的令牌（pat_…）'); return; }
    setSaving(true);
    try {
      // 站点地址由服务端内置，不再需要用户填写
      const r = await bindSt1Credential({
        token,
        defaultCategoryId: binding?.default_category_id ?? null,
      });
      const b = await getSt1Binding();
      setBinding(b ?? {
        base_url: baseUrl.trim(), username: r?.username ?? null, default_category_id: null,
        status: 'active', last_error: null, last_check_at: new Date().toISOString(),
      });
      setToken('');
      toast.success(`1号站点绑定成功${r?.username ? `（${r.username}）` : ''}`);
      void loadCats();
      void loadMine();
    } catch (e) {
      toast.error('绑定失败：' + ((e as Error).message || '请检查站点地址与令牌'));
    } finally { setSaving(false); }
  }

  async function handleUnbind() {
    setSaving(true);
    try {
      await unbindSt1();
      setBinding(null);
      setCats([]);
      toast.success('已解绑 1号站点');
    } catch { toast.error('解绑失败'); }
    finally { setSaving(false); }
  }

  async function handleCheck() {
    setChecking(true);
    try {
      const r = await checkSt1();
      setBinding((prev) => prev
        ? { ...prev, status: 'active', username: r?.username ?? prev.username, last_check_at: new Date().toISOString(), last_error: null }
        : prev);
      toast.success(`令牌有效${r?.username ? `（${r.username}）` : ''}`);
    } catch (e) {
      const err = e as Error & { code?: string };
      if (err.code === ST1_TOKEN_EXPIRED_CODE) {
        setBinding((prev) => prev ? { ...prev, status: 'expired', last_error: err.message } : prev);
      }
      toast.error(err.message || '验证失败');
    } finally { setChecking(false); }
  }

  async function loadCats() {
    setCatLoading(true);
    try {
      setCats(parseSt1Categories(await st1Categories()));
    } catch (e) {
      toast.error('读取站点分类失败：' + ((e as Error).message || ''));
    } finally { setCatLoading(false); }
  }

  async function handlePickCategory(id: string) {
    try {
      await setSt1DefaultCategory(id || null);
      setBinding((prev) => prev ? { ...prev, default_category_id: id || null } : prev);
      toast.success(id ? '已设为默认发布分类' : '已清除默认发布分类');
    } catch { toast.error('保存默认分类失败'); }
  }

  /** 从站点片源对象里取字符串字段（站点字段名不确定，做兼容） */
  function pickStr(o: Record<string, unknown>, keys: string[]): string {
    for (const k of keys) {
      const v = o[k];
      if (typeof v === 'string') return v;
      if (typeof v === 'number') return String(v);
    }
    return '';
  }
  function remoteIdOf(o: Record<string, unknown>): string {
    return pickStr(o, ['id', 'resource_id', 'rid']);
  }

  /** 读取「我发布的片源」 */
  async function loadMine() {
    setMineLoading(true);
    setMineHint(null);
    try {
      const r = await st1MyResources({ pageSize: 50 });
      setMine(r.items ?? []);
      setMineFiltered(r.filtered !== false);
      setMineScanned(r.scanned ?? (r.items ?? []).length);
      if (!r.filtered) setMineHint('站点列表未返回作者字段，下面是站点片源列表（可搜索后再编辑）。');
    } catch (e) {
      const err = e as Error & { code?: string };
      setMine([]);
      setMineHint(err.message || '读取站点片源失败');
      if (err.code === ST1_TOKEN_EXPIRED_CODE) {
        setBinding((prev) => prev ? { ...prev, status: 'expired', last_error: err.message } : prev);
      }
    } finally { setMineLoading(false); }
  }

  function openEdit(item: Record<string, unknown>) {
    setEditItem(item);
    setEditForm({
      title: pickStr(item, ['title', 'name']),
      panUrl: pickStr(item, ['pan_url', 'panUrl', 'link', 'url']),
      panCode: pickStr(item, ['pan_code', 'panCode', 'code', 'password']),
      content: pickStr(item, ['content', 'description', 'desc']),
      categoryId: pickStr(item, ['category_id', 'categoryId']) || (binding?.default_category_id ?? ''),
    });
  }

  /** 保存站点片源修改（PATCH 局部更新，只提交改动字段） */
  async function saveEdit() {
    if (!editItem) return;
    const remoteId = remoteIdOf(editItem);
    if (!remoteId) { toast.error('该片源缺少 id，无法编辑'); return; }
    if (!editForm.title.trim()) { toast.error('标题不能为空'); return; }
    setEditSaving(true);
    try {
      await updateSt1Resource({
        remoteId,
        title: editForm.title.trim(),
        ...(editForm.panUrl.trim() ? { panUrl: editForm.panUrl.trim() } : {}),
        panCode: editForm.panCode.trim(),
        content: editForm.content,
        categoryId: editForm.categoryId || null,
      });
      // 顺手记住分类：之后发布新片源默认用它
      if (editForm.categoryId) {
        try { await setSt1DefaultCategory(editForm.categoryId); } catch { /* 非关键 */ }
      }
      toast.success('已在 1号站点更新');
      setEditItem(null);
      void loadMine();
    } catch (e) {
      toast.error('更新失败：' + ((e as Error).message || ''));
    } finally { setEditSaving(false); }
  }

  /** 验证码 SVG → data URL：当图片渲染，SVG 里即便带脚本也不会执行（比 dangerouslySetInnerHTML 安全） */
  const captchaSrc = useMemo(() => {
    if (!captchaSvg) return '';
    const bytes = new TextEncoder().encode(captchaSvg);
    let bin = '';
    for (const b of bytes) bin += String.fromCharCode(b);
    try {
      return `data:image/svg+xml;base64,${btoa(bin)}`;
    } catch {
      return '';
    }
  }, [captchaSvg]);

  async function loadCaptcha() {
    setCaptchaLoading(true);
    try {
      const r = await st1Captcha();
      setCaptchaSvg(r?.svg ?? '');
      setCaptchaCode('');
    } catch (e) {
      toast.error('获取验证码失败：' + ((e as Error).message || ''));
    } finally { setCaptchaLoading(false); }
  }

  async function handleLogin() {
    if (!loginUser.trim() || !loginPass) { toast.error('请填写站点账号与密码'); return; }
    if (!captchaCode.trim()) { toast.error('请填写图形验证码'); return; }
    setLoggingIn(true);
    try {
      const r = await st1Login({ username: loginUser, password: loginPass, captcha: captchaCode });
      setBinding((prev) => prev
        ? { ...prev, username: r?.username ?? prev.username, status: 'active', last_error: null }
        : {
            base_url: null, username: r?.username ?? null, default_category_id: null,
            status: 'active', last_error: null, last_check_at: new Date().toISOString(),
          });
      setLoginPass('');
      setCaptchaCode('');
      toast.success(`站点登录成功${r?.username ? `（${r.username}）` : ''}`);
    } catch (e) {
      const err = e as Error & { code?: string };
      toast.error(err.message || '登录失败');
      // 验证码错误/过期 → 自动换一张（验证码与会话绑定，必须重新取）
      if (err.code === 'ST1_CAPTCHA_ERROR' || /验证码/.test(err.message ?? '')) void loadCaptcha();
    } finally { setLoggingIn(false); }
  }

  return (
    <div className="space-y-6">
      <div className="rounded-xl border border-border bg-card p-4 md:p-6">
        <div className="flex items-center justify-between mb-4 gap-3 flex-wrap">
          <div className="flex items-center gap-2">
            <Radio className="h-4 w-4 text-primary shrink-0" />
            <h2 className="font-serif text-base font-bold text-foreground">1号站点 · 开放 API 绑定</h2>
            <SiteUrlHint site="st1" />
          </div>
          <div className="flex items-center gap-2">
            {loadingBinding ? (
              <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
            ) : isBound ? (
              <Badge className="bg-secondary/15 text-secondary border-0 hover:bg-secondary/15">
                已绑定{binding?.username ? ` · ${binding.username}` : ' · 正常'}
              </Badge>
            ) : isExpired ? (
              <Badge className="bg-destructive/15 text-destructive border-0 hover:bg-destructive/15">令牌已失效</Badge>
            ) : (
              <Badge variant="secondary" className="bg-muted text-muted-foreground border-0">未绑定</Badge>
            )}
            {isBound && (
              <Button variant="outline" size="sm" onClick={handleCheck} disabled={checking}
                className="h-8 gap-1.5 border-border text-muted-foreground hover:text-foreground hover:bg-muted">
                {checking ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ShieldCheck className="h-3.5 w-3.5" />}检测令牌
              </Button>
            )}
            {(isBound || isExpired) && (
              <Button variant="outline" size="sm" onClick={handleUnbind} disabled={saving}
                className="h-8 gap-1.5 border-border text-destructive hover:text-destructive hover:bg-destructive/10">
                <Trash2 className="h-3.5 w-3.5" />解绑
              </Button>
            )}
          </div>
        </div>

        <div className="mb-4 p-3 rounded-lg bg-muted/60 text-xs text-muted-foreground leading-relaxed space-y-1">
          <div>
            1号站点是<b className="text-foreground">开放 API</b>型站点：登录站点后到「<b className="text-foreground">开放API</b>」标签生成自己的令牌
            （形如 <code className="font-mono">pat_xxx</code>，明文只显示一次），把它填到这里即可。
          </div>
          <div>
            接入地址为 <code className="font-mono">&lt;站点&gt;/api/open</code>，鉴权 <code className="font-mono">Authorization: Bearer pat_…</code>；
            支持发布片源（<code className="font-mono">POST /resources</code>）与编辑片源（<code className="font-mono">PATCH /resources/:id</code>）、
            分类 / PT 标签 / 豆瓣查询。
          </div>
          <div>
            绑定后：资源管理里把资源发布到该站点时使用的就是<b className="text-foreground">你自己的令牌</b>；资源改名或换链接后会自动 PATCH 同步。
            站点侧重新生成令牌后旧的立即失效，需要在这里重新绑定。
          </div>
        </div>

        {isExpired && (
          <div className="mb-4 p-3 rounded-lg bg-destructive/10 text-xs text-destructive leading-relaxed">
            令牌已失效（{binding?.last_error || '站点返回 401'}）。请到 1号站点「开放API」标签重新生成令牌后，在下面重新填写。
          </div>
        )}

        <div className="space-y-3">
          {/* 站点地址：已内置在服务端，用户不需要填写 */}
          <div className="rounded-lg border border-border bg-muted/40 px-3 py-2">
            <div className="text-sm text-foreground">
              站点地址：<span className="font-mono text-xs">{binding?.base_url || 'http://zy.beida.pw'}</span>
            </div>
            <div className="text-[11px] text-muted-foreground leading-relaxed">
              已由系统内置（服务端统一配置），不需要填写；接口前缀固定为 <code className="font-mono">/api/open</code>。
            </div>
          </div>
          <div className="space-y-1.5">
            <Label className="text-sm text-foreground">开放 API 令牌</Label>
            <Input
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder={isBound ? '如需更换令牌，粘贴新的 pat_… 后点保存' : 'pat_…'}
              className="h-9 bg-input border-border font-mono text-xs"
            />
          </div>
          <div className="flex items-center gap-2">
            <Button onClick={handleBind} disabled={saving} className="gap-1.5 bg-primary text-primary-foreground hover:bg-primary/90">
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
              {isBound ? '更新绑定' : '保存并校验'}
            </Button>
            <span className="text-[11px] text-muted-foreground">
              保存时会先调用站点的 <code className="font-mono">GET /profile</code> 校验令牌，失败不会落库。
            </span>
          </div>
        </div>

        {/* 站点账号密码登录（图形验证码）：拿站点内部会话，和开放 API 令牌相互独立 */}
        <div className="mt-5 pt-4 border-t border-border space-y-3">
          <div className="flex items-start justify-between gap-2 flex-wrap">
            <div className="min-w-0">
              <div className="text-sm text-foreground">站点账号登录（可选）</div>
              <div className="text-[11px] text-muted-foreground leading-relaxed">
                用你在 1号站点的<b className="text-foreground">账号密码</b>登录，建立站点内部会话（登录需要
                <b className="text-foreground">图形验证码</b>，所以无法自动重登）。它和上面那枚「开放 API 令牌」是两套凭据：
                发布 / 编辑片源走令牌。
              </div>
            </div>
            {binding?.username && (
              <Badge variant="secondary" className="bg-muted text-muted-foreground border-0 shrink-0">
                站点账号：{binding.username}
              </Badge>
            )}
          </div>
          <div className="grid gap-3 md:grid-cols-2">
            <div className="space-y-1.5">
              <Label className="text-sm text-foreground">站点账号</Label>
              <Input value={loginUser} onChange={(e) => setLoginUser(e.target.value)}
                placeholder="站点用户名" className="h-9 bg-input border-border" />
            </div>
            <div className="space-y-1.5">
              <Label className="text-sm text-foreground">站点密码</Label>
              <Input type="password" value={loginPass} onChange={(e) => setLoginPass(e.target.value)}
                placeholder="站点密码" className="h-9 bg-input border-border" />
            </div>
          </div>
          <div className="flex items-end gap-3 flex-wrap">
            <div className="space-y-1.5 w-44">
              <Label className="text-sm text-foreground">图形验证码</Label>
              <Input value={captchaCode} onChange={(e) => setCaptchaCode(e.target.value)}
                placeholder="输入图片中的字符" className="h-9 bg-input border-border" />
            </div>
            <button
              type="button"
              onClick={loadCaptcha}
              title="点击刷新验证码"
              className="h-9 min-w-[120px] px-3 rounded-md border border-border bg-input flex items-center justify-center"
            >
              {captchaLoading ? (
                <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
              ) : captchaSrc ? (
                <img src={captchaSrc} alt="图形验证码" className="h-7" />
              ) : (
                <span className="text-[11px] text-muted-foreground">点击获取验证码</span>
              )}
            </button>
            <Button onClick={handleLogin} disabled={loggingIn} variant="outline"
              className="h-9 gap-1.5 border-border text-foreground hover:bg-muted">
              {loggingIn ? <Loader2 className="h-4 w-4 animate-spin" /> : <LogIn className="h-4 w-4" />}
              账号登录
            </Button>
            <span className="text-[11px] text-muted-foreground pb-2">
              验证码与本次会话绑定：先点验证码图片获取，再填账号密码与验证码。
            </span>
          </div>
        </div>

        {/* 凭据云端保存（需求③）：绑定信息与会话/令牌都在服务端，换设备不用重填 */}
        <div className="mt-4 text-[11px] text-muted-foreground leading-relaxed">
          凭据已保存到<b className="text-foreground">云端</b>：绑定信息在服务端{' '}
          <code className="font-mono">st1_sessions</code>（站点地址、开放 API 令牌、站点会话 Cookie、站点账号），
          令牌与站点密码另存一份<b className="text-foreground">加密副本</b>（
          <code className="font-mono">site_credentials</code>）——换浏览器、换设备都不需要重新填写。
        </div>

        {/* 我的已发布片源（需求②）：展示账号在站点的片源，并支持编辑 */}
        {isBound && (
          <div className="mt-5 pt-4 border-t border-border space-y-3">
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <div className="min-w-0">
                <div className="text-sm text-foreground">我的已发布片源</div>
                <div className="text-[11px] text-muted-foreground leading-relaxed">
                  读取站点 <code className="font-mono">GET /resources</code>
                  {mineScanned ? `（扫描 ${mineScanned} 条${mineFiltered ? '，已筛出你的' : ''}）` : ''}；
                  点「编辑」可直接改标题 / 云盘地址 / 提取码 / 简介 / 分类（站点{' '}
                  <code className="font-mono">PATCH /resources/:id</code>）。
                </div>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <Button variant="outline" size="sm" onClick={loadCats} disabled={catLoading}
                  className="h-8 gap-1.5 border-border text-muted-foreground hover:text-foreground hover:bg-muted">
                  {catLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}读取分类
                </Button>
                <Button variant="outline" size="sm" onClick={loadMine} disabled={mineLoading}
                  className="h-8 gap-1.5 border-border text-muted-foreground hover:text-foreground hover:bg-muted">
                  {mineLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}刷新片源
                </Button>
              </div>
            </div>
            {mineHint && <p className="text-[11px] text-muted-foreground">{mineHint}</p>}
            {mineLoading && mine.length === 0 ? (
              <p className="text-[11px] text-muted-foreground">正在读取站点片源…</p>
            ) : mine.length === 0 ? (
              <p className="text-[11px] text-muted-foreground">
                {mineHint ? '' : '还没有读取到你在该站点发布的片源（发布后会出现在这里，可直接编辑）。'}
              </p>
            ) : (
              <div className="space-y-2 max-h-[340px] overflow-y-auto pr-1">
                {mine.map((it, i) => {
                  const rid = remoteIdOf(it);
                  const title = pickStr(it, ['title', 'name']) || `（无标题${rid ? ` #${rid}` : ''}）`;
                  const link = pickStr(it, ['pan_url', 'panUrl', 'link', 'url']);
                  const cat = pickStr(it, ['category_name', 'category_name_text', 'category', 'category_id']);
                  const at = pickStr(it, ['updated_at', 'updatedAt', 'created_at', 'time']);
                  return (
                    <div key={rid || i} className="rounded-lg border border-border px-3 py-2 space-y-1">
                      <div className="flex items-start justify-between gap-2">
                        <div className="text-sm text-foreground leading-snug min-w-0 break-words">{title}</div>
                        <Button variant="ghost" size="sm" onClick={() => openEdit(it)} disabled={!rid}
                          className="h-7 shrink-0 gap-1 text-xs text-muted-foreground hover:text-foreground hover:bg-muted">
                          <Pencil className="h-3.5 w-3.5" />编辑
                        </Button>
                      </div>
                      <div className="text-[11px] text-muted-foreground break-all">
                        {[cat && `分类：${cat}`, at && `更新：${at}`, link].filter(Boolean).join(' · ')}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </div>

      {/* 编辑站点片源（PATCH 只提交改动字段） */}
      <Dialog open={!!editItem} onOpenChange={(o) => !o && setEditItem(null)}>
        <DialogContent className="max-w-[calc(100%-2rem)] md:max-w-lg max-h-[90dvh] overflow-y-auto bg-card border-border">
          <DialogHeader>
            <DialogTitle>编辑 1号站点片源</DialogTitle>
            <DialogDescription className="text-xs text-muted-foreground">
              只提交改动的字段，保存后站点立即生效（更换云盘地址后站点的失效计数会自动清零）。
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label className="text-sm text-foreground">标题</Label>
              <Input value={editForm.title} onChange={(e) => setEditForm({ ...editForm, title: e.target.value })}
                className="h-9 bg-input border-border" />
            </div>
            <div className="grid gap-3 md:grid-cols-2">
              <div className="space-y-1.5">
                <Label className="text-sm text-foreground">云盘地址</Label>
                <Input value={editForm.panUrl} onChange={(e) => setEditForm({ ...editForm, panUrl: e.target.value })}
                  placeholder="http(s)://…" className="h-9 bg-input border-border" />
              </div>
              <div className="space-y-1.5">
                <Label className="text-sm text-foreground">提取码</Label>
                <Input value={editForm.panCode} onChange={(e) => setEditForm({ ...editForm, panCode: e.target.value })}
                  className="h-9 bg-input border-border" />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label className="text-sm text-foreground">分类</Label>
              {cats.length > 0 ? (
                <Select value={editForm.categoryId || ''} onValueChange={(v) => setEditForm({ ...editForm, categoryId: v })}>
                  <SelectTrigger className="h-9 bg-input border-border"><SelectValue placeholder="选择分类" /></SelectTrigger>
                  <SelectContent>
                    {cats.map((c) => <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>)}
                  </SelectContent>
                </Select>
              ) : (
                <div className="flex items-center gap-2">
                  <Input value={editForm.categoryId} onChange={(e) => setEditForm({ ...editForm, categoryId: e.target.value })}
                    placeholder="分类 ID（或点右侧「读取分类」）" className="h-9 bg-input border-border" />
                  <Button variant="outline" size="sm" onClick={loadCats} disabled={catLoading}
                    className="h-9 shrink-0 gap-1.5 border-border text-muted-foreground hover:text-foreground hover:bg-muted">
                    {catLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}读取分类
                  </Button>
                </div>
              )}
            </div>
            <div className="space-y-1.5">
              <Label className="text-sm text-foreground">简介（支持 BBCode）</Label>
              <Textarea value={editForm.content} onChange={(e) => setEditForm({ ...editForm, content: e.target.value })}
                rows={6} className="bg-input border-border text-xs" />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditItem(null)}
              className="border-border text-muted-foreground hover:text-foreground hover:bg-muted">取消</Button>
            <Button onClick={saveEdit} disabled={editSaving}
              className="gap-1.5 bg-primary text-primary-foreground hover:bg-primary/90">
              {editSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}保存修改
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
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
            <SiteUrlHint site="panfx" />
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
              <table className="w-full table-fixed text-sm md:table-auto md:min-w-max">
                <thead>
                  <tr className="border-b border-border bg-card">
                    <th className="px-4 py-3 text-left text-xs font-semibold text-muted-foreground whitespace-nowrap md:min-w-52">标题</th>
                    <th className="hidden px-4 py-3 text-left text-xs font-semibold text-muted-foreground whitespace-nowrap md:table-cell">回复</th>
                    <th className="hidden px-4 py-3 text-left text-xs font-semibold text-muted-foreground whitespace-nowrap md:table-cell">浏览</th>
                    <th className="hidden px-4 py-3 text-left text-xs font-semibold text-muted-foreground whitespace-nowrap md:table-cell">发布时间</th>
                    <th className="hidden px-4 py-3 text-right text-xs font-semibold text-muted-foreground whitespace-nowrap md:table-cell">操作</th>
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
                        <td className="px-4 py-3 font-medium text-foreground break-words md:max-w-xs md:truncate md:whitespace-nowrap">
                          <a href={url} target="_blank" rel="noreferrer"
                            className="hover:text-primary hover:underline transition-colors">
                            {post.subject || '—'}
                          </a>
                          {/* 手机端：回复 / 浏览 / 发布时间折到标题下方，操作跟在信息行右端 */}
                          <div className="mt-1 flex flex-wrap items-center justify-between gap-x-2 gap-y-1 md:hidden">
                            <div className="flex flex-wrap items-center gap-2 text-[11px] font-normal text-muted-foreground">
                              <span>回复 {post.posts ?? '—'}</span>
                              <span>浏览 {post.views ?? '—'}</span>
                              <span>{date}</span>
                            </div>
                            <div className="flex items-center gap-1">
                              <Button variant="ghost" size="sm" onClick={() => setDeleteTarget(post)}
                                className="h-7 px-2 text-xs font-normal text-destructive hover:text-destructive hover:bg-muted">
                                <Trash2 className="h-3.5 w-3.5" />删除
                              </Button>
                            </div>
                          </div>
                        </td>
                        <td className="hidden px-4 py-3 whitespace-nowrap text-xs text-muted-foreground md:table-cell">{post.posts ?? '—'}</td>
                        <td className="hidden px-4 py-3 whitespace-nowrap text-xs text-muted-foreground md:table-cell">{post.views ?? '—'}</td>
                        <td className="hidden px-4 py-3 whitespace-nowrap text-xs text-muted-foreground md:table-cell">{date}</td>
                        <td className="hidden px-4 py-3 whitespace-nowrap text-right md:table-cell">
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
                <SiteUrlHint site="mukaku" />
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
              <BatchPostButton site="mukaku" disabled={binding_} />
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

// ─── 聚影标签页 (www.jying.top) ──────────────────────────────

function JyingTab() {
  const [binding, setBinding] = useState<JyingBinding | null>(null);
  const [bindingLoading, setBindingLoading] = useState(true);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [binding_, setBinding_] = useState(false);
  const [shares, setShares] = useState<JyingShareItem[]>([]);
  const [listLoading, setListLoading] = useState(false);
  const [keyword, setKeyword] = useState('');
  const [searching, setSearching] = useState(false);
  const [editTarget, setEditTarget] = useState<JyingShareItem | null>(null);
  const [editUrl, setEditUrl] = useState('');
  const [editSaving, setEditSaving] = useState(false);

  const isBound = binding?.status === 'active';
  const isExpired = binding?.status === 'expired';

  const loadBinding = useCallback(async () => {
    setBindingLoading(true);
    try {
      const b = await getJyingBinding();
      setBinding(b);
      // 本地标记为失效时向站点复检一次：站点侧仍有效则自动恢复为可用，
      // 避免「其实还能用，却被卡在已失效、发不了」的情况
      if (b?.status === 'expired') {
        setBinding(await revalidateJyingSession());
      }
    }
    catch { toast.error('加载绑定信息失败'); }
    finally { setBindingLoading(false); }
  }, []);

  const loadShares = useCallback(async (kw = '') => {
    setListLoading(true);
    try { setShares(await loadJyingShares(kw)); }
    catch (e) {
      const err = e as Error & { code?: string };
      if (err.code === JYING_EXPIRED_CODE) {
        toast.error('聚影登录已过期，请重新登录聚影账号');
        setBinding((b) => (b ? { ...b, status: 'expired' } : b));
      } else { toast.error(err.message || '加载我的分享失败'); }
    } finally { setListLoading(false); }
  }, []);

  useEffect(() => { loadBinding(); }, [loadBinding]);
  useEffect(() => {
    if (binding?.status === 'active') loadShares('');
    else setShares([]);
  }, [binding?.status, loadShares]);

  async function handleBind() {
    if (!username.trim() || !password) { toast.error('请输入聚影账号和密码'); return; }
    setBinding_(true);
    try {
      await loginJying(username.trim(), password);
      toast.success('聚影账号登录成功，资源更新时将自动同步');
      setUsername('');
      setPassword('');
      await loadBinding();
    } catch (e) { toast.error((e as Error).message || '登录失败，请检查账号密码'); }
    finally { setBinding_(false); }
  }

  async function handleUnbind() {
    setBinding_(true);
    try {
      await unbindJying();
      toast.success('已解绑');
      setBinding(null);
      setShares([]);
    } catch { toast.error('解绑失败'); }
    finally { setBinding_(false); }
  }

  async function handleSearch() {
    setSearching(true);
    try { await loadShares(keyword); }
    finally { setSearching(false); }
  }

  function openEdit(item: JyingShareItem) {
    setEditTarget(item);
    setEditUrl(item.share_link ?? '');
  }

  async function handleSaveEdit() {
    if (!editTarget) return;
    if (!editUrl.trim()) { toast.error('分享链接不能为空'); return; }
    setEditSaving(true);
    try {
      await updateJyingShareLink(editTarget.id, editUrl.trim());
      toast.success('分享链接已更新');
      setEditTarget(null);
      await loadShares(keyword);
    } catch (e) {
      const err = e as Error & { code?: string };
      if (err.code === JYING_EXPIRED_CODE) {
        toast.error('聚影登录已过期，请重新登录');
        setBinding((b) => (b ? { ...b, status: 'expired' } : b));
      } else { toast.error(err.message || '更新失败'); }
    } finally { setEditSaving(false); }
  }

  return (
    <div className="space-y-6">
      {/* 绑定区 */}
      <div className="rounded-xl border border-border bg-card p-4 md:p-6">
        <div className="flex items-center justify-between mb-4 gap-3 flex-wrap">
          <div className="flex items-center gap-2">
            <Link2 className="h-4 w-4 text-primary shrink-0" />
            <h2 className="font-serif text-base font-bold text-foreground">聚影账号绑定</h2>
            <SiteUrlHint site="jying" />
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
            聚影账号「{binding?.username || '未知'}」正常（最近检测：{fmtDate(binding?.last_check_at)}）
          </div>
        )}
        {isExpired && (
          <div className="mb-4 p-3 rounded-lg bg-destructive/10 text-xs text-destructive">
            聚影登录已过期，请重新输入账号密码登录。
          </div>
        )}

        <div className="space-y-3">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label className="text-sm text-foreground">聚影账号</Label>
              <Input
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="jying.top 用户名或邮箱"
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
                onKeyDown={(e) => { if (e.key === 'Enter') handleBind(); }}
                placeholder="jying.top 密码"
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
            <BatchPostButton site="jying" disabled={binding_} />
          </div>
        </div>
        <div className="mt-4 flex items-start gap-2 p-3 rounded-lg bg-muted/40 text-xs text-muted-foreground">
          <Info className="h-3.5 w-3.5 shrink-0 mt-0.5" />
          <span>输入你在 www.jying.top 的<strong>账号和密码</strong>即可完成绑定，服务端会模拟登录并保存会话，<strong>密码不会落库</strong>。同步时按网盘类型匹配本地链接，仅替换已发布分享的链接。</span>
        </div>
      </div>

      {/* 我的分享记录 */}
      {isBound && (
        <div className="rounded-xl border border-border bg-card overflow-hidden">
          <div className="flex items-center justify-between px-4 md:px-6 py-4 border-b border-border gap-3 flex-wrap">
            <div className="flex items-center gap-2 min-w-0">
              <UploadCloud className="h-4 w-4 text-muted-foreground shrink-0" />
              <h2 className="font-serif text-base font-bold text-foreground">我的分享记录</h2>
              <span className="text-xs text-muted-foreground">{shares.length} 条</span>
            </div>
            <div className="flex items-center gap-2">
              <Input
                value={keyword}
                onChange={(e) => setKeyword(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') handleSearch(); }}
                placeholder="按片名筛选"
                className="h-8 w-40 text-xs bg-input border-border"
              />
              <Button variant="outline" size="sm" onClick={handleSearch} disabled={searching}
                className="h-8 text-xs border-border gap-1">
                {searching ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
                刷新
              </Button>
            </div>
          </div>

          {listLoading ? (
            <div className="flex items-center justify-center py-12 text-muted-foreground text-sm gap-2">
              <Loader2 className="h-4 w-4 animate-spin" />加载中…
            </div>
          ) : shares.length === 0 ? (
            <div className="py-12 text-center text-sm text-muted-foreground">暂无分享记录</div>
          ) : (
            <div className="divide-y divide-border">
              {shares.map((item) => (
                <div key={item.id} className="px-4 md:px-6 py-3 flex items-start gap-3 hover:bg-muted/30 transition-colors">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm font-medium text-foreground truncate">{item.movie_title || item.title}</span>
                      <Badge variant="secondary" className="text-[10px] px-1.5 py-0 shrink-0">
                        {item.resource_type_display || item.resource_type || '未知网盘'}
                      </Badge>
                      <Badge variant="outline" className="text-[10px] px-1.5 py-0 shrink-0">#{item.id}</Badge>
                    </div>
                    <div className="mt-0.5 text-xs text-muted-foreground truncate">{item.title}</div>
                    <div className="mt-0.5 text-xs text-muted-foreground/80 truncate break-all">
                      {item.share_link || '（站点未返回链接）'}
                    </div>
                  </div>
                  <Button variant="outline" size="sm" onClick={() => openEdit(item)}
                    className="h-7 text-xs border-border shrink-0 gap-1">
                    <Pencil className="h-3 w-3" />改链接
                  </Button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* 编辑弹窗 */}
      <Dialog open={!!editTarget} onOpenChange={(o) => { if (!o) setEditTarget(null); }}>
        <DialogContent className="max-w-[calc(100%-1.5rem)] sm:max-w-lg max-h-[90dvh] overflow-y-auto bg-card border-border">
          <DialogHeader>
            <DialogTitle className="font-serif">修改分享链接</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="text-xs text-muted-foreground">
              片源：{editTarget?.movie_title} · 条目 #{editTarget?.id}（{editTarget?.resource_type_display || editTarget?.resource_type}）
            </div>
            <div className="space-y-1.5">
              <Label className="text-sm text-foreground">分享链接</Label>
              <Input
                value={editUrl}
                onChange={(e) => setEditUrl(e.target.value)}
                placeholder="https://pan.quark.cn/s/xxxx"
                className="h-9 px-3 text-sm bg-input border-border"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditTarget(null)} disabled={editSaving}
              className="h-8 text-xs border-border">取消</Button>
            <Button onClick={handleSaveEdit} disabled={editSaving}
              className="h-8 text-xs bg-primary text-primary-foreground hover:bg-primary/90 gap-1.5">
              {editSaving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}保存
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ─── 栖影 HDHaven 标签页（hdhaven.com） ───────────────────────

/** 栖影网盘类型（guangya / 115 / 123 / ed2k）→ 中文标签 */
function hdhavenPanLabel(panType?: string | null) {
  if (!panType) return '未知网盘';
  return PAN_TYPE_LABELS[panType] ?? panType;
}

function HdhavenTab() {
  const [binding, setBinding] = useState<HdhavenBinding | null>(null);
  const [bindingLoading, setBindingLoading] = useState(true);
  const [binding_, setBinding_] = useState(false);
  const [shares, setShares] = useState<HdhavenShareItem[]>([]);
  const [listLoading, setListLoading] = useState(false);
  const [keyword, setKeyword] = useState('');
  const [editTarget, setEditTarget] = useState<HdhavenShareItem | null>(null);
  const [editUrl, setEditUrl] = useState('');
  const [editLoading, setEditLoading] = useState(false);
  const [editSaving, setEditSaving] = useState(false);
  const [quotaText, setQuotaText] = useState<string>('');

  const isBound = binding?.status === 'active';
  const isExpired = binding?.status === 'expired';

  // 站点无分页/筛选参数，一次取全量后在前端按片名过滤
  const visibleShares = keyword.trim()
    ? shares.filter((s) =>
        `${s.title ?? ''} ${s.media_title ?? ''}`.toLowerCase().includes(keyword.trim().toLowerCase())
      )
    : shares;

  const loadBinding = useCallback(async () => {
    setBindingLoading(true);
    try {
      const b = await getHdhavenBinding();
      setBinding(b);
      // 本地标记为失效时向站点复检一次：站点侧仍有效则自动恢复为可用
      if (b?.status === 'expired') {
        setBinding(await revalidateHdhavenSession());
      }
    }
    catch { toast.error('加载绑定信息失败'); }
    finally { setBindingLoading(false); }
  }, []);

  const loadShares = useCallback(async () => {
    setListLoading(true);
    try { setShares(await loadHdhavenShares()); }
    catch (e) {
      const err = e as Error & { code?: string };
      if (err.code === HDHAVEN_EXPIRED_CODE) {
        toast.error(err.message || '栖影授权已失效，请重新授权');
        setBinding((b) => (b ? { ...b, status: 'expired' } : b));
      } else if (err.code === HDHAVEN_RATE_LIMITED_CODE) {
        toast.error(err.message || '栖影调用次数已达上限，请稍后再试');
      } else { toast.error(err.message || '加载我的分享失败'); }
    } finally { setListLoading(false); }
  }, []);

  useEffect(() => { loadBinding(); }, [loadBinding]);
  useEffect(() => {
    if (binding?.status === 'active') loadShares();
    else setShares([]);
  }, [binding?.status, loadShares]);

  /**
   * 发起官方 OAuth 授权：跳到栖影授权页，用户点确认后带 code+state 跳回本页。
   * state 与 PKCE verifier 都在服务端，前端不接触任何凭据。
   */
  async function handleAuthorize() {
    setBinding_(true);
    try {
      const authorizeUrl = await startHdhavenOAuth();
      window.location.href = authorizeUrl;
    } catch (e) {
      toast.error((e as Error).message || '发起授权失败，请稍后重试');
      setBinding_(false);
    }
  }

  /**
   * 授权回调不在本页处理：站点登记的回调地址是站点根路径，会带着 code/state 回到首页，
   * 由 App 全局层的 useHdhavenOAuthCallback 统一接住，换完 token 再跳回本页。
   * （本页挂载时会自动 loadBinding，用户看到的仍是最新绑定状态。）
   */

  /** 查询额度余量（每分钟 60 次；每日按等级/会员，签到与 /me 不计入） */
  const loadQuota = useCallback(async () => {
    try {
      const q = (await loadHdhavenQuota()) as Record<string, unknown> | null;
      if (!q) return;
      const pick = (...keys: string[]) => {
        for (const k of keys) {
          const v = q[k];
          if (typeof v === 'number' || typeof v === 'string') return String(v);
        }
        return '';
      };
      const remain = pick('remaining', 'remain', 'left', 'available', 'quota');
      const limit = pick('limit', 'total', 'quota', 'daily');
      setQuotaText(remain && limit ? `今日剩余 ${remain} / ${limit} 次` : remain ? `今日剩余 ${remain} 次` : '');
    } catch { /* 额度查询失败不影响主流程 */ }
  }, []);

  /** 每日签到（站点说明签到不计入每日调用次数） */
  async function handleCheckin() {
    setBinding_(true);
    try {
      await checkinHdhaven();
      toast.success('签到成功');
      loadQuota();
    } catch (e) {
      toast.error((e as Error).message || '签到失败');
    } finally { setBinding_(false); }
  }

  useEffect(() => {
    if (binding?.status === 'active') loadQuota();
    else setQuotaText('');
  }, [binding?.status, loadQuota]);

  async function handleUnbind() {
    setBinding_(true);
    try {
      await unbindHdhaven();
      toast.success('已解绑');
      setBinding(null);
      setShares([]);
    } catch { toast.error('解绑失败'); }
    finally { setBinding_(false); }
  }

  /** 打开改链接弹窗：先取详情拿到站点当前链接作为默认值 */
  async function openEdit(item: HdhavenShareItem) {
    setEditTarget(item);
    setEditUrl(item.url ?? '');
    setEditLoading(true);
    try {
      const detail = await getHdhavenShareDetail(item.slug);
      if (detail?.url) setEditUrl(detail.url);
    } catch { /* 详情取不到时允许手动填写 */ }
    finally { setEditLoading(false); }
  }

  async function handleSaveEdit() {
    if (!editTarget) return;
    if (!editUrl.trim()) { toast.error('分享链接不能为空'); return; }
    setEditSaving(true);
    try {
      await updateHdhavenShareLink({ slug: editTarget.slug, url: editUrl.trim() });
      toast.success('分享链接已更新（栖影会重新审核该资源）');
      setEditTarget(null);
      await loadShares();
    } catch (e) {
      const err = e as Error & { code?: string };
      if (err.code === HDHAVEN_EXPIRED_CODE) {
        toast.error(err.message || '栖影授权已失效，请重新授权');
        setBinding((b) => (b ? { ...b, status: 'expired' } : b));
      } else if (err.code === HDHAVEN_RATE_LIMITED_CODE) {
        toast.error(err.message || '栖影调用次数已达上限，请稍后再试');
      } else { toast.error(err.message || '更新失败'); }
    } finally { setEditSaving(false); }
  }

  return (
    <div className="space-y-6">
      {/* 绑定区 */}
      <div className="rounded-xl border border-border bg-card p-4 md:p-6">
        <div className="flex items-center justify-between mb-4 gap-3 flex-wrap">
          <div className="flex items-center gap-2">
            <Link2 className="h-4 w-4 text-primary shrink-0" />
            <h2 className="font-serif text-base font-bold text-foreground">栖影账号绑定</h2>
            <SiteUrlHint site="hdhaven" />
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
            栖影账号「{binding?.username || '未知'}」
            {binding?.user_number ? `（UID ${binding.user_number}）` : ''}
            授权正常（最近检测：{fmtDate(binding?.last_check_at)}）
            {quotaText ? ` · ${quotaText}` : ''}
          </div>
        )}
        {isExpired && (
          <div className="mb-4 p-3 rounded-lg bg-destructive/10 text-xs text-destructive">
            栖影授权已失效（你在站点 OPENAPI 页面撤销了授权，或账号不可用），请重新授权。
          </div>
        )}

        <div className="space-y-3">
          <div className="flex items-center gap-2 flex-wrap">
            <Button onClick={handleAuthorize} disabled={binding_}
              className="h-9 bg-primary text-primary-foreground hover:bg-primary/90 gap-1.5">
              {binding_ ? <Loader2 className="h-4 w-4 animate-spin" /> : <LogIn className="h-4 w-4" />}
              {isBound || isExpired ? '重新授权' : '授权绑定'}
            </Button>
            {isBound && (
              <Button variant="outline" onClick={handleCheckin} disabled={binding_}
                className="h-9 border-border text-muted-foreground hover:text-foreground hover:bg-muted gap-1.5">
                每日签到
              </Button>
            )}
            {(isBound || isExpired) && (
              <Button variant="outline" onClick={handleUnbind} disabled={binding_}
                className="h-9 border-border text-muted-foreground hover:text-foreground hover:bg-muted gap-1.5">
                <Unlink className="h-4 w-4" />解绑
              </Button>
            )}
            <BatchPostButton site="hdhaven" disabled={binding_} />
          </div>

          <div className="flex items-start gap-2 p-3 rounded-lg bg-muted/40 text-xs text-muted-foreground">
            <Info className="h-3.5 w-3.5 shrink-0 mt-0.5" />
            <span>
              栖影现已开放<strong>官方开放 API</strong>，绑定方式改为 OAuth 授权：点「授权绑定」会跳到栖影授权页，
              确认授权即完成。本工具拿到的是<strong>长期有效的 access_token</strong>，加密存服务端 ——
              <strong>不再需要账号密码、不需要粘贴 Cookie、也不会话过期</strong>。
              注意账号每日有调用额度（Lv.1 200 次起，年卡 5000 次，永久不限，每分钟 60 次），
              <strong>签到与账户信息查询不计入</strong>；批量发布前可先看剩余额度。
              同步时按网盘类型匹配本地链接，仅替换已发布分享的链接；普通用户改动后资源会<strong>重新进入审核</strong>。
            </span>
          </div>
        </div>
      </div>

      {/* 我的分享记录 */}
      {isBound && (
        <div className="rounded-xl border border-border bg-card overflow-hidden">
          <div className="flex items-center justify-between px-4 md:px-6 py-4 border-b border-border gap-3 flex-wrap">
            <div className="flex items-center gap-2 min-w-0">
              <UploadCloud className="h-4 w-4 text-muted-foreground shrink-0" />
              <h2 className="font-serif text-base font-bold text-foreground">我的分享记录</h2>
              <span className="text-xs text-muted-foreground">{visibleShares.length} 条</span>
            </div>
            <div className="flex items-center gap-2">
              <Input
                value={keyword}
                onChange={(e) => setKeyword(e.target.value)}
                placeholder="按片名筛选"
                className="h-8 w-40 text-xs bg-input border-border"
              />
              <Button variant="outline" size="sm" onClick={() => loadShares()} disabled={listLoading}
                className="h-8 text-xs border-border gap-1">
                {listLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
                刷新
              </Button>
            </div>
          </div>

          {listLoading && shares.length === 0 ? (
            <div className="flex items-center justify-center py-12 text-muted-foreground text-sm gap-2">
              <Loader2 className="h-4 w-4 animate-spin" />加载中…
            </div>
          ) : visibleShares.length === 0 ? (
            <div className="py-12 text-center text-sm text-muted-foreground">
              {shares.length === 0 ? '暂无分享记录' : '没有匹配的分享记录'}
            </div>
          ) : (
            <div className="divide-y divide-border">
              {visibleShares.map((item) => (
                <div key={item.slug} className="px-4 md:px-6 py-3 flex items-start gap-3 hover:bg-muted/30 transition-colors">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm font-medium text-foreground truncate">{item.title || '未命名分享'}</span>
                      <Badge variant="secondary" className="text-[10px] px-1.5 py-0 shrink-0">
                        {hdhavenPanLabel(item.pan_type)}
                      </Badge>
                      {item.share_size && (
                        <Badge variant="outline" className="text-[10px] px-1.5 py-0 shrink-0">{item.share_size}</Badge>
                      )}
                      {item.review_status === 'pending' && (
                        <Badge className="text-[10px] px-1.5 py-0 bg-destructive/15 text-destructive border-0 hover:bg-destructive/15 shrink-0">
                          审核中
                        </Badge>
                      )}
                    </div>
                    <div className="mt-0.5 text-xs text-muted-foreground truncate">
                      {item.media_type === 'tv' ? '剧集' : '电影'}
                      {item.media_title ? ` · ${item.media_title}` : ''}
                      {item.file_count ? ` · ${item.file_count} 个文件` : ''}
                    </div>
                    <div className="mt-0.5 text-[11px] text-muted-foreground/70 font-mono truncate">{item.slug}</div>
                  </div>
                  <Button variant="outline" size="sm" onClick={() => openEdit(item)}
                    className="h-7 text-xs border-border shrink-0 gap-1">
                    <Pencil className="h-3 w-3" />改链接
                  </Button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* 编辑弹窗 */}
      <Dialog open={!!editTarget} onOpenChange={(o) => { if (!o) setEditTarget(null); }}>
        <DialogContent className="max-w-[calc(100%-1.5rem)] sm:max-w-lg max-h-[90dvh] overflow-y-auto bg-card border-border">
          <DialogHeader>
            <DialogTitle className="font-serif">修改分享链接</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="text-xs text-muted-foreground">
              分享：{editTarget?.title || editTarget?.slug}（{hdhavenPanLabel(editTarget?.pan_type)}）
            </div>
            <div className="space-y-1.5">
              <Label className="text-sm text-foreground">分享链接</Label>
              <Input
                value={editUrl}
                onChange={(e) => setEditUrl(e.target.value)}
                placeholder={editLoading ? '正在读取站点当前链接…' : 'https://www.guangyapan.com/s/xxxx'}
                className="h-9 px-3 text-sm bg-input border-border"
              />
              <p className="text-[11px] text-muted-foreground">
                栖影的更新接口为「全量字段回写」，服务端会先取原值再合并，只替换链接，其余字段不会被清空。
              </p>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditTarget(null)} disabled={editSaving}
              className="h-8 text-xs border-border">取消</Button>
            <Button onClick={handleSaveEdit} disabled={editSaving}
              className="h-8 text-xs bg-primary text-primary-foreground hover:bg-primary/90 gap-1.5">
              {editSaving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}保存
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ─── 页面入口 ────────────────────────────────────────────────
export default function SyncPage() {
  return (
    <AppLayout>
      <PageMeta
        title="站点同步管理 - 网盘推广工具"
        description="多平台与站点同步管理，支持观影、鸭影、帧影等第三方影视社区的账号绑定与自动化片源同步。"
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

        <Tabs defaultValue="xnsite">
          {/* 站点多了以后标签会超出一行：手机端换行全部铺开（不藏站点），桌面端维持一行横向滚动 */}
          <TabsList className="mb-6 bg-muted border border-border h-auto w-full max-w-full flex-wrap justify-start gap-1 p-1 md:h-9 md:flex-nowrap md:gap-0 md:overflow-x-auto">
            <TabsTrigger value="xnsite"
              className="text-xs px-2 md:px-3 data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm">
              观影站点
            </TabsTrigger>
            <TabsTrigger value="framehdr"
              className="text-xs px-2 md:px-3 data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm">
              帧影站点
            </TabsTrigger>
            <TabsTrigger value="panfx"
              className="text-xs px-2 md:px-3 data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm">
              123社区
            </TabsTrigger>
            <TabsTrigger value="mukaku"
              className="text-xs px-2 md:px-3 data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm">
              不太灵站点
            </TabsTrigger>
            <TabsTrigger value="jying"
              className="text-xs px-2 md:px-3 data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm">
              聚影站点
            </TabsTrigger>
            <TabsTrigger value="hdhaven"
              className="text-xs px-2 md:px-3 data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm">
              栖影站点
            </TabsTrigger>
            <TabsTrigger value="st1"
              className="text-xs whitespace-nowrap px-2 md:px-3 data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm">
              1号站点
            </TabsTrigger>
          </TabsList>
          <TabsContent value="xnsite"><XnSiteTab /></TabsContent>
          <TabsContent value="framehdr"><FramehdrSiteTab /></TabsContent>
          <TabsContent value="panfx"><PanfxSiteTab /></TabsContent>
          <TabsContent value="mukaku"><MukakuSiteTab /></TabsContent>
          <TabsContent value="jying"><JyingTab /></TabsContent>
          <TabsContent value="hdhaven"><HdhavenTab /></TabsContent>
          <TabsContent value="st1"><St1SiteTab /></TabsContent>
        </Tabs>
      </div>
    </AppLayout>
  );
}
