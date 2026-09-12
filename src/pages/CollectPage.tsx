import React, { useState } from 'react';
import { Film, Tv, Clapperboard, Link2, CheckCircle2, Send, ChevronDown, Info } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { toast } from 'sonner';
import { supabase } from '@/db/supabase';
import PageMeta from '@/components/common/PageMeta';

interface FormState {
  title: string;
  category: string;
  episode_count: string;
  link_url: string;
  extract_code: string;
  submitter_name: string;
  remark: string;
}

const CATEGORY_OPTIONS = [
  { value: 'anime', label: '动漫', icon: <Clapperboard className="h-4 w-4" /> },
  { value: 'series', label: '剧集', icon: <Tv className="h-4 w-4" /> },
  { value: 'movie', label: '电影', icon: <Film className="h-4 w-4" /> },
];

const EMPTY: FormState = {
  title: '',
  category: '',
  episode_count: '',
  link_url: '',
  extract_code: '',
  submitter_name: '',
  remark: '',
};

export default function CollectPage() {
  const [form, setForm] = useState<FormState>(EMPTY);
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);

  function setField(key: keyof FormState, value: string) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!form.title.trim()) {
      toast.error('请填写资源名称');
      return;
    }
    setSubmitting(true);
    try {
      const { error } = await supabase.from('resource_submissions').insert({
        title: form.title.trim(),
        category: form.category || null,
        episode_count: form.episode_count ? parseInt(form.episode_count) : null,
        link_url: form.link_url.trim() || null,
        extract_code: form.extract_code.trim() || null,
        submitter_name: form.submitter_name.trim() || null,
        remark: form.remark.trim() || null,
      });
      if (error) throw error;
      setSubmitted(true);
    } catch (e) {
      toast.error('提交失败，请稍后重试');
      console.error(e);
    } finally {
      setSubmitting(false);
    }
  }

  function handleAgain() {
    setForm(EMPTY);
    setSubmitted(false);
    setShowAdvanced(false);
  }

  /* ── 成功页 ── */
  if (submitted) {
    return (
      <div className="min-h-screen bg-background flex flex-col items-center justify-center px-6 py-12">
        <PageMeta
          title="资源收集提交 - 影视动漫网盘片源投稿入口"
          description="影视与动漫资源收集投稿页面，支持提交片名、分类、集数与网盘链接等资源信息。"
          keywords="资源收集, 片源投稿, 网盘分享, 动漫剧集, 资源提交"
        />
        <div className="w-full max-w-sm text-center space-y-6">
          <div className="mx-auto w-16 h-16 rounded-full bg-secondary/15 flex items-center justify-center">
            <CheckCircle2 className="h-8 w-8 text-secondary" />
          </div>
          <div className="space-y-2">
            <h2 className="text-lg font-semibold text-foreground">提交成功</h2>
            <p className="text-sm text-muted-foreground leading-relaxed">
              感谢你的贡献！管理员审核通过后将会添加到资源库中。
            </p>
          </div>
          <div className="rounded-xl border border-border bg-card p-4 text-left space-y-2">
            <p className="text-xs text-muted-foreground font-medium">提交内容</p>
            <p className="text-sm font-semibold text-foreground break-words">{form.title}</p>
            <div className="flex flex-wrap gap-2">
              {form.category && (
                <Badge variant="secondary" className="text-xs">
                  {CATEGORY_OPTIONS.find((c) => c.value === form.category)?.label ?? form.category}
                </Badge>
              )}
              {form.episode_count && (
                <Badge variant="outline" className="text-xs border-border text-muted-foreground">
                  第 {form.episode_count} 集
                </Badge>
              )}
            </div>
            {form.link_url && (
              <p className="text-xs text-muted-foreground flex items-center gap-1 truncate">
                <Link2 className="h-3 w-3 shrink-0" />
                <span className="truncate">{form.link_url}</span>
              </p>
            )}
          </div>
          <Button onClick={handleAgain} className="w-full h-11">
            继续提交
          </Button>
        </div>
      </div>
    );
  }

  /* ── 表单页 ── */
  return (
    <div className="min-h-screen bg-background">
      <PageMeta
        title="资源收集提交 - 影视动漫网盘片源投稿入口"
        description="影视与动漫资源收集投稿页面，支持提交片名、分类、集数与网盘链接等资源信息。"
        keywords="资源收集, 片源投稿, 网盘分享, 动漫剧集, 资源提交"
      />
      {/* 顶部装饰 */}
      <div className="bg-primary/5 border-b border-border/50">
        <div className="max-w-sm mx-auto px-6 py-6 flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center shrink-0">
            <Film className="h-5 w-5 text-primary" />
          </div>
          <div className="min-w-0">
            <h1 className="text-base font-bold text-foreground">资源收集</h1>
            <p className="text-xs text-muted-foreground mt-0.5 truncate">
              提交动漫、剧集或电影的网盘资源链接
            </p>
          </div>
        </div>
      </div>

      {/* 表单区 */}
      <form onSubmit={handleSubmit} className="max-w-sm mx-auto px-6 py-6 space-y-5">

        {/* 资源名称 */}
        <div className="space-y-1.5">
          <label className="text-sm font-medium text-foreground">
            资源名称 <span className="text-destructive">*</span>
          </label>
          <Input
            value={form.title}
            onChange={(e) => setField('title', e.target.value)}
            placeholder="如：完美世界、凡人修仙传"
            className="h-11 bg-card border-border text-sm"
            maxLength={120}
          />
        </div>

        {/* 分类 + 集数 */}
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <label className="text-sm font-medium text-foreground">分类</label>
            <Select value={form.category} onValueChange={(v) => setField('category', v)}>
              <SelectTrigger className="h-11 bg-card border-border text-sm">
                <SelectValue placeholder="选择分类" />
              </SelectTrigger>
              <SelectContent>
                {CATEGORY_OPTIONS.map((opt) => (
                  <SelectItem key={opt.value} value={opt.value}>
                    <span className="flex items-center gap-1.5">
                      {opt.icon}{opt.label}
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <label className="text-sm font-medium text-foreground">更新集数</label>
            <Input
              value={form.episode_count}
              onChange={(e) => setField('episode_count', e.target.value.replace(/\D/g, ''))}
              placeholder="如：168"
              className="h-11 bg-card border-border text-sm"
              inputMode="numeric"
              maxLength={6}
            />
          </div>
        </div>

        {/* 网盘链接 */}
        <div className="space-y-1.5">
          <label className="text-sm font-medium text-foreground">网盘链接</label>
          <Input
            value={form.link_url}
            onChange={(e) => setField('link_url', e.target.value)}
            placeholder="https://pan.quark.cn/s/…"
            className="h-11 bg-card border-border text-sm"
            inputMode="url"
          />
        </div>

        {/* 提取码 */}
        <div className="space-y-1.5">
          <label className="text-sm font-medium text-foreground">提取码</label>
          <Input
            value={form.extract_code}
            onChange={(e) => setField('extract_code', e.target.value)}
            placeholder="无提取码可留空"
            className="h-11 bg-card border-border text-sm"
            maxLength={32}
          />
        </div>

        {/* 更多选项（折叠） */}
        <div>
          <button
            type="button"
            onClick={() => setShowAdvanced((v) => !v)}
            className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            <ChevronDown
              className={`h-3.5 w-3.5 transition-transform duration-200 ${showAdvanced ? 'rotate-180' : ''}`}
            />
            {showAdvanced ? '收起选项' : '更多选项'}
          </button>

          {showAdvanced && (
            <div className="mt-3 space-y-4 border-t border-border/50 pt-4">
              <div className="space-y-1.5">
                <label className="text-sm font-medium text-foreground">你的昵称</label>
                <Input
                  value={form.submitter_name}
                  onChange={(e) => setField('submitter_name', e.target.value)}
                  placeholder="可选，用于致谢"
                  className="h-11 bg-card border-border text-sm"
                  maxLength={40}
                />
              </div>
              <div className="space-y-1.5">
                <label className="text-sm font-medium text-foreground">备注说明</label>
                <Textarea
                  value={form.remark}
                  onChange={(e) => setField('remark', e.target.value)}
                  placeholder="补充信息，如画质、音轨等"
                  className="bg-card border-border text-sm resize-none min-h-20"
                  maxLength={200}
                />
              </div>
            </div>
          )}
        </div>

        {/* 提示 */}
        <div className="flex items-start gap-2 px-3 py-2.5 rounded-lg bg-muted/50 border border-border/50">
          <Info className="h-3.5 w-3.5 text-muted-foreground shrink-0 mt-0.5" />
          <p className="text-[11px] text-muted-foreground leading-relaxed">
            提交后由管理员审核，通过后添加到资源库。请确保链接有效且内容合规。
          </p>
        </div>

        {/* 提交按钮 */}
        <Button
          type="submit"
          disabled={submitting || !form.title.trim()}
          className="w-full h-12 text-sm font-semibold gap-2"
        >
          {submitting ? (
            <>
              <span className="h-4 w-4 border-2 border-primary-foreground/40 border-t-primary-foreground rounded-full animate-spin" />
              提交中…
            </>
          ) : (
            <>
              <Send className="h-4 w-4" />
              提交资源
            </>
          )}
        </Button>

        <p className="text-center text-[11px] text-muted-foreground pb-4">
          提交即表示你同意内容仅用于学习交流目的
        </p>
      </form>
    </div>
  );
}
