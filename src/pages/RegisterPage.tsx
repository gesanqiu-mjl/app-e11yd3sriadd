import React, { useState, useEffect } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { Clapperboard, Loader2 } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { toast } from 'sonner';
import PageMeta from '@/components/common/PageMeta';
import { validateInviteCode, consumeInviteCode } from '@/services/api';

export default function RegisterPage() {
  const { user, signUpWithUsername, signInWithUsername } = useAuth();
  const navigate = useNavigate();

  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [inviteCode, setInviteCode] = useState('');
  const [agree, setAgree] = useState(false);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (user) navigate('/', { replace: true });
  }, [user, navigate]);

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

    // 1. 乐观验证邀请码
    let codeValid = false;
    try {
      codeValid = await validateInviteCode(code);
    } catch {
      toast.error('邀请码验证失败，请重试');
      setLoading(false);
      return;
    }
    if (!codeValid) {
      toast.error('邀请码无效或已被使用');
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

    // 3. 自动登录
    const { error: loginErr } = await signInWithUsername(name, password);
    if (loginErr) {
      setLoading(false);
      toast.success('注册成功，请登录');
      navigate('/login', { replace: true });
      return;
    }

    // 4. 原子消费邀请码
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
        // 消费失败不阻断登录，记录即可
        console.error('邀请码标记失败');
      }
    }

    setLoading(false);
    toast.success('注册成功');
    navigate('/', { replace: true });
  }

  return (
    <div className="flex min-h-screen w-full bg-background">
      <PageMeta
        title="新用户邀请注册 - 影视资源更新追踪管理系统"
        description="新用户注册页面，凭有效邀请码快速创建账号，开启影视资源更新追踪与同步体验。"
        keywords="用户注册, 账号注册, 邀请码注册, 影视系统, 新用户加入"
      />
      <div className="hidden md:flex md:w-1/2 flex-col justify-between p-12 bg-accent relative overflow-hidden">
        <div className="flex items-center gap-3">
          <span className="flex items-center justify-center w-10 h-10 rounded-xl bg-accent-foreground/15">
            <Clapperboard className="h-5 w-5 text-accent-foreground" />
          </span>
          <span className="font-serif text-xl font-bold text-accent-foreground">资源更新追踪</span>
        </div>
        <div className="relative z-10">
          <h1 className="font-serif text-4xl font-bold text-accent-foreground leading-tight text-balance">{"节省时间就是赚钱"}</h1>
          <p className="mt-4 text-sm text-accent-foreground/85 max-w-md text-pretty leading-relaxed">
            需要邀请码才能注册。注册后即可维护专属剧集清单，智能解析与批量导入让更新管理更轻松。
          </p>
        </div>
        <p className="text-xs text-accent-foreground/60">© 2026 资源更新追踪系统</p>
        <div className="absolute -right-16 -bottom-16 w-64 h-64 rounded-full bg-accent-foreground/5" />
      </div>
      <div className="flex flex-1 items-center justify-center p-6">
        <div className="w-full max-w-sm">
          <div className="md:hidden flex items-center gap-2.5 mb-8">
            <span className="flex items-center justify-center w-9 h-9 rounded-lg bg-primary">
              <Clapperboard className="h-4 w-4 text-primary-foreground" />
            </span>
            <span className="font-serif text-lg font-bold text-foreground">资源更新追踪</span>
          </div>

          <h2 className="font-serif text-2xl font-bold text-foreground">注册账号</h2>
          <p className="mt-1 text-sm text-muted-foreground">需要管理员提供的邀请码方可注册</p>

          <form onSubmit={handleSubmit} className="mt-6 space-y-4">
            <div className="space-y-2">
              <Label htmlFor="inviteCode" className="text-sm text-foreground">邀请码</Label>
              <Input
                id="inviteCode"
                value={inviteCode}
                onChange={(e) => setInviteCode(e.target.value.toUpperCase())}
                placeholder="8 位邀请码"
                autoComplete="off"
                maxLength={8}
                className="h-10 bg-input border-border focus-visible:ring-primary/40 tracking-widest font-mono"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="username" className="text-sm text-foreground">用户名</Label>
              <Input
                id="username"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="字母、数字或下划线"
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
                placeholder="至少 6 位"
                autoComplete="new-password"
                className="h-10 bg-input border-border focus-visible:ring-primary/40"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="confirm" className="text-sm text-foreground">确认密码</Label>
              <Input
                id="confirm"
                type="password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                placeholder="再次输入密码"
                autoComplete="new-password"
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
              注册
            </Button>
          </form>

          <p className="mt-6 text-center text-sm text-muted-foreground">
            已有账号？
            <Link to="/login" className="text-primary font-medium hover:underline ml-1">
              去登录
            </Link>
          </p>
        </div>
      </div>
    </div>
  );
}

