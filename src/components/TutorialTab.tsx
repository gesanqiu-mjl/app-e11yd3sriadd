import React, { useEffect, useRef, useState } from 'react';
import {
  BookOpen, Plus, Trash2, Loader2, Eye, EyeOff, AlertCircle,
  ImagePlus, ArrowUp, ArrowDown, X,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { toast } from 'sonner';
import {
  fetchAllTutorials,
  createTutorial,
  updateTutorial,
  deleteTutorial,
} from '@/services/api';
import type { Tutorial } from '@/types/index';
import { uploadTutorialImage, deleteTutorialImage } from '@/lib/uploadTutorialImage';

interface Draft {
  title: string;
  content: string;
  images: string[];
}

const EMPTY_DRAFT: Draft = { title: '', content: '', images: [] };

/** 图片编辑器：缩略图列表 + 添加/删除（新增与编辑共用） */
function ImageEditor({
  images,
  uploading,
  progress,
  onPick,
  onRemove,
}: {
  images: string[];
  uploading: boolean;
  progress: number;
  onPick: (files: FileList) => void;
  onRemove: (url: string) => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <Label className="text-xs text-foreground">教程配图（可多张，按顺序展示）</Label>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={uploading}
          onClick={() => fileRef.current?.click()}
          className="h-7 gap-1.5 text-xs border-border text-muted-foreground hover:text-foreground"
        >
          {uploading ? <Loader2 className="h-3 w-3 animate-spin" /> : <ImagePlus className="h-3 w-3" />}
          {uploading ? `上传中 ${progress}%` : '添加图片'}
        </Button>
      </div>

      {images.length === 0 ? (
        <div className="flex h-20 items-center justify-center rounded-lg border border-dashed border-border text-[11px] text-muted-foreground">
          还没有配图，点击「添加图片」上传截图
        </div>
      ) : (
        <div className="flex flex-wrap gap-2">
          {images.map((url) => (
            <div key={url} className="group relative h-20 w-28 overflow-hidden rounded-lg border border-border bg-muted">
              <img src={url} alt="教程配图" className="h-full w-full object-cover" />
              <button
                type="button"
                onClick={() => onRemove(url)}
                title="移除这张图"
                className="absolute right-1 top-1 flex h-5 w-5 items-center justify-center rounded-full bg-black/60 text-white opacity-90 transition-opacity hover:bg-destructive"
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          ))}
        </div>
      )}

      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        multiple
        className="hidden"
        onChange={(e) => {
          if (e.target.files?.length) onPick(e.target.files);
          e.target.value = '';
        }}
      />
      <p className="text-[11px] text-muted-foreground">
        单张超过 1MB 会自动压缩为 WEBP（最长边 1600px），保证正文里的小字依然清晰
      </p>
    </div>
  );
}

export default function TutorialTab() {
  const [items, setItems] = useState<Tutorial[]>([]);
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState(0);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState<Draft>(EMPTY_DRAFT);
  const [editSaving, setEditSaving] = useState(false);
  const [editUploading, setEditUploading] = useState(false);
  const [editProgress, setEditProgress] = useState(0);
  const [reordering, setReordering] = useState(false);

  async function load() {
    setLoading(true);
    try {
      setItems(await fetchAllTutorials());
    } catch (e) {
      toast.error((e as Error).message || '加载教程失败');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  /** 多张图片串行上传，避免并发挤占带宽；失败的单张跳过不阻断其余 */
  async function handlePick(files: FileList, target: 'new' | 'edit') {
    const setBusy = target === 'new' ? setUploading : setEditUploading;
    const setPct = target === 'new' ? setProgress : setEditProgress;
    const apply = target === 'new'
      ? (url: string) => setDraft((d) => ({ ...d, images: [...d.images, url] }))
      : (url: string) => setEditDraft((d) => ({ ...d, images: [...d.images, url] }));

    setBusy(true);
    setPct(0);
    let ok = 0;
    const fails: string[] = [];
    for (const file of Array.from(files)) {
      try {
        const { url } = await uploadTutorialImage(file, setPct);
        apply(url);
        ok += 1;
      } catch (e) {
        fails.push(`${file.name}：${(e as Error).message}`);
      }
    }
    setBusy(false);
    setPct(0);
    if (ok) toast.success(`已上传 ${ok} 张图片`);
    if (fails.length) toast.error(`有 ${fails.length} 张上传失败`, { description: fails.join('\n') });
  }

  async function handleRemoveImage(url: string, target: 'new' | 'edit') {
    const drop = (d: Draft): Draft => ({ ...d, images: d.images.filter((u) => u !== url) });
    if (target === 'new') setDraft(drop);
    else setEditDraft(drop);
    try {
      await deleteTutorialImage(url);
    } catch {
      /* 图片删除失败不影响编辑，稍后可再删 */
    }
  }

  async function handleCreate() {
    if (!draft.title.trim()) {
      toast.info('请填写教程标题');
      return;
    }
    if (!draft.content.trim() && draft.images.length === 0) {
      toast.info('请填写教程正文或添加至少一张配图');
      return;
    }
    setSaving(true);
    try {
      await createTutorial({
        title: draft.title,
        content: draft.content,
        images: draft.images,
        is_active: true,
        sort_order: items.length,
      });
      setDraft(EMPTY_DRAFT);
      toast.success('教程已发布，首页即可看到');
      await load();
    } catch (e) {
      toast.error((e as Error).message || '发布失败');
    } finally {
      setSaving(false);
    }
  }

  async function handleSaveEdit() {
    if (!editingId) return;
    if (!editDraft.title.trim()) {
      toast.info('教程标题不能为空');
      return;
    }
    setEditSaving(true);
    try {
      await updateTutorial(editingId, {
        title: editDraft.title,
        content: editDraft.content,
        images: editDraft.images,
      });
      setEditingId(null);
      toast.success('教程已更新');
      await load();
    } catch (e) {
      toast.error((e as Error).message || '更新失败');
    } finally {
      setEditSaving(false);
    }
  }

  async function handleToggle(item: Tutorial) {
    try {
      await updateTutorial(item.id, { is_active: !item.is_active });
      toast.success(item.is_active ? '已停用，首页不再展示' : '已启用');
      await load();
    } catch (e) {
      toast.error((e as Error).message || '操作失败');
    }
  }

  async function handleDelete(item: Tutorial) {
    try {
      await deleteTutorial(item.id);
      // 教程自带的配图一并清掉（每张图都是独立上传的，不存在跨教程复用）
      await Promise.allSettled(item.images.map((u) => deleteTutorialImage(u)));
      toast.success('教程已删除');
      await load();
    } catch (e) {
      toast.error((e as Error).message || '删除失败');
    }
  }

  /** 上下移：交换后按新顺序整体重编号（教程条数少，直接全量写更稳） */
  async function handleMove(index: number, dir: -1 | 1) {
    const j = index + dir;
    if (j < 0 || j >= items.length) return;
    const next = [...items];
    [next[index], next[j]] = [next[j], next[index]];
    setItems(next);
    setReordering(true);
    try {
      await Promise.all(next.map((t, i) => updateTutorial(t.id, { sort_order: i })));
      toast.success('顺序已调整');
      await load();
    } catch (e) {
      toast.error((e as Error).message || '调整顺序失败');
      await load();
    } finally {
      setReordering(false);
    }
  }

  return (
    <div className="space-y-5">
      {/* 新增教程 */}
      <div className="rounded-xl border border-border bg-card p-4 md:p-6">
        <div className="mb-3 flex items-center gap-2">
          <BookOpen className="h-4 w-4 text-primary" />
          <h3 className="text-sm font-semibold text-foreground">新增图文教程</h3>
        </div>

        <div className="space-y-3">
          <div className="max-w-md space-y-1.5">
            <Label htmlFor="tutorial-title" className="text-xs text-foreground">教程标题</Label>
            <Input
              id="tutorial-title"
              value={draft.title}
              onChange={(e) => setDraft((d) => ({ ...d, title: e.target.value }))}
              placeholder="例如：如何绑定站点账号"
              className="h-9 bg-input border-border text-sm"
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="tutorial-content" className="text-xs text-foreground">教程正文</Label>
            <Textarea
              id="tutorial-content"
              value={draft.content}
              onChange={(e) => setDraft((d) => ({ ...d, content: e.target.value }))}
              placeholder={'分步骤写清楚即可，换行会原样展示。\n1. 打开「站点同步」页面\n2. 点击「绑定账号」并扫码登录'}
              className="min-h-32 resize-y text-sm"
            />
          </div>

          <ImageEditor
            images={draft.images}
            uploading={uploading}
            progress={progress}
            onPick={(files) => void handlePick(files, 'new')}
            onRemove={(url) => void handleRemoveImage(url, 'new')}
          />

          <Button onClick={() => void handleCreate()} disabled={saving} className="gap-1.5">
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
            发布教程
          </Button>
        </div>
      </div>

      {/* 教程列表 */}
      <div className="rounded-xl border border-border bg-card p-4 md:p-6">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-foreground">已有教程</h3>
          <div className="flex items-center gap-2">
            {reordering && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
            {items.length > 0 && (
              <Badge variant="secondary" className="text-xs">共 {items.length} 篇</Badge>
            )}
          </div>
        </div>

        {loading ? (
          <div className="flex items-center justify-center py-10">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : items.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 py-10 text-center">
            <AlertCircle className="h-7 w-7 text-muted-foreground/30" />
            <p className="text-xs text-muted-foreground">还没有教程，发布后会在首页「图文教程」入口展示</p>
          </div>
        ) : (
          <div className="space-y-2.5">
            {items.map((item, index) => (
              <div
                key={item.id}
                className={`rounded-lg border p-3 transition-colors ${
                  item.is_active ? 'border-border bg-background' : 'border-border/50 bg-muted/30 opacity-70'
                }`}
              >
                {editingId === item.id ? (
                  <div className="space-y-3">
                    <div className="space-y-1.5">
                      <Label className="text-xs text-foreground">标题</Label>
                      <Input
                        value={editDraft.title}
                        onChange={(e) => setEditDraft((d) => ({ ...d, title: e.target.value }))}
                        className="h-9 bg-input border-border text-sm"
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label className="text-xs text-foreground">正文</Label>
                      <Textarea
                        value={editDraft.content}
                        onChange={(e) => setEditDraft((d) => ({ ...d, content: e.target.value }))}
                        className="min-h-32 resize-y text-sm"
                      />
                    </div>
                    <ImageEditor
                      images={editDraft.images}
                      uploading={editUploading}
                      progress={editProgress}
                      onPick={(files) => void handlePick(files, 'edit')}
                      onRemove={(url) => void handleRemoveImage(url, 'edit')}
                    />
                    <div className="flex items-center gap-2">
                      <Button size="sm" disabled={editSaving} onClick={() => void handleSaveEdit()} className="gap-1">
                        {editSaving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                        保存
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setEditingId(null)}>
                        取消
                      </Button>
                    </div>
                  </div>
                ) : (
                  <div className="flex items-start gap-3">
                    {/* 配图预览 */}
                    {item.images.length > 0 && (
                      <img
                        src={item.images[0]}
                        alt=""
                        className="hidden h-14 w-20 shrink-0 rounded-md border border-border object-cover sm:block"
                      />
                    )}

                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium text-foreground break-words">{item.title}</p>
                      <p className="mt-1 line-clamp-2 text-xs text-muted-foreground whitespace-pre-wrap break-words">
                        {item.content || '（无正文，仅配图）'}
                      </p>
                      <div className="mt-1.5 flex flex-wrap items-center gap-2">
                        <Badge
                          variant="secondary"
                          className={`h-4 border-0 px-1.5 text-[10px] ${
                            item.is_active ? 'bg-primary/15 text-primary' : 'bg-muted text-muted-foreground'
                          }`}
                        >
                          {item.is_active ? '展示中' : '已停用'}
                        </Badge>
                        <span className="text-[10px] text-muted-foreground">
                          第 {index + 1} 篇 · {item.images.length} 张配图 ·{' '}
                          {new Date(item.updated_at).toLocaleString('zh-CN')}
                        </span>
                      </div>
                    </div>

                    <div className="flex shrink-0 flex-col items-end gap-1">
                      <div className="flex items-center gap-0.5">
                        <Button
                          variant="ghost" size="sm" disabled={index === 0 || reordering}
                          title="上移" onClick={() => void handleMove(index, -1)}
                          className="h-7 w-7 p-0 text-muted-foreground hover:text-foreground"
                        >
                          <ArrowUp className="h-3 w-3" />
                        </Button>
                        <Button
                          variant="ghost" size="sm" disabled={index === items.length - 1 || reordering}
                          title="下移" onClick={() => void handleMove(index, 1)}
                          className="h-7 w-7 p-0 text-muted-foreground hover:text-foreground"
                        >
                          <ArrowDown className="h-3 w-3" />
                        </Button>
                      </div>
                      <div className="flex items-center gap-1">
                        <Button
                          variant="ghost" size="sm"
                          className="h-7 gap-1 px-2 text-xs text-muted-foreground hover:text-foreground"
                          onClick={() => {
                            setEditingId(item.id);
                            setEditDraft({ title: item.title, content: item.content, images: [...item.images] });
                          }}
                        >
                          编辑
                        </Button>
                        <Button
                          variant="ghost" size="sm"
                          className="h-7 gap-1 px-2 text-xs text-muted-foreground hover:text-primary"
                          onClick={() => void handleToggle(item)}
                        >
                          {item.is_active ? <EyeOff className="h-3 w-3" /> : <Eye className="h-3 w-3" />}
                          {item.is_active ? '停用' : '启用'}
                        </Button>
                        <Button
                          variant="ghost" size="sm"
                          className="h-7 gap-1 px-2 text-xs text-muted-foreground hover:text-destructive"
                          onClick={() => void handleDelete(item)}
                        >
                          <Trash2 className="h-3 w-3" />
                          删除
                        </Button>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
