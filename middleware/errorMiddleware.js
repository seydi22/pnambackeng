// backend/middleware/errorMiddleware.js

const errorHandler = (err, req, res, next) => {
    console.error(err.stack || err.message);

    if (err && /CORS bloque/i.test(err.message || '')) {
        return res.status(403).json({ message: err.message });
    }

    // Multer: taille / type de fichier
    if (err && err.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({
            message: 'Fichier trop volumineux (max 5 Mo).',
        });
    }
    if (err && err.code === 'LIMIT_FILE_COUNT') {
        return res.status(400).json({
            message: 'Trop de fichiers envoyes.',
        });
    }
    if (err && /Type de fichier non autorise/i.test(err.message || '')) {
        return res.status(400).json({
            message: err.message,
        });
    }

    const statusCode = err.statusCode || (res.statusCode === 200 ? 500 : res.statusCode);
    res.status(statusCode);

    res.json({
        message: err.message,
        stack: process.env.NODE_ENV === 'production' ? null : err.stack,
    });
};

module.exports = { errorHandler };
