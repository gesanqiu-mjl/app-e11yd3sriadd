import React from 'react';
import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import IntersectObserver from '@/components/common/IntersectObserver';
import { Toaster } from '@/components/ui/sonner';
import { AuthProvider } from '@/contexts/AuthContext';
import { RouteGuard } from '@/components/common/RouteGuard';
import { routes } from './routes';

const App: React.FC = () => {
  return (
    <Router>
      <AuthProvider>
        <IntersectObserver />
        <RouteGuard>
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
