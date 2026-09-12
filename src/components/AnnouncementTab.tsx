import React, { useEffect, useState } from 'react';
import { Megaphone, Plus, Trash2, Loader2, Eye, EyeOff, AlertCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { toast } from 'sonner';
import {
  fetchAllAnnouncements,
  createAnnouncement,
  updateAnnouncement,
  deleteAnnouncement,
  type Announcement,
} from '@/services/api';

export default function AnnouncementTab() {
  const [items, setItems] = useState<Announcement[]>([]);
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState('');

  async function load() {
    setLoading(true);
    try {
      setItems(await fetchAllAnnouncements());
    } catch (e) {
      toast.error((e as Error).message || '加载公告失败');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function handleCreate() {
    if (!draft.trim()) {
      toast.info('请输入公告内容');
      return;
    }
    setSaving(true);
    try {
      await createAnnouncement(draft);
      setDraft('');
      toast.success('公告已发布');
      await load();
    } catch (e) {
      toast.error((e as Error).message || '发布失败');
    } finally {
      setSaving(false);
    }
  }

  async function handleToggle(item: Announcement) {
    try {
      await updateAnnouncement(item.id, { is_active: !item.is_active });
      toast.success(item.is_active ? '已停用公告' : '已启用公告');
      await load();
    } catch (e) {
      toast.error((e as Error).message || '操作失败');
    }
  }

  async function handleSaveEdit() {
    if (!editingId) return;
    if (!editDraft.trim()) {
      toast.info('公告内容不能为空');
      return;
    }
    try {
      await updateAnnouncement(editingId, { content: editDraft });
      setEditingId(null);
      toast.success('公告已更新');
      await load();
    } catch (e) {
      toast.error((e as Error).message || '更新失败');
    }
  }

  async function handleDelete(id: string) {
    try {
      await deleteAnnouncement(id);
      toast.success('公告已删除');
      await load();
    } catch (e) {
      toast.error((e as Error).message || '删除失败');
    }
  }

  return (
    <div className="space-y-5">
      {/* 新增公告 */}
      <div className="rounded-xl border border-border bg-card p-4 md:p-6">
        <div className="flex items-center gap-2 mb-3">
          <Megaphone className="h-4 w-4 text-primary" />
          <h3 className="text-sm font-semibold text-foreground">发布新公告</h3>
        </div>
        <Textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="输入公告内容，将展示在网站顶部滚动条（支持多条，用分隔符自动拼接滚动）"
          className="min-h-24 resize-y mb-3 text-sm"
        />
        <Button onClick={handleCreate} disabled={saving} className="gap-1.5">
          {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
          发布公告
        </Button>
      </div>

      {/* 公告列表 */}
      <div className="rounded-xl border border-border bg-card p-4 md:p-6">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-semibold text-foreground">已有公告</h3>
          {items.length > 0 && (
            <Badge variant="secondary" className="text-xs">
              共 {items.length} 条
            </Badge>
          )}
        </div>

        {loading ? (
          <div className="flex items-center justify-center py-10">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : items.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-10 gap-2 text-center">
            <AlertCircle className="h-7 w-7 text-muted-foreground/30" />
            <p className="text-xs text-muted-foreground">暂无公告，发布后将在网站顶部滚动展示</p>
          </div>
        ) : (
          <div className="space-y-2.5">
            {items.map((item) => (
              <div
                key={item.id}
                className={`rounded-lg border p-3 transition-colors ${
                  item.is_active ? 'border-border bg-background' : 'border-border/50 bg-muted/30 opacity-70'
                }`}
              >
                {editingId === item.id ? (
                  <div className="space-y-2">
                    <Textarea
                      value={editDraft}
                      onChange={(e) => setEditDraft(e.target.value)}
                      className="min-h-20 text-sm resize-y"
                    />
                    <div className="flex items-center gap-2">
                      <Button size="sm" onClick={handleSaveEdit} className="gap-1">
                        保存
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setEditingId(null)}>
                        取消
                      </Button>
                    </div>
                  </div>
                ) : (
                  <div className="flex items-start gap-3">
                    <div className="flex-1 min-w-0">
                      <p className="text-sm text-foreground leading-relaxed break-words whitespace-pre-wrap">
                        {item.content}
                      </p>
                      <div className="flex items-center gap-2 mt-1.5">
                        <Badge
                          variant="secondary"
                          className={`text-[10px] h-4 px-1.5 border-0 ${
                            item.is_active ? 'bg-primary/15 text-primary' : 'bg-muted text-muted-foreground'
                          }`}
                        >
                          {item.is_active ? '展示中' : '已停用'}
                        </Badge>
                        <span className="text-[10px] text-muted-foreground">
                          {new Date(item.created_at).toLocaleString('zh-CN')}
                        </span>
                      </div>
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 px-2 text-xs text-muted-foreground hover:text-foreground gap-1"
                        onClick={() => {
                          setEditingId(item.id);
                          setEditDraft(item.content);
                        }}
                      >
                        编辑
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 px-2 text-xs text-muted-foreground hover:text-primary gap-1"
                        onClick={() => handleToggle(item)}
                      >
                        {item.is_active ? <EyeOff className="h-3 w-3" /> : <Eye className="h-3 w-3" />}
                        {item.is_active ? '停用' : '启用'}
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 px-2 text-xs text-muted-foreground hover:text-destructive gap-1"
                        onClick={() => handleDelete(item.id)}
                      >
                        <Trash2 className="h-3 w-3" />
                        删除
                      </Button>
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