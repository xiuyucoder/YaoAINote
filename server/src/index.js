import 'dotenv/config';

// OpenTelemetry must initialize before Express (and its HTTP dependencies) load.
const observability = await import('./lib/observability.js');
const [
  { default: express },
  { default: cors },
  { requireApiKey },
  { default: documentsRouter },
  { default: chatRouter },
] = await Promise.all([
  import('express'),
  import('cors'),
  import('./middleware/auth.js'),
  import('./routes/documents.js'),
  import('./routes/chat.js'),
]);

const {
  annotateRoute,
  errorInfo,
  instrumentStage,
  isPrometheusEnabled,
  log,
  markRequestError,
  outcomeForError,
  prometheusHandler,
  requestTelemetry,
} = observability;

const app = express();

const corsOrigins = (process.env.CORS_ORIGINS || 'http://localhost:5173')
  .split(',')
  .map((s) => s.trim());

app.use(requestTelemetry);
app.use(cors({ origin: corsOrigins, exposedHeaders: ['x-request-id'] }));

app.get('/metrics', (req, res) => {
  annotateRoute(req, '/metrics');
  if (!isPrometheusEnabled()) {
    res.status(404).end();
    return;
  }
  prometheusHandler(req, res);
});

app.use(express.json({ limit: '2mb' }));

app.get('/api/health', async (req, res, next) => {
  annotateRoute(req, '/api/health');
  try {
    await instrumentStage(
      {
        name: 'health.check',
        event: 'health.check',
        message: 'Health check completed',
        errorCode: 'HEALTH_CHECK_FAILED',
        attributes: { 'health.status': 'ok' },
      },
      async () => {
        res.json({ ok: true });
      },
    );
  } catch (error) {
    next(error);
  }
});

app.use('/api/documents', requireApiKey, documentsRouter);
app.use('/api/chat', requireApiKey, chatRouter);

app.use((err, req, res, _next) => {
  markRequestError(req, err, 'HTTP_REQUEST_FAILED');
  const error = errorInfo(err, 'HTTP_REQUEST_FAILED');
  const outcome = outcomeForError(err, 'HTTP_REQUEST_FAILED');
  log(outcome === 'server_error' ? 'error' : 'warn', {
    event: 'http.request.failed',
    message: 'HTTP request failed',
    outcome,
    error,
  });
  res.status(err.status || 500).json({ error: err.message || 'Server error' });
});

const port = Number(process.env.PORT) || 3000;
// Bind to 0.0.0.0 explicitly — Railway / most container platforms require this.
// Without an explicit host, Node may bind to 127.0.0.1 only, and the platform's
// proxy can't reach us (502 Bad Gateway).
const host = process.env.HOST || '0.0.0.0';
app.listen(port, host, () => {
  log('info', {
    event: 'server.started',
    message: 'YaoAINote server started',
    port,
  });
});
