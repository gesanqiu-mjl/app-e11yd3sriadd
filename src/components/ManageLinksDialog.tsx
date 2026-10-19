import React, { useState, useEffect } from 'react';
import { Plus, Trash2, CloudIcon, Link2, Loader2 } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { toast } from 'sonner';
import { Resource } from '@/types/index';
import { type PanLink, detectPanName } from '@/lib/panUtils';
import { updateResourceField, recordChange } from '@/services/api';
import { createShortLink, shortLinkUrl } from '@/services/shortlinks';
import { FIELD_LABELS } from '@/types/index';

interface ManageLinksDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  resource: Resource | null;
  onSaved: (resource: Resource) => void;
}

export default function ManageLinksDialog({
  open,
  onOpenChange,
  resource,
  onSaved,
}: ManageLinksDialogProps) {
  const [links, setLinks] = useState<PanLink[]>([]);
  const [saving, setSaving] = useState(false);
  /** 正在生成短链的链接下标 */
  const [shorteningIdx, setShorteningIdx] = useState<number | null>(null);

  useEffect(() => {
    if (!open || !resource) return;
    // 初始化：优先 links 数组，回退旧 link 字段
    const init =
      Array.isArray(resource.links) && resource.links.length > 0
        ? resource.links
        : resource.link?.trim()
        ? [{ url: resource.link.trim(), pan_name: detectPanName(resource.link) }]
        : [];
    setLinks(init);
  }, [open, resource]);

  function addLink() {
    setLinks((prev) => [...prev, { url: '', pan_name: '' }]);
  }

  function updateUrl(idx: number, url: string) {
    setLinks((prev) =>
      prev.map((l, i) =>
        i === idx ? { url, pan_name: detectPanName(url) || l.pan_name } : l
      )
    );
  }

  function updateName(idx: number, pan_name: string) {
    setLinks((prev) => prev.map((l, i) => (i === idx ? { ...l, pan_name } : l)));
  }

  function removeLink(idx: number) {
    setLinks((prev) => prev.filter((_, i) => i !== idx));
  }

  /**
   * 为这条网盘链接生成中转短链并复制。
   * 分享短链后，「短链统计」页能看到点击量 / 独立访客 / 来源渠道。
   */
  async function makeShortLink(idx: number) {
    const l = links[idx];
    const url = (l?.url ?? '').trim();
    if (!url) { toast.error('请先填写链接'); return; }
    if (!/^https?:\/\//i.test(url)) { toast.error('链接需要以 http(s):// 开头'); return; }
    setShorteningIdx(idx);
    try {
      const link = await createShortLink({
        title: resource?.name ?? url,
        targetUrl: url,
        panName: l.pan_name ?? null,
        resourceId: resource?.id ?? null,
        // 默认用「随机短码」形态：6 位，分享出去最短（要"路径与原链一致"可在短链页手动选择）
        codeMode: 'short',
      });
      const short = shortLinkUrl(link.code, link.channel);
      await navigator.clipboard.writeText(short).catch(() => undefined);
      toast.success('短链已生成并复制到剪贴板');
    } catch (e) {
      toast.error('生成短链失败：' + ((e as Error).message || ''));
    } finally {
      setShorteningIdx(null);
    }
  }

  async function handleSave() {
    if (!resource) return;
    const validLinks = links.filter((l) => l.url.trim());
    setSaving(true);
    try {
      const firstUrl = validLinks[0]?.url ?? '';
      await updateResourceField(resource.id, 'links', validLinks);
      if (firstUrl !== resource.link) {
        await updateResourceField(resource.id, 'link', firstUrl);
      }
      await recordChange({
        resource_id: resource.id,
        resource_name: resource.name,
        field_name: 'links',
        field_label: FIELD_LABELS['links'] ?? '链接',
        old_value: JSON.stringify(resource.links ?? []),
        new_value: JSON.stringify(validLinks),
      });
      const updated: Resource = { ...resource, links: validLinks, link: firstUrl };
      onSaved(updated);
      toast.success('链接已保存');
      onOpenChange(false);
    } catch {
      toast.error('保存失败，请重试');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[calc(100%-2rem)] md:max-w-lg bg-card border-border max-h-[90dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-foreground text-sm">
            <CloudIcon className="h-4 w-4 text-primary" />
            管理云盘链接
            {resource && (
              <span className="text-muted-foreground font-normal truncate max-w-48 text-xs">
                — {resource.name}
              </span>
            )}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-3">
          {links.length === 0 ? (
            <p className="text-xs text-muted-foreground text-center py-4 italic">
              暂无链接，点击「添加链接」添加云盘链接
            </p>
          ) : (
            <div className="space-y-2.5">
              {links.map((l, idx) => (
                <div key={idx} className="rounded-lg border border-border/60 bg-muted/20 p-2.5 space-y-1.5">
                  <div className="flex items-center gap-1.5">
                    <span className="text-[10px] text-muted-foreground shrink-0">#{idx + 1}</span>
                    {l.pan_name && (
                      <Badge variant="secondary"
                        className="h-4 px-1.5 text-[10px] bg-primary/10 text-primary border-0 shrink-0">
                        {l.pan_name}
                      </Badge>
                    )}
                    <Button variant="ghost" size="sm"
                      disabled={shorteningIdx === idx || !l.url.trim()}
                      onClick={() => void makeShortLink(idx)}
                      title="生成中转短链（可统计点击量与来源渠道）"
                      className="h-5 ml-auto shrink-0 gap-1 px-1.5 text-[10px] text-muted-foreground hover:text-primary hover:bg-primary/10">
                      {shorteningIdx === idx
                        ? <Loader2 className="h-3 w-3 animate-spin" />
                        : <Link2 className="h-3 w-3" />}
                      短链
                    </Button>
                    <Button variant="ghost" size="icon"
                      onClick={() => removeLink(idx)}
                      className="h-5 w-5 shrink-0 text-muted-foreground hover:text-destructive hover:bg-destructive/10">
                      <Trash2 className="h-3 w-3" />
                    </Button>
                  </div>
                  <Input
                    value={l.url}
                    onChange={(e) => updateUrl(idx, e.target.value)}
                    placeholder="https://..."
                    className="h-7 text-xs bg-input border-border focus-visible:ring-primary/40"
                  />
                  <Input
                    value={l.pan_name}
                    onChange={(e) => updateName(idx, e.target.value)}
                    placeholder="云盘名称（自动识别，可修改）"
                    className="h-6 text-[11px] bg-input border-border focus-visible:ring-primary/40"
                  />
                </div>
              ))}
            </div>
          )}

          <Button type="button" variant="ghost" size="sm"
            onClick={addLink}
            className="w-full h-7 text-xs border border-dashed border-border text-muted-foreground hover:text-primary hover:border-primary hover:bg-primary/5 gap-1">
            <Plus className="h-3 w-3" />添加链接
          </Button>
        </div>

        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="ghost" size="sm"
            onClick={() => onOpenChange(false)}
            className="text-muted-foreground hover:bg-muted">取消</Button>
          <Button type="button" size="sm" disabled={saving}
            onClick={handleSave}
            className="bg-primary text-primary-foreground hover:bg-primary/90">
            {saving ? '保存中…' : '确认保存'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
