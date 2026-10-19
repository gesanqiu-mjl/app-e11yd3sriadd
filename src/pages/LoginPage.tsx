import React, { useState, useEffect } from 'react';
import { useNavigate, useLocation, Link } from 'react-router-dom';
import { Clapperboard, Loader2, BookOpen, KeyRound, ShieldCheck } from 'lucide-react';
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

/** 内置登录页背景（后台未配置自定义背景图时使用） */
const BUILTIN_LOGIN_BG = '/images/login-bg.png';

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

  /** 品牌标志（有配置用配置的 logo，否则用默认图标） */
  const brandLogo = (boxClass: string, iconClass: string) =>
    cfg.left_logo_url ? (
      <img src={cfg.left_logo_url} alt="logo" className={`${boxClass} rounded-xl object-cover`} />
    ) : (
      <span className={`${boxClass} flex items-center justify-center rounded-xl bg-[#2563EB]`}>
        <Clapperboard className={iconClass} />
      </span>
    );

  const inputClass =
    'h-12 rounded-lg border-0 bg-[#EAF3FE] px-4 text-[15px] text-slate-800 shadow-none placeholder:text-slate-400 focus-visible:ring-2 focus-visible:ring-[#2563EB]/35';

  return (
    <div className="relative flex min-h-screen w-full flex-col items-center justify-center overflow-x-hidden px-5 py-6 sm:px-8 sm:py-10">
      <PageMeta
        title="账号安全登录 - 网盘推广工具"
        description="登录影视资源更新追踪与多盘同步系统，安全访问资源列表与跨站点发布同步功能。"
        keywords="用户登录, 账号登录, 影视资源系统, 安全认证, 会员登录"
      />

      {/* 背景：后台配置了自定义背景图则优先用后台的，否则用内置科技蓝底图 */}
      <div
        className="absolute inset-0 bg-cover bg-center"
        style={{
          backgroundColor: cfg.left_bg_color,
          backgroundImage: `url(${
            cfg.left_use_bg_image && cfg.left_bg_image_url ? cfg.left_bg_image_url : BUILTIN_LOGIN_BG
          })`,
        }}
      />
      {/* 浅色蒙版：让居中的白卡片在科技蓝底图上清晰、稳定 */}
      <div className="absolute inset-0 bg-white/35" />

      {/* 品牌区：居中在卡片上方（后台「登录页配置」里的品牌名 / 标题 / 描述） */}
      <div className="relative z-10 mb-5 flex w-full max-w-[440px] flex-col items-center gap-2 text-center">
        <div className="flex items-center gap-2.5">
          {brandLogo('w-10 h-10', 'h-5 w-5 text-white')}
          <span className="text-lg font-bold tracking-tight text-slate-800">{cfg.left_title}</span>
        </div>
        {cfg.left_heading?.trim() && (
          <h1 className="mt-1 text-2xl font-bold leading-snug text-slate-900 text-balance">
            {cfg.left_heading}
          </h1>
        )}
        {cfg.left_description?.trim() && (
          <p className="max-w-md text-[13px] leading-relaxed text-slate-600 text-pretty">
            {cfg.left_description}
          </p>
        )}
      </div>

      {/* 登录卡片：屏幕正中 */}
      <div className="relative z-10 w-full max-w-[440px]">
        <div className="rounded-2xl bg-white p-7 shadow-[0_24px_70px_-20px_rgba(37,99,235,0.35)] sm:p-9">
          <h2 className="text-[26px] font-bold leading-tight text-slate-900">{cfg.right_title}</h2>
          {cfg.right_subtitle?.trim() && (
            <p className="mt-1.5 text-[13px] text-slate-500">{cfg.right_subtitle}</p>
          )}

          <form onSubmit={handleSubmit} className="mt-7 space-y-4">
            <div>
              <Label htmlFor="username" className="sr-only">账号</Label>
              <Input
                id="username"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="请输入账号"
                autoComplete="username"
                className={inputClass}
              />
            </div>
            <div>
              <Label htmlFor="password" className="sr-only">密码</Label>
              <Input
                id="password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="请输入密码"
                autoComplete="current-password"
                className={inputClass}
              />
            </div>

            {/* 注册 / 忘记密码 */}
            <div className="flex items-center justify-between text-[13px]">
              <Link to="/register" className="text-slate-500 transition-colors hover:text-[#2563EB]">
                注册
              </Link>
              <Dialog>
                <DialogTrigger asChild>
                  <button
                    type="button"
                    className="text-slate-500 transition-colors hover:text-[#2563EB]"
                  >
                    忘记密码？
                  </button>
                </DialogTrigger>
                <DialogContent className="max-w-[calc(100%-2rem)] md:max-w-md">
                  <DialogHeader>
                    <DialogTitle className="text-left">忘记密码怎么办？</DialogTitle>
                    <DialogDescription className="text-left">
                      为保障账号安全，密码重置由管理员人工处理：请联系管理员并提供你的账号名，
                      重置后即可用新密码登录。
                    </DialogDescription>
                  </DialogHeader>
                  {cfg.tutorial_url?.trim() && (
                    <Button
                      type="button"
                      variant="secondary"
                      className="h-10 gap-1.5 bg-[#EAF3FE] text-slate-700 hover:bg-[#DCEAFD]"
                      onClick={() => window.open(cfg.tutorial_url!.trim(), '_blank', 'noopener,noreferrer')}
                    >
                      <BookOpen className="h-4 w-4" />
                      查看使用教程
                    </Button>
                  )}
                </DialogContent>
              </Dialog>
            </div>

            <label className="flex cursor-pointer items-start gap-2 pt-1">
              <Checkbox
                checked={agree}
                onCheckedChange={(v) => setAgree(v === true)}
                className="mt-0.5 border-slate-300 data-[state=checked]:border-[#2563EB] data-[state=checked]:bg-[#2563EB]"
              />
              <span className="text-[11px] leading-relaxed text-slate-500">
                我已阅读并同意
                <span className="text-[#2563EB]">《用户协议》</span>与
                <span className="text-[#2563EB]">《隐私政策》</span>
              </span>
            </label>

            <Button
              type="submit"
              disabled={loading}
              className="mt-2 h-12 w-full rounded-full bg-[#2563EB] text-[15px] font-semibold text-white shadow-lg shadow-blue-500/25 transition-colors hover:bg-[#1D4ED8]"
            >
              {loading && <Loader2 className="h-4 w-4 animate-spin" />}
              {cfg.right_btn_text}
            </Button>
          </form>

          {/* 教程 / 邀请码入口 */}
          {(cfg.tutorial_url?.trim() || cfg.invite_code_info?.trim()) && (
            <div className="mt-5 grid grid-cols-2 gap-2">
              {cfg.tutorial_url?.trim() && (
                <Button
                  type="button"
                  variant="secondary"
                  className="h-10 gap-1.5 rounded-lg bg-[#EAF3FE] text-[13px] text-slate-600 hover:bg-[#DCEAFD] hover:text-slate-700"
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
                      className="h-10 gap-1.5 rounded-lg bg-[#EAF3FE] text-[13px] text-slate-600 hover:bg-[#DCEAFD] hover:text-slate-700"
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
                      <pre className="whitespace-pre-wrap break-words font-sans text-sm leading-relaxed text-foreground/90">
                        {cfg.invite_code_info.trim()}
                      </pre>
                    </div>
                  </DialogContent>
                </Dialog>
              )}
            </div>
          )}

          <p className="mt-5 flex items-center justify-center gap-1.5 text-[11px] text-slate-400">
            <ShieldCheck className="h-3.5 w-3.5" />
            账号信息仅用于本系统登录，传输全程加密
          </p>
        </div>

        {cfg.left_copyright?.trim() && (
          <p className="mt-4 text-center text-xs text-slate-500">{cfg.left_copyright}</p>
        )}
      </div>
    </div>
  );
}
