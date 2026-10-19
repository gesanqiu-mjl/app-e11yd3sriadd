import React, { useState, useEffect } from 'react';
import { Layers, Wand2, Trash2, CheckCircle2, AlertTriangle, Info } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { toast } from 'sonner';
import { Resource } from '@/types/index';
import { insertResources, fetchResourceQuota, RESOURCE_QUOTA_EXCEEDED_CODE } from '@/services/api';
import { parseMultipleResources, type ParsedResource } from '@/lib/parse';

interface BatchImportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onImported: (resources: Resource[]) => void;
  maxSortOrder: number;
}

export default function BatchImportDialog({
  open,
  onOpenChange,
  onImported,
  maxSortOrder,
}: BatchImportDialogProps) {
  const [rawText, setRawText] = useState('');
  const [parsed, setParsed] = useState<ParsedResource[]>([]);
  const [submitting, setSubmitting] = useState(false);
  // 资源配额（非管理员上限，管理员为 null 表示不限制）
  const [quota, setQuota] = useState<{ isAdmin: boolean; used: number; limit: number } | null>(null);

  useEffect(() => {
    if (!open) {
      setRawText('');
      setParsed([]);
    }
  }, [open]);

  // 打开弹窗时拉取配额，提前展示剩余额度（管理员不展示）
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    fetchResourceQuota()
      .then((q) => { if (!cancelled) setQuota(q); })
      .catch(() => { if (!cancelled) setQuota(null); });
    return () => { cancelled = true; };
  }, [open]);

  /** 非管理员剩余可导入条数（管理员为 null，表示不限制） */
  const remaining = quota && !quota.isAdmin ? Math.max(quota.limit - quota.used, 0) : null;

  function handleParse() {
    if (!rawText.trim()) {
      toast.info('请先粘贴资源文本');
      return;
    }
    const result = parseMultipleResources(rawText);
    setParsed(result);
    if (result.length > 0) {
      toast.success(`已解析出 ${result.length} 条资源`);
    } else {
      toast.info('未能解析出资源，请检查格式');
    }
  }

  function updateField(index: number, field: keyof ParsedResource, value: string | number) {
    setParsed((prev) =>
      prev.map((item, i) => (i === index ? { ...item, [field]: value } : item))
    );
  }

  function removeItem(index: number) {
    setParsed((prev) => prev.filter((_, i) => i !== index));
  }

  async function handleImport() {
    const valid = parsed.filter((p) => p.name.trim() !== '');
    if (valid.length === 0) {
      toast.error('没有可导入的资源，请先解析或填写资源名称');
      return;
    }
    // 非管理员配额预检：超出剩余额度直接拦下，不发请求
    if (remaining !== null && valid.length > remaining) {
      toast.error(
        `非管理员账号最多 ${quota?.limit ?? 0} 条资源，当前已有 ${quota?.used ?? 0} 条，最多还可导入 ${remaining} 条（本次 ${valid.length} 条）`
      );
      return;
    }
    setSubmitting(true);
    try {
      const items = valid.map((p) => ({
        name: p.name.trim(),
        episode_count: Number(p.episode_count) || 0,
        link: p.links[0]?.url ?? p.link.trim(),
        links: p.links.length > 0 ? p.links : (p.link.trim() ? [{ url: p.link.trim(), pan_name: '' }] : []),
        sort_order: 0,
        // 文本解析不含封面与完结状态，统一给默认值
        cover_url: null,
        is_finished: false,
      }));
      const results = await insertResources(items);
      if (results.length > 0) {
        onImported(results);
        toast.success(`成功导入 ${results.length} 条资源`);
        setRawText('');
        setParsed([]);
        onOpenChange(false);
      }
    } catch (err) {
      const e = err as Error & { code?: string };
      toast.error(e.code === RESOURCE_QUOTA_EXCEEDED_CODE ? e.message : '导入失败，请重试');
    } finally {
      setSubmitting(false);
    }
  }

  const validCount = parsed.filter((p) => p.name.trim() !== '').length;
  const invalidCount = parsed.length - validCount;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[calc(100%-2rem)] md:max-w-2xl bg-card border-border flex flex-col max-h-[90dvh]">
        <DialogHeader className="shrink-0">
          <DialogTitle className="flex items-center gap-2 text-foreground">
            <Layers className="h-4 w-4 text-primary" />
            批量导入资源
          </DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-3 min-h-0 flex-1 overflow-hidden">
          {/* 非管理员配额提示 */}
          {remaining !== null && (
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground shrink-0">
              <Info className="h-3 w-3 shrink-0" />
              非管理员账号最多 {quota?.limit} 条资源：当前已有 {quota?.used} 条，还可导入 {remaining} 条
            </div>
          )}

          {/* 粘贴区 */}
          <div className="shrink-0 space-y-2">
            <div className="flex items-center gap-1.5">
              <Wand2 className="h-3.5 w-3.5 text-primary shrink-0" />
              <span className="text-xs text-muted-foreground">
                粘贴多行资源文本，每条资源以「链接：」行或链接结尾分隔，点击下方按钮自动解析
              </span>
            </div>
            <Textarea
              value={rawText}
              onChange={(e) => setRawText(e.target.value)}
              rows={6}
              placeholder={`示例：\n择日飞升【2026国漫】更新至 第8集 4K HDR 高码率【杜比环绕声+立体环绕声】【纯净版、不缺集】\n链接：https://www.guangyapan.com/s/1935553455604404319_aeZIFqDoqz15G-J_\n时光代理人 第三季【新番开播】 更新至 第4集 4K SDR 增强 高码率【纯净版】\n链接：https://www.guangyapan.com/s/1935571182641475590_aeZIFqDoqz15G-J_`}
              className="text-xs bg-input border-border focus-visible:ring-primary/40 resize-none font-mono"
            />
            <Button
              type="button"
              size="sm"
              onClick={handleParse}
              className="w-full h-7 text-xs gap-1.5 bg-primary text-primary-foreground hover:bg-primary/90"
            >
              <Wand2 className="h-3.5 w-3.5" />
              解析预览
            </Button>
          </div>

          {/* 解析结果列表 */}
          {parsed.length > 0 && (
            <div className="flex flex-col min-h-0 flex-1 overflow-hidden rounded-lg border border-border">
              <div className="flex items-center justify-between px-3 py-2 border-b border-border bg-muted/30 shrink-0">
                <div className="flex items-center gap-2">
                  <span className="text-xs text-muted-foreground">解析结果</span>
                  <Badge className="h-4 px-1.5 text-xs bg-primary/20 text-primary border-0 hover:bg-primary/20">
                    {validCount} 条有效
                  </Badge>
                  {invalidCount > 0 && (
                    <Badge className="h-4 px-1.5 text-xs bg-destructive/20 text-destructive border-0 hover:bg-destructive/20">
                      {invalidCount} 条待补
                    </Badge>
                  )}
                </div>
                <span className="text-xs text-muted-foreground">可逐条修改后再导入</span>
              </div>
              <div className="flex-1 min-h-0 overflow-y-auto p-2 space-y-2">
                {parsed.map((item, index) => {
                  const hasName = item.name.trim() !== '';
                  return (
                    <div
                      key={index}
                      className="rounded-md border border-border/60 bg-background p-2.5 space-y-1.5"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-1.5 min-w-0">
                          {hasName ? (
                            <CheckCircle2 className="h-3 w-3 text-accent shrink-0" />
                          ) : (
                            <AlertTriangle className="h-3 w-3 text-destructive shrink-0" />
                          )}
                          <span className="text-xs text-muted-foreground shrink-0">
                            #{index + 1}
                          </span>
                        </div>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-6 w-6 shrink-0 text-muted-foreground hover:text-destructive hover:bg-destructive/10"
                          onClick={() => removeItem(index)}
                        >
                          <Trash2 className="h-3 w-3" />
                        </Button>
                      </div>
                      <Input
                        value={item.name}
                        onChange={(e) => updateField(index, 'name', e.target.value)}
                        placeholder="资源名称（必填）"
                        className="h-7 text-xs bg-input border-border focus-visible:ring-primary/40"
                      />
                      <div className="flex gap-2">
                        <Input
                          value={item.episode_count}
                          type="number"
                          min={0}
                          onChange={(e) =>
                            updateField(index, 'episode_count', e.target.valueAsNumber || 0)
                          }
                          placeholder="集数"
                          className="h-7 text-xs bg-input border-border focus-visible:ring-primary/40 w-20 shrink-0"
                        />
                        <div className="flex-1 min-w-0 space-y-1">
                          {item.links && item.links.length > 0 ? (
                            item.links.map((l, li) => (
                              <div key={li} className="flex items-center gap-1 min-w-0">
                                {l.pan_name && (
                                  <Badge variant="secondary"
                                    className="h-4 px-1.5 text-[10px] bg-primary/10 text-primary border-0 shrink-0 whitespace-nowrap">
                                    {l.pan_name}
                                  </Badge>
                                )}
                                <span className="text-[10px] text-muted-foreground truncate">{l.url}</span>
                              </div>
                            ))
                          ) : (
                            <Input
                              value={item.link}
                              onChange={(e) => updateField(index, 'link', e.target.value)}
                              placeholder="链接"
                              className="h-7 text-xs bg-input border-border focus-visible:ring-primary/40 w-full"
                            />
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>

        {/* 底部操作 */}
        <div className="flex justify-end gap-2 shrink-0 pt-1">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => { setRawText(''); setParsed([]); onOpenChange(false); }}
            className="text-muted-foreground hover:bg-muted"
          >
            取消
          </Button>
          <Button
            type="button"
            size="sm"
            disabled={submitting || validCount === 0}
            onClick={handleImport}
            className="bg-primary text-primary-foreground hover:bg-primary/90"
          >
            {submitting ? '导入中…' : `确认导入${validCount > 0 ? `（${validCount}）` : ''}`}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}