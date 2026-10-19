import React, { useState } from 'react';
import { Check, ImagePlus, Link2, Loader2, Sparkles, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Resource } from '@/types/index';

/**
 * 手机端资源卡片列表（仅 < md 显示，桌面端仍是表格）。
 *
 * 按设计稿排布：左侧封面海报，右侧自上而下 ——
 *   ① 操作芯片行：资源名称（固定标签）/ 快捷绑定 / 绑定 / 第 N 集 /（右）删除
 *   ② 完整资源标题（两行截断）
 *   ③ 网盘链接芯片行（失效链接标红，点击进入「管理链接」）
 *
 * 关键：所有动作都复用桌面的同一套回调与行内编辑状态（由 ResourceTable 传入），
 * 不在这里另写一份保存逻辑，避免两端行为不一致。
 */
interface ResourceCardListProps {
  resources: Resource[];
  readOnly: boolean;
  /** 触屏设备：标题需双击才进编辑（防止滚动误触），与桌面表格的判定保持一致 */
  isTouchDevice: boolean;
  brokenCovers: Record<string, boolean>;
  onCoverBroken: (id: string) => void;
  onCoverClick: (id: string) => void;
  onRemoveCover: (resource: Resource) => void;
  uploadingId: string | null;
  uploadProgress: number;
  deletingId: string | null;
  onDelete: (id: string) => void;
  onQuickBind: (resource: Resource) => void;
  onBind: (resource: Resource) => void;
  onManageLinks: (resource: Resource) => void;
  /** 行内编辑：与桌面表格共用 ResourceTable 的 editState / saveEdit */
  editState: { rowId: string; field: string; value: string } | null;
  onStartEdit: (resource: Resource, field: 'name' | 'episode_count') => void;
  onEditValueChange: (value: string) => void;
  onSaveEdit: () => void;
  onCancelEdit: () => void;
  inputRef: React.Ref<HTMLInputElement>;
  onEditKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => void;
}

/** 取该资源的网盘链接（多盘优先，回退到单链接字段） */
function panLinksOf(resource: Resource): Array<{ url: string; pan_name?: string; status?: string }> {
  if (Array.isArray(resource.links) && resource.links.length > 0) return resource.links;
  return resource.link?.trim() ? [{ url: resource.link, pan_name: '' }] : [];
}

export default function ResourceCardList({
  resources,
  readOnly,
  isTouchDevice,
  brokenCovers,
  onCoverBroken,
  onCoverClick,
  onRemoveCover,
  uploadingId,
  uploadProgress,
  deletingId,
  onDelete,
  onQuickBind,
  onBind,
  onManageLinks,
  editState,
  onStartEdit,
  onEditValueChange,
  onSaveEdit,
  onCancelEdit,
  inputRef,
  onEditKeyDown,
}: ResourceCardListProps) {
  /** 点封面才浮出「更换 / 删除」（设计稿封面本身是干净海报，不放常显按钮） */
  const [coverMenuId, setCoverMenuId] = useState<string | null>(null);

  if (resources.length === 0) {
    return (
      <div className="px-4 py-12 text-center text-xs text-muted-foreground md:hidden">
        没有匹配的资源
      </div>
    );
  }

  return (
    <div className="md:hidden">
      {resources.map((resource) => {
        const editingName = editState?.rowId === resource.id && editState?.field === 'name';
        const editingEpisode = editState?.rowId === resource.id && editState?.field === 'episode_count';
        const panLinks = panLinksOf(resource);
        const coverBroken = brokenCovers[resource.id];
        const uploading = uploadingId === resource.id;

        return (
          <div
            key={resource.id}
            className="border-b border-border/70 bg-card px-2 py-2.5 last:border-b-0"
          >
            <div className="flex gap-2">
              {/* ① 封面海报 */}
              <div className="relative h-24 w-16 shrink-0 overflow-hidden rounded-lg bg-muted md:h-24">
                {uploading ? (
                  <div className="flex h-full w-full flex-col items-center justify-center gap-1">
                    <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />
                    <span className="text-[9px] text-primary">{uploadProgress}%</span>
                  </div>
                ) : resource.cover_url && !coverBroken ? (
                  <>
                    <img
                      src={resource.cover_url}
                      alt="封面"
                      referrerPolicy="no-referrer"
                      className="h-full w-full object-cover"
                      onError={() => onCoverBroken(resource.id)}
                    />
                    {/* 触屏没有 hover：点封面浮出操作（再点一次收起），默认保持干净海报 */}
                    <button
                      type="button"
                      aria-label="封面操作"
                      onClick={() => setCoverMenuId((cur) => (cur === resource.id ? null : resource.id))}
                      className="absolute inset-0"
                    />
                    {coverMenuId === resource.id && (
                      <div className="absolute inset-x-0 bottom-0 flex justify-center gap-1 bg-black/60 py-1">
                        <button
                          type="button"
                          onClick={() => { setCoverMenuId(null); onCoverClick(resource.id); }}
                          className="rounded px-1.5 py-0.5 text-[9px] leading-none text-white active:bg-white/25"
                        >
                          更换
                        </button>
                        <button
                          type="button"
                          onClick={() => { setCoverMenuId(null); onRemoveCover(resource); }}
                          className="rounded px-1.5 py-0.5 text-[9px] leading-none text-red-300 active:bg-red-500/25"
                        >
                          删除
                        </button>
                      </div>
                    )}
                  </>
                ) : (
                  <button
                    type="button"
                    disabled={readOnly}
                    onClick={() => onCoverClick(resource.id)}
                    className="flex h-full w-full flex-col items-center justify-center gap-1 border border-dashed border-border text-muted-foreground"
                  >
                    <ImagePlus className="h-4 w-4" />
                    <span className="text-[9px] leading-tight">{coverBroken ? '封面失效' : '添加封面'}</span>
                  </button>
                )}
              </div>

              {/* ② 右侧内容 */}
              <div className="min-w-0 flex-1">
                {/* 操作芯片行：资源名称（**固定分类标签**，设计稿语义）/ 快捷绑定 / 绑定 / 集数（可编辑）/ 删除
                    注意：这里不显示具体剧名 —— 改名字请双击（触屏）/单击（PC）下方的资源标题（见 ③） */}
                {/* 芯片行：四颗芯片 + 删除键**自适应平分**整行宽度（flex-1 + 居中），
                    内边距与字号压到最小 → 一行放得下，不折行、不横滑、不截断 */}
                <div className="flex w-full items-center gap-1">
                  <span className="inline-flex min-w-0 flex-1 items-center justify-center overflow-hidden whitespace-nowrap rounded-full border border-primary/30 bg-primary/10 px-0.5 py-0.5 text-[9px] font-medium leading-3.5 text-primary">
                    资源名称
                  </span>

                  <button
                    type="button"
                    disabled={readOnly}
                    onClick={() => onQuickBind(resource)}
                    className="inline-flex min-w-0 flex-1 items-center justify-center gap-0.5 overflow-hidden whitespace-nowrap rounded-full border border-primary/30 px-0.5 py-0.5 text-[9px] leading-3.5 text-primary active:bg-primary/10"
                  >
                    <Sparkles className="h-2.5 w-2.5 shrink-0" />快捷绑定
                  </button>

                  <button
                    type="button"
                    disabled={readOnly}
                    onClick={() => onBind(resource)}
                    className="inline-flex min-w-0 flex-1 items-center justify-center gap-0.5 overflow-hidden whitespace-nowrap rounded-full border border-border px-0.5 py-0.5 text-[9px] leading-3.5 text-muted-foreground active:bg-muted"
                  >
                    <Link2 className="h-2.5 w-2.5 shrink-0" />绑定
                  </button>

                  {editingEpisode ? (
                    <Input
                      ref={inputRef}
                      value={editState?.value ?? ''}
                      inputMode="numeric"
                      onChange={(e) => onEditValueChange(e.target.value)}
                      onKeyDown={onEditKeyDown}
                      onBlur={onSaveEdit}
                      className="h-7 w-20 shrink-0 px-2 text-base md:text-xs bg-input border-primary/50"
                    />
                  ) : (
                    <button
                      type="button"
                      disabled={readOnly}
                      onClick={() => onStartEdit(resource, 'episode_count')}
                      title="点击修改集数"
                      className="min-w-0 flex-1 overflow-hidden whitespace-nowrap rounded-full border border-primary/25 bg-primary/10 px-0.5 py-0.5 text-center text-[9px] leading-3.5 text-primary active:bg-primary/15"
                    >
                      第{resource.episode_count ?? 0}集
                    </button>
                  )}

                  <button
                    type="button"
                    disabled={readOnly || deletingId === resource.id}
                    onClick={() => onDelete(resource.id)}
                    title="删除资源"
                    className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-muted-foreground active:bg-destructive/10 active:text-destructive"
                  >
                    {deletingId === resource.id
                      ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      : <Trash2 className="h-3.5 w-3.5" />}
                  </button>
                </div>

                {/* ③ 完整标题（最多两行）：触屏双击 / 桌面单击进入行内编辑，
                    复用桌面表格同一套 editState / saveEdit，不另写一份保存逻辑。
                    touch-manipulation 关掉「双击缩放」，否则手机上双击会被浏览器当成缩放、
                    根本不会触发 dblclick */}
                {editingName ? (
                  <Input
                    ref={inputRef}
                    value={editState?.value ?? ''}
                    onChange={(e) => onEditValueChange(e.target.value)}
                    onKeyDown={onEditKeyDown}
                    onBlur={onSaveEdit}
                    className="mt-1.5 h-8 text-[13px] bg-input border-primary/50"
                  />
                ) : (
                  <p
                    onClick={isTouchDevice ? undefined : () => onStartEdit(resource, 'name')}
                    onDoubleClick={isTouchDevice ? () => onStartEdit(resource, 'name') : undefined}
                    title={isTouchDevice ? '双击编辑名称' : '点击编辑名称'}
                    className="mt-1.5 line-clamp-2 touch-manipulation text-[13px] font-medium leading-snug text-foreground"
                  >
                    {resource.name || '未命名资源'}
                  </p>
                )}

                {/* ④ 网盘链接芯片（点击进入管理链接） */}
                <div className="mt-1.5 flex flex-wrap items-center gap-x-1 gap-y-1">
                  {panLinks.length > 0 ? (
                    panLinks.map((l, i) => (
                      <button
                        key={i}
                        type="button"
                        disabled={readOnly}
                        onClick={() => onManageLinks(resource)}
                        className={`inline-flex shrink-0 items-center whitespace-nowrap rounded-full px-1 py-0.5 text-[9px] leading-3.5 ${
                          l.status === 'invalid'
                            ? 'bg-destructive/15 text-destructive'
                            : 'bg-muted text-muted-foreground'
                        }`}
                      >
                        {l.pan_name || '链接'}
                      </button>
                    ))
                  ) : (
                    <button
                      type="button"
                      disabled={readOnly}
                      onClick={() => onManageLinks(resource)}
                      className="text-[10px] italic text-muted-foreground/60"
                    >
                      点击添加链接
                    </button>
                  )}
                </div>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
