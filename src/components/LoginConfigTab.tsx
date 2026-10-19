import React, { useState, useEffect, useRef } from 'react';
import { Clapperboard, Loader2, Upload, Eye, Save, Image, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import { Separator } from '@/components/ui/separator';
import { Progress } from '@/components/ui/progress';
import { toast } from 'sonner';
import { getLoginConfig, saveLoginConfig } from '@/services/api';
import { LoginConfig, LOGIN_CONFIG_DEFAULTS } from '@/types/index';
import { uploadLoginAsset } from '@/lib/uploadLoginAsset';

type DraftConfig = Omit<LoginConfig, 'id' | 'updated_at'>;

export default function LoginConfigTab() {
  const [draft, setDraft] = useState<DraftConfig>(LOGIN_CONFIG_DEFAULTS);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [logoProgress, setLogoProgress] = useState(0);
  const [bgProgress, setBgProgress] = useState(0);
  const [uploadingLogo, setUploadingLogo] = useState(false);
  const [uploadingBg, setUploadingBg] = useState(false);
  const logoInputRef = useRef<HTMLInputElement>(null);
  const bgInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    getLoginConfig()
      .then((data) => {
        const { id: _id, updated_at: _at, ...rest } = data;
        setDraft(rest);
      })
      .catch(() => toast.error('加载登录页配置失败'))
      .finally(() => setLoading(false));
  }, []);

  function set<K extends keyof DraftConfig>(key: K, value: DraftConfig[K]) {
    setDraft((prev) => ({ ...prev, [key]: value }));
  }

  async function handleSave() {
    setSaving(true);
    try {
      await saveLoginConfig(draft);
      toast.success('登录页配置已保存，刷新登录页即可看到效果');
    } catch {
      toast.error('保存失败，请重试');
    } finally {
      setSaving(false);
    }
  }

  async function handleUploadLogo(file: File) {
    setUploadingLogo(true);
    setLogoProgress(0);
    try {
      const result = await uploadLoginAsset(file, 'logo', setLogoProgress);
      set('left_logo_url', result.url);
      toast.success(result.compressed
        ? `Logo 已上传（已压缩至 ${(result.finalSize / 1024).toFixed(0)} KB）`
        : 'Logo 已上传');
    } catch (e) {
      toast.error((e as Error).message || 'Logo 上传失败');
    } finally {
      setUploadingLogo(false);
    }
  }

  async function handleUploadBg(file: File) {
    setUploadingBg(true);
    setBgProgress(0);
    try {
      const result = await uploadLoginAsset(file, 'background', setBgProgress);
      set('left_bg_image_url', result.url);
      toast.success(result.compressed
        ? `背景图已上传（已压缩至 ${(result.finalSize / 1024).toFixed(0)} KB）`
        : '背景图已上传');
    } catch (e) {
      toast.error((e as Error).message || '背景图上传失败');
    } finally {
      setUploadingBg(false);
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const leftStyle: React.CSSProperties = {
    backgroundColor: draft.left_use_bg_image ? undefined : draft.left_bg_color,
    backgroundImage: draft.left_use_bg_image && draft.left_bg_image_url
      ? `url(${draft.left_bg_image_url})`
      : undefined,
    backgroundSize: 'cover',
    backgroundPosition: 'center',
  };

  return (
    <div className="flex flex-col gap-6">
      {/* 顶部操作栏 */}
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h3 className="text-sm font-semibold text-foreground">登录页配置</h3>
          <p className="text-xs text-muted-foreground mt-0.5">修改后点击保存立即生效，无需重启</p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm"
            onClick={() => window.open('/login', '_blank')}
            className="h-8 gap-1.5 border-border text-muted-foreground hover:text-foreground hover:bg-muted">
            <Eye className="h-3.5 w-3.5" />预览登录页
          </Button>
          <Button size="sm" onClick={handleSave} disabled={saving}
            className="h-8 gap-1.5 bg-primary text-primary-foreground hover:bg-primary/90">
            {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
            保存配置
          </Button>
        </div>
      </div>

      {/* 侧边栏顶部展示位 */}
      <div className="rounded-lg border border-border bg-card p-4 space-y-3">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <div>
            <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">侧边栏顶部展示位</h4>
            <p className="text-[11px] text-muted-foreground mt-0.5">
              登录后左侧功能菜单最上方显示的内容，填图片或视频地址即可（替代原来的品牌文字）
            </p>
          </div>
          <div className="flex items-center gap-1">
            {(['none', 'image', 'video'] as const).map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => set('sidebar_media_type', t)}
                className={`h-7 px-2.5 rounded-md text-xs border transition-colors ${
                  draft.sidebar_media_type === t
                    ? 'border-primary text-primary bg-primary/10 font-medium'
                    : 'border-border text-muted-foreground hover:text-foreground'
                }`}
              >
                {t === 'none' ? '不展示' : t === 'image' ? '图片' : '视频'}
              </button>
            ))}
          </div>
        </div>

        {draft.sidebar_media_type !== 'none' && (
          <>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label className="text-xs text-foreground">
                  {draft.sidebar_media_type === 'video' ? '视频地址（mp4 / webm）' : '图片地址'}
                </Label>
                <Input
                  value={draft.sidebar_media_url ?? ''}
                  onChange={(e) => set('sidebar_media_url', e.target.value || null)}
                  placeholder="https://... 或 /images/xxx.png"
                  className="h-9 bg-input border-border text-xs"
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs text-foreground">点击跳转链接（可选）</Label>
                <Input
                  value={draft.sidebar_media_link ?? ''}
                  onChange={(e) => set('sidebar_media_link', e.target.value || null)}
                  placeholder="留空则不可点击"
                  className="h-9 bg-input border-border text-xs"
                />
              </div>
            </div>

            {draft.sidebar_media_url?.trim() && (
              <div className="rounded-lg border border-border overflow-hidden bg-muted/40 p-3">
                <div className="text-[11px] text-muted-foreground mb-2">效果预览（左侧菜单宽度约 256px）</div>
                <div className="w-56 overflow-hidden rounded-xl ring-1 ring-border bg-card">
                  {draft.sidebar_media_type === 'video' ? (
                    <video
                      src={draft.sidebar_media_url.trim()}
                      className="aspect-video w-full object-cover"
                      autoPlay
                      muted
                      loop
                      playsInline
                    />
                  ) : (
                    <img
                      src={draft.sidebar_media_url.trim()}
                      alt="展示位预览"
                      className="aspect-video w-full object-cover"
                    />
                  )}
                </div>
              </div>
            )}
          </>
        )}
      </div>

      {/* 资源管理页顶部展示位 */}
      <div className="rounded-lg border border-border bg-card p-4 space-y-3">
        <div>
          <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">资源管理页顶部横幅</h4>
          <p className="text-[11px] text-muted-foreground mt-0.5">
            登录后「资源管理」页面最上方展示的横幅图片（留空则不展示，管理员会看到引导入口）
          </p>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <Label className="text-xs text-foreground">横幅图片地址</Label>
            <Input
              value={draft.home_banner_url ?? ''}
              onChange={(e) => set('home_banner_url', e.target.value || null)}
              placeholder="https://... 或 /images/banner.png"
              className="h-9 bg-input border-border text-xs"
            />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs text-foreground">点击跳转链接（可选）</Label>
            <Input
              value={draft.home_banner_link ?? ''}
              onChange={(e) => set('home_banner_link', e.target.value || null)}
              placeholder="留空则不可点击"
              className="h-9 bg-input border-border text-xs"
            />
          </div>
        </div>
        {draft.home_banner_url?.trim() && (
          <div className="rounded-lg border border-border overflow-hidden bg-muted/40 p-3">
            <div className="text-[11px] text-muted-foreground mb-2">效果预览（内容区宽度，高度贴合）</div>
            <div className="overflow-hidden rounded-xl ring-1 ring-border bg-card">
              <img src={draft.home_banner_url.trim()} alt="横幅预览" className="h-24 w-full object-cover md:h-32" />
            </div>
          </div>
        )}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* 左列：实时小预览 */}
        <div className="space-y-4">
          <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">实时预览</h4>
          <div className="rounded-lg overflow-hidden border border-border aspect-[4/3] flex shadow-sm">
            {/* 左侧预览 */}
            <div className="w-2/5 relative flex flex-col justify-between p-4" style={leftStyle}>
              {draft.left_use_bg_image && draft.left_bg_image_url && (
                <div className="absolute inset-0 bg-black/40" />
              )}
              <div className="flex items-center gap-1.5 relative z-10">
                {draft.left_logo_url
                  ? <img src={draft.left_logo_url} alt="logo" className="w-5 h-5 rounded object-cover" />
                  : <span className="flex items-center justify-center w-5 h-5 rounded bg-white/20">
                      <Clapperboard className="h-3 w-3 text-white" />
                    </span>
                }
                <span className="text-[9px] font-bold text-white truncate">{draft.left_title}</span>
              </div>
              <div className="relative z-10">
                <p className="text-[8px] font-bold text-white leading-tight line-clamp-2">{draft.left_heading}</p>
                <p className="text-[7px] text-white/70 mt-1 line-clamp-2">{draft.left_description}</p>
              </div>
              <p className="text-[6px] text-white/50 relative z-10 truncate">{draft.left_copyright}</p>
            </div>
            {/* 右侧预览 */}
            <div className="flex-1 flex flex-col justify-center p-4 bg-background">
              <p className="text-[9px] font-bold text-foreground">{draft.right_title}</p>
              <p className="text-[7px] text-muted-foreground mt-0.5 mb-3">{draft.right_subtitle}</p>
              <div className="h-3 rounded bg-muted mb-1.5 text-[0px]">用户名</div>
              <div className="h-3 rounded bg-muted mb-2 text-[0px]">密码</div>
              <div className="h-4 rounded bg-primary flex items-center justify-center">
                <span className="text-[7px] text-primary-foreground">{draft.right_btn_text}</span>
              </div>
            </div>
          </div>
        </div>

        {/* 右列：配置表单 */}
        <div className="space-y-6 overflow-y-auto max-h-[600px] pr-1">
          {/* 左侧区域 */}
          <div className="space-y-3">
            <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide flex items-center gap-1.5">
              <span className="w-2 h-2 rounded-full bg-primary inline-block" />左侧品牌区
            </h4>

            {/* Logo 上传 */}
            <div className="space-y-1.5">
              <Label className="text-xs text-foreground">Logo 图标</Label>
              <div className="flex items-center gap-2">
                {draft.left_logo_url
                  ? <img src={draft.left_logo_url} alt="logo" className="w-10 h-10 rounded-lg object-cover border border-border" />
                  : <div className="w-10 h-10 rounded-lg bg-muted border border-dashed border-border flex items-center justify-center">
                      <Image className="h-4 w-4 text-muted-foreground" />
                    </div>
                }
                <div className="flex-1 min-w-0">
                  <input ref={logoInputRef} type="file" accept="image/*" className="hidden"
                    onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) handleUploadLogo(f); }} />
                  <Button variant="outline" size="sm" disabled={uploadingLogo}
                    onClick={() => logoInputRef.current?.click()}
                    className="h-7 gap-1.5 text-xs border-border text-muted-foreground hover:text-foreground hover:bg-muted">
                    {uploadingLogo ? <Loader2 className="h-3 w-3 animate-spin" /> : <Upload className="h-3 w-3" />}
                    {draft.left_logo_url ? '替换 Logo' : '上传 Logo'}
                  </Button>
                  {uploadingLogo && <Progress value={logoProgress} className="h-1 mt-1.5" />}
                </div>
                {draft.left_logo_url && (
                  <Button variant="ghost" size="sm" onClick={() => set('left_logo_url', null)}
                    className="h-7 px-2 text-xs text-muted-foreground hover:text-destructive hover:bg-destructive/10">
                    移除
                  </Button>
                )}
              </div>
            </div>

            {/* 小标题 */}
            <div className="space-y-1.5">
              <Label className="text-xs text-foreground">左上角标题文字</Label>
              <Input value={draft.left_title} onChange={(e) => set('left_title', e.target.value)}
                className="h-8 text-xs bg-input border-border" placeholder="网盘推广工具" />
            </div>

            {/* 大标题 */}
            <div className="space-y-1.5">
              <Label className="text-xs text-foreground">大标题</Label>
              <Input value={draft.left_heading} onChange={(e) => set('left_heading', e.target.value)}
                className="h-8 text-xs bg-input border-border" placeholder="高效追踪每一部剧集的更新" />
            </div>

            {/* 描述 */}
            <div className="space-y-1.5">
              <Label className="text-xs text-foreground">描述简介</Label>
              <textarea value={draft.left_description} onChange={(e) => set('left_description', e.target.value)}
                rows={3}
                className="w-full px-3 py-2 text-xs rounded-md border border-border bg-input text-foreground resize-none focus:outline-none focus:ring-1 focus:ring-primary/40"
                placeholder="智能解析、批量导入…" />
            </div>

            {/* 版权 */}
            <div className="space-y-1.5">
              <Label className="text-xs text-foreground">底部版权文字</Label>
              <Input value={draft.left_copyright} onChange={(e) => set('left_copyright', e.target.value)}
                className="h-8 text-xs bg-input border-border" placeholder="© 2026 网盘推广工具" />
            </div>

            <Separator className="bg-border/60" />

            {/* 背景色 / 背景图 */}
            <div className="flex items-center justify-between">
              <Label className="text-xs text-foreground">使用背景图片</Label>
              <Switch checked={draft.left_use_bg_image} onCheckedChange={(v) => set('left_use_bg_image', v)} />
            </div>

            {!draft.left_use_bg_image ? (
              <div className="space-y-1.5">
                <Label className="text-xs text-foreground">背景颜色</Label>
                <div className="flex items-center gap-2">
                  <input type="color" value={draft.left_bg_color}
                    onChange={(e) => set('left_bg_color', e.target.value)}
                    className="h-8 w-10 rounded cursor-pointer border border-border p-0.5 bg-transparent" />
                  <Input value={draft.left_bg_color} onChange={(e) => set('left_bg_color', e.target.value)}
                    className="h-8 text-xs bg-input border-border flex-1" placeholder="#1a6b4a" />
                  <Button variant="ghost" size="sm" onClick={() => set('left_bg_color', LOGIN_CONFIG_DEFAULTS.left_bg_color)}
                    className="h-8 px-2 text-xs text-muted-foreground hover:text-foreground" title="重置默认色">
                    <RefreshCw className="h-3 w-3" />
                  </Button>
                </div>
              </div>
            ) : (
              <div className="space-y-1.5">
                <Label className="text-xs text-foreground">背景图片</Label>
                {draft.left_bg_image_url && (
                  <div className="rounded-md overflow-hidden border border-border aspect-video w-full bg-muted mb-1.5">
                    <img src={draft.left_bg_image_url} alt="背景图" className="w-full h-full object-cover" />
                  </div>
                )}
                <div className="flex items-center gap-2">
                  <input ref={bgInputRef} type="file" accept="image/*" className="hidden"
                    onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) handleUploadBg(f); }} />
                  <Button variant="outline" size="sm" disabled={uploadingBg}
                    onClick={() => bgInputRef.current?.click()}
                    className="h-7 gap-1.5 text-xs border-border text-muted-foreground hover:text-foreground hover:bg-muted">
                    {uploadingBg ? <Loader2 className="h-3 w-3 animate-spin" /> : <Upload className="h-3 w-3" />}
                    {draft.left_bg_image_url ? '替换背景图' : '上传背景图'}
                  </Button>
                  {uploadingBg && <Progress value={bgProgress} className="h-1 flex-1" />}
                  {draft.left_bg_image_url && !uploadingBg && (
                    <Button variant="ghost" size="sm" onClick={() => set('left_bg_image_url', null)}
                      className="h-7 px-2 text-xs text-muted-foreground hover:text-destructive hover:bg-destructive/10">
                      移除图片
                    </Button>
                  )}
                </div>
                <p className="text-[10px] text-muted-foreground">支持 JPEG / PNG / WEBP，超 1MB 自动压缩</p>
              </div>
            )}
          </div>

          <Separator className="bg-border/60" />

          {/* 右侧表单区 */}
          <div className="space-y-3">
            <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide flex items-center gap-1.5">
              <span className="w-2 h-2 rounded-full bg-accent inline-block" />右侧表单区
            </h4>

            <div className="space-y-1.5">
              <Label className="text-xs text-foreground">欢迎标题</Label>
              <Input value={draft.right_title} onChange={(e) => set('right_title', e.target.value)}
                className="h-8 text-xs bg-input border-border" placeholder="欢迎回来" />
            </div>

            <div className="space-y-1.5">
              <Label className="text-xs text-foreground">副标题</Label>
              <Input value={draft.right_subtitle} onChange={(e) => set('right_subtitle', e.target.value)}
                className="h-8 text-xs bg-input border-border" placeholder="登录以管理你的剧集资源" />
            </div>

            <div className="space-y-1.5">
              <Label className="text-xs text-foreground">登录按钮文字</Label>
              <Input value={draft.right_btn_text} onChange={(e) => set('right_btn_text', e.target.value)}
                className="h-8 text-xs bg-input border-border" placeholder="登录" />
            </div>
          </div>

          <Separator className="bg-border/60" />

          {/* 教程与邀请码 */}
          <div className="space-y-3">
            <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide flex items-center gap-1.5">
              <span className="w-2 h-2 rounded-full bg-accent inline-block" />教程与邀请码
            </h4>

            <div className="space-y-1.5">
              <Label className="text-xs text-foreground">教程地址（链接）</Label>
              <Input value={draft.tutorial_url ?? ''} onChange={(e) => set('tutorial_url', e.target.value || null)}
                className="h-8 text-xs bg-input border-border" placeholder="https://example.com/tutorial" />
              <p className="text-[10px] text-muted-foreground">
                登录页「使用教程」按钮将在新窗口打开此链接；留空则不显示按钮
              </p>
            </div>

            <div className="space-y-1.5">
              <Label className="text-xs text-foreground">邀请码获取说明</Label>
              <Textarea
                value={draft.invite_code_info ?? ''}
                onChange={(e) => set('invite_code_info', e.target.value || null)}
                className="min-h-24 text-xs bg-input border-border resize-y"
                placeholder={'例如：\n1. 关注公众号 XXX 回复「邀请码」获取\n2. 联系管理员 QQ：123456\n3. 每个邀请码可注册一个账号，有效期 7 天'}
              />
              <p className="text-[10px] text-muted-foreground">
                登录页「邀请码」按钮弹窗中展示的多行说明；留空则不显示按钮
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
