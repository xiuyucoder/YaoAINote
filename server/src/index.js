import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { requireApiKey } from './middleware/auth.js';
import documentsRouter from './routes/documents.js';
import chatRouter from './routes/chat.js';

const app = express();

const corsOrigins = (process.env.CORS_ORIGINS || 'http://localhost:5173')
  .split(',')
  .map((s) => s.trim());

app.use(cors({ origin: corsOrigins }));
app.use(express.json({ limit: '2mb' }));

app.get('/api/health', (_req, res) => {
  res.json({ ok: true });
});

app.use('/api/documents', requireApiKey, documentsRouter);
app.use('/api/chat', requireApiKey, chatRouter);

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(err.status || 500).json({ error: err.message || 'Server error' });
});

const port = Number(process.env.PORT) || 3000;
// Bind to 0.0.0.0 explicitly — Railway / most container platforms require this.
// Without an explicit host, Node may bind to 127.0.0.1 only, and the platform's
// proxy can't reach us (502 Bad Gateway).
const host = process.env.HOST || '0.0.0.0';
app.listen(port, host, () => {
  console.log(`yaoainote server listening on http://${host}:${port}`);
});
