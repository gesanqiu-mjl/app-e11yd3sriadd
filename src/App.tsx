import React from 'react';
import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import IntersectObserver from '@/components/common/IntersectObserver';
import { Toaster } from '@/components/ui/sonner';
import { AuthProvider } from '@/contexts/AuthContext';
import { RouteGuard } from '@/components/common/RouteGuard';
import { useHdhavenOAuthCallback } from '@/hooks/use-hdhaven-oauth-callback';
import { routes } from './routes';

/**
 * 栖影 OAuth 授权回调：站点登记的回调地址是根路径，会带着 code/state 回到首页，
 * 必须在路由之外全局接住，否则授权成功后无人处理、换不到 token。
 */
const HdhavenOAuthCallback: React.FC = () => {
  useHdhavenOAuthCallback();
  return null;
};

const App: React.FC = () => {
  return (
    <Router>
      <AuthProvider>
        <IntersectObserver />
        <RouteGuard>
          <HdhavenOAuthCallback />
          <Routes>
            {routes.map((route, index) => (
              <Route key={index} path={route.path} element={route.element} />
            ))}
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </RouteGuard>
        {/* mobileOffset：手机端底部有固定的底部导航（56px + 安全区），
            提示条抬高显示，避免被导航栏压住看不到 */}
        <Toaster mobileOffset={{ bottom: '4.5rem' }} />
      </AuthProvider>
    </Router>
  );
};

export default App;
