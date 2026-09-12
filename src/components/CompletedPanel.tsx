import React, { useState } from 'react';
import { Copy, CheckCheck, CheckSquare, Square, X, AlertCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { toast } from 'sonner';
import { Resource, DisplayFormat } from '@/types/index';
import { formatResource, filterLinksByFormat } from '@/lib/format';
import { copyCardsToClipboard } from '@/lib/clipboardUtils';
import { resolveLinks } from '@/lib/panUtils';

interface CompletedPanelProps {
  /** 全部资源（内部过滤出已完结） */
  resources: Resource[];
  /** 移除已完结标记 */
  onRemoveFinished: (resource: Resource) => void;
  /** 显示格式（与已更新面板共用） */
  format: DisplayFormat;
  onFormatChange: (f: DisplayFormat) => void;
}

export default function CompletedPanel({ resources, onRemoveFinished, format, onFormatChange }: CompletedPanelProps) {
  const finished = resources.filter((r) => r.is_finished);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const allSelected = finished.length > 0 && selectedIds.size === finished.length;

  function toggleSelect(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleSelectAll() {
    setSelectedIds(allSelected ? new Set() : new Set(finished.map((r) => r.id)));
  }

  /** 复制一组资源为图文长图 */
  async function copyGroup(list: Resource[], label: string) {
    if (list.length === 0) {
      toast.info('请先勾选要复制的资源');
      return;
    }
    const text = list.map((r) => formatResource(r, format)).join('\n\n');
    const { ok, withImage } = await copyCardsToClipboard(
      list.map((r) => ({
        name: r.name,
        links: filterLinksByFormat(resolveLinks(r.links, r.link ?? ''), format),
        coverUrl: r.cover_url,
      })),
      text
    );
    if (ok) {
      toast.success(
        withImage
          ? `已复制 ${list.length} 条为图文长图（${label}），可直接粘贴到 QQ`
          : `已复制 ${list.length} 条（${label}）`
      );
    } else {
      toast.error('复制失败，请手动选中文本复制');
    }
  }

  return (
    <div className="flex flex-col h-full">
      {/* 标题栏 */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-border shrink-0">
        <div className="flex items-center gap-2">
          <CheckCheck className="h-4 w-4 text-accent" />
          <span className="text-sm font-semibold text-foreground">已完结</span>
          {finished.length > 0 && (
            <Badge variant="secondary" className="h-4 px-1.5 text-xs bg-accent/20 text-accent border-0">
              {finished.length}
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
            disabled={finished.length === 0}
            title="全选/取消全选">
            {allSelected ? <CheckSquare className="h-3 w-3" /> : <Square className="h-3 w-3" />}
            {allSelected ? '取消' : '全选'}
          </Button>
        </div>
      </div>

      {/* 操作栏：全部复制 / 勾选复制 */}
      {finished.length > 0 && (
        <div className="flex items-center justify-between px-4 py-2 border-b border-border/50 shrink-0 bg-muted/20">
          <Button variant="ghost" size="sm" onClick={() => copyGroup(finished, '全部')}
            className="h-6 px-2 text-xs text-primary hover:bg-primary/10 gap-1">
            <Copy className="h-3 w-3" />全部复制
          </Button>
          <Button variant="ghost" size="sm" onClick={() => copyGroup(finished.filter((r) => selectedIds.has(r.id)), '勾选')}
            disabled={selectedIds.size === 0}
            className="h-6 px-2 text-xs text-muted-foreground hover:text-primary hover:bg-primary/10 gap-1 disabled:opacity-40">
            <Copy className="h-3 w-3" />复制勾选({selectedIds.size})
          </Button>
        </div>
      )}

      {/* 内容区 */}
      <div className="flex-1 min-h-0 overflow-y-auto">
        {finished.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full gap-3 text-center px-6">
            <AlertCircle className="h-8 w-8 text-muted-foreground/30" />
            <p className="text-xs text-muted-foreground leading-relaxed">
              在左侧资源列表勾选「完结」，资源会出现在这里，便于复制分享
            </p>
          </div>
        ) : (
          <div className="p-3 space-y-2.5">
            {finished.map((resource) => {
              const text = formatResource(resource, format);
              const lines = text.split('\n');
              const selected = selectedIds.has(resource.id);
              return (
                <div key={resource.id}
                  className={`group relative rounded-lg border bg-card transition-colors overflow-hidden ${
                    selected ? 'border-primary/60 ring-1 ring-primary/30' : 'border-border/60 hover:border-primary/30'
                  }`}>
                  <div className="flex items-stretch gap-0">
                    {/* 勾选区 */}
                    <button
                      onClick={() => toggleSelect(resource.id)}
                      className={`w-8 shrink-0 flex items-center justify-center transition-colors ${
                        selected ? 'bg-primary/10 text-primary' : 'text-muted-foreground/40 hover:text-primary hover:bg-primary/5'
                      }`}
                      aria-label={selected ? '取消选择' : '选择'}
                    >
                      {selected ? <CheckSquare className="h-4 w-4" /> : <Square className="h-4 w-4" />}
                    </button>
                    {/* 封面：手机 w-16，桌面 w-24 */}
                    {resource.cover_url ? (
                      <div className="w-16 md:w-24 shrink-0 aspect-[2/3] relative overflow-hidden bg-muted">
                        <img src={resource.cover_url} alt="封面" className="w-full h-full object-cover" />
                      </div>
                    ) : null}
                    {/* 信息区 */}
                    <div className="flex-1 min-w-0 p-2 md:p-2.5 flex flex-col justify-between">
                      <div>
                        <p className="text-xs text-foreground font-medium leading-snug break-words line-clamp-2 md:line-clamp-4">
                          {lines[0]}
                        </p>
                        {lines[1] && (
                          <p className="text-[10px] text-primary truncate leading-snug mt-1.5">
                            {lines[1]}
                          </p>
                        )}
                      </div>
                      <div className="flex items-center gap-1 mt-2">
                        <Button variant="ghost" size="sm"
                          className="h-6 px-2 text-[10px] text-muted-foreground hover:text-primary hover:bg-primary/10 gap-1 self-start"
                          onClick={() => copyGroup([resource], '单条')}>
                          <Copy className="h-3 w-3" />复制（含封面）
                        </Button>
                        <Button variant="ghost" size="sm"
                          className="h-6 px-2 text-[10px] text-muted-foreground hover:text-destructive hover:bg-destructive/10 gap-1 self-start"
                          onClick={() => onRemoveFinished(resource)}
                          title="移出已完结">
                          <X className="h-3 w-3" />移出
                        </Button>
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
