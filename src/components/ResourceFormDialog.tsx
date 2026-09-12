import React, { useState, useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { Plus, Wand2, Trash2, CloudIcon } from 'lucide-react';
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
import {
  Form,
  FormField,
  FormItem,
  FormLabel,
  FormControl,
  FormMessage,
} from '@/components/ui/form';
import { toast } from 'sonner';
import { Resource } from '@/types/index';
import { type PanLink, detectPanName } from '@/lib/panUtils';
import { insertResource } from '@/services/api';
import { parseResourceText } from '@/lib/parse';

interface ResourceFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAdded: (resource: Resource) => void;
  maxSortOrder: number;
}

interface FormValues {
  rawText: string;
  rawLink: string;
  name: string;
  episode_count: number;
}

export default function ResourceFormDialog({
  open,
  onOpenChange,
  onAdded,
  maxSortOrder,
}: ResourceFormDialogProps) {
  const [submitting, setSubmitting] = useState(false);
  const [links, setLinks] = useState<PanLink[]>([]);

  const form = useForm<FormValues>({
    defaultValues: { rawText: '', rawLink: '', name: '', episode_count: 0 },
  });

  useEffect(() => {
    if (!open) { form.reset(); setLinks([]); }
  }, [open, form]);

  function handleParse() {
    const values = form.getValues();
    const parsed = parseResourceText(values.rawText, values.rawLink);
    form.setValue('name', parsed.name);
    form.setValue('episode_count', parsed.episode_count);
    if (parsed.links.length > 0) {
      // 合并去重
      setLinks((prev) => {
        const existing = new Set(prev.map((l) => l.url));
        const incoming = parsed.links.filter((l) => !existing.has(l.url));
        return [...prev, ...incoming];
      });
    }
    if (parsed.name || parsed.episode_count || parsed.links.length > 0) {
      toast.success(`已解析，提取到 ${parsed.links.length} 个链接`);
    } else {
      toast.info('未能解析出内容，请手动填写');
    }
  }

  function addLink() {
    setLinks((prev) => [...prev, { url: '', pan_name: '' }]);
  }

  function updateLinkUrl(idx: number, url: string) {
    setLinks((prev) => prev.map((l, i) =>
      i === idx ? { url, pan_name: detectPanName(url) || l.pan_name } : l
    ));
  }

  function updateLinkName(idx: number, pan_name: string) {
    setLinks((prev) => prev.map((l, i) => i === idx ? { ...l, pan_name } : l));
  }

  function removeLink(idx: number) {
    setLinks((prev) => prev.filter((_, i) => i !== idx));
  }

  async function onSubmit(values: FormValues) {
    if (!values.name.trim()) { form.setError('name', { message: '资源名称不能为空' }); return; }
    const validLinks = links.filter((l) => l.url.trim());
    setSubmitting(true);
    try {
      const result = await insertResource({
        name: values.name.trim(),
        episode_count: Number(values.episode_count) || 0,
        link: validLinks[0]?.url ?? '',
        links: validLinks,
        sort_order: 0,
        cover_url: null,
      });
      if (result) {
        onAdded(result);
        toast.success('资源已添加');
        form.reset();
        setLinks([]);
        onOpenChange(false);
      }
    } catch {
      toast.error('添加失败，请重试');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[calc(100%-2rem)] md:max-w-lg bg-card border-border max-h-[90dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-foreground">
            <Plus className="h-4 w-4 text-primary" />新增资源
          </DialogTitle>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-3">
            {/* 智能解析区 */}
            <div className="rounded-lg border border-primary/20 bg-primary/5 p-3 space-y-2.5">
              <div className="flex items-center gap-1.5">
                <Wand2 className="h-3.5 w-3.5 text-primary" />
                <span className="text-xs font-medium text-primary">智能解析</span>
                <span className="text-xs text-muted-foreground">粘贴文本自动提取名称/集数/多云盘链接</span>
              </div>
              <FormField control={form.control} name="rawText" render={({ field }) => (
                <FormItem>
                  <FormLabel className="text-xs text-muted-foreground">资源描述文本</FormLabel>
                  <FormControl>
                    <Textarea {...field} rows={3}
                      placeholder={"粘贴含多个云盘链接的文本，如：\n时光代理人 第4集\n光鸭云盘链接：https://...\n迅雷云盘链接：https://..."}
                      className="text-xs bg-input border-border focus-visible:ring-primary/40 resize-none" />
                  </FormControl>
                </FormItem>
              )} />
              <FormField control={form.control} name="rawLink" render={({ field }) => (
                <FormItem>
                  <FormLabel className="text-xs text-muted-foreground">额外链接（可选）</FormLabel>
                  <FormControl>
                    <Input {...field} placeholder="https://..."
                      className="h-8 text-xs bg-input border-border focus-visible:ring-primary/40" />
                  </FormControl>
                </FormItem>
              )} />
              <Button type="button" size="sm" onClick={handleParse}
                className="w-full h-7 text-xs gap-1.5 bg-primary text-primary-foreground hover:bg-primary/90">
                <Wand2 className="h-3.5 w-3.5" />自动解析并填充
              </Button>
            </div>

            {/* 解析结果 */}
            <div className="space-y-2.5">
              <span className="text-xs text-muted-foreground">解析结果（可手动修改）</span>
              <FormField control={form.control} name="name" render={({ field }) => (
                <FormItem>
                  <FormLabel className="text-xs text-muted-foreground">资源名称 *</FormLabel>
                  <FormControl>
                    <Input {...field} placeholder="资源名称"
                      className="h-8 text-sm bg-input border-border focus-visible:ring-primary/40" />
                  </FormControl>
                  <FormMessage className="text-xs" />
                </FormItem>
              )} />
              <FormField control={form.control} name="episode_count" render={({ field }) => (
                <FormItem>
                  <FormLabel className="text-xs text-muted-foreground">集数</FormLabel>
                  <FormControl>
                    <Input {...field} type="number" min={0} placeholder="0"
                      className="h-8 text-sm bg-input border-border focus-visible:ring-primary/40"
                      onChange={(e) => field.onChange(e.target.valueAsNumber || 0)} />
                  </FormControl>
                </FormItem>
              )} />

              {/* 多云盘链接 */}
              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <span className="text-xs text-muted-foreground flex items-center gap-1">
                    <CloudIcon className="h-3 w-3" />云盘链接
                    {links.length > 0 && (
                      <Badge variant="secondary" className="h-4 px-1 text-[10px] ml-1">{links.length}</Badge>
                    )}
                  </span>
                  <Button type="button" variant="ghost" size="sm"
                    onClick={addLink}
                    className="h-6 px-2 text-xs text-primary hover:bg-primary/10 gap-1">
                    <Plus className="h-3 w-3" />添加链接
                  </Button>
                </div>
                {links.length === 0 ? (
                  <p className="text-[11px] text-muted-foreground/60 italic px-1">
                    解析后自动填入，或点击「添加链接」手动添加
                  </p>
                ) : (
                  <div className="space-y-2">
                    {links.map((l, idx) => (
                      <div key={idx} className="flex gap-1.5 items-start">
                        <div className="flex-1 min-w-0 space-y-1">
                          <Input
                            value={l.url}
                            onChange={(e) => updateLinkUrl(idx, e.target.value)}
                            placeholder="https://..."
                            className="h-7 text-xs bg-input border-border focus-visible:ring-primary/40"
                          />
                          <div className="flex items-center gap-1.5">
                            {l.pan_name && (
                              <Badge variant="secondary"
                                className="h-4 px-1.5 text-[10px] bg-primary/10 text-primary border-0 shrink-0">
                                {l.pan_name}
                              </Badge>
                            )}
                            <Input
                              value={l.pan_name}
                              onChange={(e) => updateLinkName(idx, e.target.value)}
                              placeholder="云盘名称（自动识别，可修改）"
                              className="h-6 text-[11px] bg-input border-border focus-visible:ring-primary/40 flex-1"
                            />
                          </div>
                        </div>
                        <Button type="button" variant="ghost" size="icon"
                          onClick={() => removeLink(idx)}
                          className="h-7 w-7 shrink-0 text-muted-foreground hover:text-destructive hover:bg-destructive/10">
                          <Trash2 className="h-3 w-3" />
                        </Button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>

            <div className="flex justify-end gap-2 pt-1">
              <Button type="button" variant="ghost" size="sm"
                onClick={() => { form.reset(); setLinks([]); onOpenChange(false); }}
                className="text-muted-foreground hover:bg-muted">取消</Button>
              <Button type="submit" size="sm" disabled={submitting}
                className="bg-primary text-primary-foreground hover:bg-primary/90">
                {submitting ? '添加中…' : '确认添加'}
              </Button>
            </div>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
