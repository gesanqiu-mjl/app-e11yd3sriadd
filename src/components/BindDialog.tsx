import React, { useState, useEffect, useMemo } from 'react';
import { Search, Loader2, Link2, Unlink, CheckCircle2, Info, Tv2, Drama, Film } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from '@/components/ui/dialog';
import { toast } from 'sonner';
import { PAN_TYPE_LABELS, detectPanName } from '@/lib/panUtils';
import {
  loadPanLinks, bindResourceToLink, unbindResource, COOKIE_EXPIRED_CODE, searchPanLinks,
  loadXnShares, bindResourceToXnShare, unbindResourceFromXn, XN_COOKIE_EXPIRED_CODE,
  searchYaVideos, bindResourceToYa, unbindResourceFromYa, YA_EXPIRED_CODE,
  loadFramehdrLinks, bindResourceToFramehdr, unbindResourceFromFramehdr, FRAMEHDR_COOKIE_EXPIRED_CODE,
  loadPanfxPosts, bindResourceToPanfx, unbindResourceFromPanfx, PANFX_COOKIE_EXPIRED_CODE,
  fetchMukakuResources, bindResourceToMukaku, unbindResourceFromMukaku, MUKAKU_TOKEN_EXPIRED_CODE,
} from '@/services/api';
import type {
  Resource, PinglianLink, ResourceBinding, XnShare, XnResourceBinding,
  YaLink, YaResourceBinding, FramehdrLink, FramehdrResourceBinding,
  PanfxPost, PanfxResourceBinding, MukakuWpResource, MukakuResourceBinding,
} from '@/types/index';

function fmtDate(iso?: string | null) {
  if (!iso) return '';
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

interface BindDialogProps {
  resource: Resource | null;
  pinglianBindings: ResourceBinding[];
  xnBindings: XnResourceBinding[];
  yaBindings: YaResourceBinding[];
  framehdrBinding: FramehdrResourceBinding | null;
  panfxBinding: PanfxResourceBinding | null;
  mukakuBindings: MukakuResourceBinding[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onPinglianBound: (resourceId: string, binding: ResourceBinding) => void;
  onPinglianUnbound: (resourceId: string, linkId?: number) => void;
  onXnBound: (resourceId: string, binding: XnResourceBinding) => void;
  onXnUnbound: (resourceId: string, shareId?: string) => void;
  onYaBound: (resourceId: string, binding: YaResourceBinding) => void;
  onYaUnbound: (resourceId: string, linkId?: number) => void;
  onFramehdrBound: (resourceId: string, binding: FramehdrResourceBinding) => void;
  onFramehdrUnbound: (resourceId: string) => void;
  onPanfxBound: (resourceId: string, binding: PanfxResourceBinding) => void;
  onPanfxUnbound: (resourceId: string) => void;
  onMukakuBound: (resourceId: string, binding: MukakuResourceBinding) => void;
  onMukakuUnbound: (resourceId: string, linkId?: number) => void;
}

// ─── 盘链标签页内容（一链接一记录：同一部剧的多条网盘记录可分别绑定） ──
function PinglianPane({
  resource, pinglianBindings, onPinglianBound, onPinglianUnbound,
}: Pick<BindDialogProps, 'resource' | 'pinglianBindings' | 'onPinglianBound' | 'onPinglianUnbound'>) {
  const [links, setLinks] = useState<PinglianLink[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [keyword, setKeyword] = useState('');
  const [bindingLinkId, setBindingLinkId] = useState<number | null>(null);
  const [unbindingLinkId, setUnbindingLinkId] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    loadPanLinks()
      .then((data) => { if (!cancelled) setLinks(data); })
      .catch((e) => {
        if (cancelled) return;
        setLinks([]);
        const err = e as Error & { code?: string };
        setLoadError(
          err.code === COOKIE_EXPIRED_CODE
            ? '盘链登录已过期，请先到「站点同步」页重新登录'
            : err.message || '加载站点剧集失败'
        );
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  // v4 站点列表单页最多 200 条（发布量大的用户首屏不全）：
  // 输入关键词后改为站点服务端搜索（?search=），覆盖全部发布记录
  const [serverResults, setServerResults] = useState<PinglianLink[] | null>(null);
  const [searching, setSearching] = useState(false);

  useEffect(() => {
    const kw = keyword.trim();
    if (!kw) {
      setServerResults(null);
      setSearching(false);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(async () => {
      setSearching(true);
      try {
        const res = await searchPanLinks(kw);
        if (!cancelled) setServerResults(res);
      } catch {
        if (!cancelled) setServerResults([]);
      } finally {
        if (!cancelled) setSearching(false);
      }
    }, 400);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [keyword]);

  const filtered = useMemo(() => {
    // 服务端搜索结果直接采用；无关键词时本地过滤首屏 200 条
    if (serverResults) return serverResults;
    const q = keyword.trim().toLowerCase();
    if (!q) return links;
    return links.filter((l) =>
      (l.title ?? '').toLowerCase().includes(q) ||
      (l.video_title ?? '').toLowerCase().includes(q)
    );
  }, [links, keyword, serverResults]);

  async function handleBind(link: PinglianLink) {
    if (!resource) return;
    setBindingLinkId(link.id);
    try {
      await bindResourceToLink(resource.id, link);
      const existing = pinglianBindings.find((b) => b.link_id === link.id);
      onPinglianBound(resource.id, {
        id: existing?.id ?? '',
        resource_id: resource.id,
        link_id: link.id,
        link_title: link.title,
        vod_name: link.video_title,
        pan_type: link.pan_type,
        link_password: link.password,
        created_at: existing?.created_at ?? new Date().toISOString(),
      });
      toast.success('绑定盘链成功，资源更新时将自动同步');
    } catch { toast.error('绑定失败，请重试'); }
    finally { setBindingLinkId(null); }
  }

  async function handleUnbind(linkId: number) {
    if (!resource) return;
    setUnbindingLinkId(linkId);
    try {
      await unbindResource(resource.id, linkId);
      onPinglianUnbound(resource.id, linkId);
      toast.success('已解绑该条盘链记录');
    } catch { toast.error('解绑失败'); }
    finally { setUnbindingLinkId(null); }
  }

  return (
    <div className="space-y-3">
      {pinglianBindings.length > 0 && (
        <div className="space-y-1.5">
          <p className="text-[11px] text-muted-foreground px-0.5">
            已绑定 {pinglianBindings.length} 条站点记录，同步时将按网盘类型自动匹配对应链接
          </p>
          {pinglianBindings.map((b) => (
            <div key={b.link_id}
              className="flex items-center gap-2 p-2.5 rounded-lg bg-secondary/10 border border-secondary/20">
              <CheckCircle2 className="h-4 w-4 text-secondary shrink-0" />
              <div className="flex-1 min-w-0 overflow-hidden">
                <p className="text-xs font-medium text-foreground truncate leading-snug">
                  {b.vod_name || `#${b.link_id}`}
                </p>
                <p className="text-[11px] text-muted-foreground truncate mt-0.5 leading-snug">
                  {b.link_title ?? '—'}
                  {b.pan_type && (
                    <span className="ml-1 shrink-0">
                      · {PAN_TYPE_LABELS[b.pan_type] ?? b.pan_type}
                    </span>
                  )}
                </p>
              </div>
              <Button variant="ghost" size="sm" onClick={() => handleUnbind(b.link_id)}
                disabled={unbindingLinkId === b.link_id}
                className="h-7 shrink-0 text-xs text-destructive hover:text-destructive hover:bg-destructive/10 gap-1 px-2">
                {unbindingLinkId === b.link_id
                  ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  : <Unlink className="h-3.5 w-3.5" />}
                解绑
              </Button>
            </div>
          ))}
        </div>
      )}

      <div className="relative">
        <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
        <Input value={keyword} onChange={(e) => setKeyword(e.target.value)}
          placeholder="搜索盘链剧集名称…"
          className="pl-8 h-9 text-sm bg-input border-border focus-visible:ring-primary/40" />
      </div>

      {loading ? (
        <div className="py-10 text-center text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin inline mr-2" />加载盘链剧集…
        </div>
      ) : loadError ? (
        <div className="flex items-start gap-2 py-6 px-3 text-sm text-destructive">
          <Info className="h-4 w-4 shrink-0 mt-0.5" /><span>{loadError}</span>
        </div>
      ) : searching ? (
        <div className="py-10 text-center text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin inline mr-2" />正在站点内搜索「{keyword.trim()}」…
        </div>
      ) : filtered.length === 0 ? (
        <div className="py-10 text-center text-sm text-muted-foreground">
          {keyword ? `未找到「${keyword}」` : '站点暂无剧集，请先到盘链发布资源'}
        </div>
      ) : (
        <div className="max-h-56 overflow-y-auto overflow-x-hidden w-full min-w-0 rounded-lg border border-border divide-y divide-border/50">
          {filtered.map((link) => {
            const bound = pinglianBindings.find((b) => b.link_id === link.id);
            return (
              <div key={link.id}
                className={`flex items-center gap-2 px-3 py-2.5 transition-colors min-w-0 w-full ${bound ? 'bg-secondary/10' : 'hover:bg-muted/40'}`}>
                <div className="flex-1 min-w-0 overflow-hidden">
                  <p className="flex items-baseline gap-1 text-xs font-medium text-foreground leading-snug">
                    {link.video_title && <span className="text-muted-foreground shrink-0">[{link.video_title}]</span>}
                    <span className="truncate min-w-0">{link.title || '—'}</span>
                  </p>
                  <div className="flex items-center gap-2 mt-0.5">
                    <span className="text-[11px] text-muted-foreground">
                      {fmtDate(link.updated_at ?? link.created_at)}
                    </span>
                    <Badge variant="secondary"
                      className="h-4 px-1.5 bg-muted text-muted-foreground border-0 hover:bg-muted text-[10px]">
                      {PAN_TYPE_LABELS[link.pan_type] ?? link.pan_type}
                    </Badge>
                  </div>
                </div>
                {bound ? (
                  <Button variant="ghost" size="sm" onClick={() => handleUnbind(link.id)}
                    disabled={unbindingLinkId === link.id}
                    className="h-7 shrink-0 text-xs text-destructive hover:text-destructive hover:bg-destructive/10 gap-1 px-2">
                    {unbindingLinkId === link.id
                      ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      : <Unlink className="h-3.5 w-3.5" />}
                    解绑
                  </Button>
                ) : (
                  <Button variant="outline" size="sm"
                    onClick={() => handleBind(link)}
                    disabled={bindingLinkId === link.id}
                    className="h-7 shrink-0 text-xs border-border text-muted-foreground hover:text-foreground hover:bg-muted gap-1">
                    {bindingLinkId === link.id
                      ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      : <Link2 className="h-3.5 w-3.5" />}
                    绑定
                  </Button>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ─── 帧影站点标签页内容 ────────────────────────────────────────
function FramehdrPane({
  resource, framehdrBinding, onFramehdrBound, onFramehdrUnbound,
}: Pick<BindDialogProps, 'resource' | 'framehdrBinding' | 'onFramehdrBound' | 'onFramehdrUnbound'>) {
  const [links, setLinks] = useState<FramehdrLink[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [keyword, setKeyword] = useState('');
  const [bindingLinkId, setBindingLinkId] = useState<number | null>(null);
  const [unbinding, setUnbinding] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    loadFramehdrLinks()
      .then((data) => { if (!cancelled) setLinks(data); })
      .catch((e) => {
        if (cancelled) return;
        setLinks([]);
        const err = e as Error & { code?: string };
        setLoadError(
          err.code === FRAMEHDR_COOKIE_EXPIRED_CODE
            ? '帧影站点登录已过期，请先到「站点同步」页重新绑定 Cookie'
            : err.message || '加载帧影站点发布记录失败'
        );
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  const filtered = useMemo(() => {
    const q = keyword.trim().toLowerCase();
    if (!q) return links;
    return links.filter((l) =>
      (l.title ?? '').toLowerCase().includes(q) ||
      (l.drive_name ?? '').toLowerCase().includes(q)
    );
  }, [links, keyword]);

  async function handleBind(link: FramehdrLink) {
    if (!resource) return;
    setBindingLinkId(link.id);
    try {
      await bindResourceToFramehdr(resource.id, link);
      onFramehdrBound(resource.id, {
        id: framehdrBinding?.id ?? '',
        resource_id: resource.id,
        link_id: link.id,
        link_title: link.title ?? null,
        drive_name: link.drive_name ?? null,
        created_at: framehdrBinding?.created_at ?? new Date().toISOString(),
      });
      toast.success('绑定帧影站点成功，资源更新时将自动同步');
    } catch (e) {
      toast.error('绑定失败：' + ((e as Error).message || '请重试'));
    } finally { setBindingLinkId(null); }
  }

  async function handleUnbind() {
    if (!resource) return;
    setUnbinding(true);
    try {
      await unbindResourceFromFramehdr(resource.id);
      onFramehdrUnbound(resource.id);
      toast.success('已解绑帧影站点');
    } catch { toast.error('解绑失败'); }
    finally { setUnbinding(false); }
  }

  return (
    <div className="space-y-3">
      {framehdrBinding && (
        <div className="flex items-center gap-2 p-3 rounded-lg bg-secondary/10 border border-secondary/20">
          <CheckCircle2 className="h-4 w-4 text-secondary shrink-0" />
          <div className="flex-1 min-w-0 overflow-hidden">
            <p className="text-xs font-medium text-foreground truncate leading-snug">
              已绑定：{framehdrBinding.link_title || `#${framehdrBinding.link_id}`}
            </p>
            <p className="text-[11px] text-muted-foreground truncate mt-0.5 leading-snug">
              {framehdrBinding.drive_name ?? '—'}
            </p>
          </div>
          <Button variant="ghost" size="sm" onClick={handleUnbind} disabled={unbinding}
            className="h-7 shrink-0 text-xs text-destructive hover:text-destructive hover:bg-destructive/10 gap-1 px-2">
            {unbinding ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Unlink className="h-3.5 w-3.5" />}
            解绑
          </Button>
        </div>
      )}

      <div className="relative">
        <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
        <Input value={keyword} onChange={(e) => setKeyword(e.target.value)}
          placeholder="搜索帧影站点发布记录…"
          className="pl-8 h-9 text-sm bg-input border-border focus-visible:ring-primary/40" />
      </div>

      {loading ? (
        <div className="py-10 text-center text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin inline mr-2" />加载帧影站点发布记录…
        </div>
      ) : loadError ? (
        <div className="flex items-start gap-2 py-6 px-3 text-sm text-destructive">
          <Info className="h-4 w-4 shrink-0 mt-0.5" /><span>{loadError}</span>
        </div>
      ) : filtered.length === 0 ? (
        <div className="py-10 text-center text-sm text-muted-foreground">
          {keyword ? `未找到「${keyword}」` : '站点暂无发布记录，请先到帧影站点发布资源'}
        </div>
      ) : (
        <div className="max-h-56 overflow-y-auto overflow-x-hidden w-full min-w-0 rounded-lg border border-border divide-y divide-border/50">
          {filtered.map((link) => {
            const isCurrent = framehdrBinding?.link_id === link.id;
            return (
              <div key={link.id}
                className={`flex items-center gap-2 px-3 py-2.5 transition-colors min-w-0 w-full ${isCurrent ? 'bg-secondary/10' : 'hover:bg-muted/40'}`}>
                <Film className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                <div className="flex-1 min-w-0 overflow-hidden">
                  <p className="text-xs font-medium text-foreground truncate leading-snug">
                    {link.title || '—'}
                  </p>
                  <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                    {link.drive_name && (
                      <Badge variant="secondary"
                        className="px-1.5 py-0 text-[10px] leading-4 h-4 bg-primary/10 text-primary border-0 font-normal shrink-0">
                        {link.drive_name}
                      </Badge>
                    )}
                    {link.extract_code && (
                      <span className="text-[11px] text-muted-foreground">提取码 {link.extract_code}</span>
                    )}
                  </div>
                </div>
                {isCurrent ? (
                  <Badge className="shrink-0 bg-secondary/15 text-secondary border-0 hover:bg-secondary/15 text-xs">已绑定</Badge>
                ) : (
                  <Button variant="outline" size="sm"
                    onClick={() => handleBind(link)}
                    disabled={bindingLinkId === link.id}
                    className="h-7 shrink-0 text-xs border-border text-muted-foreground hover:text-foreground hover:bg-muted gap-1">
                    {bindingLinkId === link.id
                      ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      : <Link2 className="h-3.5 w-3.5" />}
                    {framehdrBinding ? '换绑' : '绑定'}
                  </Button>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ─── 123社区标签页内容 ────────────────────────────────────────
function PanfxPane({
  resource, panfxBinding, onPanfxBound, onPanfxUnbound,
}: Pick<BindDialogProps, 'resource' | 'panfxBinding' | 'onPanfxBound' | 'onPanfxUnbound'>) {
  const [posts, setPosts] = useState<PanfxPost[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [keyword, setKeyword] = useState('');
  const [bindingTid, setBindingTid] = useState<number | null>(null);
  const [unbinding, setUnbinding] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    loadPanfxPosts()
      .then((data) => { if (!cancelled) setPosts(data); })
      .catch((e) => {
        if (cancelled) return;
        setPosts([]);
        const err = e as Error & { code?: string };
        setLoadError(
          err.code === PANFX_COOKIE_EXPIRED_CODE
            ? '123社区 Cookie 已失效，请先到「站点同步」页重新绑定'
            : err.message || '加载 123社区帖子失败'
        );
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  const filtered = posts.filter((p) => {
    const q = keyword.trim().toLowerCase();
    if (!q) return true;
    return (p.subject ?? '').toLowerCase().includes(q);
  });

  async function handleBind(post: PanfxPost) {
    if (!resource) return;
    setBindingTid(post.tid);
    try {
      await bindResourceToPanfx(resource.id, post);
      onPanfxBound(resource.id, {
        id: panfxBinding?.id ?? '',
        resource_id: resource.id,
        tid: post.tid,
        firstpid: post.firstpid ?? null,
        subject: post.subject ?? null,
        fid: post.fid ? String(post.fid) : null,
        created_at: panfxBinding?.created_at ?? new Date().toISOString(),
      });
      toast.success('绑定 123社区成功，资源更新时将自动同步');
    } catch (e) {
      toast.error('绑定失败：' + ((e as Error).message || '请重试'));
    } finally { setBindingTid(null); }
  }

  async function handleUnbind() {
    if (!resource) return;
    setUnbinding(true);
    try {
      await unbindResourceFromPanfx(resource.id);
      onPanfxUnbound(resource.id);
      toast.success('已解绑 123社区');
    } catch { toast.error('解绑失败'); }
    finally { setUnbinding(false); }
  }

  return (
    <div className="space-y-3">
      {panfxBinding && (
        <div className="flex items-center gap-2 p-3 rounded-lg bg-secondary/10 border border-secondary/20">
          <CheckCircle2 className="h-4 w-4 text-secondary shrink-0" />
          <div className="flex-1 min-w-0 overflow-hidden">
            <p className="text-xs font-medium text-foreground truncate leading-snug">
              已绑定：{panfxBinding.subject || `tid#${panfxBinding.tid}`}
            </p>
            <p className="text-[11px] text-muted-foreground truncate mt-0.5 leading-snug">
              tid={panfxBinding.tid}
            </p>
          </div>
          <Button variant="ghost" size="sm" onClick={handleUnbind} disabled={unbinding}
            className="h-7 shrink-0 text-xs text-destructive hover:text-destructive hover:bg-destructive/10 gap-1 px-2">
            {unbinding ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Unlink className="h-3.5 w-3.5" />}
            解绑
          </Button>
        </div>
      )}

      <div className="relative">
        <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
        <Input value={keyword} onChange={(e) => setKeyword(e.target.value)}
          placeholder="搜索 123社区帖子标题…"
          className="pl-8 h-9 text-sm bg-input border-border focus-visible:ring-primary/40" />
      </div>

      {loading ? (
        <div className="py-10 text-center text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin inline mr-2" />加载 123社区帖子…
        </div>
      ) : loadError ? (
        <div className="flex items-start gap-2 py-6 px-3 text-sm text-destructive">
          <Info className="h-4 w-4 shrink-0 mt-0.5" /><span>{loadError}</span>
        </div>
      ) : filtered.length === 0 ? (
        <div className="py-10 text-center text-sm text-muted-foreground">
          {keyword ? `未找到「${keyword}」` : '暂无帖子，请先到 123社区发布资源帖'}
        </div>
      ) : (
        <div className="max-h-56 overflow-y-auto overflow-x-hidden w-full min-w-0 rounded-lg border border-border divide-y divide-border/50">
          {filtered.map((post) => {
            const isCurrent = panfxBinding?.tid === post.tid;
            const date = post.create_date
              ? new Date(Number(post.create_date) * 1000).toLocaleDateString('zh-CN')
              : '';
            return (
              <div key={post.tid}
                className={`flex items-center gap-2 px-3 py-2.5 transition-colors min-w-0 w-full ${isCurrent ? 'bg-secondary/10' : 'hover:bg-muted/40'}`}>
                <Tv2 className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                <div className="flex-1 min-w-0 overflow-hidden">
                  <p className="text-xs font-medium text-foreground truncate leading-snug">
                    {post.subject || '—'}
                  </p>
                  <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                    <span className="text-[11px] text-muted-foreground">tid={post.tid}</span>
                    {post.posts != null && (
                      <span className="text-[11px] text-muted-foreground">{post.posts} 回复</span>
                    )}
                    {date && <span className="text-[11px] text-muted-foreground">{date}</span>}
                  </div>
                </div>
                {isCurrent ? (
                  <Badge className="shrink-0 bg-secondary/15 text-secondary border-0 hover:bg-secondary/15 text-xs">已绑定</Badge>
                ) : (
                  <Button variant="outline" size="sm"
                    onClick={() => handleBind(post)}
                    disabled={bindingTid === post.tid}
                    className="h-7 shrink-0 text-xs border-border text-muted-foreground hover:text-foreground hover:bg-muted gap-1">
                    {bindingTid === post.tid
                      ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      : <Link2 className="h-3.5 w-3.5" />}
                    {panfxBinding ? '换绑' : '绑定'}
                  </Button>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ─── 观影站点标签页内容（一链接一记录：同一部剧的多条网盘分享可分别绑定） ──
function XnPane({
  resource, xnBindings, onXnBound, onXnUnbound,
}: Pick<BindDialogProps, 'resource' | 'xnBindings' | 'onXnBound' | 'onXnUnbound'>) {
  const [shares, setShares] = useState<XnShare[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [keyword, setKeyword] = useState('');
  const [bindingId, setBindingId] = useState<string | null>(null);
  const [unbindingId, setUnbindingId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    loadXnShares({ search: '' })
      .then(({ list }) => { if (!cancelled) setShares(list); })
      .catch((e) => {
        if (cancelled) return;
        setShares([]);
        const err = e as Error & { code?: string };
        setLoadError(
          err.code === XN_COOKIE_EXPIRED_CODE
            ? '观影站点登录已过期，请先到「站点同步」页重新绑定 Cookie'
            : err.message || '加载观影站点分享失败'
        );
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  const filtered = useMemo(() => {
    const q = keyword.trim().toLowerCase();
    if (!q) return shares;
    return shares.filter((s) =>
      (s.title ?? '').toLowerCase().includes(q) ||
      (s.tname ?? '').toLowerCase().includes(q)
    );
  }, [shares, keyword]);

  async function handleBind(share: XnShare) {
    if (!resource) return;
    setBindingId(share.id);
    try {
      await bindResourceToXnShare(resource.id, share);
      const existing = xnBindings.find((b) => b.share_id === share.id);
      onXnBound(resource.id, {
        id: existing?.id ?? '',
        resource_id: resource.id,
        share_id: share.id,
        share_title: share.title,
        share_url: share.url,
        pan_label: existing?.pan_label ?? (detectPanName(share.url ?? '') || null),
        created_at: existing?.created_at ?? new Date().toISOString(),
      });
      toast.success('绑定观影站点成功，资源更新时将自动同步');
    } catch { toast.error('绑定失败，请重试'); }
    finally { setBindingId(null); }
  }

  async function handleUnbind(shareId: string) {
    if (!resource) return;
    setUnbindingId(shareId);
    try {
      await unbindResourceFromXn(resource.id, shareId);
      onXnUnbound(resource.id, shareId);
      toast.success('已解绑该条观影分享');
    } catch { toast.error('解绑失败'); }
    finally { setUnbindingId(null); }
  }

  return (
    <div className="space-y-3">
      {xnBindings.length > 0 && (
        <div className="space-y-1.5">
          <p className="text-[11px] text-muted-foreground px-0.5">
            已绑定 {xnBindings.length} 条分享记录，同步时将按网盘类型自动匹配对应链接
          </p>
          {xnBindings.map((b) => (
            <div key={b.share_id}
              className="flex items-center gap-2 p-2.5 rounded-lg bg-secondary/10 border border-secondary/20">
              <CheckCircle2 className="h-4 w-4 text-secondary shrink-0" />
              <div className="flex-1 min-w-0 overflow-hidden">
                <p className="text-xs font-medium text-foreground truncate leading-snug">
                  {b.share_title || b.share_id}
                </p>
                <p className="text-[11px] text-muted-foreground truncate mt-0.5 leading-snug">
                  {b.share_url
                    ? <span className="opacity-70">{b.share_url}</span>
                    : <span className="opacity-50">ID: {b.share_id}</span>}
                  {b.pan_label && <span className="ml-1 shrink-0">· {b.pan_label}</span>}
                </p>
              </div>
              <Button variant="ghost" size="sm" onClick={() => handleUnbind(b.share_id)}
                disabled={unbindingId === b.share_id}
                className="h-7 shrink-0 text-xs text-destructive hover:text-destructive hover:bg-destructive/10 gap-1 px-2">
                {unbindingId === b.share_id
                  ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  : <Unlink className="h-3.5 w-3.5" />}
                解绑
              </Button>
            </div>
          ))}
        </div>
      )}

      <div className="relative">
        <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
        <Input value={keyword} onChange={(e) => setKeyword(e.target.value)}
          placeholder="搜索观影站点分享名称…"
          className="pl-8 h-9 text-sm bg-input border-border focus-visible:ring-primary/40" />
      </div>

      {loading ? (
        <div className="py-10 text-center text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin inline mr-2" />加载观影站点分享…
        </div>
      ) : loadError ? (
        <div className="flex items-start gap-2 py-6 px-3 text-sm text-destructive">
          <Info className="h-4 w-4 shrink-0 mt-0.5" /><span>{loadError}</span>
        </div>
      ) : filtered.length === 0 ? (
        <div className="py-10 text-center text-sm text-muted-foreground">
          {keyword ? `未找到「${keyword}」` : '暂无分享，请先到「站点同步 → 观影站点」发布'}
        </div>
      ) : (
        <div className="max-h-56 overflow-y-auto overflow-x-hidden w-full min-w-0 rounded-lg border border-border divide-y divide-border/50">
          {filtered.map((share) => {
            const bound = xnBindings.find((b) => b.share_id === share.id);
            return (
              <div key={share.id}
                className={`flex items-center gap-2 px-3 py-2.5 transition-colors min-w-0 w-full ${bound ? 'bg-secondary/10' : 'hover:bg-muted/40'}`}>
                <Tv2 className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                <div className="flex-1 min-w-0 overflow-hidden">
                  <p className="flex items-baseline gap-1 text-xs font-medium text-foreground leading-snug">
                    {share.tname && <span className="text-muted-foreground shrink-0">[{share.tname}]</span>}
                    <span className="truncate min-w-0">{share.title || '—'}</span>
                  </p>
                  <div className="flex items-center gap-1.5 mt-0.5 flex-wrap">
                    {share.time && (
                      <span className="text-[11px] text-muted-foreground">{share.time}</span>
                    )}
                    {detectPanName(share.url ?? '') && (
                      <Badge variant="secondary"
                        className="px-1.5 py-0 text-[10px] leading-4 h-4 bg-primary/10 text-primary border-0 font-normal shrink-0">
                        {detectPanName(share.url ?? '')}
                      </Badge>
                    )}
                  </div>
                </div>
                {bound ? (
                  <Button variant="ghost" size="sm" onClick={() => handleUnbind(share.id)}
                    disabled={unbindingId === share.id}
                    className="h-7 shrink-0 text-xs text-destructive hover:text-destructive hover:bg-destructive/10 gap-1 px-2">
                    {unbindingId === share.id
                      ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      : <Unlink className="h-3.5 w-3.5" />}
                    解绑
                  </Button>
                ) : (
                  <Button variant="outline" size="sm"
                    onClick={() => handleBind(share)}
                    disabled={bindingId === share.id}
                    className="h-7 shrink-0 text-xs border-border text-muted-foreground hover:text-foreground hover:bg-muted gap-1">
                    {bindingId === share.id
                      ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      : <Link2 className="h-3.5 w-3.5" />}
                    绑定
                  </Button>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ─── 鸭影臻藏标签页内容 ────────────────────────────────────────
const DRIVE_TYPE_LABELS: Record<string, string> = {
  aliyun: '阿里云盘', quark: '夸克', '123': '123 网盘', baidu: '百度网盘',
  uc: 'UC 网盘', xunlei: '迅雷云盘', mobile: '移动云盘', tianyi: '天翼云盘',
  weiyun: '微云', pikpak: 'PikPak', magnet: '磁力链', others: '其他',
};

/** 从资源名称中提取干净的搜索关键词（去除画质/剧集/标签等冗余信息） */
function cleanSearchTitle(raw: string): string {
  return raw
    .replace(/【[^】]*】/g, '')           // 【纯净版】
    .replace(/\[[^\]]*\]/g, '')            // [字幕]
    .replace(/（[^）]*）/g, '')            // （国漫）
    .replace(/\([^)]*\)/g, '')             // (2021)
    .replace(/更新至.*/g, '')               // 更新至第285集
    .replace(/第\s*\d+\s*集.*/g, '')       // 第285集起
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/** 提取核心标题：去掉「第X季/部/期」等词缀，搜无结果时作为回退关键词 */
function getCoreTitle(title: string): string {
  return title
    .replace(/\s*第\s*[一二三四五六七八九十百千\d]+\s*[季部期章篇].*/g, '')
    .replace(/\s*[Ss]eason\s*\d+.*/gi, '')
    .replace(/\s+\d{1,2}$/, '')   // 末尾孤立数字（如"斗罗大陆 2"）
    .trim();
}

function YaPane({
  resource, yaBindings, onYaBound, onYaUnbound,
}: Pick<BindDialogProps, 'resource' | 'yaBindings' | 'onYaBound' | 'onYaUnbound'>) {
  const initKw = cleanSearchTitle(resource?.name ?? '');
  const [keyword, setKeyword] = useState(initKw);
  const [allLinks, setAllLinks] = useState<YaLink[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [bindingId, setBindingId] = useState<string | null>(null);
  const [unbindingId, setUnbindingId] = useState<number | null>(null);

  const doLoad = React.useCallback(async (kw: string) => {
    const q = kw.trim();
    if (!q) return;
    setLoading(true);
    setLoadError(null);
    setAllLinks([]);
    try {
      const data = await searchYaVideos(q);
      if (data.length === 0) {
        // 无结果时自动缩减关键词（去掉「第X部/季/期」）回退重试一次
        const core = getCoreTitle(q);
        if (core && core !== q) {
          const data2 = await searchYaVideos(core);
          setAllLinks(data2);
          if (data2.length > 0) {
            setKeyword(core);
            toast.info(`「${q}」无匹配，已自动缩减为「${core}」重新搜索`);
          }
          return;
        }
      }
      setAllLinks(data);
    } catch (e) {
      setAllLinks([]);
      const err = e as Error & { code?: string };
      setLoadError(
        err.code === YA_EXPIRED_CODE
          ? '鸭影臻藏站点登录已过期，请先到「站点同步」页重新绑定账号'
          : err.message || '加载鸭影臻藏片源失败'
      );
    } finally { setLoading(false); }
  }, []);

  // 进入时用清洗后的资源名称自动加载
  useEffect(() => {
    const kw = cleanSearchTitle(resource?.name ?? '');
    if (kw) { setKeyword(kw); doLoad(kw); }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resource?.name]);

  function handleSearch() { if (keyword.trim()) doLoad(keyword); }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') { e.preventDefault(); handleSearch(); }
  }

  async function handleBind(link: YaLink) {
    if (!resource) return;
    const linkKey = link.name ?? link.url ?? String(link.id);
    setBindingId(linkKey);
    try {
      const result = await bindResourceToYa(resource.id, link);
      const existing = yaBindings.find((b) => b.link_id === result.link_id);
      onYaBound(resource.id, {
        id: existing?.id ?? '',
        resource_id: resource.id,
        link_id: result.link_id,
        link_title: link.name ?? null,
        vod_name: link.video_title ?? null,
        pan_label: link.drive_label || detectPanName(link.url ?? '') || link.drive_type || null,
        created_at: existing?.created_at ?? new Date().toISOString(),
      });
      toast.success('绑定鸭影臻藏成功，资源更新时将自动同步');
    } catch (e) {
      const err = e as Error & { code?: string };
      toast.error(
        err.code === YA_EXPIRED_CODE
          ? '鸭影臻藏登录已过期，请重新绑定账号'
          : '绑定失败：' + (err.message || '请重试')
      );
    } finally { setBindingId(null); }
  }

  async function handleUnbind(linkId: number) {
    if (!resource) return;
    setUnbindingId(linkId);
    try {
      await unbindResourceFromYa(resource.id, linkId);
      onYaUnbound(resource.id, linkId);
      toast.success('已解绑该条鸭影片源');
    } catch { toast.error('解绑失败'); }
    finally { setUnbindingId(null); }
  }

  return (
    <div className="space-y-3">
      {/* 已绑定列表（仿盘链样式：一条网盘一条记录） */}
      {yaBindings.length > 0 && (
        <div className="space-y-1.5">
          <p className="text-[11px] text-muted-foreground px-0.5">
            已绑定 {yaBindings.length} 条片源记录，同步时将按网盘类型自动匹配对应链接
          </p>
          {yaBindings.map((b) => (
            <div key={b.link_id}
              className="flex items-center gap-2 p-2.5 rounded-lg bg-secondary/10 border border-secondary/20">
              <CheckCircle2 className="h-4 w-4 text-secondary shrink-0" />
              <div className="flex-1 min-w-0 overflow-hidden">
                <p className="text-xs font-medium text-foreground truncate leading-snug">
                  {b.vod_name
                    ? `${b.vod_name} · ${b.link_title || `#${b.link_id}`}`
                    : b.link_title || `#${b.link_id}`}
                </p>
                {b.pan_label && (
                  <p className="text-[11px] text-muted-foreground truncate mt-0.5 leading-snug">
                    {b.pan_label}
                  </p>
                )}
              </div>
              <Button variant="ghost" size="sm" onClick={() => handleUnbind(b.link_id)}
                disabled={unbindingId === b.link_id}
                className="h-7 shrink-0 text-xs text-destructive hover:text-destructive hover:bg-destructive/10 gap-1 px-2">
                {unbindingId === b.link_id
                  ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  : <Unlink className="h-3.5 w-3.5" />}
                解绑
              </Button>
            </div>
          ))}
        </div>
      )}

      {/* 搜索框：支持回车或点按钮触发远程搜索 */}
      <div className="relative flex gap-2">
        <div className="relative flex-1">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
          <Input value={keyword} onChange={(e) => setKeyword(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="输入片名，按回车搜索…"
            className="pl-8 h-9 text-sm bg-input border-border focus-visible:ring-primary/40" />
        </div>
        <Button size="sm" onClick={handleSearch} disabled={loading || !keyword.trim()}
          className="h-9 shrink-0 px-3 bg-primary text-primary-foreground hover:bg-primary/90">
          {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Search className="h-3.5 w-3.5" />}
        </Button>
      </div>

      {/* 列表区 */}
      {loading ? (
        <div className="py-10 text-center text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin inline mr-2" />加载中…
        </div>
      ) : loadError ? (
        <div className="flex items-start gap-2 py-6 px-3 text-sm text-destructive">
          <Info className="h-4 w-4 shrink-0 mt-0.5" /><span>{loadError}</span>
        </div>
      ) : allLinks.length === 0 ? (
        <div className="py-10 text-center text-sm text-muted-foreground">
          未找到「{keyword}」的鸭影臻藏片源，可尝试修改片名后重新搜索
        </div>
      ) : (
        <div className="max-h-56 overflow-y-auto overflow-x-hidden w-full min-w-0 rounded-lg border border-border divide-y divide-border/50">
          {allLinks.map((link) => {
            const linkKey = link.name ?? link.url ?? String(link.id);
            const bound = yaBindings.find((b) => b.link_id === link.id);
            return (
              <div key={linkKey}
                className={`flex items-center gap-2 px-3 py-2.5 transition-colors min-w-0 w-full ${bound ? 'bg-secondary/10' : 'hover:bg-muted/40'}`}>
                <Drama className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                <div className="flex-1 min-w-0 overflow-hidden">
                  <p className="flex items-baseline gap-1 text-xs font-medium text-foreground leading-snug min-w-0">
                    {link.video_title && (
                      <span className="text-muted-foreground shrink-0">[{link.video_title}]</span>
                    )}
                    <span className="truncate min-w-0">{link.name || '—'}</span>
                  </p>
                  <div className="flex items-center gap-1.5 mt-0.5 flex-wrap">
                    {(link.updated_at ?? link.created_at) && (
                      <span className="text-[11px] text-muted-foreground">
                        {fmtDate(link.updated_at ?? link.created_at)}
                      </span>
                    )}
                    {(link.drive_label || link.drive_type || link.url) && (
                      <Badge variant="secondary"
                        className="px-1.5 py-0 text-[10px] leading-4 h-4 bg-primary/10 text-primary border-0 font-normal shrink-0">
                        {link.drive_label
                          || (link.drive_type && link.drive_type !== 'others' ? DRIVE_TYPE_LABELS[link.drive_type] || link.drive_type : null)
                          || detectPanName(link.url ?? '')
                          || DRIVE_TYPE_LABELS[link.drive_type!]
                          || link.drive_type}
                      </Badge>
                    )}
                  </div>
                </div>
                {bound ? (
                  <Button variant="ghost" size="sm" onClick={() => handleUnbind(bound.link_id)}
                    disabled={unbindingId === bound.link_id}
                    className="h-7 shrink-0 text-xs text-destructive hover:text-destructive hover:bg-destructive/10 gap-1 px-2">
                    {unbindingId === bound.link_id
                      ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      : <Unlink className="h-3.5 w-3.5" />}
                    解绑
                  </Button>
                ) : (
                  <Button variant="outline" size="sm"
                    onClick={() => handleBind(link)}
                    disabled={bindingId === linkKey}
                    className="h-7 shrink-0 text-xs border-border text-muted-foreground hover:text-foreground hover:bg-muted gap-1">
                    {bindingId === linkKey
                      ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      : <Link2 className="h-3.5 w-3.5" />}
                    绑定
                  </Button>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ─── 不太灵站点标签页内容 ────────────────────────────────────────
function MukakuPane({
  resource, mukakuBindings, onMukakuBound, onMukakuUnbound,
}: Pick<BindDialogProps, 'resource' | 'mukakuBindings' | 'onMukakuBound' | 'onMukakuUnbound'>) {
  const [resources, setResources] = useState<MukakuWpResource[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [keyword, setKeyword] = useState('');
  const [bindingId, setBindingId] = useState<number | null>(null);
  const [unbindingId, setUnbindingId] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    fetchMukakuResources()
      .then((data) => { if (!cancelled) setResources(data.items); })
      .catch((e) => {
        if (cancelled) return;
        setResources([]);
        const err = e as Error & { code?: string };
        setLoadError(
          err.code === MUKAKU_TOKEN_EXPIRED_CODE
            ? '不太灵站点登录已过期，请先到「站点同步」页重新登录'
            : err.message || '加载不太灵站点发布记录失败'
        );
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  const filtered = useMemo(() => {
    const q = keyword.trim().toLowerCase();
    if (!q) return resources;
    return resources.filter((item) =>
      (item.seed_name ?? '').toLowerCase().includes(q) ||
      (item.vod_name ?? '').toLowerCase().includes(q) ||
      (item.link ?? '').toLowerCase().includes(q)
    );
  }, [resources, keyword]);

  async function handleBind(item: MukakuWpResource) {
    if (!resource) return;
    setBindingId(item.id);
    try {
      await bindResourceToMukaku(resource.id, {
        id: item.id,
        movies_id: item.movies_id,
        seed_name: item.seed_name,
        vod_name: item.vod_name,
        pan_type: item.type,
        code: item.code,
      });
      onMukakuBound(resource.id, {
        id: '',
        resource_id: resource.id,
        link_id: item.id,
        movies_id: item.movies_id,
        seed_name: item.seed_name ?? null,
        vod_name: item.vod_name ?? null,
        pan_type: item.type ?? null,
        share_code: item.code ?? null,
        created_at: new Date().toISOString(),
      });
      toast.success('绑定不太灵站点发布记录成功，更新时将自动同步');
    } catch (e) {
      toast.error('绑定失败：' + ((e as Error).message || '请重试'));
    } finally {
      setBindingId(null);
    }
  }

  async function handleUnbind(linkId: number) {
    if (!resource) return;
    setUnbindingId(linkId);
    try {
      await unbindResourceFromMukaku(resource.id, linkId);
      onMukakuUnbound(resource.id, linkId);
      toast.success('已解除不太灵发布记录绑定');
    } catch {
      toast.error('解绑失败');
    } finally {
      setUnbindingId(null);
    }
  }

  return (
    <div className="space-y-3">
      {mukakuBindings.length > 0 && (
        <div className="space-y-1.5 p-2.5 rounded-lg bg-secondary/10 border border-secondary/20 text-xs">
          <div className="flex items-center gap-1.5 text-secondary font-medium">
            <CheckCircle2 className="h-4 w-4 shrink-0" />
            <span>已绑定 {mukakuBindings.length} 条不太灵发布记录</span>
          </div>
          <div className="space-y-1 pt-1">
            {mukakuBindings.map((b) => (
              <div key={b.link_id} className="flex items-center justify-between gap-2 p-1.5 rounded bg-background/60 border border-border/50">
                <div className="flex-1 min-w-0">
                  <span className="font-semibold text-foreground truncate block">
                    {b.seed_name || `#${b.link_id}`}
                  </span>
                  <span className="text-[10px] text-muted-foreground font-mono">
                    ID: {b.link_id} {b.pan_type && `· ${b.pan_type}`}
                  </span>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => handleUnbind(b.link_id)}
                  disabled={unbindingId === b.link_id}
                  className="h-6 text-[11px] text-destructive hover:text-destructive hover:bg-destructive/10 px-2"
                >
                  {unbindingId === b.link_id ? <Loader2 className="h-3 w-3 animate-spin" /> : <Unlink className="h-3 w-3 mr-0.5" />}
                  解绑
                </Button>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="relative">
        <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
        <Input
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
          placeholder="搜索不太灵站点发布记录…"
          className="pl-8 h-9 text-sm bg-input border-border focus-visible:ring-primary/40"
        />
      </div>

      {loadError && (
        <div className="flex items-start gap-2 p-2.5 rounded-md bg-destructive/10 border border-destructive/20 text-xs text-destructive">
          <Info className="h-4 w-4 shrink-0 mt-0.5" />
          <span className="flex-1">{loadError}</span>
        </div>
      )}

      {loading ? (
        <div className="py-10 text-center text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin inline mr-2" />
          加载不太灵发布记录…
        </div>
      ) : filtered.length === 0 ? (
        <div className="py-10 text-center text-sm text-muted-foreground">
          {keyword ? `未找到「${keyword}」` : '暂无发布记录，请先在「站点同步」页搜索挂载'}
        </div>
      ) : (
        <div className="space-y-1.5 max-h-72 overflow-y-auto pr-0.5">
          {filtered.map((item) => {
            const isBound = mukakuBindings.some((b) => b.link_id === item.id);
            return (
              <div
                key={item.id}
                className={`flex items-center gap-2 p-2.5 rounded-lg border text-xs transition-colors ${
                  isBound ? 'bg-secondary/10 border-secondary/30' : 'bg-muted/30 border-border hover:bg-muted/60'
                }`}
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5">
                    <span className="font-medium text-foreground truncate">{item.seed_name || `#${item.id}`}</span>
                    {item.type && <Badge variant="outline" className="text-[10px] px-1 py-0">{item.type}</Badge>}
                  </div>
                  <p className="text-[11px] text-muted-foreground font-mono truncate mt-0.5">{item.link}</p>
                </div>
                {isBound ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => handleUnbind(item.id)}
                    disabled={unbindingId === item.id}
                    className="h-7 text-xs text-destructive hover:text-destructive hover:bg-destructive/10 shrink-0 gap-1 px-2"
                  >
                    {unbindingId === item.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Unlink className="h-3.5 w-3.5" />}
                    解绑
                  </Button>
                ) : (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => handleBind(item)}
                    disabled={bindingId === item.id}
                    className="h-7 shrink-0 text-xs border-border text-muted-foreground hover:text-foreground hover:bg-muted gap-1"
                  >
                    {bindingId === item.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Link2 className="h-3.5 w-3.5" />}
                    绑定
                  </Button>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ─── 弹窗入口 ────────────────────────────────────────────────
export default function BindDialog({
  resource, pinglianBindings, xnBindings, yaBindings, framehdrBinding, panfxBinding, mukakuBindings, open, onOpenChange,
  onPinglianBound, onPinglianUnbound, onXnBound, onXnUnbound, onYaBound, onYaUnbound,
  onFramehdrBound, onFramehdrUnbound, onPanfxBound, onPanfxUnbound, onMukakuBound, onMukakuUnbound,
}: BindDialogProps) {
  const boundCount = pinglianBindings.length + xnBindings.length + yaBindings.length
    + (framehdrBinding ? 1 : 0) + (panfxBinding ? 1 : 0) + mukakuBindings.length;
  const hasBound = boundCount > 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[calc(100%-2rem)] md:max-w-xl bg-card border-border">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 flex-wrap">
            绑定站点剧集
            {hasBound && (
              <Badge className="bg-secondary/15 text-secondary border-0 text-xs">
                已绑定 {boundCount} 个站点
              </Badge>
            )}
          </DialogTitle>
          {resource && (
            <p className="text-xs font-medium text-foreground break-words line-clamp-2 bg-muted/60 border border-border/50 rounded px-2 py-1 mt-1 w-full min-w-0">
              {resource.name}
            </p>
          )}
          <DialogDescription className="text-xs">
            选择站点中的对应剧集，绑定后修改资源名称/集数/链接将自动同步到已绑定的站点。
          </DialogDescription>
        </DialogHeader>

        <Tabs defaultValue="pinglian" className="w-full min-w-0">
          <TabsList className="w-full bg-muted border border-border h-8 mb-1">
            <TabsTrigger value="pinglian"
              className="flex-1 text-xs data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm">
              盘链
              {pinglianBindings.length > 0 && <span className="ml-1 w-1.5 h-1.5 rounded-full bg-secondary inline-block" />}
            </TabsTrigger>
            <TabsTrigger value="xnsite"
              className="flex-1 text-xs data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm">
              观影
              {xnBindings.length > 0 && <span className="ml-1 w-1.5 h-1.5 rounded-full bg-secondary inline-block" />}
            </TabsTrigger>
            <TabsTrigger value="ya"
              className="flex-1 text-xs data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm">
              鸭影
              {yaBindings.length > 0 && <span className="ml-1 w-1.5 h-1.5 rounded-full bg-secondary inline-block" />}
            </TabsTrigger>
            <TabsTrigger value="framehdr"
              className="flex-1 text-xs data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm">
              帧影
              {framehdrBinding && <span className="ml-1 w-1.5 h-1.5 rounded-full bg-secondary inline-block" />}
            </TabsTrigger>
            <TabsTrigger value="panfx"
              className="flex-1 text-xs data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm">
              123社区
              {panfxBinding && <span className="ml-1 w-1.5 h-1.5 rounded-full bg-secondary inline-block" />}
            </TabsTrigger>
            <TabsTrigger value="mukaku"
              className="flex-1 text-xs data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm">
              不太灵
              {mukakuBindings.length > 0 && <span className="ml-1 w-1.5 h-1.5 rounded-full bg-secondary inline-block" />}
            </TabsTrigger>
          </TabsList>
          <TabsContent value="pinglian" className="w-full min-w-0 mt-0">
            <PinglianPane
              resource={resource} pinglianBindings={pinglianBindings}
              onPinglianBound={onPinglianBound} onPinglianUnbound={onPinglianUnbound}
            />
          </TabsContent>
          <TabsContent value="xnsite" className="w-full min-w-0 mt-0">
            <XnPane
              resource={resource} xnBindings={xnBindings}
              onXnBound={onXnBound} onXnUnbound={onXnUnbound}
            />
          </TabsContent>
          <TabsContent value="ya" className="w-full min-w-0 mt-0">
            <YaPane
              resource={resource} yaBindings={yaBindings}
              onYaBound={onYaBound} onYaUnbound={onYaUnbound}
            />
          </TabsContent>
          <TabsContent value="framehdr" className="w-full min-w-0 mt-0">
            <FramehdrPane
              resource={resource} framehdrBinding={framehdrBinding}
              onFramehdrBound={onFramehdrBound} onFramehdrUnbound={onFramehdrUnbound}
            />
          </TabsContent>
          <TabsContent value="panfx" className="w-full min-w-0 mt-0">
            <PanfxPane
              resource={resource} panfxBinding={panfxBinding}
              onPanfxBound={onPanfxBound} onPanfxUnbound={onPanfxUnbound}
            />
          </TabsContent>
          <TabsContent value="mukaku" className="w-full min-w-0 mt-0">
            <MukakuPane
              resource={resource} mukakuBindings={mukakuBindings}
              onMukakuBound={onMukakuBound} onMukakuUnbound={onMukakuUnbound}
            />
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
