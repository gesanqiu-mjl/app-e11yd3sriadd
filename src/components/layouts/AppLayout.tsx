import React from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { Clapperboard, LayoutDashboard, LogOut, User, ChevronDown, RefreshCw, Clock } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { Button } from '@/components/ui/button';
import AnnouncementBar from '@/components/AnnouncementBar';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

interface AppLayoutProps {
  children: React.ReactNode;
}

export default function AppLayout({ children }: AppLayoutProps) {
  const { profile, signOut } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const isAdmin = profile?.role === 'admin';
  const username = profile?.username || '用户';

  async function handleSignOut() {
    await signOut();
    navigate('/login', { replace: true });
  }

  const navItems = [
    { label: '资源管理', path: '/', icon: Clapperboard },
    { label: '站点同步', path: '/sync', icon: RefreshCw },
    ...(isAdmin ? [{ label: '管理后台', path: '/admin', icon: LayoutDashboard }] : []),
  ];

  return (
    <div className="flex flex-col min-h-screen w-full bg-background">
      <AnnouncementBar />
      <header className="sticky top-0 z-30 flex items-center justify-between gap-3 px-4 md:px-8 h-14 border-b border-border bg-card/90 backdrop-blur-sm shrink-0">
        <Link to="/" className="flex items-center gap-2.5 min-w-0">
          <span className="flex items-center justify-center w-8 h-8 rounded-lg bg-primary shrink-0">
            <Clapperboard className="h-4 w-4 text-primary-foreground" />
          </span>
          <span className="font-serif text-base md:text-lg font-bold text-foreground truncate">{"云盘推广得力干将"}</span>
        </Link>

        <nav className="hidden md:flex items-center gap-1">
          {navItems.map((item) => {
            const active = location.pathname === item.path;
            return (
              <Link
                key={item.path}
                to={item.path}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm transition-colors ${
                  active
                    ? 'bg-primary/10 text-primary font-medium'
                    : 'text-muted-foreground hover:text-foreground hover:bg-muted'
                }`}
              >
                <item.icon className="h-3.5 w-3.5" />
                {item.label}
              </Link>
            );
          })}
        </nav>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              className="h-8 gap-1.5 px-2 text-foreground hover:bg-muted"
            >
              <span className="flex items-center justify-center w-6 h-6 rounded-full bg-primary/15 text-primary text-xs font-semibold shrink-0">
                {username.charAt(0).toUpperCase()}
              </span>
              <span className="hidden sm:inline max-w-24 truncate text-sm">{username}</span>
              <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-48">
            <div className="px-2 py-1.5 text-xs text-muted-foreground">
              已登录：{username}
              {isAdmin && <span className="ml-1 text-primary">（管理员）</span>}
            </div>
            {/* 会员到期时间 */}
            {(() => {
              const expires = profile?.membership_expires_at;
              let expiryText: string;
              let expiryClass: string;
              if (isAdmin) {
                expiryText = '管理员 · 永久有效';
                expiryClass = 'text-primary';
              } else if (!expires) {
                expiryText = '会员状态：未设置';
                expiryClass = 'text-muted-foreground';
              } else {
                const expired = new Date(expires).getTime() <= Date.now();
                expiryText = expired
                  ? '会员已过期'
                  : `会员到期：${new Date(expires).toLocaleDateString()}`;
                expiryClass = expired ? 'text-destructive' : 'text-accent';
              }
              return (
                <div className={`px-2 py-1.5 text-xs flex items-center gap-1.5 ${expiryClass}`}>
                  <Clock className="h-3.5 w-3.5 shrink-0" />
                  {expiryText}
                </div>
              );
            })()}
            <DropdownMenuSeparator />
            {navItems.map((item) => (
              <DropdownMenuItem key={item.path} onClick={() => navigate(item.path)}>
                <item.icon className="h-4 w-4 mr-2" />
                {item.label}
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={handleSignOut} className="text-destructive focus:text-destructive">
              <LogOut className="h-4 w-4 mr-2" />
              退出登录
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </header>
      <main className="flex-1 min-w-0 min-h-0">{children}</main>
    </div>
  );
}