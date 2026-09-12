import React, { useState, useEffect } from 'react';
import { useNavigate, useLocation, Link } from 'react-router-dom';
import { Clapperboard, Loader2, BookOpen, KeyRound } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { toast } from 'sonner';
import PageMeta from '@/components/common/PageMeta';
import { getLoginConfig } from '@/services/api';
import { LoginConfig, LOGIN_CONFIG_DEFAULTS } from '@/types/index';

export default function LoginPage() {
  const { user, signInWithUsername } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const from = (location.state as { from?: string })?.from || '/';

  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [agree, setAgree] = useState(false);
  const [loading, setLoading] = useState(false);
  const [cfg, setCfg] = useState<Omit<LoginConfig, 'id' | 'updated_at'>>(LOGIN_CONFIG_DEFAULTS);

  useEffect(() => {
    if (user) navigate(from, { replace: true });
  }, [user, from, navigate]);

  // 加载登录页配置
  useEffect(() => {
    getLoginConfig()
      .then((data) => {
        const { id: _id, updated_at: _at, ...rest } = data;
        setCfg(rest);
      })
      .catch(() => {}); // 静默失败，用默认值
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!username.trim() || !password) {
      toast.error('请输入用户名和密码');
      return;
    }
    if (!agree) {
      toast.error('请先阅读并同意用户协议与隐私政策');
      return;
    }
    setLoading(true);
    const { error } = await signInWithUsername(username.trim(), password);
    setLoading(false);
    if (error) {
      toast.error(error.message || '账号或密码错误');
      return;
    }
    toast.success('登录成功');
    navigate(from, { replace: true });
  }

  return (
    <div className="flex min-h-screen w-full bg-background">
      <PageMeta
        title="账号安全登录 - 影视资源追踪与同步系统"
        description="登录影视资源更新追踪与多盘同步系统，安全访问资源列表与跨站点发布同步功能。"
        keywords="用户登录, 账号登录, 影视资源系统, 安全认证, 会员登录"
      />
      {/* 左侧品牌区 */}
      <div
        className="hidden md:flex md:w-1/2 flex-col justify-between p-12 relative overflow-hidden"
        style={{
          backgroundColor: cfg.left_use_bg_image ? undefined : cfg.left_bg_color,
          backgroundImage: cfg.left_use_bg_image && cfg.left_bg_image_url
            ? `url(${cfg.left_bg_image_url})`
            : undefined,
          backgroundSize: 'cover',
          backgroundPosition: 'center',
        }}
      >
        {/* 背景图时加遮罩 */}
        {cfg.left_use_bg_image && cfg.left_bg_image_url && (
          <div className="absolute inset-0 bg-black/40" />
        )}
        <div className="flex items-center gap-3 relative z-10">
          {cfg.left_logo_url ? (
            <img
              src={cfg.left_logo_url}
              alt="logo"
              className="w-10 h-10 rounded-xl object-cover"
            />
          ) : (
            <span className="flex items-center justify-center w-10 h-10 rounded-xl bg-white/15">
              <Clapperboard className="h-5 w-5 text-white" />
            </span>
          )}
          <span className="font-serif text-xl font-bold text-white">{cfg.left_title}</span>
        </div>
        <div className="relative z-10">
          <h1 className="font-serif text-4xl font-bold text-white leading-tight text-balance">
            {cfg.left_heading}
          </h1>
          <p className="mt-4 text-sm text-white/80 max-w-md text-pretty leading-relaxed">
            {cfg.left_description}
          </p>
        </div>
        <p className="text-xs text-white/60 relative z-10">{cfg.left_copyright}</p>
        {/* 装饰 */}
        {!cfg.left_use_bg_image && (
          <>
            <div className="absolute -right-16 -bottom-16 w-64 h-64 rounded-full bg-white/5" />
            <div className="absolute right-20 top-24 w-32 h-32 rounded-full bg-white/5" />
          </>
        )}
      </div>

      {/* 右侧表单区 */}
      <div className="flex flex-1 items-center justify-center p-6">
        <div className="w-full max-w-sm">
          <div className="md:hidden flex items-center gap-2.5 mb-8">
            {cfg.left_logo_url ? (
              <img src={cfg.left_logo_url} alt="logo" className="w-9 h-9 rounded-lg object-cover" />
            ) : (
              <span className="flex items-center justify-center w-9 h-9 rounded-lg bg-primary">
                <Clapperboard className="h-4 w-4 text-primary-foreground" />
              </span>
            )}
            <span className="font-serif text-lg font-bold text-foreground">{cfg.left_title}</span>
          </div>

          <h2 className="font-serif text-2xl font-bold text-foreground">{cfg.right_title}</h2>
          <p className="mt-1 text-sm text-muted-foreground">{cfg.right_subtitle}</p>

          <form onSubmit={handleSubmit} className="mt-6 space-y-4">
            <div className="space-y-2">
              <Label htmlFor="username" className="text-sm text-foreground">用户名</Label>
              <Input
                id="username"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="请输入用户名"
                autoComplete="username"
                className="h-10 bg-input border-border focus-visible:ring-primary/40"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="password" className="text-sm text-foreground">密码</Label>
              <Input
                id="password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="请输入密码"
                autoComplete="current-password"
                className="h-10 bg-input border-border focus-visible:ring-primary/40"
              />
            </div>

            <label className="flex items-start gap-2 min-h-12 items-center cursor-pointer">
              <Checkbox
                checked={agree}
                onCheckedChange={(v) => setAgree(v === true)}
                className="mt-0.5"
              />
              <span className="text-xs text-muted-foreground leading-relaxed">
                我已阅读并同意
                <span className="text-primary">《用户协议》</span>与
                <span className="text-primary">《隐私政策》</span>
              </span>
            </label>

            <Button
              type="submit"
              disabled={loading}
              className="w-full h-10 bg-primary text-primary-foreground hover:bg-primary/90 gap-1.5"
            >
              {loading && <Loader2 className="h-4 w-4 animate-spin" />}
              {cfg.right_btn_text}
            </Button>
          </form>

          {/* 教程 + 邀请码入口 */}
          <div className="mt-4 grid grid-cols-2 gap-2">
            {cfg.tutorial_url?.trim() && (
              <Button
                type="button"
                variant="secondary"
                className="h-9 gap-1.5 bg-input text-foreground hover:bg-muted"
                onClick={() => window.open(cfg.tutorial_url!.trim(), '_blank', 'noopener,noreferrer')}
              >
                <BookOpen className="h-4 w-4" />
                使用教程
              </Button>
            )}
            {cfg.invite_code_info?.trim() && (
              <Dialog>
                <DialogTrigger asChild>
                  <Button
                    type="button"
                    variant="secondary"
                    className="h-9 gap-1.5 bg-input text-foreground hover:bg-muted"
                  >
                    <KeyRound className="h-4 w-4" />
                    邀请码
                  </Button>
                </DialogTrigger>
                <DialogContent className="max-w-[calc(100%-2rem)] md:max-w-lg">
                  <DialogHeader>
                    <DialogTitle className="text-left">如何获取邀请码</DialogTitle>
                    <DialogDescription className="text-left">
                      按以下说明获取激活码后即可注册使用
                    </DialogDescription>
                  </DialogHeader>
                  <div className="max-h-[50dvh] overflow-y-auto">
                    <pre className="whitespace-pre-wrap break-words text-sm text-foreground/90 leading-relaxed font-sans">
                      {cfg.invite_code_info.trim()}
                    </pre>
                  </div>
                </DialogContent>
              </Dialog>
            )}
          </div>

          <p className="mt-6 text-center text-sm text-muted-foreground">
            还没有账号？
            <Link to="/register" className="text-primary font-medium hover:underline ml-1">
              立即注册
            </Link>
          </p>
        </div>
      </div>
    </div>
  );
}
