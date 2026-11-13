import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { PrivyProvider } from '@privy-io/react-auth';
import { PRIVY_APP_ID } from './config';
import { NEARxPrivy } from './context/provider';
import './index.css';
import App from './App.tsx';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <PrivyProvider
      appId={PRIVY_APP_ID}
      config={{
        appearance: {
          accentColor: '#0F6B4F',
          theme: 'light',
          showWalletLoginFirst: false,
        },
        loginMethods: ['email', 'google'],
      }}
    >
      <NEARxPrivy>
        <App />
      </NEARxPrivy>
    </PrivyProvider>
  </StrictMode>,
);
