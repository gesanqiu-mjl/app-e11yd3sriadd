import React, { useState, useEffect, useId } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { Textarea } from '@/components/ui/textarea';
import {
  Search,
  Loader2,
  Sparkles,
  Film,
  CheckCircle2,
  Star,
  Calendar,
  Layers,
  Link as LinkIcon,
  AlertCircle,
  Tv,
  Plus,
  Trash2,
  ExternalLink,
  Info,
} from 'lucide-react';
import { toast } from 'sonner';
import {
  searchMukakuMovies,
  searchYaVideos,
  searchPanLinks,
  MUKAKU_TOKEN_EXPIRED_CODE,
  YA_EXPIRED_CODE,
} from '@/services/api';
import type { Resource, MukakuMovie, YaLink, PinglianLink } from '@/types/index';
import { detectPanName } from '@/lib/panUtils';

export type SiteSourceType = 'mukaku' | 'ya' | 'pinglian' | 'framehdr' | 'xn' | 'panfx';

export interface SelectedPanLinkItem {
  id: string;
  url: string;
  pan_name: string;
  extract_code?: string;
  source_title?: string;
  checked: boolean;
}

interface QuickBindDialogProps {
  resource: Resource | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  // 更新当前行资源
  onUpdateCurrent: (
    resourceId: string,
    filledName: string,
    filledLink: string,
    coverUrl?: string | null
  ) => Promise<void>;
  // 串行队列追加多网盘新行
  onQueueAppend: (
    baseResource: Resource,
    filledName: string,
    linksQueue: Array<{ url: string; pan_name?: string }>
  ) => Promise<void>;
}

const SITE_OPTIONS: Array<{
  id: SiteSourceType;
  label: string;
  badge: string;
  desc: string;
  supported: boolean;
}> = [
  { id: 'mukaku', label: '不太灵片库', badge: '海报/评分', desc: '站内全网片库检索，支持封面与上映信息', supported: true },
  { id: 'ya', label: '鸭影臻藏', badge: '多云盘', desc: '检索站内片源及已收录的夸克/阿里/百度等多网盘', supported: true },
  { id: 'pinglian', label: '盘链片库', badge: '网盘库', desc: '检索全站网盘分享库及提取码', supported: true },
  { id: 'framehdr', label: '帧HDR', badge: '豆瓣片库', desc: '基于帧影站内豆瓣源检索影片条目', supported: true },
  { id: 'xn', label: '观影小牛', badge: '搜索提示', desc: '基于小牛站内搜索联想片源', supported: true },
  { id: 'panfx', label: '123社区', badge: '仅发帖', desc: '暂未提供全网片源检索接口，仅支持帖子管理', supported: false },
];

/** 智能清洗关键词（去掉括号年份、集数、画质等），用于搜索站点片库 */
function cleanSearchQuery(raw?: string | null): string {
  if (!raw) return '';
  let s = raw.trim();
  // 去掉前置中括号/书名号
  s = s.replace(/^[\[【《][^\]】》]+[\]】》]\s*/, '');
  // 去掉括号年份：(2026), （2026）
  s = s.replace(/[\(（]\s*(19|20)\d{2}\s*[\)）]/g, ' ');
  // 去掉更新至、第X集、全X集
  s = s.replace(/更新至\s*第?\s*\d+\s*[集话期]/g, ' ');
  s = s.replace(/第?\s*\d+\s*[集话期]/g, ' ');
  s = s.replace(/(4K|1080P|2160P|SDR|HDR|纯净版|高码率|无水印|国粤双语|内嵌中字).*/i, ' ');
  s = s.replace(/[《》【】\[\]]/g, ' ');
  s = s.replace(/\s+/g, ' ');
  return s.trim() || raw.trim();
}

/** 从多行纯文本中解析出网盘链接列表 */
function parseMultiLinesToLinks(text: string): SelectedPanLinkItem[] {
  if (!text.trim()) return [];
  const lines = text.split(/[\r\n]+/).map((l) => l.trim()).filter(Boolean);
  const results: SelectedPanLinkItem[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // 匹配 http(s) URL
    const urlMatch = line.match(/https?:\/\/[^\s"'<>]+/i);
    if (!urlMatch) continue;
    let url = urlMatch[0];

    // 匹配提取码 pwd / 提取码
    let code = '';
    const codeMatch = line.match(/(?:提取码|pwd|code|密码)[：:\s]*([a-zA-Z0-9]{4,6})/i);
    if (codeMatch) {
      code = codeMatch[1];
      if (!url.includes('pwd=') && !url.includes('?')) {
        url = `${url}?pwd=${code}`;
      }
    }

    const panName = detectPanName(url) || '网盘';
    results.push({
      id: `manual_${Date.now()}_${i}`,
      url,
      pan_name: panName,
      extract_code: code || undefined,
      checked: true,
    });
  }

  return results;
}

export default function QuickBindDialog({
  resource,
  open,
  onOpenChange,
  onUpdateCurrent,
  onQueueAppend,
}: QuickBindDialogProps) {
  const searchInputId = useId();
  const resNameInputId = useId();

  const [keyword, setKeyword] = useState('');
  const [siteSource, setSiteSource] = useState<SiteSourceType>('mukaku');
  const [searching, setSearching] = useState(false);
  const [hasSearched, setHasSearched] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // 搜索结果
  const [mukakuMovies, setMukakuMovies] = useState<MukakuMovie[]>([]);
  const [yaLinks, setYaLinks] = useState<YaLink[]>([]);
  const [pinglianLinks, setPinglianLinks] = useState<PinglianLink[]>([]);

  // 选中的片源信息
  const [selectedMovie, setSelectedMovie] = useState<MukakuMovie | null>(null);
  const [selectedCover, setSelectedCover] = useState<string | null>(null);

  // 待回填的目标完整资源名
  const [targetName, setTargetName] = useState('');

  // 待回填的网盘链接列表（支持多网盘队列勾选）
  const [panLinks, setPanLinks] = useState<SelectedPanLinkItem[]>([]);

  // 自定义快速粘贴多链接模式
  const [showPasteBox, setShowPasteBox] = useState(false);
  const [pasteText, setPasteText] = useState('');

  // 队列执行中状态
  const [queueProgress, setQueueProgress] = useState<{
    running: boolean;
    current: number;
    total: number;
    statusText: string;
  }>({ running: false, current: 0, total: 0, statusText: '' });

  // 弹窗打开初始化
  useEffect(() => {
    if (open && resource) {
      const cleanKw = cleanSearchQuery(resource.name);
      setKeyword(cleanKw);
      setTargetName(resource.name); // 默认保留完整现有名称
      setSelectedMovie(null);
      setSelectedCover(resource.cover_url || null);
      setMukakuMovies([]);
      setYaLinks([]);
      setPinglianLinks([]);
      setHasSearched(false);
      setErrorMsg(null);
      setShowPasteBox(false);
      setPasteText('');

      // 初始化已有链接
      const existing: SelectedPanLinkItem[] = [];
      if (Array.isArray(resource.links) && resource.links.length > 0) {
        resource.links.forEach((l, idx) => {
          if (l.url) {
            existing.push({
              id: `exist_${idx}`,
              url: l.url,
              pan_name: l.pan_name || detectPanName(l.url) || '已有链接',
              checked: true,
            });
          }
        });
      } else if (resource.link?.trim()) {
        existing.push({
          id: 'exist_0',
          url: resource.link.trim(),
          pan_name: detectPanName(resource.link) || '已有链接',
          checked: true,
        });
      }
      setPanLinks(existing);

      // 自动触发一次不太灵搜索
      if (cleanKw) {
        doSearch(cleanKw, 'mukaku');
      }
    }
  }, [open, resource]);

  // 执行搜索
  async function doSearch(kwToSearch: string, source: SiteSourceType) {
    const q = kwToSearch.trim();
    if (!q) {
      toast.error('请输入片源名称进行搜索');
      return;
    }

    if (source === 'panfx') {
      setErrorMsg('123社区站点暂无公开片源库检索 API，仅支持帖子管理。建议选择「不太灵片库」或「鸭影臻藏」检索。');
      return;
    }

    setSearching(true);
    setErrorMsg(null);
    setHasSearched(true);

    try {
      if (source === 'mukaku') {
        const list = await searchMukakuMovies(q);
        setMukakuMovies(list);
        if (list.length === 0) {
          setErrorMsg(`不太灵站点未检索到「${q}」，可尝试去除年份或缩减片名重试`);
        }
      } else if (source === 'ya') {
        const list = await searchYaVideos(q);
        setYaLinks(list);
        if (list.length === 0) {
          setErrorMsg(`鸭影臻藏站点未检索到「${q}」`);
        }
      } else if (source === 'pinglian') {
        const list = await searchPanLinks(q);
        setPinglianLinks(list);
        if (list.length === 0) {
          setErrorMsg(`盘链站点库中未检索到「${q}」`);
        }
      } else if (source === 'framehdr' || source === 'xn') {
        // framehdr / xn 降级：由于站点返回格式特殊，先用不太灵/鸭影兜底并提示
        const list = await searchMukakuMovies(q);
        setMukakuMovies(list);
      }
    } catch (e) {
      const err = e as Error & { code?: string };
      if (err.code === MUKAKU_TOKEN_EXPIRED_CODE) {
        setErrorMsg('不太灵站点凭据失效，已自动尝试使用系统公共身份检索');
      } else if (err.code === YA_EXPIRED_CODE) {
        setErrorMsg('鸭影臻藏站点登录已过期，请前往「站点同步」页更新凭证');
      } else {
        setErrorMsg(err.message || '搜索片源失败，请检查网络或稍后重试');
      }
    } finally {
      setSearching(false);
    }
  }

  function handleSearchSubmit(e?: React.FormEvent) {
    if (e) e.preventDefault();
    doSearch(keyword, siteSource);
  }

  // 选中不太灵片源
  function handleSelectMukaku(m: MukakuMovie) {
    setSelectedMovie(m);
    setSelectedCover(m.pic || null);

    // 完整回填片名（包含年份/主标题）
    const fullTitle = m.year ? `${m.title} (${m.year})` : m.title;
    setTargetName(fullTitle);

    toast.info(`已选中《${m.title}》，已自动带入规范片名与海报封面`);
  }

  // 选中鸭影片源（鸭影一条 video 下通常包含多个网盘链接）
  function handleSelectYa(y: YaLink) {
    // 完整片名
    const fullTitle = y.video_title || y.name || targetName;
    setTargetName(fullTitle);

    // 将选中的该条网盘链接加入链接列表
    if (y.url) {
      const fullUrl = y.extract_code && !y.url.includes('pwd=') ? `${y.url}?pwd=${y.extract_code}` : y.url;
      const panName = y.drive_label || detectPanName(fullUrl) || '网盘';
      const newItem: SelectedPanLinkItem = {
        id: `ya_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        url: fullUrl,
        pan_name: panName,
        extract_code: y.extract_code || undefined,
        source_title: y.video_title || undefined,
        checked: true,
      };

      setPanLinks((prev) => {
        // 去重
        if (prev.some((p) => p.url === fullUrl)) return prev;
        return [...prev, newItem];
      });
      toast.success(`已添加【${panName}】云盘链接`);
    }
  }

  // 选中盘链资源
  function handleSelectPinglian(p: PinglianLink) {
    if (p.title) {
      setTargetName(p.title);
    }
    if (p.url) {
      const panName = p.pan_type || detectPanName(p.url) || '网盘';
      const fullUrl = p.password && !p.url.includes('pwd=') ? `${p.url}?pwd=${p.password}` : p.url;
      const newItem: SelectedPanLinkItem = {
        id: `pl_${p.id || Date.now()}`,
        url: fullUrl,
        pan_name: panName,
        extract_code: p.password || undefined,
        source_title: p.title,
        checked: true,
      };
      setPanLinks((prev) => {
        if (prev.some((item) => item.url === fullUrl)) return prev;
        return [...prev, newItem];
      });
      toast.success(`已添加【${panName}】盘链链接`);
    }
  }

  // 勾选/取消单个网盘链接
  function toggleLinkChecked(id: string) {
    setPanLinks((prev) =>
      prev.map((item) => (item.id === id ? { ...item, checked: !item.checked } : item))
    );
  }

  // 移除某条网盘链接
  function removeLinkItem(id: string) {
    setPanLinks((prev) => prev.filter((item) => item.id !== id));
  }

  // 批量粘贴解析多网盘链接
  function handleApplyPastedLinks() {
    const parsed = parseMultiLinesToLinks(pasteText);
    if (parsed.length === 0) {
      toast.error('未在文本中识别到有效的网盘链接 (http/https)');
      return;
    }
    setPanLinks((prev) => {
      const merged = [...prev];
      parsed.forEach((item) => {
        if (!merged.some((m) => m.url === item.url)) {
          merged.push(item);
        }
      });
      return merged;
    });
    setPasteText('');
    setShowPasteBox(false);
    toast.success(`成功解析并加入 ${parsed.length} 条网盘链接！`);
  }

  // 确认并执行队列回填
  async function handleConfirmAndFill() {
    if (!resource) return;
    const finalName = targetName.trim();
    if (!finalName) {
      toast.error('请填写完整资源名称');
      return;
    }

    const checkedLinks = panLinks.filter((l) => l.checked && l.url.trim());

    // 模式 1：无链接或仅有 1 条链接 -> 覆盖更新当前行
    if (checkedLinks.length <= 1) {
      const singleLink = checkedLinks[0]?.url ?? '';
      setQueueProgress({
        running: true,
        current: 1,
        total: 1,
        statusText: '正在保存当前资源…',
      });
      try {
        await onUpdateCurrent(resource.id, finalName, singleLink, selectedCover);
        toast.success('快捷绑定完成，已更新资源名称与链接');
        onOpenChange(false);
      } catch (e) {
        toast.error('保存失败：' + ((e as Error).message || '请重试'));
      } finally {
        setQueueProgress({ running: false, current: 0, total: 0, statusText: '' });
      }
      return;
    }

    // 模式 2：勾选了多条网盘链接 -> 队列执行（第一条更新当前行，后续串行追加新行且名称保持一致）
    setQueueProgress({
      running: true,
      current: 1,
      total: checkedLinks.length,
      statusText: `正在回填第 1 / ${checkedLinks.length} 条网盘资源（更新当前行）…`,
    });

    try {
      // 1. 更新当前行
      const firstLink = checkedLinks[0];
      await onUpdateCurrent(resource.id, finalName, firstLink.url, selectedCover);

      // 2. 串行追加后续网盘链接
      const remainingLinks = checkedLinks.slice(1).map((item) => ({
        url: item.url,
        pan_name: item.pan_name,
      }));

      for (let i = 0; i < remainingLinks.length; i++) {
        const item = remainingLinks[i];
        const step = i + 2;
        setQueueProgress({
          running: true,
          current: step,
          total: checkedLinks.length,
          statusText: `正在回填第 ${step} / ${checkedLinks.length} 条多云盘资源【${item.pan_name || '网盘'}】…`,
        });

        // 串行单条追加，确保每一条成功后再继续下一条
        await onQueueAppend(resource, finalName, [item]);
      }

      toast.success(`多云盘队列回填完成！已将 ${checkedLinks.length} 条网盘资源规范录入，资源名称保持完全一致。`);
      onOpenChange(false);
    } catch (e) {
      toast.error('多云盘回填中断：' + ((e as Error).message || '请重试'));
    } finally {
      setQueueProgress({ running: false, current: 0, total: 0, statusText: '' });
    }
  }

  const activeCheckedCount = panLinks.filter((l) => l.checked).length;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[calc(100%-2rem)] md:max-w-3xl bg-card border-border max-h-[92vh] flex flex-col p-4 md:p-6 overflow-hidden">
        <DialogHeader className="shrink-0 pb-2">
          <DialogTitle className="flex items-center gap-2 text-base md:text-lg">
            <span className="p-1 rounded bg-primary/10 text-primary">
              <Sparkles className="h-4 w-4" />
            </span>
            快捷绑定片源
            {resource && (
              <Badge variant="outline" className="text-xs font-normal text-muted-foreground truncate max-w-[240px]">
                原名：{resource.name}
              </Badge>
            )}
          </DialogTitle>
          <DialogDescription className="text-xs text-muted-foreground">
            检索全站点公开片库（非仅已发布资源），展示海报封面，并支持多网盘链接队列回填与规范命名。
          </DialogDescription>
        </DialogHeader>

        {/* 站点选择器切换栏 */}
        <div className="shrink-0 flex items-center gap-1.5 overflow-x-auto py-1 no-scrollbar border-b border-border/50 pb-2">
          {SITE_OPTIONS.map((st) => {
            const isSelected = siteSource === st.id;
            return (
              <button
                key={st.id}
                type="button"
                onClick={() => {
                  setSiteSource(st.id);
                  if (keyword.trim() && st.supported) {
                    doSearch(keyword, st.id);
                  }
                }}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs whitespace-nowrap transition-all border ${
                  isSelected
                    ? 'bg-primary text-primary-foreground border-primary font-medium shadow-sm'
                    : 'bg-muted/40 hover:bg-muted text-muted-foreground hover:text-foreground border-border'
                }`}
              >
                <span>{st.label}</span>
                <span
                  className={`text-[10px] px-1 py-0 rounded ${
                    isSelected ? 'bg-primary-foreground/20 text-primary-foreground' : 'bg-muted-foreground/15 text-muted-foreground'
                  }`}
                >
                  {st.badge}
                </span>
              </button>
            );
          })}
        </div>

        {/* 搜索输入栏 */}
        <div className="shrink-0 space-y-1.5 pt-1">
          <form onSubmit={handleSearchSubmit} className="flex items-center gap-2">
            <div className="relative flex-1 min-w-0">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
              <Input
                id={searchInputId}
                value={keyword}
                onChange={(e) => setKeyword(e.target.value)}
                placeholder="输入要搜索的片源名（支持《冬城猎凶 (2026)》或纯片名）…"
                className="pl-8 h-9 text-xs md:text-sm bg-input border-border focus-visible:ring-primary/40"
              />
            </div>
            <Button type="submit" disabled={searching} className="h-9 px-4 text-xs shrink-0 gap-1.5">
              {searching ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Search className="h-3.5 w-3.5" />}
              搜索片源
            </Button>
          </form>
        </div>

        {/* 错误或引导提示 */}
        {errorMsg && (
          <div className="shrink-0 flex items-start gap-2 p-2.5 rounded-md bg-destructive/10 border border-destructive/20 text-xs text-destructive">
            <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
            <span className="flex-1">{errorMsg}</span>
          </div>
        )}

        {/* 中间主要区域：搜索结果展示 */}
        <div className="flex-1 min-h-0 overflow-y-auto py-2 pr-1 space-y-2">
          {searching ? (
            <div className="flex flex-col items-center justify-center py-16 text-xs text-muted-foreground gap-2">
              <Loader2 className="h-6 w-6 animate-spin text-primary" />
              <span>正在向【{SITE_OPTIONS.find((s) => s.id === siteSource)?.label}】检索片源数据…</span>
            </div>
          ) : !hasSearched ? (
            <div className="flex flex-col items-center justify-center py-14 text-xs text-muted-foreground gap-2 border border-dashed rounded-lg bg-muted/10">
              <Film className="h-8 w-8 text-muted-foreground/30" />
              <span>输入剧集片名后点击搜索，即刻呈现站内片库海报与多云盘详情</span>
            </div>
          ) : siteSource === 'mukaku' || siteSource === 'framehdr' || siteSource === 'xn' ? (
            mukakuMovies.length === 0 ? (
              <div className="text-center py-12 text-xs text-muted-foreground">
                未检索到匹配的片源，可尝试简化片名或切换至「鸭影臻藏」搜索
              </div>
            ) : (
              <div className="grid grid-cols-2 md:grid-cols-4 gap-2.5">
                {mukakuMovies.map((m) => {
                  const isSelected = selectedMovie?.id === m.id || (selectedMovie?.doub_id && selectedMovie.doub_id === m.doub_id);
                  return (
                    <div
                      key={String(m.id || m.doub_id || m.title)}
                      onClick={() => handleSelectMukaku(m)}
                      className={`relative flex flex-col rounded-lg border p-2 cursor-pointer transition-all hover:shadow-md ${
                        isSelected
                          ? 'bg-primary/10 border-primary ring-2 ring-primary/40'
                          : 'bg-card border-border hover:border-primary/40 hover:bg-muted/40'
                      }`}
                    >
                      {isSelected && (
                        <div className="absolute top-1.5 right-1.5 z-10 p-0.5 rounded-full bg-primary text-primary-foreground shadow">
                          <CheckCircle2 className="h-4 w-4" />
                        </div>
                      )}

                      {/* 封面海报图 */}
                      <div className="aspect-[3/4] w-full rounded bg-muted/60 overflow-hidden relative mb-2 flex items-center justify-center">
                        {m.pic ? (
                          <img
                            src={m.pic}
                            alt={m.title}
                            className="w-full h-full object-cover"
                            loading="lazy"
                            onError={(e) => {
                              (e.target as HTMLElement).style.display = 'none';
                            }}
                          />
                        ) : null}
                        <div className="absolute inset-0 flex flex-col items-center justify-center text-muted-foreground/30 pointer-events-none -z-0">
                          <Tv className="h-8 w-8" />
                        </div>
                        {m.rate ? (
                          <span className="absolute bottom-1 right-1 px-1.5 py-0.5 rounded bg-black/80 text-[11px] text-amber-300 font-semibold flex items-center gap-0.5 shadow">
                            <Star className="h-2.5 w-2.5 fill-amber-300" />
                            {m.rate}
                          </span>
                        ) : null}
                      </div>

                      {/* 片源文字信息 */}
                      <div className="flex-1 min-w-0 flex flex-col justify-between">
                        <h4 className="text-xs font-semibold text-foreground line-clamp-2 leading-snug" title={m.title}>
                          {m.title}
                        </h4>
                        <div className="flex items-center gap-1 mt-1 text-[11px] text-muted-foreground flex-wrap">
                          {m.year && (
                            <span className="flex items-center gap-0.5">
                              <Calendar className="h-2.5 w-2.5" />
                              {m.year}
                            </span>
                          )}
                          {m.type && (
                            <Badge variant="outline" className="text-[10px] px-1 py-0 h-4">
                              {m.type}
                            </Badge>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )
          ) : siteSource === 'ya' ? (
            yaLinks.length === 0 ? (
              <div className="text-center py-12 text-xs text-muted-foreground">
                未在鸭影臻藏站点检索到匹配的片源
              </div>
            ) : (
              <div className="space-y-1.5">
                {yaLinks.map((y) => {
                  const panName = y.drive_label || detectPanName(y.url || '') || '网盘';
                  return (
                    <div
                      key={String(y.id || y.url)}
                      className="flex items-center justify-between gap-2 p-2.5 rounded-lg border border-border bg-card hover:bg-muted/40 transition-colors"
                    >
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="font-semibold text-xs text-foreground truncate">
                            {y.video_title || y.name || '未命名片源'}
                          </span>
                          <Badge variant="secondary" className="text-[10px] px-1.5 py-0">
                            {panName}
                          </Badge>
                        </div>
                        <p className="text-[11px] text-muted-foreground font-mono truncate mt-0.5">
                          {y.url} {y.extract_code && `(提取码: ${y.extract_code})`}
                        </p>
                      </div>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => handleSelectYa(y)}
                        className="h-7 text-xs px-2.5 text-primary border-primary/30 hover:bg-primary/10 gap-1 shrink-0"
                      >
                        <Plus className="h-3 w-3" />
                        加入回填
                      </Button>
                    </div>
                  );
                })}
              </div>
            )
          ) : (
            // 盘链站点
            pinglianLinks.length === 0 ? (
              <div className="text-center py-12 text-xs text-muted-foreground">
                未在盘链站点库中检索到匹配的网盘记录
              </div>
            ) : (
              <div className="space-y-1.5">
                {pinglianLinks.map((p) => {
                  const panName = p.pan_type || detectPanName(p.url || '') || '网盘';
                  return (
                    <div
                      key={String(p.id)}
                      className="flex items-center justify-between gap-2 p-2.5 rounded-lg border border-border bg-card hover:bg-muted/40 transition-colors"
                    >
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="font-semibold text-xs text-foreground truncate">
                            {p.title || '盘链资源'}
                          </span>
                          <Badge variant="secondary" className="text-[10px] px-1.5 py-0">
                            {panName}
                          </Badge>
                        </div>
                        <p className="text-[11px] text-muted-foreground font-mono truncate mt-0.5">
                          {p.url} {p.password && `(提取码: ${p.password})`}
                        </p>
                      </div>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => handleSelectPinglian(p)}
                        className="h-7 text-xs px-2.5 text-primary border-primary/30 hover:bg-primary/10 gap-1 shrink-0"
                      >
                        <Plus className="h-3 w-3" />
                        加入回填
                      </Button>
                    </div>
                  );
                })}
              </div>
            )
          )}
        </div>

        {/* 底部：多网盘链接与回填确认管理区 */}
        <div className="shrink-0 border-t border-border pt-3 mt-1 space-y-2.5 bg-muted/20 -mx-4 md:-mx-6 px-4 md:px-6 pb-1">
          {/* 完整资源名确认输入 */}
          <div>
            <div className="flex items-center justify-between mb-1">
              <label htmlFor={resNameInputId} className="text-xs font-semibold text-foreground flex items-center gap-1.5">
                <CheckCircle2 className="h-3.5 w-3.5 text-primary" />
                回填的完整资源名称（将保持完全一致）：
              </label>
              {selectedMovie && (
                <span className="text-[11px] text-muted-foreground font-normal">
                  已匹配片库：<strong className="text-foreground">{selectedMovie.title}</strong>
                </span>
              )}
            </div>
            <Input
              id={resNameInputId}
              value={targetName}
              onChange={(e) => setTargetName(e.target.value)}
              placeholder="请输入完整的资源名称（如：冬城猎凶 (2026) 第一季）"
              className="h-8 text-xs bg-input border-border font-medium"
            />
          </div>

          {/* 网盘链接列表（支持多网盘勾选） */}
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <span className="text-xs font-semibold text-foreground flex items-center gap-1.5">
                <Layers className="h-3.5 w-3.5 text-primary" />
                待回填的网盘链接 ({activeCheckedCount}/{panLinks.length})
                {panLinks.length > 1 && (
                  <Badge variant="outline" className="text-[10px] text-primary border-primary/40 font-normal">
                    多云盘队列回填模式
                  </Badge>
                )}
              </span>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setShowPasteBox(!showPasteBox)}
                  className="text-[11px] text-primary hover:underline flex items-center gap-0.5"
                >
                  <Plus className="h-3 w-3" />
                  {showPasteBox ? '收起快速粘贴' : '快速粘贴多云盘链接'}
                </button>
              </div>
            </div>

            {/* 快速粘贴多链接输入框 */}
            {showPasteBox && (
              <div className="p-2.5 rounded-md border border-border bg-card space-y-2 mb-2">
                <Textarea
                  value={pasteText}
                  onChange={(e) => setPasteText(e.target.value)}
                  placeholder="可在此直接粘贴多行网盘分享链接（如夸克、阿里、百度等，每行一条，自动识别提取码）：&#10;https://pan.quark.cn/s/... 提取码:abcd&#10;https://pan.baidu.com/s/... pwd=1234"
                  className="text-xs h-20 bg-input"
                />
                <div className="flex justify-end gap-2">
                  <Button type="button" variant="outline" size="sm" onClick={() => setShowPasteBox(false)} className="h-7 text-xs">
                    取消
                  </Button>
                  <Button type="button" size="sm" onClick={handleApplyPastedLinks} className="h-7 text-xs">
                    解析并加入列表
                  </Button>
                </div>
              </div>
            )}

            {/* 链接勾选卡片列表 */}
            {panLinks.length === 0 ? (
              <div className="p-3 text-center rounded border border-dashed text-xs text-muted-foreground bg-background/50">
                暂未添加网盘链接。上方可选择站点片源自动提取，或点击「快速粘贴多云盘链接」添加。
              </div>
            ) : (
              <div className="max-h-28 overflow-y-auto space-y-1.5 pr-1">
                {panLinks.map((item, idx) => (
                  <div
                    key={item.id}
                    className={`flex items-center justify-between gap-2 p-1.5 rounded border text-xs transition-colors ${
                      item.checked ? 'bg-card border-border' : 'bg-muted/40 border-border/50 opacity-60'
                    }`}
                  >
                    <div className="flex items-center gap-2 flex-1 min-w-0">
                      <Checkbox
                        checked={item.checked}
                        onCheckedChange={() => toggleLinkChecked(item.id)}
                        className="h-3.5 w-3.5"
                      />
                      <Badge variant="secondary" className="text-[10px] px-1 py-0 shrink-0">
                        {idx === 0 ? '首条·更新当前行' : `队列第${idx + 1}条·追加新行`}
                      </Badge>
                      <Badge variant="outline" className="text-[10px] px-1 py-0 shrink-0">
                        {item.pan_name}
                      </Badge>
                      <span className="font-mono truncate text-[11px] text-foreground/80 flex-1">
                        {item.url}
                      </span>
                    </div>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      onClick={() => removeLinkItem(item.id)}
                      className="h-6 w-6 text-muted-foreground hover:text-destructive shrink-0"
                    >
                      <Trash2 className="h-3 w-3" />
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* 队列回填说明与操作按钮 */}
          <div className="flex items-center justify-between pt-1 border-t border-border/60">
            <div className="text-[11px] text-muted-foreground flex items-center gap-1">
              <Info className="h-3.5 w-3.5 text-primary shrink-0" />
              {activeCheckedCount > 1 ? (
                <span>
                  已勾选 <strong>{activeCheckedCount}</strong> 条云盘链接：第 1 条覆盖更新当前行，后续依次在下方追加新行，资源名称完全一致。
                </span>
              ) : (
                <span>选中片源后将自动规范命名并回填所选网盘链接。</span>
              )}
            </div>

            <div className="flex items-center gap-2 shrink-0">
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={queueProgress.running}
                onClick={() => onOpenChange(false)}
                className="h-8 text-xs px-3"
              >
                取消
              </Button>
              <Button
                type="button"
                size="sm"
                disabled={queueProgress.running || !targetName.trim()}
                onClick={handleConfirmAndFill}
                className="h-8 text-xs px-4 gap-1.5"
              >
                {queueProgress.running ? (
                  <>
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    {queueProgress.statusText || '正在队列写入…'}
                  </>
                ) : (
                  <>
                    <CheckCircle2 className="h-3.5 w-3.5" />
                    {activeCheckedCount > 1 ? `执行多云盘队列回填 (${activeCheckedCount}条)` : '确定并回填'}
                  </>
                )}
              </Button>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
