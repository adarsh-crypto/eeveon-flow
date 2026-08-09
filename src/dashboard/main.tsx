import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import '../shared/theme.css';
import './styles.css';

const host = document.getElementById('root');
if (!host) throw new Error('dashboard root missing');

createRoot(host).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
