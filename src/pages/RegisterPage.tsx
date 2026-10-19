import React, { useState, useEffect } from 'react';
import { useNavigate, Link } from 'react-router-dom';
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
import { checkInviteCode, consumeInviteCode, getLoginConfig } from '@/services/api';
import { LoginConfig, LOGIN_CONFIG_DEFAULTS } from '@/types/index';

/** 内置背景（与登录页共用；后台未配置自定义背景图时使用） */
const BUILTIN_LOGIN_BG = '/images/login-bg.png';

export default function RegisterPage() {
  const { user, signUpWithUsername, signInWithUsername } = useAuth();
  const navigate = useNavigate();

  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [inviteCode, setInviteCode] = useState('');
  const [agree, setAgree] = useState(false);
  const [loading, setLoading] = useState(false);
  const [cfg, setCfg] = useState<Omit<LoginConfig, 'id' | 'updated_at'>>(LOGIN_CONFIG_DEFAULTS);

  useEffect(() => {
    if (user) navigate('/', { replace: true });
  }, [user, navigate]);

  // 与登录页共用同一套外观配置（背景图 / 品牌名 / logo / 版权）
  useEffect(() => {
    getLoginConfig()
      .then((data) => {
        const { id: _id, updated_at: _at, ...rest } = data;
        setCfg(rest);
      })
      .catch(() => {});
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const name = username.trim();
    const code = inviteCode.trim().toUpperCase();
    if (!code) {
      toast.error('请输入邀请码');
      return;
    }
    if (!name || !password) {
      toast.error('请填写用户名和密码');
      return;
    }
    if (!/^[a-zA-Z0-9_]+$/.test(name)) {
      toast.error('用户名仅支持字母、数字和下划线');
      return;
    }
    if (password.length < 6) {
      toast.error('密码至少 6 位');
      return;
    }
    if (password !== confirm) {
      toast.error('两次输入的密码不一致');
      return;
    }
    if (!agree) {
      toast.error('请先阅读并同意用户协议与隐私政策');
      return;
    }

    setLoading(true);

    // 1. 乐观验证邀请码：区分「不存在 / 已被使用 / 已被撤销」，便于用户和站长定位
    let codeStatus: Awaited<ReturnType<typeof checkInviteCode>>;
    try {
      codeStatus = await checkInviteCode(code);
    } catch {
      toast.error('邀请码验证失败，请检查网络后重试');
      setLoading(false);
      return;
    }
    if (codeStatus !== 'ok') {
      toast.error(
        codeStatus === 'used'
          ? '该邀请码已被使用过，请联系管理员获取新邀请码（如果是你自己注册的账号，请直接登录）'
          : codeStatus === 'revoked'
            ? '该邀请码已被管理员撤销，无法使用，请联系管理员获取新邀请码'
            : '邀请码不存在，请检查是否输入正确（8 位字母数字，注意不要多复制空格）'
      );
      setLoading(false);
      return;
    }

    // 2. 注册
    const { error, userId } = await signUpWithUsername(name, password);
    if (error) {
      setLoading(false);
      const msg = error.message || '';
      if (msg.includes('already')) {
        toast.error('该用户名已被注册');
      } else {
        toast.error(msg || '注册失败，请重试');
      }
      return;
    }

    // 3. 原子消费邀请码
    //    必须放在「自动登录」之前：自动登录可能因任何原因失败（此前的邮箱未确认就是典型），
    //    若放在其后，失败时会提前 return，导致邀请码一直未被消费（可被重复使用），
    //    且会员到期时间保持 NULL —— 而 NULL 会被判定为「无限制」，等于白送永久会员。
    if (userId) {
      try {
        const consumed = await consumeInviteCode(code, userId);
        if (!consumed) {
          // 极小概率并发冲突
          toast.error('邀请码已被他人抢先使用，请联系管理员');
          setLoading(false);
          return;
        }
      } catch {
        // 消费失败不阻断注册，记录即可
        console.error('邀请码标记失败');
      }
    }

    // 4. 自动登录
    const { error: loginErr } = await signInWithUsername(name, password);
    if (loginErr) {
      setLoading(false);
      toast.success('注册成功，请登录');
      navigate('/login', { replace: true });
      return;
    }

    setLoading(false);
    toast.success('注册成功');
    navigate('/', { replace: true });
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
        title="新用户邀请注册 - 网盘推广工具"
        description="新用户注册页面，凭有效邀请码快速创建账号，开启影视资源更新追踪与同步体验。"
        keywords="用户注册, 账号注册, 邀请码注册, 影视系统, 新用户加入"
      />

      {/* 背景：与登录页同源（后台配置优先） */}
      <div
        className="absolute inset-0 bg-cover bg-center"
        style={{
          backgroundColor: cfg.left_bg_color,
          backgroundImage: `url(${
            cfg.left_use_bg_image && cfg.left_bg_image_url ? cfg.left_bg_image_url : BUILTIN_LOGIN_BG
          })`,
        }}
      />
      <div className="absolute inset-0 bg-white/35" />

      {/* 品牌区：居中在卡片上方 */}
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
      </div>

      {/* 注册卡片：屏幕正中 */}
      <div className="relative z-10 w-full max-w-[440px]">
        <div className="rounded-2xl bg-white p-7 shadow-[0_24px_70px_-20px_rgba(37,99,235,0.35)] sm:p-9">
          <h2 className="text-[26px] font-bold leading-tight text-slate-900">注册账号</h2>
          <p className="mt-1.5 text-[13px] text-slate-500">需要管理员提供的邀请码方可注册</p>

          <form onSubmit={handleSubmit} className="mt-6 space-y-3.5">
            <div>
              <Label htmlFor="inviteCode" className="sr-only">邀请码</Label>
              <Input
                id="inviteCode"
                value={inviteCode}
                onChange={(e) => setInviteCode(e.target.value.toUpperCase())}
                placeholder="8 位邀请码"
                autoComplete="off"
                maxLength={8}
                className={`${inputClass} font-mono tracking-widest`}
              />
            </div>
            <div>
              <Label htmlFor="username" className="sr-only">用户名</Label>
              <Input
                id="username"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="用户名（字母、数字或下划线）"
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
                placeholder="密码（至少 6 位）"
                autoComplete="new-password"
                className={inputClass}
              />
            </div>
            <div>
              <Label htmlFor="confirm" className="sr-only">确认密码</Label>
              <Input
                id="confirm"
                type="password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                placeholder="再次输入密码"
                autoComplete="new-password"
                className={inputClass}
              />
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
              className="mt-1 h-12 w-full rounded-full bg-[#2563EB] text-[15px] font-semibold text-white shadow-lg shadow-blue-500/25 transition-colors hover:bg-[#1D4ED8]"
            >
              {loading && <Loader2 className="h-4 w-4 animate-spin" />}
              注册
            </Button>
          </form>

          {/* 教程 / 邀请码说明 */}
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
                    如何获取邀请码
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

          <p className="mt-5 flex items-center justify-center gap-1.5 text-[11px] text-slate-400">
            <ShieldCheck className="h-3.5 w-3.5" />
            邀请码一码一用，账号信息传输全程加密
          </p>
        </div>

        <p className="mt-4 text-center text-[13px] text-slate-600">
          已有账号？
          <Link to="/login" className="ml-1 font-medium text-[#2563EB] hover:underline">
            去登录
          </Link>
        </p>
        {cfg.left_copyright?.trim() && (
          <p className="mt-2 text-center text-xs text-slate-500">{cfg.left_copyright}</p>
        )}
      </div>
    </div>
  );
}
