import React, { useState } from 'react';
import { Copy, Trash2, CheckCheck, AlertCircle, ImagePlus, Download, AlertTriangle, Loader2, CheckSquare, Square, History } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { toast } from 'sonner';
import { UpdatedItem, DisplayFormat } from '@/types/index';
import { formatResource, filterLinksByFormat } from '@/lib/format';
import { copyCardsToClipboard, generateCardImage } from '@/lib/clipboardUtils';
import { resolveLinks } from '@/lib/panUtils';

interface UpdatedPanelProps {
  items: UpdatedItem[];
  format: DisplayFormat;
  onClear: () => void;
  onFormatChange: (f: DisplayFormat) => void;
  dayOffset: number;
  onDayOffsetChange: (offset: number) => void;
  /** 打开「查看历史」弹窗（按钮放在日期切换行，紧跟「前天」之后） */
  onOpenHistory?: () => void;
  loading?: boolean;
}

const DAY_OPTIONS: Array<{ offset: number; label: string }> = [
  { offset: 0, label: '今天' },
  { offset: 1, label: '昨天' },
  { offset: 2, label: '前天' },
];

export default function UpdatedPanel({
  items,
  format,
  onClear,
  onFormatChange,
  dayOffset,
  onDayOffsetChange,
  onOpenHistory,
  loading = false,
}: UpdatedPanelProps) {
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const allSelected = items.length > 0 && selectedIds.size === items.length;

  function toggleSelect(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleSelectAll() {
    setSelectedIds(allSelected ? new Set() : new Set(items.map((i) => i.resource.id)));
  }

  /**
   * 复制一组资源。
   * card = false（默认）：只复制纯文字 —— 粘贴到微信 / QQ / Word 得到可编辑文本；
   * card = true：复制图文长图（封面 + 文字），适合需要封面的分享场景。
   */
  async function copyGroup(list: UpdatedItem[], label: string, card = false) {
    if (list.length === 0) {
      toast.info('请先勾选要复制的资源');
      return;
    }
    const text = list.map((item) => formatResource(item.resource, format)).join('\n\n');
    const { ok, withImage, reason } = await copyCardsToClipboard(
      list.map((item) => {
        const r = item.resource;
        const links = filterLinksByFormat(resolveLinks(r.links, r.link ?? ''), format);
        return { name: r.name, links, coverUrl: r.cover_url };
      }),
      text,
      card ? 'card' : 'text'
    );
    if (ok) {
      if (withImage) {
        toast.success(`已复制 ${list.length} 条（${label}）：封面 + 标题 + 可点击链接，可直接粘贴到 QQ / 微信`);
      } else if (!card) {
        toast.success(`已复制 ${list.length} 条为纯文字（${label}）`);
      } else if (reason === 'insecure-context') {
        toast.warning('已复制文字：当前为 HTTP 访问，浏览器禁止写入富文本到剪贴板，改用 HTTPS 访问即可带上封面与可点击链接');
      } else {
        toast.success(`已复制 ${list.length} 条（${label}）`);
      }
    } else {
      toast.error('复制失败，请手动选中文本复制');
    }
  }

  /** 复制单条：封面 + 资源信息合成为一张卡片图，粘贴到 QQ 图文俱全 */
  async function copyItem(item: UpdatedItem) {
    await copyGroup([item], '单条', true);
  }

  /** 手机端：生成卡片图片并通过 Web Share API 分享或直接下载 */
  async function shareCardItem(item: UpdatedItem) {
    const text = formatResource(item.resource, format);
    const r = item.resource;
    const links = filterLinksByFormat(resolveLinks(r.links, r.link ?? ''), format);
    const toastId = 'gen-card';
    toast.loading('生成图片中…', { id: toastId });
    try {
      const blob = await generateCardImage({ name: r.name, links, coverUrl: r.cover_url }, text);
      toast.dismiss(toastId);
      if (!blob) { toast.error('图片生成失败'); return; }
      const fileName = `${(r.name || 'resource').replace(/[/\\?%*:|"<>]/g, '_')}.png`;
      const file = new File([blob], fileName, { type: 'image/png' });
      if (typeof navigator.canShare === 'function' && navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], title: r.name || '资源卡片' });
      } else {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = fileName;
        document.body.appendChild(a); a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        toast.success('图片已保存，可发送到 QQ');
      }
    } catch (e) {
      toast.dismiss(toastId);
      if (!(e instanceof Error && e.name === 'AbortError')) toast.error('操作失败');
    }
  }

  return (
    <div className="flex flex-col h-full">
      {/* 面板标题栏 */}
      <div className="px-4 py-3 border-b border-border shrink-0">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <CheckCheck className="h-4 w-4 text-accent" />
            <span className="text-sm font-semibold text-foreground">已更新</span>
            {items.length > 0 && (
              <Badge variant="secondary" className="h-4 px-1.5 text-xs bg-primary/20 text-primary border-0">
                {items.length}
              </Badge>
            )}
            {selectedIds.size > 0 && (
              <span className="text-[10px] text-muted-foreground">已选 {selectedIds.size} 条</span>
            )}
          </div>
          <div className="flex items-center gap-1">
            {/* 云盘选择器：全部 / 光鸭 / 夸克 */}
            {(['all', 'guangya', 'quark'] as const).map((f) => {
              const labels: Record<string, string> = { all: '全部', guangya: '光鸭', quark: '夸克' };
              const active = format === f;
              return (
                <Button key={f} variant="ghost" size="sm"
                  onClick={() => onFormatChange(f)}
                  className={`h-6 px-2 text-xs ${active ? 'bg-primary/15 text-primary font-medium' : 'text-muted-foreground hover:text-foreground hover:bg-muted'}`}>
                  {labels[f]}
                </Button>
              );
            })}
            <Button variant="ghost" size="sm"
              className="h-6 px-2 text-xs text-muted-foreground hover:text-foreground hover:bg-muted gap-1"
              onClick={toggleSelectAll}
              disabled={items.length === 0}
              title="全选/取消全选">
              {allSelected ? <CheckSquare className="h-3 w-3" /> : <Square className="h-3 w-3" />}
              {allSelected ? '取消' : '全选'}
            </Button>
          </div>
        </div>
        {/* 日期切换：今天 / 昨天 / 前天 */}
        <div className="flex items-center gap-1 mt-2">
          {DAY_OPTIONS.map((opt) => {
            const active = dayOffset === opt.offset;
            return (
              <Button
                key={opt.offset}
                variant={active ? 'default' : 'ghost'}
                size="sm"
                onClick={() => onDayOffsetChange(opt.offset)}
                className={`h-6 px-2.5 text-xs gap-1 ${
                  active
                    ? 'bg-primary text-primary-foreground hover:bg-primary/90'
                    : 'text-muted-foreground hover:text-foreground hover:bg-muted'
                }`}
              >
                {opt.label}
              </Button>
            );
          })}
          {/* 查看历史：从左侧工具栏移到这里，紧跟「前天」之后 */}
          {onOpenHistory && (
            <Button
              variant="ghost"
              size="sm"
              onClick={onOpenHistory}
              title="查看资源修改历史"
              className="h-6 px-2 text-xs gap-1 text-muted-foreground hover:text-foreground hover:bg-muted shrink-0"
            >
              <History className="h-3 w-3" />
              查看历史
            </Button>
          )}
          {loading && <Loader2 className="h-3 w-3 animate-spin text-muted-foreground ml-1" />}
        </div>
      </div>

      {/* 操作栏 */}
      {items.length > 0 && (
        <div className="flex items-center justify-between px-4 py-2 border-b border-border/50 shrink-0 bg-muted/20">
          <div className="flex items-center gap-1">
            <Button variant="ghost" size="sm" onClick={() => copyGroup(items, '全部', true)}
              title="复制为卡片图（封面 + 资源名 + 网盘链接），可直接粘贴到 QQ / 微信"
              className="h-6 px-2 text-xs text-primary hover:bg-primary/10 gap-1">
              <ImagePlus className="h-3 w-3" />全部复制
            </Button>
            <Button variant="ghost" size="sm" onClick={() => copyGroup(items, '全部')}
              title="只复制纯文字，粘贴到任何地方都是可编辑文本"
              className="h-6 px-2 text-xs text-muted-foreground hover:text-primary hover:bg-primary/10 gap-1">
              <Copy className="h-3 w-3" />复制文字
            </Button>
          </div>
          <div className="flex items-center gap-1">
            <Button variant="ghost" size="sm"
              onClick={() => copyGroup(items.filter((i) => selectedIds.has(i.resource.id)), '勾选', true)}
              disabled={selectedIds.size === 0}
              className="h-6 px-2 text-xs text-muted-foreground hover:text-primary hover:bg-primary/10 gap-1 disabled:opacity-40">
              <Copy className="h-3 w-3" />复制勾选({selectedIds.size})
            </Button>
            <Button variant="ghost" size="sm" onClick={onClear}
              className="h-6 px-2 text-xs text-muted-foreground hover:text-destructive hover:bg-destructive/10 gap-1">
              <Trash2 className="h-3 w-3" />清空
            </Button>
          </div>
        </div>
      )}

      {/* 内容区 */}
      <div className="flex-1 min-h-0 overflow-y-auto">
        {items.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full gap-3 text-center px-6">
            <AlertCircle className="h-8 w-8 text-muted-foreground/30" />
            <p className="text-xs text-muted-foreground leading-relaxed">
              修改剧集表中的集数或其他字段后，对应资源会自动出现在这里
            </p>
          </div>
        ) : (
          <div className="p-3 space-y-2.5">
            {items.map((item, idx) => {
              const text = formatResource(item.resource, format);
              const lines = text.split('\n');
              const hasCover = !!item.resource.cover_url;
              const selected = selectedIds.has(item.resource.id);

              return (
                <div key={`${item.resource.id}-${idx}`}
                  className={`group relative rounded-lg border bg-card transition-colors overflow-hidden ${
                    selected ? 'border-primary/60 ring-1 ring-primary/30' : 'border-border/60 hover:border-primary/30'
                  }`}>

                  {hasCover ? (
                    /* === 有封面：勾选 + 图片 + 信息并排 === */
                    <div className="flex gap-0">
                      {/* 封面图：手机 w-16，桌面 w-24（放最左侧，勾选框已移到操作行末尾） */}
                      <div className="w-16 md:w-24 shrink-0 aspect-[2/3] relative overflow-hidden bg-muted">
                        <img
                          src={item.resource.cover_url!}
                          alt="封面"
                          referrerPolicy="no-referrer"
                          className="w-full h-full object-cover"
                        />
                      </div>
                      {/* 信息区：手机紧凑 p-2，桌面 p-2.5 */}
                      <div className="flex-1 min-w-0 p-2 md:p-2.5 flex flex-col justify-between">
                        <div>
                          <div className="flex items-center gap-1 mb-1.5">
                            <span className="text-[10px] text-accent font-medium leading-none">
                              {item.changedFieldLabel}已更新
                            </span>
                            <span className="text-[10px] text-muted-foreground leading-none">
                              {formatTime(item.changedAt)}
                            </span>
                          </div>
                          <p className="text-xs text-foreground font-medium leading-snug break-words line-clamp-2 md:line-clamp-4">
                            {lines[0]}
                          </p>
                        </div>
                        {lines[1] && (
                          <p className="text-[10px] text-primary truncate leading-snug mt-1.5">
                            {lines[1]}
                          </p>
                        )}
                        {/* 复制按钮 */}
                        <div className="flex items-center gap-1 mt-2">
                          <Button variant="ghost" size="sm"
                            className="h-6 px-2 text-[10px] text-muted-foreground hover:text-primary hover:bg-primary/10 gap-1 self-start"
                            onClick={() => copyItem(item)}>
                            <Copy className="h-3 w-3" />复制（含封面）
                          </Button>
                          {/* 手机端：生成卡片图分享/保存（移动端浏览器不支持 HTML clipboard） */}
                          <Button variant="ghost" size="sm"
                            className="md:hidden h-6 px-2 text-[10px] text-muted-foreground hover:text-primary hover:bg-primary/10 gap-1 self-start"
                            onClick={() => shareCardItem(item)}>
                            <Download className="h-3 w-3" />保存图片
                          </Button>
                          {/* 勾选：放在复制按钮之后，封面得以靠左更美观 */}
                          <button
                            onClick={() => toggleSelect(item.resource.id)}
                            className={`ml-auto h-6 w-6 shrink-0 flex items-center justify-center rounded-md transition-colors ${
                              selected
                                ? 'bg-primary/10 text-primary'
                                : 'text-muted-foreground/40 hover:text-primary hover:bg-primary/5'
                            }`}
                            aria-label={selected ? '取消选择' : '选择'}
                            title={selected ? '取消选择' : '选择'}
                          >
                            {selected ? <CheckSquare className="h-3.5 w-3.5" /> : <Square className="h-3.5 w-3.5" />}
                          </button>
                        </div>
                        {/* 站点同步失败提示（不纳入复制范围） */}
                        {item.syncErrors && item.syncErrors.length > 0 && (
                          <div className="mt-1.5 flex flex-col gap-0.5">
                            {item.syncErrors.map(({ site, reason }) => (
                              <div key={site} className="flex items-start gap-1 text-[10px] text-destructive leading-snug">
                                <AlertTriangle className="h-3 w-3 shrink-0 mt-0.5" />
                                <span><span className="font-medium">{site}</span> 同步失败：{reason}</span>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>
                  ) : (
                    /* === 无封面：纯文字卡片 === */
                    <div className="flex items-stretch gap-0">
                      <div className="flex-1 min-w-0 p-3 pr-8">
                      <div className="flex items-center gap-1.5 mb-2">
                        <ImagePlus className="h-3 w-3 text-muted-foreground/40" />
                        <span className="text-xs text-accent font-medium">{item.changedFieldLabel}已更新</span>
                        <span className="text-xs text-muted-foreground">{formatTime(item.changedAt)}</span>
                      </div>
                      <div className="text-xs leading-relaxed space-y-0.5 overflow-hidden">
                        {lines.map((line, i) => (
                          <p key={i} className={i === 0
                            ? 'text-foreground font-medium truncate'
                            : 'text-primary truncate'}>
                            {line}
                          </p>
                        ))}
                      </div>
                      {/* 复制按钮 */}
                      <Button variant="ghost" size="icon"
                        className="absolute top-2.5 right-2 h-6 w-6 opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground hover:text-primary hover:bg-primary/10"
                        onClick={() => copyItem(item)} title="复制此条">
                        <Copy className="h-3 w-3" />
                      </Button>
                      {/* 勾选：移到操作行末尾（与有封面的卡片保持一致） */}
                      <div className="mt-2 flex items-center justify-end">
                        <button
                          onClick={() => toggleSelect(item.resource.id)}
                          className={`h-6 w-6 shrink-0 flex items-center justify-center rounded-md transition-colors ${
                            selected
                              ? 'bg-primary/10 text-primary'
                              : 'text-muted-foreground/40 hover:text-primary hover:bg-primary/5'
                          }`}
                          aria-label={selected ? '取消选择' : '选择'}
                          title={selected ? '取消选择' : '选择'}
                        >
                          {selected ? <CheckSquare className="h-3.5 w-3.5" /> : <Square className="h-3.5 w-3.5" />}
                        </button>
                      </div>
                      {/* 站点同步失败提示（不纳入复制范围） */}
                      {item.syncErrors && item.syncErrors.length > 0 && (
                        <div className="mt-1.5 flex flex-col gap-0.5">
                          {item.syncErrors.map(({ site, reason }) => (
                            <div key={site} className="flex items-start gap-1 text-[10px] text-destructive leading-snug">
                              <AlertTriangle className="h-3 w-3 shrink-0 mt-0.5" />
                              <span><span className="font-medium">{site}</span> 同步失败：{reason}</span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function formatTime(date: Date): string {
  const now = new Date();
  const diff = now.getTime() - date.getTime();
  if (diff < 60000) return '刚刚';
  if (diff < 3600000) return `${Math.floor(diff / 60000)} 分钟前`;
  const h = date.getHours().toString().padStart(2, '0');
  const m = date.getMinutes().toString().padStart(2, '0');
  return `${h}:${m}`;
}
