import { StrictMode } from 'react';

import { createRoot } from 'react-dom/client';

import { App } from './App.tsx';

import './index.scss';

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error('Unable to find #root element');
}

createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
