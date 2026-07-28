import jwt from 'jsonwebtoken';
import { randomBytes } from 'crypto';
import * as db from '../db.js';

const JWT_SECRET = (() => {
  let secret = db.getSetting('jwt_secret');
  if (secret) return secret;
  secret = randomBytes(64).toString('hex');
  db.setSetting('jwt_secret', secret);
  return secret;
})();

function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing token' });
  }
  try {
    req.user = jwt.verify(authHeader.split(' ')[1], JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

function adminMiddleware(req, res, next) {
  authMiddleware(req, res, () => {
    const user = db.getUser(req.user.username);
    if (!user || !user.is_admin) return res.status(403).json({ error: 'Admin only' });
    next();
  });
}

function apiKeyAuth(req, res, next) {
  const key = req.headers['x-api-key'];
  if (!key) return res.status(401).json({ error: 'X-API-Key header required' });
  const valid = db.validateApiKey(key);
  if (!valid) return res.status(401).json({ error: 'Invalid API key' });
  req.apiKeyName = valid.name;
  next();
}

export { JWT_SECRET, authMiddleware, adminMiddleware, apiKeyAuth };
