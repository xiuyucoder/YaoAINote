import {
  annotateRoute,
  createHttpError,
  instrumentStage,
  markRequestError,
  recordAuth,
} from '../lib/observability.js';

export function requireApiKey(req, res, next) {
  const route = req.baseUrl === '/api/chat'
    ? req.path === '/feedback'
      ? '/api/chat/feedback'
      : '/api/chat'
    : req.method === 'DELETE'
      ? '/api/documents/:id'
      : '/api/documents';
  annotateRoute(req, route);

  instrumentStage(
    {
      name: 'auth.api_key',
      event: 'auth.api_key',
      message: 'API key check completed',
      attributes: {},
      errorCode: 'API_KEY_REJECTED',
      onComplete: ({ outcome, summary }) => recordAuth(summary['auth.result'] || outcome),
    },
    async (stage) => {
      const expected = process.env.APP_API_KEY;
      if (!expected) {
        req.telemetry.authResult = 'misconfigured';
        stage.setAttribute('auth.result', 'misconfigured');
        throw createHttpError(
          500,
          'APP_API_KEY not configured on server',
          { type: 'ConfigurationError', code: 'APP_API_KEY_MISSING' },
        );
      }

      const provided = req.header('x-api-key');
      if (provided !== expected) {
        req.telemetry.authResult = provided ? 'rejected' : 'missing';
        stage.setAttribute('auth.result', req.telemetry.authResult);
        throw createHttpError(
          401,
          'invalid or missing x-api-key',
          { type: 'AuthenticationError', code: 'API_KEY_REJECTED' },
        );
      }

      req.telemetry.authenticated = true;
      req.telemetry.authResult = 'accepted';
      stage.setAttribute('auth.result', 'accepted');
    },
  ).then(
    () => next(),
    (error) => {
      markRequestError(req, error, 'API_KEY_REJECTED');
      res.status(error.status || 500).json({ error: error.message || 'Server error' });
    },
  );
}
