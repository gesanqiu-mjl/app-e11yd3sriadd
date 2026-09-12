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
} from 'lucide-react';
import { toast } from 'sonner';
import { searchMukakuMovies, searchYaVideos, MUKAKU_TOKEN_EXPIRED_CODE, YA_EXPIRED_CODE } from '@/services/api';
import type { Resource, MukakuMovie, YaLink } from '@/types/index';

interface QuickBindDialogProps {
  resource: Resource | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onBoundAndFilled: (
    resourceId: string,
    filledName: string,
    filledLink: string,
    selectedMovie?: MukakuMovie | null
  ) => Promise<void>;
}

/** 清理资源名称中可能存在的干扰字符（如 第X集、更新至、画质等），提取出干净的片名用于搜索 */
function extractSearchKeyword(rawName?: string | null): string {
  if (!rawName) return '';
  let s = rawName.trim();
  // 去除开头的【...】或 [...]
  s = s.replace(/^\[[^\]]+\]\s*/, '').replace(/^【[^】]+】\s*/, '');
  // 去除「第X集」「更新至 第X集」「全X集」「完结」
  s = s.replace(/更新至\s*第?\s*\d+\s*[集话期]/g, '');
  s = s.replace(/第?\s*\d+\s*[集话期]/g, '');
  s = s.replace(/\[\d+\]/g, '');
  s = s.replace(/【\d+】/g, '');
  s = s.replace(/(4K|1080P|2160P|SDR|HDR|纯净版|高码率|无水印|国粤双语|内嵌中字).*/i, '');
  s = s.replace(/【[^】]*】/g, ' ');
  s = s.replace(/\[[^\]]*\]/g, ' ');
  return s.trim() || rawName.trim();
}

export default function QuickBindDialog({
  resource,
  open,
  onOpenChange,
  onBoundAndFilled,
}: QuickBindDialogProps) {
  const searchInputId = useId();
  const resNameInputId = useId();
  const panLinkInputId = useId();

  const [keyword, setKeyword] = useState('');
  const [siteSource, setSiteSource] = useState<'mukaku' | 'ya'>('mukaku');
  const [searching, setSearching] = useState(false);
  const [hasSearched, setHasSearched] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // 搜索结果
  const [mukakuMovies, setMukakuMovies] = useState<MukakuMovie[]>([]);
  const [yaLinks, setYaLinks] = useState<YaLink[]>([]);

  // 当前选中
  const [selectedMovie, setSelectedMovie] = useState<MukakuMovie | null>(null);
  const [selectedYa, setSelectedYa] = useState<YaLink | null>(null);

  // 待回填的名称和链接
  const [targetName, setTargetName] = useState('');
  const [targetLink, setTargetLink] = useState('');
  const [submitting, setSubmitting] = useState(false);

  // 打开弹窗时初始化状态
  useEffect(() => {
    if (open && resource) {
      const cleanKw = extractSearchKeyword(resource.name);
      setKeyword(cleanKw);
      setTargetName(cleanKw || resource.name);
      setTargetLink(resource.link || '');
      setSelectedMovie(null);
      setSelectedYa(null);
      setMukakuMovies([]);
      setYaLinks([]);
      setHasSearched(false);
      setErrorMsg(null);

      // 如果有默认关键词，自动触发一次搜索
      if (cleanKw) {
        doSearch(cleanKw, 'mukaku');
      }
    }
  }, [open, resource]);

  async function doSearch(kwToSearch: string, source: 'mukaku' | 'ya') {
    const q = kwToSearch.trim();
    if (!q) {
      toast.error('请输入片源名称进行搜索');
      return;
    }
    setSearching(true);
    setErrorMsg(null);
    setHasSearched(true);
    setSelectedMovie(null);
    setSelectedYa(null);

    try {
      if (source === 'mukaku') {
        const list = await searchMukakuMovies(q);
        setMukakuMovies(list);
        if (list.length === 0) {
          // 如果不太灵搜索无结果，可提示用户或建议切换
        }
      } else {
        const list = await searchYaVideos(q);
        setYaLinks(list);
      }
    } catch (e) {
      const err = e as Error & { code?: string };
      if (err.code === MUKAKU_TOKEN_EXPIRED_CODE) {
        setErrorMsg('不太灵站点登录态已失效，请先到「站点同步」页重新登录绑定');
      } else if (err.code === YA_EXPIRED_CODE) {
        setErrorMsg('鸭影臻藏站点登录已过期，请先到「站点同步」页更新凭证');
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

  function handleSelectMukaku(m: MukakuMovie) {
    setSelectedMovie(m);
    setSelectedYa(null);
    // 自动将片源名称填入
    setTargetName(m.title);
    // 保持已有链接或提示填写
    if (!targetLink && resource?.link) {
      setTargetLink(resource.link);
    }
  }

  function handleSelectYa(y: YaLink) {
    setSelectedYa(y);
    setSelectedMovie(null);
    if (y.video_title) {
      setTargetName(y.video_title);
    }
    if (y.url) {
      const fullUrl = y.extract_code ? `${y.url}?pwd=${y.extract_code}` : y.url;
      setTargetLink(fullUrl);
    }
  }

  async function handleConfirm() {
    if (!resource) return;
    const finalName = targetName.trim();
    if (!finalName) {
      toast.error('请确认或填写片源名称');
      return;
    }

    setSubmitting(true);
    try {
      await onBoundAndFilled(resource.id, finalName, targetLink.trim(), selectedMovie);
      toast.success('快捷绑定成功，已自动更新资源名称与链接！');
      onOpenChange(false);
    } catch (e) {
      toast.error('保存失败：' + ((e as Error).message || '请重试'));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[calc(100%-2rem)] md:max-w-2xl bg-card border-border max-h-[90vh] flex flex-col p-4 md:p-6 overflow-hidden">
        <DialogHeader className="shrink-0 pb-2">
          <DialogTitle className="flex items-center gap-2 text-base md:text-lg">
            <span className="p-1 rounded bg-primary/10 text-primary">
              <Sparkles className="h-4 w-4" />
            </span>
            快捷绑定片源
            {resource && (
              <Badge variant="outline" className="text-xs font-normal text-muted-foreground truncate max-w-[200px]">
                当前：{resource.name}
              </Badge>
            )}
          </DialogTitle>
          <DialogDescription className="text-xs text-muted-foreground">
            搜索站点片库中的剧集/电影资源，选中后将自动回填资源名称与网盘链接并保存。
          </DialogDescription>
        </DialogHeader>

        {/* 顶部搜索操作栏 */}
        <div className="shrink-0 space-y-2 py-1">
          <form onSubmit={handleSearchSubmit} className="flex items-center gap-2">
            <div className="relative flex-1 min-w-0">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
              <Input
                id={searchInputId}
                value={keyword}
                onChange={(e) => setKeyword(e.target.value)}
                placeholder="输入要搜索的片源名称（如：庆余年、凡人修仙传）…"
                className="pl-8 h-9 text-xs md:text-sm bg-input border-border focus-visible:ring-primary/40"
              />
            </div>

            {/* 站点选择小切换器 */}
            <div className="flex items-center rounded-md border border-border bg-muted p-0.5 shrink-0">
              <button
                type="button"
                onClick={() => {
                  setSiteSource('mukaku');
                  if (keyword.trim()) doSearch(keyword, 'mukaku');
                }}
                className={`px-2.5 py-1 text-xs rounded transition-colors ${
                  siteSource === 'mukaku'
                    ? 'bg-background font-medium text-foreground shadow-sm'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                不太灵片库
              </button>
              <button
                type="button"
                onClick={() => {
                  setSiteSource('ya');
                  if (keyword.trim()) doSearch(keyword, 'ya');
                }}
                className={`px-2.5 py-1 text-xs rounded transition-colors ${
                  siteSource === 'ya'
                    ? 'bg-background font-medium text-foreground shadow-sm'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                鸭影片库
              </button>
            </div>

            <Button type="submit" disabled={searching} className="h-9 px-3.5 text-xs shrink-0 gap-1.5">
              {searching ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Search className="h-3.5 w-3.5" />}
              搜索
            </Button>
          </form>
        </div>

        {/* 错误提示 */}
        {errorMsg && (
          <div className="shrink-0 flex items-start gap-2 p-2.5 rounded-md bg-destructive/10 border border-destructive/20 text-xs text-destructive">
            <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
            <span className="flex-1">{errorMsg}</span>
          </div>
        )}

        {/* 搜索结果滚动展示区 */}
        <div className="flex-1 min-h-0 overflow-y-auto py-2 pr-1 space-y-2">
          {searching ? (
            <div className="flex flex-col items-center justify-center py-16 text-xs text-muted-foreground gap-2">
              <Loader2 className="h-6 w-6 animate-spin text-primary" />
              <span>正在站内检索片库资源，请稍候…</span>
            </div>
          ) : !hasSearched ? (
            <div className="flex flex-col items-center justify-center py-16 text-xs text-muted-foreground gap-2 border border-dashed rounded-lg">
              <Film className="h-8 w-8 text-muted-foreground/40" />
              <span>输入片源名称后点击搜索，即可查看站点内片源封面与详细信息</span>
            </div>
          ) : siteSource === 'mukaku' ? (
            mukakuMovies.length === 0 ? (
              <div className="text-center py-12 text-xs text-muted-foreground">
                未在不太灵站点检索到匹配的片源，可尝试简化片名（如去除标点或季数）或切换至鸭影片库搜索
              </div>
            ) : (
              <div className="grid grid-cols-2 md:grid-cols-3 gap-2.5">
                {mukakuMovies.map((m) => {
                  const isSelected = selectedMovie?.id === m.id || (selectedMovie?.doub_id && selectedMovie.doub_id === m.doub_id);
                  return (
                    <div
                      key={String(m.id || m.doub_id || m.title)}
                      onClick={() => handleSelectMukaku(m)}
                      className={`relative flex flex-col rounded-lg border p-2 cursor-pointer transition-all hover:shadow-md ${
                        isSelected
                          ? 'bg-primary/10 border-primary ring-1 ring-primary/40'
                          : 'bg-card border-border hover:border-primary/40 hover:bg-muted/40'
                      }`}
                    >
                      {isSelected && (
                        <div className="absolute top-1.5 right-1.5 z-10 p-0.5 rounded-full bg-primary text-primary-foreground">
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
                              // 图片加载失败时替换为占位图标
                              (e.target as HTMLElement).style.display = 'none';
                            }}
                          />
                        ) : null}
                        <div className="absolute inset-0 flex flex-col items-center justify-center text-muted-foreground/40 pointer-events-none -z-0">
                          <Tv className="h-8 w-8" />
                        </div>
                        {m.rate ? (
                          <span className="absolute bottom-1 right-1 px-1.5 py-0.5 rounded bg-black/75 text-[11px] text-amber-300 font-semibold flex items-center gap-0.5">
                            <Star className="h-2.5 w-2.5 fill-amber-300" />
                            {m.rate}
                          </span>
                        ) : null}
                      </div>

                      {/* 片源信息 */}
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
          ) : yaLinks.length === 0 ? (
            <div className="text-center py-12 text-xs text-muted-foreground">
              未在鸭影臻藏站点检索到匹配的片源
            </div>
          ) : (
            <div className="space-y-1.5">
              {yaLinks.map((y) => {
                const isSelected = selectedYa?.id === y.id;
                return (
                  <div
                    key={String(y.id || y.url)}
                    onClick={() => handleSelectYa(y)}
                    className={`flex items-center justify-between gap-2 p-2.5 rounded-lg border cursor-pointer transition-colors ${
                      isSelected
                        ? 'bg-primary/10 border-primary'
                        : 'bg-card border-border hover:bg-muted/40'
                    }`}
                  >
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-semibold text-xs text-foreground truncate">
                          {y.video_title || y.name || '未命名片源'}
                        </span>
                        {y.drive_label && (
                          <Badge variant="outline" className="text-[10px] px-1 py-0">
                            {y.drive_label}
                          </Badge>
                        )}
                      </div>
                      <p className="text-[11px] text-muted-foreground font-mono truncate mt-0.5">
                        {y.url} {y.extract_code && `(提取码: ${y.extract_code})`}
                      </p>
                    </div>
                    {isSelected ? (
                      <CheckCircle2 className="h-4 w-4 text-primary shrink-0" />
                    ) : (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleSelectYa(y);
                        }}
                        className="h-7 text-xs px-2 text-muted-foreground hover:text-foreground"
                      >
                        选择
                      </Button>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* 选定回填确认区 */}
        <div className="shrink-0 border-t border-border pt-3 mt-1 space-y-2.5 bg-muted/20 -mx-4 md:-mx-6 px-4 md:px-6 pb-1">
          <div className="text-xs font-semibold text-foreground flex items-center justify-between">
            <span className="flex items-center gap-1.5">
              <CheckCircle2 className="h-3.5 w-3.5 text-primary" />
              自动回填信息确认
            </span>
            {selectedMovie && (
              <span className="text-[11px] text-muted-foreground font-normal">
                已选中片源：<strong className="text-foreground">{selectedMovie.title}</strong>
              </span>
            )}
            {selectedYa && (
              <span className="text-[11px] text-muted-foreground font-normal">
                已选中片源：<strong className="text-foreground">{selectedYa.video_title || selectedYa.name}</strong>
              </span>
            )}
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-2 text-xs">
            <div>
              <label htmlFor={resNameInputId} className="block text-[11px] text-muted-foreground mb-1">
                回填的资源名称：
              </label>
              <Input
                id={resNameInputId}
                value={targetName}
                onChange={(e) => setTargetName(e.target.value)}
                placeholder="片源名称"
                className="h-8 text-xs bg-input border-border"
              />
            </div>
            <div>
              <label htmlFor={panLinkInputId} className="block text-[11px] text-muted-foreground mb-1">
                回填的网盘链接：
              </label>
              <div className="relative">
                <LinkIcon className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
                <Input
                  id={panLinkInputId}
                  value={targetLink}
                  onChange={(e) => setTargetLink(e.target.value)}
                  placeholder="https://pan... (如已有可保留或粘贴更新)"
                  className="pl-8 h-8 text-xs bg-input border-border"
                />
              </div>
            </div>
          </div>

          <div className="flex items-center justify-end gap-2 pt-1">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => onOpenChange(false)}
              className="h-8 text-xs px-3"
            >
              取消
            </Button>
            <Button
              type="button"
              size="sm"
              disabled={submitting || !targetName.trim()}
              onClick={handleConfirm}
              className="h-8 text-xs px-4 gap-1.5"
            >
              {submitting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CheckCircle2 className="h-3.5 w-3.5" />}
              确定并回填
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
