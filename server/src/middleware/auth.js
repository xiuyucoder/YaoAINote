import {
  annotateRoute,
  createHttpError,
  instrumentStage,
  markRequestError,
  recordAuth,
} from '../lib/observability.js';

export function requireApiKey(req, res, next) {
  const route =
    req.baseUrl === '/api/chat'
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

      // Accept API key from multiple sources for flexibility:
      // - x-api-key header
      // - Authorization: ApiKey <key> or Authorization: Api-Key <key>
      // - query param `api_key` or `apikey`
      const authHeader = req.header('authorization') || req.header('Authorization');
      const authKeyFromAuthHeader =
        authHeader && /^(?:ApiKey|Api-Key)\s+(.+)$/i.test(authHeader)
          ? authHeader.replace(/^(?:ApiKey|Api-Key)\s+/i, '')
          : null;
      const provided =
        req.header('x-api-key') || authKeyFromAuthHeader || req.query?.api_key || req.query?.apikey;

      // If server is not configured with an APP_API_KEY, allow an explicit development bypass
      // when ALLOW_NO_API_KEY=true and NODE_ENV=development to aid local testing.
      if (!expected) {
        if (process.env.NODE_ENV === 'development' && process.env.ALLOW_NO_API_KEY === 'true') {
          req.telemetry.authResult = 'disabled';
          stage.setAttribute('auth.result', 'disabled');
          return;
        }

        req.telemetry.authResult = 'misconfigured';
        stage.setAttribute('auth.result', 'misconfigured');
        throw createHttpError(500, 'APP_API_KEY not configured on server', {
          type: 'ConfigurationError',
          code: 'APP_API_KEY_MISSING',
        });
      }

      if (provided !== expected) {
        req.telemetry.authResult = provided ? 'rejected' : 'missing';
        stage.setAttribute('auth.result', req.telemetry.authResult);
        throw createHttpError(
          401,
          'invalid or missing API key. Provide x-api-key header, Authorization: ApiKey <key>, or ?api_key=...',
          { type: 'AuthenticationError', code: 'API_KEY_REJECTED' }
        );
      }

      req.telemetry.authenticated = true;
      req.telemetry.authResult = 'accepted';
      stage.setAttribute('auth.result', 'accepted');
    }
  ).then(
    () => next(),
    (error) => {
      markRequestError(req, error, 'API_KEY_REJECTED');
      res.status(error.status || 500).json({ error: error.message || 'Server error' });
    }
  );
}
