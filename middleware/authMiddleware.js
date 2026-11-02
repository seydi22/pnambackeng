const jwt = require('jsonwebtoken');
const Agent = require('../models/Agent');

function extractToken(req) {
    const headerToken = req.header('x-auth-token');
    if (headerToken) return headerToken;

    const authHeader = req.header('Authorization');
    if (authHeader && authHeader.startsWith('Bearer ')) {
        return authHeader.slice(7).trim();
    }

    return null;
}

module.exports = async function (req, res, next) {
    const token = extractToken(req);

    if (!token) {
        return res.status(401).json({ msg: 'Aucun token, autorisation refusee' });
    }

    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        req.user = decoded.user;

        if (req.user && req.user.role === 'aam') {
            const agent = await Agent.findById(req.user.id).select('sessionStamp actif');
            if (!agent || agent.actif === false) {
                return res.status(401).json({ msg: 'Compte desactive.', code: 'session_replaced' });
            }
            if (!req.user.sessionStamp || agent.sessionStamp !== req.user.sessionStamp) {
                return res.status(401).json({
                    msg: 'Une autre connexion utilise le compte de l equipe. Reconnectez-vous.',
                    code: 'session_replaced',
                });
            }
        }

        return next();
    } catch (err) {
        return res.status(401).json({ msg: 'Token invalide' });
    }
};
