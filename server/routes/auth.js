import jwt from 'jsonwebtoken';
import { randomBytes } from 'crypto';
import * as db from '../db.js';
import { JWT_SECRET, authMiddleware, adminMiddleware } from '../middleware/auth.js';
import { hashPassword } from '../utils.js';

function doRegister(req, res) {
  const { username, password } = req.body;
  const existing = db.getUser(username);
  if (existing) return res.status(409).json({ error: 'User already exists' });
  db.createUser(username, hashPassword(password, JWT_SECRET));
  const token = jwt.sign({ username }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ token });
}

export default function(app) {
  app.post('/api/auth/register', (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Username and password required' });

    const count = db.userCount();
    if (count > 0) {
      return authMiddleware(req, res, () => {
        const admin = db.getUser(req.user.username);
        if (!admin || !admin.is_admin) return res.status(403).json({ error: 'Admin only' });
        doRegister(req, res);
      });
    }
    doRegister(req, res);
  });

  app.post('/api/auth/login', (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
    const user = db.getUser(username);
    if (!user || user.password_hash !== hashPassword(password, JWT_SECRET)) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    const token = jwt.sign({ username, is_admin: user.is_admin }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, is_admin: user.is_admin });
  });

  app.get('/api/auth/check', authMiddleware, (req, res) => {
    const user = db.getUser(req.user.username);
    res.json({ valid: true, username: req.user.username, is_admin: user?.is_admin || false });
  });

  app.get('/api/auth/users', adminMiddleware, (req, res) => {
    res.json(db.listUsers());
  });

  app.delete('/api/auth/users/:username', adminMiddleware, (req, res) => {
    if (req.params.username === req.user.username) {
      return res.status(400).json({ error: 'Cannot delete yourself' });
    }
    try {
      db.deleteUser(req.params.username);
      res.json({ success: true });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  app.post('/api/auth/change-password', adminMiddleware, (req, res) => {
    const { username, newPassword } = req.body;
    if (!username || !newPassword) return res.status(400).json({ error: 'Username and new password required' });
    const user = db.getUser(username);
    if (!user) return res.status(404).json({ error: 'User not found' });
    db.changePassword(username, hashPassword(newPassword, JWT_SECRET));
    res.json({ success: true });
  });

  app.post('/api/auth/change-my-password', authMiddleware, (req, res) => {
    const { newPassword } = req.body;
    if (!newPassword) return res.status(400).json({ error: 'New password required' });
    db.changePassword(req.user.username, hashPassword(newPassword, JWT_SECRET));
    res.json({ success: true });
  });

  app.get('/api/auth/apikeys', adminMiddleware, (req, res) => {
    res.json(db.listApiKeys());
  });

  app.post('/api/auth/apikeys', adminMiddleware, (req, res) => {
    const { name } = req.body;
    if (!name) return res.status(400).json({ error: 'Name required' });
    const key = 'ef_' + randomBytes(24).toString('hex');
    db.createApiKey(name, key);
    res.json({ name, key });
  });

  app.delete('/api/auth/apikeys/:id', adminMiddleware, (req, res) => {
    db.deleteApiKey(parseInt(req.params.id));
    res.json({ success: true });
  });
}
