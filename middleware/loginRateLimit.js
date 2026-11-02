// backend/middleware/loginRateLimit.js
// Rate-limit leger en memoire (sans dependance externe) pour POST /login.

const WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const MAX_ATTEMPTS = 10;

const attemptsByKey = new Map();

function getClientKey(req) {
    const matricule = req.body && req.body.matricule
        ? String(req.body.matricule).trim().toLowerCase()
        : '';
    const ip = req.ip || (req.connection && req.connection.remoteAddress) || 'unknown';
    return `${ip}::${matricule || 'no-matricule'}`;
}

function pruneExpired(now) {
    for (const [key, entry] of attemptsByKey.entries()) {
        if (now - entry.windowStart >= WINDOW_MS) {
            attemptsByKey.delete(key);
        }
    }
}

function loginRateLimit(req, res, next) {
    const now = Date.now();
    if (attemptsByKey.size > 5000) {
        pruneExpired(now);
    }

    const key = getClientKey(req);
    let entry = attemptsByKey.get(key);

    if (!entry || now - entry.windowStart >= WINDOW_MS) {
        entry = { windowStart: now, count: 0 };
        attemptsByKey.set(key, entry);
    }

    entry.count += 1;

    if (entry.count > MAX_ATTEMPTS) {
        const retryAfterSec = Math.ceil((WINDOW_MS - (now - entry.windowStart)) / 1000);
        res.setHeader('Retry-After', String(retryAfterSec));
        return res.status(429).json({
            msg: 'Trop de tentatives de connexion. Reessayez plus tard.',
        });
    }

    return next();
}

module.exports = loginRateLimit;
