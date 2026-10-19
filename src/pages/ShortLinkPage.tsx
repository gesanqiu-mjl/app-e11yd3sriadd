import { useCallback, useEffect, useMemo, useState } from 'react';
import { Area, AreaChart, Bar, BarChart, CartesianGrid, XAxis, YAxis } from 'recharts';
import { toast } from 'sonner';
import {
  Link2, Plus, Copy, Trash2, RefreshCw, Loader2, MousePointerClick,
  Users, CalendarDays, TrendingUp, TrendingDown, Search, BarChart3, Unlink, Layers,
  ArrowUpRight, Bot, UserPlus,
} from 'lucide-react';
import AppLayout from '@/components/layouts/AppLayout';
import PageMeta from '@/components/common/PageMeta';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { Progress } from '@/components/ui/progress';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from '@/components/ui/chart';
import { fetchResources } from '@/services/api';
import type { Resource } from '@/types/index';
import {
  listShortLinks, createShortLink, updateShortLink, deleteShortLink, createShortLinksBulk,
  fetchShortLinkStats, fetchShortLinkDaily, fetchShortLinkChannels, fetchRecentClicks,
  fetchDailyAll, sumByDay, dailyOf, rangeCompare,
  shortLinkUrl, shortLinkDisplay, sumStats, briefUa, derivePathCode,
  type ShortLink, type ShortLinkStat, type ShortLinkDaily, type ShortLinkChannel,
  type ShortLinkClick, type ShortLinkDailyAll,
} from '@/services/shortlinks';

const RANGE_OPTIONS = [
  { value: '1', label: '今天' },
  { value: '7', label: '近 7 天' },
  { value: '30', label: '近 30 天' },
];

const chartConfig = {
  clicks: { label: '点击', color: 'hsl(var(--primary))' },
  uniques: { label: '独立访客', color: 'hsl(var(--muted-foreground))' },
} satisfies ChartConfig;

function fmtTime(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function hostOf(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url.slice(0, 30); }
}

/** 迷你走势（纯 SVG，不引入图表实例；列表里几十条也不卡） */
function Spark({ data, className = '' }: { data: number[]; className?: string }) {
  const w = 64, h = 22;
  const max = Math.max(1, ...data);
  const step = data.length > 1 ? w / (data.length - 1) : w;
  const pts = data.map((v, i) => `${(i * step).toFixed(1)},${(h - (v / max) * (h - 3) - 1.5).toFixed(1)}`).join(' ');
  const area = `0,${h} ${pts} ${w},${h}`;
  return (
    <svg width={w} height={h} className={className} aria-hidden>
      <polyline points={area} fill="hsl(var(--primary) / 0.12)" stroke="none" />
      <polyline points={pts} fill="none" stroke="hsl(var(--primary))" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

/** 环比标记 */
function Delta({ delta, suffix = '' }: { delta: number; suffix?: string }) {
  if (!delta) return <span className="text-[11px] text-muted-foreground">— 与上期持平</span>;
  const up = delta > 0;
  return (
    <span className={`text-[11px] inline-flex items-center gap-0.5 ${up ? 'text-emerald-500' : 'text-destructive'}`}>
      {up ? <TrendingUp className="h-3 w-3" /> : <TrendingDown className="h-3 w-3" />}
      {up ? '+' : ''}{delta}{suffix} 较上期
    </span>
  );
}

export default function ShortLinkPage() {
  const [links, setLinks] = useState<ShortLink[]>([]);
  const [stats, setStats] = useState<Record<string, ShortLinkStat>>({});
  const [dailyRows, setDailyRows] = useState<ShortLinkDailyAll[]>([]);
  const [loading, setLoading] = useState(true);
  const [range, setRange] = useState('7');
  const [keyword, setKeyword] = useState('');
  const [creating, setCreating] = useState(false);
  const [batching, setBatching] = useState(false);

  const [detail, setDetail] = useState<ShortLink | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [daily, setDaily] = useState<ShortLinkDaily[]>([]);
  const [channels, setChannels] = useState<ShortLinkChannel[]>([]);
  const [recent, setRecent] = useState<ShortLinkClick[]>([]);
  const [onlyNew, setOnlyNew] = useState(false);

  const days = Number(range);

  const load = useCallback(async (daysStr: string) => {
    setLoading(true);
    try {
      const d = Number(daysStr);
      const [list, st, rows] = await Promise.all([
        listShortLinks(),
        fetchShortLinkStats(d).catch(() => ({}) as Record<string, ShortLinkStat>),
        // 取 2 倍区间：一半用于画图，一半用于算环比
        fetchDailyAll(Math.max(2, d * 2)).catch(() => [] as ShortLinkDailyAll[]),
      ]);
      setLinks(list);
      setStats(st);
      setDailyRows(rows);
    } catch (e) {
      toast.error('读取短链失败：' + ((e as Error).message || ''));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(range); }, [load, range]);

  const filtered = useMemo(() => {
    const q = keyword.trim().toLowerCase();
    if (!q) return links;
    return links.filter((l) =>
      l.title.toLowerCase().includes(q) || l.code.includes(q) || l.target_url.toLowerCase().includes(q)
    );
  }, [links, keyword]);

  const summary = useMemo(() => sumStats(stats, links.map((l) => l.id)), [stats, links]);
  const allByDay = useMemo(() => sumByDay(dailyRows), [dailyRows]);
  const trend = useMemo(() => allByDay.slice(-Math.max(1, days)), [allByDay, days]);
  const cmp = useMemo(() => rangeCompare(dailyRows, Math.max(1, days)), [dailyRows, days]);
  const todayClicks = trend.length ? trend[trend.length - 1].clicks : 0;
  const yesterdayClicks = trend.length > 1 ? trend[trend.length - 2].clicks : 0;

  /** 区间内点击排行（只看得到前 5） */
  const top = useMemo(() => {
    return [...links]
      .map((l) => ({ link: l, clicks: Number(stats[l.id]?.clicks_range ?? 0) }))
      .filter((x) => x.clicks > 0)
      .sort((a, b) => b.clicks - a.clicks)
      .slice(0, 5);
  }, [links, stats]);

  const sparkOf = useCallback(
    (linkId: string) => dailyOf(dailyRows, linkId, Math.min(Math.max(days, 2), 7)).map((d) => d.clicks),
    [dailyRows, days]
  );

  async function copyText(text: string, tip = '短链已复制') {
    try { await navigator.clipboard.writeText(text); toast.success(tip); }
    catch { toast.error('复制失败，请手动选择复制'); }
  }

  async function toggleEnabled(link: ShortLink, enabled: boolean) {
    setLinks((prev) => prev.map((l) => (l.id === link.id ? { ...l, enabled } : l)));
    try {
      await updateShortLink(link.id, { enabled });
      toast.success(enabled ? '已启用' : '已停用（访问会提示链接不可用）');
    } catch {
      setLinks((prev) => prev.map((l) => (l.id === link.id ? { ...l, enabled: !enabled } : l)));
      toast.error('保存失败');
    }
  }

  async function removeLink(link: ShortLink) {
    if (!window.confirm(`删除短链「${link.title}」？\n删除后该短链立即失效，点击明细一并清除。`)) return;
    try {
      await deleteShortLink(link.id);
      setLinks((prev) => prev.filter((l) => l.id !== link.id));
      toast.success('已删除');
    } catch { toast.error('删除失败'); }
  }

  async function openDetail(link: ShortLink) {
    setDetail(link);
    setDetailLoading(true);
    setOnlyNew(false);
    setDaily([]); setChannels([]); setRecent([]);
    try {
      const win = days <= 1 ? 7 : days;
      const [d, c, r] = await Promise.all([
        fetchShortLinkDaily(link.id, win),
        fetchShortLinkChannels(link.id, win),
        fetchRecentClicks(link.id, 60),
      ]);
      setDaily(d); setChannels(c); setRecent(r);
    } catch (e) {
      toast.error('读取统计失败：' + ((e as Error).message || ''));
    } finally { setDetailLoading(false); }
  }

  const recentShown = onlyNew ? recent.filter((c) => c.is_unique && !c.is_bot) : recent;
  const channelTotal = channels.reduce((a, b) => a + Number(b.clicks), 0) || 1;

  return (
    <AppLayout>
      <PageMeta
        title="短链统计 - 网盘推广工具"
        description="把网盘链接换成自己的中转短链，统计被多少人访问、点击、来自哪些渠道"
        keywords="短链,点击统计,独立访客,推广统计,批量生成"
      />
      <div className="p-4 md:p-6 max-w-4xl mx-auto">
        <div className="flex items-center justify-between gap-3 mb-5 flex-wrap">
          <div className="flex items-center gap-2.5">
            <span className="flex items-center justify-center w-8 h-8 rounded-lg bg-primary/10 shrink-0">
              <Link2 className="h-4 w-4 text-primary" />
            </span>
            <div>
              <h1 className="font-serif text-xl font-bold text-foreground">短链统计</h1>
              <p className="text-xs text-muted-foreground">
                分享短链，别人点开时自动记录点击并跳转网盘；只统计<span className="text-foreground">本账号</span>的短链，各账号数据互相隔离
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => void load(range)} disabled={loading}
              className="h-9 gap-1.5 border-border text-muted-foreground hover:text-foreground hover:bg-muted">
              {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
              刷新
            </Button>
            <Button variant="outline" size="sm" onClick={() => setBatching(true)}
              className="h-9 gap-1.5 border-border text-foreground hover:bg-muted">
              <Layers className="h-4 w-4" />批量生成
            </Button>
            <Button size="sm" onClick={() => setCreating(true)}
              className="h-9 gap-1.5 bg-primary text-primary-foreground hover:bg-primary/90">
              <Plus className="h-4 w-4" />新建短链
            </Button>
          </div>
        </div>

        {/* 汇总：紧凑指标条（不再一张卡铺满一行） */}
        <div className="rounded-lg border border-border bg-card mb-4 divide-y divide-border md:divide-y-0 md:divide-x md:grid md:grid-cols-4">
          <div className="px-3 py-2">
            <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
              <MousePointerClick className="h-3.5 w-3.5" />总点击
            </div>
            <div className="flex items-baseline gap-2 mt-0.5">
              <span className="font-serif text-lg font-bold text-foreground">{summary.total}</span>
              <span className="text-[10px] text-muted-foreground">累计</span>
            </div>
          </div>
          <div className="px-3 py-2">
            <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
              <TrendingUp className="h-3.5 w-3.5" />近 {days} 天
            </div>
            <div className="flex items-baseline gap-2 mt-0.5">
              <span className="font-serif text-lg font-bold text-foreground">{cmp.current}</span>
              <Delta delta={cmp.delta} />
            </div>
          </div>
          <div className="px-3 py-2">
            <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
              <Users className="h-3.5 w-3.5" />独立访客
            </div>
            <div className="flex items-baseline gap-2 mt-0.5">
              <span className="font-serif text-lg font-bold text-foreground">{summary.uniques}</span>
              <span className="text-[10px] text-muted-foreground">同 IP 当天算 1</span>
            </div>
          </div>
          <div className="px-3 py-2">
            <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
              <CalendarDays className="h-3.5 w-3.5" />今日
            </div>
            <div className="flex items-baseline gap-2 mt-0.5">
              <span className="font-serif text-lg font-bold text-foreground">{todayClicks}</span>
              <Delta delta={todayClicks - yesterdayClicks} suffix=" 较昨日" />
            </div>
          </div>
        </div>

        {/* 总趋势 + 排行 */}
        <div className="grid gap-3 md:grid-cols-3 mb-5 items-start">
          <div className="md:col-span-2 rounded-lg border border-border bg-card p-3">
            <div className="flex items-center justify-between mb-2">
              <span className="text-sm text-foreground">全部短链点击趋势</span>
              <span className="text-[11px] text-muted-foreground">
                近 {days} 天 · 合计 {trend.reduce((a, b) => a + b.clicks, 0)} 次
              </span>
            </div>
            {trend.length === 0 || trend.every((d) => d.clicks === 0) ? (
              <div className="h-[150px] flex items-center justify-center text-xs text-muted-foreground">
                这 {days} 天还没有点击
              </div>
            ) : (
              <ChartContainer config={chartConfig} className="h-[120px] w-full aspect-auto">
                <AreaChart data={trend} margin={{ left: 0, right: 6, top: 4, bottom: 0 }}>
                  <CartesianGrid vertical={false} />
                  <XAxis dataKey="day" tickLine={false} axisLine={false} tickMargin={4}
                    tickFormatter={(v: string) => String(v).slice(5)} />
                  <YAxis width={26} tickLine={false} axisLine={false} allowDecimals={false} />
                  <ChartTooltip content={<ChartTooltipContent />} />
                  <Area type="monotone" dataKey="clicks" stroke="var(--color-clicks)"
                    fill="var(--color-clicks)" fillOpacity={0.18} strokeWidth={2} />
                </AreaChart>
              </ChartContainer>
            )}
          </div>
          <div className="rounded-lg border border-border bg-card p-3">
            <div className="text-sm text-foreground mb-2">点击排行（近 {days} 天）</div>
            {top.length === 0 ? (
              <p className="text-xs text-muted-foreground">暂无数据</p>
            ) : (
              <div className="space-y-2">
                {top.map((t, i) => (
                  <div key={t.link.id} className="flex items-center gap-2">
                    <span className={`w-4 text-[11px] shrink-0 ${i === 0 ? 'text-primary font-bold' : 'text-muted-foreground'}`}>
                      {i + 1}
                    </span>
                    <span className="flex-1 min-w-0 text-[11px] text-foreground truncate" title={t.link.title}>
                      {t.link.title}
                    </span>
                    <span className="text-[11px] text-foreground shrink-0 font-medium">{t.clicks}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* 工具栏 */}
        <div className="flex items-center gap-2 mb-3 flex-wrap">
          <div className="relative flex-1 min-w-[180px] max-w-sm">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
            <Input value={keyword} onChange={(e) => setKeyword(e.target.value)}
              placeholder="搜索标题 / 短码 / 目标链接"
              className="h-9 pl-8 bg-input border-border text-sm" />
          </div>
          <Select value={range} onValueChange={setRange}>
            <SelectTrigger className="h-9 w-[120px] bg-input border-border"><SelectValue /></SelectTrigger>
            <SelectContent>
              {RANGE_OPTIONS.map((o) => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>

        {/* 列表 */}
        {loading && links.length === 0 ? (
          <div className="py-16 text-center text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin inline mr-1.5" />正在读取短链…
          </div>
        ) : filtered.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border py-16 text-center">
            <Link2 className="h-7 w-7 text-muted-foreground mx-auto mb-2" />
            <p className="text-sm text-foreground mb-1">
              {links.length === 0 ? '还没有短链' : `没有匹配「${keyword}」的短链`}
            </p>
            <p className="text-xs text-muted-foreground max-w-md mx-auto leading-relaxed">
              「新建短链」单条生成；「**批量生成**」可以一次性把**所有更新中的资源**生成短链（自动跳过已生成的）。
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            {filtered.map((l) => {
              const s = stats[l.id];
              const url = shortLinkUrl(l.code, l.channel);
              const spark = sparkOf(l.id);
              const sparkTotal = spark.reduce((a, b) => a + b, 0);
              return (
                <div key={l.id} className="rounded-lg border border-border bg-card p-3 space-y-2">
                  {/* 标题 + 操作：手机端按钮收成纯图标，长标题才能占满整行 */}
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <span className="text-sm font-medium text-foreground break-words">{l.title}</span>
                        {!l.enabled && <Badge variant="secondary" className="text-[10px] h-4 px-1.5">已停用</Badge>}
                        {l.pan_name && <Badge variant="outline" className="text-[10px] h-4 px-1.5">{l.pan_name}</Badge>}
                        {l.channel && <Badge variant="outline" className="text-[10px] h-4 px-1.5">渠道 {l.channel}</Badge>}
                      </div>
                      <div className="text-[11px] text-muted-foreground mt-1 break-all">
                        <span className="font-mono text-primary">{shortLinkDisplay(l.code)}</span>
                        <span className="mx-1.5">→</span>
                        {hostOf(l.target_url)}
                        {l.extract_code ? `（提取码 ${l.extract_code}）` : ''}
                      </div>
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      <Button variant="outline" size="sm" onClick={() => void copyText(url)} title="复制短链"
                        className="h-8 w-8 p-0 border-border text-xs text-foreground hover:bg-muted sm:w-auto sm:gap-1 sm:px-2.5">
                        <Copy className="h-3.5 w-3.5" /><span className="hidden sm:inline">复制</span>
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => void openDetail(l)} title="查看统计"
                        className="h-8 w-8 p-0 text-xs text-muted-foreground hover:text-foreground hover:bg-muted sm:w-auto sm:gap-1 sm:px-2.5">
                        <BarChart3 className="h-3.5 w-3.5" /><span className="hidden sm:inline">统计</span>
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => void removeLink(l)} title="删除短链"
                        className="h-8 w-8 p-0 text-xs text-destructive hover:text-destructive hover:bg-destructive/10">
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </div>

                  {/* 指标：手机 2 列 / 桌面 4 列，数字左对齐成栅格，不再挤成一行 */}
                  <div className="grid grid-cols-2 gap-x-4 gap-y-1 border-t border-border/60 pt-2 text-[11px] text-muted-foreground sm:grid-cols-4">
                    <div className="flex items-baseline gap-1">
                      总点击<b className="text-xs text-foreground">{s?.clicks_total ?? l.click_count}</b>
                    </div>
                    <div className="flex items-baseline gap-1">
                      今日<b className="text-xs text-foreground">{s?.clicks_today ?? 0}</b>
                    </div>
                    <div className="flex items-baseline gap-1">
                      独立访客<b className="text-xs text-foreground">{s?.uniques_range ?? 0}</b>
                    </div>
                    <div className="flex items-baseline gap-1">
                      近 7 天<b className="text-xs text-foreground">{sparkTotal}</b>
                    </div>
                  </div>

                  {/* 走势 + 最近点击 + 启用：走势只在有数据时画（全 0 会画出一条像下划线的横线） */}
                  <div className="flex items-center justify-between gap-2 flex-wrap">
                    <div className="flex min-w-0 items-center gap-2 text-[11px] text-muted-foreground">
                      {sparkTotal > 0 && <Spark data={spark} className="shrink-0" />}
                      <span className="truncate">最近点击 {fmtTime(s?.last_click_at ?? l.last_click_at)}</span>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      <span className="text-[11px] text-muted-foreground">启用</span>
                      <Switch checked={l.enabled} onCheckedChange={(v) => void toggleEnabled(l, v)} />
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        <p className="text-[11px] text-muted-foreground mt-4 leading-relaxed">
          说明：点击明细里的 IP 只保存<b className="text-foreground">加盐哈希</b>（不存明文）；
          同一访客当天多次点击只算 1 个「独立访客」；明显爬虫（curl/python/bot 等 UA）会记录但不计入点击量；
          短链后追加 <code className="font-mono">?c=渠道名</code> 可区分来源。
        </p>
      </div>

      {/* 统计详情 */}
      <Dialog open={!!detail} onOpenChange={(o) => !o && setDetail(null)}>
        <DialogContent className="max-w-[calc(100%-2rem)] md:max-w-3xl bg-card border-border max-h-[88vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="break-words">{detail?.title || '短链统计'}</DialogTitle>
            <DialogDescription className="text-xs text-muted-foreground break-all">
              <span className="font-mono text-primary">{shortLinkDisplay(detail?.code ?? '')}</span>
              <span className="mx-1.5">→</span>{detail?.target_url}
            </DialogDescription>
          </DialogHeader>

          {detailLoading ? (
            <div className="py-12 text-center text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin inline mr-1.5" />正在统计…
            </div>
          ) : (
            <div className="space-y-5">
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                {[
                  { label: '区间点击', value: daily.reduce((a, b) => a + Number(b.clicks), 0) },
                  { label: '区间独立访客', value: daily.reduce((a, b) => a + Number(b.uniques), 0) },
                  { label: '今日', value: daily.length ? Number(daily[daily.length - 1].clicks) : 0 },
                  { label: '累计点击', value: detail?.click_count ?? 0 },
                ].map((c) => (
                  <div key={c.label} className="rounded-lg border border-border px-3 py-2">
                    <div className="text-[11px] text-muted-foreground">{c.label}</div>
                    <div className="font-serif text-lg font-bold text-foreground">{c.value}</div>
                  </div>
                ))}
              </div>

              <div>
                <div className="text-sm text-foreground mb-2">点击趋势</div>
                <ChartContainer config={chartConfig} className="h-[200px] w-full aspect-auto">
                  <AreaChart data={daily} margin={{ left: 4, right: 8, top: 6, bottom: 0 }}>
                    <CartesianGrid vertical={false} />
                    <XAxis dataKey="day" tickLine={false} axisLine={false} tickMargin={6}
                      tickFormatter={(v: string) => String(v).slice(5)} />
                    <YAxis width={28} tickLine={false} axisLine={false} allowDecimals={false} />
                    <ChartTooltip content={<ChartTooltipContent />} />
                    <Area type="monotone" dataKey="clicks" stroke="var(--color-clicks)"
                      fill="var(--color-clicks)" fillOpacity={0.18} strokeWidth={2} />
                    <Area type="monotone" dataKey="uniques" stroke="var(--color-uniques)"
                      fill="var(--color-uniques)" fillOpacity={0.12} strokeWidth={1.5} />
                  </AreaChart>
                </ChartContainer>
              </div>

              <div className="grid gap-4 md:grid-cols-2">
                <div>
                  <div className="text-sm text-foreground mb-2">来源渠道</div>
                  {channels.length === 0 ? (
                    <p className="text-xs text-muted-foreground">暂无数据</p>
                  ) : (
                    <div className="space-y-2">
                      {channels.map((c) => (
                        <div key={c.channel} className="space-y-1">
                          <div className="flex items-center justify-between gap-2 text-[11px]">
                            <span className="text-foreground truncate">{c.channel}</span>
                            <span className="text-muted-foreground shrink-0">
                              {c.clicks} 次 · 独立 {c.uniques}
                            </span>
                          </div>
                          <Progress value={(Number(c.clicks) / channelTotal) * 100} className="h-1.5" />
                        </div>
                      ))}
                    </div>
                  )}
                  {channels.length > 0 && (
                    <div className="mt-4">
                      <div className="text-[11px] text-muted-foreground mb-1.5">渠道对比</div>
                      <ChartContainer config={{ clicks: { label: '点击', color: 'hsl(var(--primary))' } }}
                        className="h-[120px] w-full aspect-auto">
                        <BarChart data={channels.slice(0, 8)} margin={{ left: 0, right: 6, top: 4, bottom: 0 }}>
                          <XAxis dataKey="channel" tickLine={false} axisLine={false} tickMargin={4}
                            tickFormatter={(v: string) => (String(v).length > 4 ? `${String(v).slice(0, 4)}…` : String(v))} />
                          <YAxis width={24} tickLine={false} axisLine={false} allowDecimals={false} />
                          <ChartTooltip content={<ChartTooltipContent />} />
                          <Bar dataKey="clicks" fill="var(--color-clicks)" radius={[3, 3, 0, 0]} />
                        </BarChart>
                      </ChartContainer>
                    </div>
                  )}
                </div>

                <div>
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-sm text-foreground">最近点击</span>
                    <button
                      onClick={() => setOnlyNew((v) => !v)}
                      className={`text-[11px] px-2 py-0.5 rounded border transition-colors ${
                        onlyNew ? 'border-primary text-primary bg-primary/10' : 'border-border text-muted-foreground hover:text-foreground'
                      }`}
                    >
                      <UserPlus className="h-3 w-3 inline mr-1" />只看新访客
                    </button>
                  </div>
                  {recentShown.length === 0 ? (
                    <p className="text-xs text-muted-foreground">暂无数据</p>
                  ) : (
                    <div className="max-h-60 overflow-y-auto space-y-1.5 pr-1">
                      {recentShown.map((c) => (
                        <div key={c.id} className="rounded-md border border-border/70 px-2 py-1.5 text-[11px]">
                          <div className="flex items-center justify-between gap-2">
                            <span className="text-foreground">{fmtTime(c.clicked_at)}</span>
                            <span className="text-muted-foreground flex items-center gap-1.5">
                              {c.channel ? `渠道 ${c.channel}` : '未标记'}
                              {c.is_bot && (
                                <Badge variant="secondary" className="h-4 px-1 text-[10px] gap-0.5">
                                  <Bot className="h-2.5 w-2.5" />爬虫
                                </Badge>
                              )}
                              {!c.is_bot && c.is_unique && <Badge variant="outline" className="h-4 px-1 text-[10px]">新访客</Badge>}
                            </span>
                          </div>
                          <div className="text-muted-foreground mt-0.5 truncate">
                            {briefUa(c.ua)}
                            {c.ip_hash ? ` · 访客 ${c.ip_hash.slice(0, 6)}` : ''}
                            {c.referer ? ` · 来自 ${hostOf(c.referer)}` : ''}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}

          <DialogFooter>
            <Button variant="outline" onClick={() => detail && void copyText(shortLinkUrl(detail.code, detail.channel))}
              className="gap-1.5 border-border text-muted-foreground hover:text-foreground hover:bg-muted">
              <Copy className="h-4 w-4" />复制短链
            </Button>
            <Button variant="outline" onClick={() => detail && window.open(shortLinkUrl(detail.code, detail.channel), '_blank')}
              className="gap-1.5 border-border text-muted-foreground hover:text-foreground hover:bg-muted">
              <ArrowUpRight className="h-4 w-4" />打开测试
            </Button>
            <Button onClick={() => setDetail(null)}
              className="bg-primary text-primary-foreground hover:bg-primary/90">关闭</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <CreateShortLinkDialog
        open={creating}
        onOpenChange={setCreating}
        onCreated={(link) => {
          setLinks((prev) => [link, ...prev]);
          void load(range);
          void copyText(shortLinkUrl(link.code, link.channel), '短链已创建并复制');
        }}
      />

      <BatchCreateDialog
        open={batching}
        onOpenChange={setBatching}
        existingTargets={links.map((l) => l.target_url)}
        onDone={(n) => { void load(range); toast.success(`批量生成完成：新建 ${n} 条短链`); }}
      />
    </AppLayout>
  );
}

// ─── 新建单条短链 ────────────────────────────────────────────
function CreateShortLinkDialog({
  open, onOpenChange, onCreated,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onCreated: (link: ShortLink) => void;
}) {
  const [resources, setResources] = useState<Resource[]>([]);
  const [resourceId, setResourceId] = useState('');
  const [linkHost, setLinkHost] = useState('');
  const [title, setTitle] = useState('');
  const [url, setUrl] = useState('');
  const [code, setCode] = useState('');
  const [channel, setChannel] = useState('');
  // 默认「随机短码」：6 位（如 …/go/abc123），分享出去最短；需要"路径与原链一致"时可在下拉里改成另一种
  const [codeMode, setCodeMode] = useState<'path' | 'short'>('short');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    fetchResources().then(setResources).catch(() => setResources([]));
  }, [open]);

  const picked = useMemo(() => resources.find((r) => r.id === resourceId) ?? null, [resources, resourceId]);

  function reset() {
    setResourceId(''); setLinkHost(''); setTitle(''); setUrl(''); setCode(''); setChannel('');
    setCodeMode('short');
  }

  const previewUrl = useMemo(() => {
    const codeSample = codeMode === 'path' ? (derivePathCode(url) ?? 'abc123') : 'abc123';
    return shortLinkUrl(codeSample, channel);
  }, [codeMode, url, channel]);

  function pickResource(id: string) {
    setResourceId(id);
    const r = resources.find((x) => x.id === id);
    if (!r) return;
    setTitle(r.name);
    const linkList = (r.links ?? []).filter((l) => l?.url);
    if (linkList.length === 1) { setUrl(linkList[0].url); setLinkHost(linkList[0].url); }
    else { setUrl(''); setLinkHost(''); }
  }

  async function submit() {
    if (!url.trim()) { toast.error('请填写或选择要跳转的网盘链接'); return; }
    setSaving(true);
    try {
      const link = await createShortLink({
        title: title.trim() || hostOf(url),
        targetUrl: url,
        extractCode: code,
        panName: picked?.links?.find((l) => l.url === url)?.pan_name ?? null,
        resourceId: resourceId || null,
        channel,
        codeMode,
      });
      onCreated(link);
      reset();
      onOpenChange(false);
    } catch (e) {
      toast.error('创建失败：' + ((e as Error).message || ''));
    } finally { setSaving(false); }
  }

  const linkOptions = (picked?.links ?? []).filter((l) => l?.url);

  return (
    <Dialog open={open} onOpenChange={(o) => { onOpenChange(o); if (!o) reset(); }}>
      <DialogContent className="max-w-[calc(100%-2rem)] md:max-w-lg max-h-[90dvh] overflow-y-auto bg-card border-border">
        <DialogHeader>
          <DialogTitle>新建短链</DialogTitle>
          <DialogDescription className="text-xs text-muted-foreground">
            选一条资源（或直接粘贴网盘链接）→ 生成短链；分享后点击量/独立访客/来源渠道自动统计。
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label className="text-sm text-foreground">关联资源（可选）</Label>
            <Select value={resourceId || '__none__'} onValueChange={(v) => pickResource(v === '__none__' ? '' : v)}>
              <SelectTrigger className="h-9 bg-input border-border">
                <SelectValue placeholder="不关联，直接填链接" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__none__">不关联，直接填链接</SelectItem>
                {resources.map((r) => (
                  <SelectItem key={r.id} value={r.id}>
                    {r.name.length > 40 ? `${r.name.slice(0, 40)}…` : r.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {linkOptions.length > 1 && (
            <div className="space-y-1.5">
              <Label className="text-sm text-foreground">选择网盘链接</Label>
              <Select value={linkHost || '__pick__'} onValueChange={(v) => {
                if (v === '__pick__') return;
                setUrl(v); setLinkHost(v);
              }}>
                <SelectTrigger className="h-9 bg-input border-border">
                  <SelectValue placeholder="该资源有多条链接，选一条" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__pick__">请选择</SelectItem>
                  {linkOptions.map((l, i) => (
                    <SelectItem key={`${l.url}-${i}`} value={l.url}>
                      {l.pan_name ? `${l.pan_name} · ` : ''}{hostOf(l.url)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          <div className="space-y-1.5">
            <Label className="text-sm text-foreground">跳转目标（网盘链接）</Label>
            <Input value={url} onChange={(e) => setUrl(e.target.value)}
              placeholder="https://www.guangyapan.com/s/xxxx" className="h-9 bg-input border-border text-xs" />
          </div>

          <div className="grid gap-3 md:grid-cols-2">
            <div className="space-y-1.5">
              <Label className="text-sm text-foreground">标题（展示用）</Label>
              <Input value={title} onChange={(e) => setTitle(e.target.value)}
                placeholder="资源名称" className="h-9 bg-input border-border" />
            </div>
            <div className="space-y-1.5">
              <Label className="text-sm text-foreground">提取码（可选）</Label>
              <Input value={code} onChange={(e) => setCode(e.target.value)}
                placeholder="留空则直接跳转" className="h-9 bg-input border-border" />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label className="text-sm text-foreground">短链形态</Label>
            <Select value={codeMode} onValueChange={(v) => setCodeMode(v as 'path' | 'short')}>
              <SelectTrigger className="h-9 bg-input border-border"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="path">沿用原链接路径（分享出去只有域名不同）</SelectItem>
                <SelectItem value="short">随机短码（6 位，最短）</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-[11px] text-muted-foreground break-all">
              短链预览：<span className="font-mono text-primary">{previewUrl}</span>
            </p>
          </div>

          <div className="space-y-1.5">
            <Label className="text-sm text-foreground">默认渠道标记（可选）</Label>
            <Input value={channel} onChange={(e) => setChannel(e.target.value)}
              placeholder="例如：群A / 站点 / 朋友圈（用于区分来源）" className="h-9 bg-input border-border" />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}
            className="border-border text-muted-foreground hover:text-foreground hover:bg-muted">取消</Button>
          <Button onClick={() => void submit()} disabled={saving}
            className="gap-1.5 bg-primary text-primary-foreground hover:bg-primary/90">
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Unlink className="h-4 w-4" />}生成短链
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── 批量生成（更新中的资源）──────────────────────────────────
function BatchCreateDialog({
  open, onOpenChange, existingTargets, onDone,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  /** 已有短链的目标地址：这些会被跳过，不重复生成 */
  existingTargets: string[];
  onDone: (created: number) => void;
}) {
  const [resources, setResources] = useState<Resource[]>([]);
  const [loading, setLoading] = useState(false);
  const [picked, setPicked] = useState<Record<string, boolean>>({});
  const [keyword, setKeyword] = useState('');
  // 批量创建同样默认「随机短码」（最短）
  const [codeMode, setCodeMode] = useState<'path' | 'short'>('short');
  const [channel, setChannel] = useState('');
  const [scope, setScope] = useState<'all' | 'first'>('all');
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [result, setResult] = useState<{ created: number; skipped: number; failed: Array<{ target: string; reason: string }> } | null>(null);

  const existing = useMemo(() => new Set(existingTargets.map((u) => u.trim())), [existingTargets]);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    setResult(null);
    setProgress({ done: 0, total: 0 });
    fetchResources()
      .then((list) => {
        const updated = list.filter((r) => r.is_finished !== true);
        setResources(updated);
        setPicked(Object.fromEntries(updated.map((r) => [r.id, true])));
      })
      .catch(() => { setResources([]); setPicked({}); })
      .finally(() => setLoading(false));
  }, [open]);

  const filtered = useMemo(() => {
    const q = keyword.trim().toLowerCase();
    if (!q) return resources;
    return resources.filter((r) => r.name.toLowerCase().includes(q));
  }, [resources, keyword]);

  /** 某个资源本次会生成的条数（已存在的会跳过） */
  const planOf = useCallback((r: Resource): { targets: string[]; skipped: number } => {
    const links = (r.links ?? []).filter((l) => l?.url?.trim()).map((l) => l.url.trim());
    const list = scope === 'first' ? links.slice(0, 1) : links;
    const fresh = list.filter((u) => !existing.has(u));
    return { targets: fresh, skipped: list.length - fresh.length };
  }, [existing, scope]);

  const plan = useMemo(() => {
    const chosen = filtered.filter((r) => picked[r.id]);
    let create = 0, skip = 0, noLink = 0;
    for (const r of chosen) {
      const p = planOf(r);
      if ((r.links ?? []).filter((l) => l?.url?.trim()).length === 0) noLink++;
      create += p.targets.length;
      skip += p.skipped;
    }
    return { chosen: chosen.length, create, skip, noLink };
  }, [filtered, picked, planOf]);

  async function run() {
    const chosen = filtered.filter((r) => picked[r.id]);
    const items = chosen.flatMap((r) => {
      const p = planOf(r);
      const links = (r.links ?? []).filter((l) => l?.url?.trim());
      const map = new Map(links.map((l) => [l.url.trim(), l]));
      return p.targets.map((url) => ({
        title: r.name,
        targetUrl: url,
        panName: map.get(url)?.pan_name ?? null,
        resourceId: r.id,
        channel,
        codeMode,
      }));
    });

    if (items.length === 0) { toast.info('没有需要新建的短链（都已生成过）'); return; }
    setRunning(true);
    setResult(null);
    setProgress({ done: 0, total: items.length });
    try {
      // 同一目标地址只保留一条，避免批内自撞
      const seen = new Set<string>();
      const uniq = items.filter((i) => (seen.has(i.targetUrl) ? false : (seen.add(i.targetUrl), true)));
      const { created, failed } = await createShortLinksBulk(uniq, (done, total) => setProgress({ done, total }));
      setResult({ created: created.length, skipped: plan.skip, failed });
      onDone(created.length);
    } catch (e) {
      toast.error('批量生成失败：' + ((e as Error).message || ''));
    } finally {
      setRunning(false);
    }
  }

  const allPicked = filtered.length > 0 && filtered.every((r) => picked[r.id]);

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!running) onOpenChange(o); }}>
      <DialogContent className="max-w-[calc(100%-2rem)] md:max-w-2xl bg-card border-border max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>批量生成短链</DialogTitle>
          <DialogDescription className="text-xs text-muted-foreground">
            默认列出**所有更新中的资源**（已完结的不列出），每个资源按其网盘链接生成短链；已生成过的自动跳过。
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="py-12 text-center text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin inline mr-1.5" />正在读取资源…
          </div>
        ) : (
          <div className="space-y-3">
            <div className="grid gap-3 md:grid-cols-3">
              <div className="space-y-1.5">
                <Label className="text-sm text-foreground">每个资源生成</Label>
                <Select value={scope} onValueChange={(v) => setScope(v as 'all' | 'first')}>
                  <SelectTrigger className="h-9 bg-input border-border"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">每条网盘链接一条</SelectItem>
                    <SelectItem value="first">只第一条网盘链接</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label className="text-sm text-foreground">短链形态</Label>
                <Select value={codeMode} onValueChange={(v) => setCodeMode(v as 'path' | 'short')}>
                  <SelectTrigger className="h-9 bg-input border-border"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="path">沿用原链接路径</SelectItem>
                    <SelectItem value="short">随机短码</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label className="text-sm text-foreground">默认渠道（可选）</Label>
                <Input value={channel} onChange={(e) => setChannel(e.target.value)}
                  placeholder="如 群A" className="h-9 bg-input border-border" />
              </div>
            </div>

            <div className="flex items-center gap-2">
              <div className="relative flex-1">
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
                <Input value={keyword} onChange={(e) => setKeyword(e.target.value)}
                  placeholder="筛选资源名" className="h-9 pl-8 bg-input border-border text-sm" />
              </div>
              <Button variant="outline" size="sm"
                onClick={() => {
                  const next: Record<string, boolean> = { ...picked };
                  for (const r of filtered) next[r.id] = !allPicked;
                  setPicked(next);
                }}
                className="h-9 shrink-0 border-border text-muted-foreground hover:text-foreground hover:bg-muted">
                {allPicked ? '全不选' : '全选'}
              </Button>
            </div>

            <div className="rounded-lg border border-border max-h-64 overflow-y-auto divide-y divide-border/60">
              {filtered.length === 0 ? (
                <p className="text-xs text-muted-foreground py-6 text-center">没有更新中的资源</p>
              ) : (
                filtered.map((r) => {
                  const p = planOf(r);
                  const total = (r.links ?? []).filter((l) => l?.url?.trim()).length;
                  return (
                    <label key={r.id} className="flex items-start gap-2.5 px-3 py-2 cursor-pointer hover:bg-muted/40">
                      <Checkbox checked={!!picked[r.id]} onCheckedChange={(v) => setPicked((prev) => ({ ...prev, [r.id]: v === true }))}
                        className="mt-0.5 shrink-0" />
                      <div className="min-w-0 flex-1">
                        <div className="text-xs text-foreground truncate">{r.name}</div>
                        <div className="text-[11px] text-muted-foreground mt-0.5">
                          集数 {r.episode_count ?? '—'} · 链接 {total} 条
                          {p.targets.length > 0 && <span className="text-primary"> → 将新建 {p.targets.length} 条</span>}
                          {p.skipped > 0 && <span> · 跳过 {p.skipped} 条（已存在）</span>}
                          {total === 0 && <span className="text-destructive"> · 该资源没有网盘链接</span>}
                        </div>
                      </div>
                    </label>
                  );
                })
              )}
            </div>

            <div className="rounded-lg bg-muted/40 border border-border px-3 py-2 text-[11px] text-muted-foreground">
              已选 <b className="text-foreground">{plan.chosen}</b> 个资源 ·
              将新建 <b className="text-primary">{plan.create}</b> 条短链 ·
              跳过 <b className="text-foreground">{plan.skip}</b> 条（已存在）
              {plan.noLink > 0 && <> · <span className="text-destructive">{plan.noLink} 个资源没有链接</span></>}
            </div>

            {running && (
              <div className="space-y-1.5">
                <Progress value={progress.total ? (progress.done / progress.total) * 100 : 0} className="h-1.5" />
                <p className="text-[11px] text-muted-foreground">
                  正在生成 {progress.done}/{progress.total} …
                </p>
              </div>
            )}

            {result && (
              <div className="rounded-lg border border-border px-3 py-2 space-y-1">
                <p className="text-xs text-foreground">
                  完成：新建 <b className="text-primary">{result.created}</b> 条 ·
                  跳过 {result.skipped} 条已存在
                  {result.failed.length > 0 && <> · <span className="text-destructive">失败 {result.failed.length} 条</span></>}
                </p>
                {result.failed.length > 0 && (
                  <div className="max-h-24 overflow-y-auto text-[11px] text-muted-foreground space-y-0.5">
                    {result.failed.slice(0, 10).map((f, i) => (
                      <div key={i} className="truncate">{hostOf(f.target)} — {f.reason}</div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={running}
            className="border-border text-muted-foreground hover:text-foreground hover:bg-muted">
            {result ? '关闭' : '取消'}
          </Button>
          <Button onClick={() => void run()} disabled={running || loading || plan.create === 0}
            className="gap-1.5 bg-primary text-primary-foreground hover:bg-primary/90">
            {running ? <Loader2 className="h-4 w-4 animate-spin" /> : <Layers className="h-4 w-4" />}
            {running ? '生成中…' : `生成 ${plan.create} 条短链`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
