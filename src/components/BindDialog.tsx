import React, { useState, useEffect, useMemo, useCallback } from 'react';
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
  loadXnShares, bindResourceToXnShare, unbindResourceFromXn, XN_COOKIE_EXPIRED_CODE,
  searchYaVideos, bindResourceToYa, unbindResourceFromYa, YA_EXPIRED_CODE,
  loadFramehdrLinks, bindResourceToFramehdr, unbindResourceFromFramehdr, FRAMEHDR_COOKIE_EXPIRED_CODE,
  loadPanfxPosts, bindResourceToPanfx, unbindResourceFromPanfx, PANFX_COOKIE_EXPIRED_CODE,
  st1MyResources, bindResourceToSt1, unbindResourceFromSt1, ST1_TOKEN_EXPIRED_CODE,
  fetchMukakuResources, bindResourceToMukaku, unbindResourceFromMukaku, MUKAKU_TOKEN_EXPIRED_CODE,
  loadJyingShares, bindResourceToJying, unbindResourceFromJying, JYING_EXPIRED_CODE,
} from '@/services/api';
import type {
  Resource, XnShare, XnResourceBinding,
  YaLink, YaResourceBinding, FramehdrLink, FramehdrResourceBinding,
  PanfxPost, PanfxResourceBinding, MukakuWpResource, MukakuResourceBinding,
  St1ResourceBinding,
  JyingShareItem, JyingResourceBinding,
} from '@/types/index';

function fmtDate(iso?: string | null) {
  if (!iso) return '';
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

interface BindDialogProps {
  resource: Resource | null;
  xnBindings: XnResourceBinding[];
  yaBindings: YaResourceBinding[];
  framehdrBinding: FramehdrResourceBinding | null;
  panfxBinding: PanfxResourceBinding | null;
  /** 1号站点绑定（一个资源绑定站点上的一条片源） */
  st1Binding: St1ResourceBinding | null;
  mukakuBindings: MukakuResourceBinding[];
  jyingBindings: JyingResourceBinding[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onXnBound: (resourceId: string, binding: XnResourceBinding) => void;
  onXnUnbound: (resourceId: string, shareId?: string) => void;
  onYaBound: (resourceId: string, binding: YaResourceBinding) => void;
  onYaUnbound: (resourceId: string, linkId?: number) => void;
  onFramehdrBound: (resourceId: string, binding: FramehdrResourceBinding) => void;
  onFramehdrUnbound: (resourceId: string) => void;
  onPanfxBound: (resourceId: string, binding: PanfxResourceBinding) => void;
  onPanfxUnbound: (resourceId: string) => void;
  onSt1Bound: (resourceId: string, binding: St1ResourceBinding) => void;
  onSt1Unbound: (resourceId: string) => void;
  onMukakuBound: (resourceId: string, binding: MukakuResourceBinding) => void;
  onMukakuUnbound: (resourceId: string, linkId?: number) => void;
  onJyingBound: (resourceId: string, binding: JyingResourceBinding) => void;
  onJyingUnbound: (resourceId: string, linkId?: number) => void;
}

// ─── 聚影标签页内容（只列出该账号在聚影已发布的分享记录，用于绑定） ───
function JyingPane({
  resource, jyingBindings, onJyingBound, onJyingUnbound,
}: Pick<BindDialogProps, 'resource' | 'jyingBindings' | 'onJyingBound' | 'onJyingUnbound'>) {
  const [shares, setShares] = useState<JyingShareItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [keyword, setKeyword] = useState('');
  const [bindingId, setBindingId] = useState<number | null>(null);
  const [unbindingId, setUnbindingId] = useState<number | null>(null);

  const load = useCallback(async (kw = '') => {
    setLoading(true);
    setLoadError(null);
    try {
      setShares(await loadJyingShares(kw));
    } catch (e) {
      const err = e as Error & { code?: string };
      setShares([]);
      setLoadError(
        err.code === JYING_EXPIRED_CODE
          ? '聚影登录已过期，请先到「站点同步」页重新登录'
          : err.message || '加载聚影发布记录失败'
      );
    } finally { setLoading(false); }
  }, []);

  useEffect(() => {
    let cancelled = false;
    load('').finally(() => { if (cancelled) return; });
    return () => { cancelled = true; };
  }, [load]);

  async function handleBind(item: JyingShareItem) {
    if (!resource) return;
    setBindingId(item.id);
    try {
      await bindResourceToJying(resource.id, {
        id: item.id,
        movie_id: item.movie_id,
        title: item.title,
        vod_name: item.movie_title,
        share_link: item.share_link,
      });
      const existing = jyingBindings.find((b) => b.link_id === item.id);
      onJyingBound(resource.id, {
        id: existing?.id ?? '',
        resource_id: resource.id,
        link_id: item.id,
        movie_id: item.movie_id,
        link_title: item.title,
        vod_name: item.movie_title,
        pan_label: detectPanName(item.share_link ?? '') || item.resource_type_display || null,
        created_at: existing?.created_at ?? new Date().toISOString(),
      });
      toast.success('绑定聚影发布记录成功，资源更新时将自动同步');
    } catch { toast.error('绑定失败，请重试'); }
    finally { setBindingId(null); }
  }

  async function handleUnbind(linkId: number) {
    if (!resource) return;
    setUnbindingId(linkId);
    try {
      await unbindResourceFromJying(resource.id, linkId);
      onJyingUnbound(resource.id, linkId);
      toast.success('已解绑该条聚影记录');
    } catch { toast.error('解绑失败'); }
    finally { setUnbindingId(null); }
  }

  return (
    <div className="space-y-3">
      {jyingBindings.length > 0 && (
        <div className="space-y-1.5">
          <div className="text-xs font-medium text-muted-foreground">已绑定 {jyingBindings.length} 条聚影发布记录</div>
          {jyingBindings.map((b) => (
            <div key={b.link_id} className="flex items-center justify-between gap-2 p-2 rounded-lg bg-muted/40 border border-border text-xs">
              <div className="min-w-0 flex items-center gap-2">
                <CheckCircle2 className="h-3.5 w-3.5 text-primary shrink-0" />
                <div className="min-w-0">
                  <div className="truncate text-foreground">{b.vod_name || b.link_title || `#${b.link_id}`}</div>
                  <div className="text-[10px] text-muted-foreground truncate">
                    {b.pan_label || '未知网盘'} · 条目 #{b.link_id}
                  </div>
                </div>
              </div>
              <Button variant="ghost" size="sm" onClick={() => handleUnbind(b.link_id)}
                disabled={unbindingId === b.link_id}
                className="h-7 text-xs text-destructive hover:text-destructive hover:bg-destructive/10 shrink-0 gap-1">
                {unbindingId === b.link_id ? <Loader2 className="h-3 w-3 animate-spin" /> : <Unlink className="h-3 w-3" />}
                解绑
              </Button>
            </div>
          ))}
        </div>
      )}

      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
          <Input
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') load(keyword); }}
            placeholder="按片名筛选你的聚影发布记录"
            className="h-8 pl-8 text-xs bg-input border-border"
          />
        </div>
        <Button variant="outline" size="sm" onClick={() => load(keyword)} disabled={loading}
          className="h-8 text-xs border-border gap-1">
          {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Search className="h-3.5 w-3.5" />}
          筛选
        </Button>
      </div>

      {loadError ? (
        <div className="py-6 text-center text-xs text-destructive">{loadError}</div>
      ) : loading ? (
        <div className="flex items-center justify-center py-8 text-muted-foreground text-xs gap-2">
          <Loader2 className="h-4 w-4 animate-spin" />加载中…
        </div>
      ) : shares.length === 0 ? (
        <div className="py-8 text-center text-xs text-muted-foreground">未找到你的聚影发布记录</div>
      ) : (
        <div className="space-y-1.5 max-h-80 overflow-y-auto pr-1">
          {shares.map((item) => {
            const bound = jyingBindings.some((b) => b.link_id === item.id);
            return (
              <div key={item.id}
                className="flex items-start justify-between gap-2 p-2 rounded-lg border border-border bg-card text-xs">
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <span className="font-medium text-foreground truncate">{item.movie_title || item.title}</span>
                    <Badge variant="secondary" className="text-[10px] px-1 py-0">
                      {item.resource_type_display || item.resource_type || '未知网盘'}
                    </Badge>
                    {bound && <Badge className="text-[10px] px-1 py-0 bg-primary/15 text-primary border-0">已绑定</Badge>}
                  </div>
                  <div className="mt-0.5 text-[10px] text-muted-foreground truncate">{item.title}</div>
                  <div className="text-[10px] text-muted-foreground/80 truncate">{item.share_link || '（无链接）'}</div>
                </div>
                <Button variant={bound ? 'ghost' : 'outline'} size="sm"
                  onClick={() => (bound ? handleUnbind(item.id) : handleBind(item))}
                  disabled={bindingId === item.id || unbindingId === item.id}
                  className="h-7 text-xs shrink-0 gap-1">
                  {bindingId === item.id || unbindingId === item.id
                    ? <Loader2 className="h-3 w-3 animate-spin" />
                    : bound ? <Unlink className="h-3 w-3" /> : <Link2 className="h-3 w-3" />}
                  {bound ? '解绑' : '绑定'}
                </Button>
              </div>
            );
          })}
        </div>
      )}

      <div className="flex items-start gap-2 p-2 rounded-lg bg-muted/40 text-[11px] text-muted-foreground">
        <Info className="h-3.5 w-3.5 shrink-0 mt-0.5" />
        <span>此处只列出你账号在聚影<strong>已发布</strong>的分享记录，绑定后资源更新时会自动替换该记录的链接。新增分享请使用「快捷绑定与发布」。</span>
      </div>
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

// ─── 1号站点标签页内容 ────────────────────────────────────────
function St1Pane({
  resource, st1Binding, onSt1Bound, onSt1Unbound,
}: Pick<BindDialogProps, 'resource' | 'st1Binding' | 'onSt1Bound' | 'onSt1Unbound'>) {
  const [items, setItems] = useState<Array<Record<string, unknown>>>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [keyword, setKeyword] = useState('');
  const [bindingId, setBindingId] = useState<string | null>(null);
  const [unbinding, setUnbinding] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    st1MyResources({ pageSize: 50 })
      .then((r) => { if (!cancelled) setItems(r.items ?? []); })
      .catch((e) => {
        if (cancelled) return;
        setItems([]);
        const err = e as Error & { code?: string };
        setLoadError(
          err.code === ST1_TOKEN_EXPIRED_CODE
            ? '1号站点令牌已失效，请先到「站点同步」页重新绑定令牌'
            : err.message || '加载 1号站点片源失败'
        );
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  /** 站点字段名不确定，做兼容取值 */
  const pick = (o: Record<string, unknown>, keys: string[]): string => {
    for (const k of keys) {
      const v = o[k];
      if (typeof v === 'string') return v;
      if (typeof v === 'number') return String(v);
    }
    return '';
  };

  const filtered = items.filter((it) => {
    const q = keyword.trim().toLowerCase();
    if (!q) return true;
    return pick(it, ['title', 'name']).toLowerCase().includes(q);
  });

  async function handleBind(it: Record<string, unknown>) {
    if (!resource) return;
    const remoteId = pick(it, ['id', 'resource_id', 'rid']);
    if (!remoteId) { toast.error('该片源缺少 id，无法绑定'); return; }
    setBindingId(remoteId);
    try {
      const b = await bindResourceToSt1({
        resourceId: resource.id,
        remoteId,
        title: pick(it, ['title', 'name']) || null,
        remoteUrl: pick(it, ['pan_url', 'panUrl', 'link', 'url']) || null,
      });
      onSt1Bound(resource.id, b);
      toast.success('绑定 1号站点成功，资源更新时将自动同步');
    } catch (e) {
      toast.error('绑定失败：' + ((e as Error).message || '请重试'));
    } finally { setBindingId(null); }
  }

  async function handleUnbind() {
    if (!resource) return;
    setUnbinding(true);
    try {
      await unbindResourceFromSt1(resource.id);
      onSt1Unbound(resource.id);
      toast.success('已解绑 1号站点');
    } catch { toast.error('解绑失败'); }
    finally { setUnbinding(false); }
  }

  return (
    <div className="space-y-3">
      {st1Binding && (
        <div className="flex items-center gap-2 p-3 rounded-lg bg-secondary/10 border border-secondary/20">
          <CheckCircle2 className="h-4 w-4 text-secondary shrink-0" />
          <div className="flex-1 min-w-0 overflow-hidden">
            <p className="text-xs font-medium text-foreground truncate leading-snug">
              已绑定：{st1Binding.title || `#${st1Binding.remote_id}`}
            </p>
            <p className="text-[11px] text-muted-foreground truncate mt-0.5 leading-snug">
              remote_id={st1Binding.remote_id}
            </p>
          </div>
          <Button variant="ghost" size="sm" onClick={handleUnbind} disabled={unbinding}
            className="h-7 shrink-0 text-xs text-destructive hover:text-destructive hover:bg-destructive/10 gap-1 px-2">
            {unbinding ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Unlink className="h-3.5 w-3.5" />}
            解绑
          </Button>
        </div>
      )}

      <div className="flex items-center gap-2">
        <Input value={keyword} onChange={(e) => setKeyword(e.target.value)}
          placeholder="按标题筛选我在 1号站点的片源…" className="h-8 bg-input border-border text-xs" />
        <span className="text-[11px] text-muted-foreground shrink-0">{filtered.length}/{items.length}</span>
      </div>

      {loading ? (
        <div className="py-10 text-center text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin inline mr-1.5" />加载站点片源…
        </div>
      ) : loadError ? (
        <div className="py-6 text-center text-xs text-destructive">{loadError}</div>
      ) : filtered.length === 0 ? (
        <div className="py-10 text-center text-sm text-muted-foreground">
          {keyword ? `未找到「${keyword}」` : '暂无片源：先到「站点同步 → 1号站点」绑定令牌，或发布片源后再来绑定'}
        </div>
      ) : (
        <div className="max-h-56 overflow-y-auto overflow-x-hidden w-full min-w-0 rounded-lg border border-border divide-y divide-border/50">
          {filtered.map((it, i) => {
            const remoteId = pick(it, ['id', 'resource_id', 'rid']);
            const title = pick(it, ['title', 'name']) || `（无标题${remoteId ? ` #${remoteId}` : ''}）`;
            const link = pick(it, ['pan_url', 'panUrl', 'link', 'url']);
            const isCurrent = !!st1Binding && remoteId === String(st1Binding.remote_id);
            return (
              <div key={remoteId || i}
                className={`flex items-center gap-2 px-3 py-2.5 transition-colors min-w-0 w-full ${isCurrent ? 'bg-secondary/10' : 'hover:bg-muted/40'}`}>
                <Tv2 className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                <div className="flex-1 min-w-0 overflow-hidden">
                  <p className="text-xs font-medium text-foreground truncate leading-snug">{title}</p>
                  <p className="text-[11px] text-muted-foreground truncate mt-0.5 leading-snug">
                    {link || `id=${remoteId}`}
                  </p>
                </div>
                <Button size="sm" variant={isCurrent ? 'ghost' : 'outline'}
                  disabled={!!bindingId || isCurrent}
                  onClick={() => handleBind(it)}
                  className={`h-7 shrink-0 text-xs gap-1 px-2 ${isCurrent
                    ? 'text-muted-foreground'
                    : 'border-border text-foreground hover:bg-muted'}`}>
                  {bindingId === remoteId
                    ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    : isCurrent ? '已绑定' : '绑定'}
                </Button>
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
      {/* 已绑定列表（一条网盘一条记录） */}
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
  resource, xnBindings, yaBindings, framehdrBinding, panfxBinding, st1Binding, mukakuBindings,
  jyingBindings, open, onOpenChange,
  onXnBound, onXnUnbound, onYaBound, onYaUnbound,
  onFramehdrBound, onFramehdrUnbound, onPanfxBound, onPanfxUnbound, onSt1Bound, onSt1Unbound,
  onMukakuBound, onMukakuUnbound,
  onJyingBound, onJyingUnbound,
}: BindDialogProps) {
  const boundCount = xnBindings.length + yaBindings.length
    + (framehdrBinding ? 1 : 0) + (panfxBinding ? 1 : 0) + (st1Binding ? 1 : 0) + mukakuBindings.length
    + jyingBindings.length;
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

        <Tabs defaultValue="xnsite" className="w-full min-w-0">
          {/* 9 个站点 tab 在手机宽度一行放不下（不换行时内在宽度约 520px，必然溢出屏幕），
              所以改成可换行 + 高度自适应：窄屏自动折成两行，桌面端仍是单行 h-8 */}
          <TabsList className="w-full flex-wrap justify-start h-auto md:h-8 bg-muted border border-border mb-1">
            <TabsTrigger value="xnsite"
              className="flex-1 text-xs data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm">
              观影
              {xnBindings.length > 0 && <span className="ml-1 w-1.5 h-1.5 rounded-full bg-secondary inline-block" />}
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
            <TabsTrigger value="jying"
              className="flex-1 text-xs data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm">
              聚影
              {jyingBindings.length > 0 && <span className="ml-1 w-1.5 h-1.5 rounded-full bg-secondary inline-block" />}
            </TabsTrigger>
            <TabsTrigger value="st1"
              className="flex-1 text-xs data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm">
              1号站点
              {st1Binding && <span className="ml-1 w-1.5 h-1.5 rounded-full bg-secondary inline-block" />}
            </TabsTrigger>
          </TabsList>
          <TabsContent value="st1" className="w-full min-w-0 mt-0">
            <St1Pane
              resource={resource} st1Binding={st1Binding}
              onSt1Bound={onSt1Bound} onSt1Unbound={onSt1Unbound}
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
          <TabsContent value="jying" className="w-full min-w-0 mt-0">
            <JyingPane
              resource={resource} jyingBindings={jyingBindings}
              onJyingBound={onJyingBound} onJyingUnbound={onJyingUnbound}
            />
          </TabsContent>
          </Tabs>
      </DialogContent>
    </Dialog>
  );
}
