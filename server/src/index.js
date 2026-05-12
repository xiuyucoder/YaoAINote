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
app.listen(port, () => {
  console.log(`yaoainote server listening on http://localhost:${port}`);
});
