import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import { initializeTelemetry, startInitialRender } from './observability.js';
import './styles.css';

initializeTelemetry();
const initialRender = startInitialRender();

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App initialRender={initialRender} />
  </StrictMode>,
);
