const PROVIDER_ERROR_CODE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const PROVIDER_IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export function providerFailureAttributes(error) {
  const statusCode = Number(error?.status ?? error?.statusCode);
  const providerError = error?.error?.error ?? error?.error;
  const code =
    typeof error?.code === 'string'
      ? error.code
      : typeof providerError?.code === 'string'
        ? providerError.code
        : undefined;
  const errorType = typeof providerError?.type === 'string' ? providerError.type : undefined;
  const requestId = typeof error?.requestID === 'string' ? error.requestID : undefined;

  return {
    'provider.status': 'error',
    'provider.error.status_code':
      Number.isInteger(statusCode) && statusCode >= 100 && statusCode <= 599
        ? statusCode
        : undefined,
    'provider.error.code': PROVIDER_ERROR_CODE_PATTERN.test(code || '') ? code : 'UNKNOWN',
    'provider.error.type': PROVIDER_IDENTIFIER_PATTERN.test(errorType || '')
      ? errorType
      : undefined,
    'provider.request_id': PROVIDER_IDENTIFIER_PATTERN.test(requestId || '')
      ? requestId
      : undefined,
  };
}

export function safeEndpointOrigin(baseUrl = process.env.ANTHROPIC_BASE_URL) {
  try {
    return new URL(baseUrl || 'https://api.anthropic.com').origin;
  } catch {
    return 'INVALID_ENDPOINT';
  }
}
