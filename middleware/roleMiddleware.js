// backend/middleware/roleMiddleware.js

const { expandRoles } = require('../utils/roles');
const { assertBackoffice } = require('../utils/habilitations');

module.exports = (roles, options = {}) => {
    const allowed = expandRoles(roles);
    if (!options.centralOnly && roles.includes('admin')) allowed.add('backoffice');

    return async function (req, res, next) {
        if (!req.user || !req.user.role) {
            return res.status(401).json({ msg: 'Acces refuse : role non defini.' });
        }

        if (!allowed.has(req.user.role)) {
            return res.status(403).json({ msg: 'Acces refuse : vous n\'avez pas les permissions necessaires.' });
        }

        if (req.user.role === 'backoffice') {
            try {
                await assertBackoffice(req);
            } catch (err) {
                return res.status(err.statusCode || 403).json({ msg: err.message });
            }
        }

        return next();
    };
};