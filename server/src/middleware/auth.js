export function requireApiKey(req, res, next) {
  const expected = process.env.APP_API_KEY;
  if (!expected) {
    return res.status(500).json({ error: 'APP_API_KEY not configured on server' });
  }
  const provided = req.header('x-api-key');
  if (provided !== expected) {
    return res.status(401).json({ error: 'invalid or missing x-api-key' });
  }
  next();
}
