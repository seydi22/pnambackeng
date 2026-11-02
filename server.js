const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const helmet = require('helmet');
const dotenv = require('dotenv');
const fs = require('fs');
const path = require('path');
const images = require('./services/imageStorage');

dotenv.config();

const agentRoutes = require('./routes/agentRoutes');
const merchantRoutes = require('./routes/merchantRoutes');
const logRoutes = require('./routes/logRoutes');
const exportRoutes = require('./routes/exportRoutes');
const appRoutes = require('./routes/appRoutes');
const { errorHandler } = require('./middleware/errorMiddleware');
const logMiddleware = require('./middleware/logger');

if (!process.env.MONGO_URI) {
    console.error('Erreur: MONGO_URI n\'est pas definie.');
    process.exit(1);
}

if (!process.env.JWT_SECRET) {
    console.error('Erreur: JWT_SECRET n\'est pas defini.');
    process.exit(1);
}

const app = express();
const PORT = process.env.PORT || 5000;

app.set('trust proxy', 1);

app.use(helmet({
    crossOriginResourcePolicy: { policy: 'cross-origin' },
}));

const defaultOrigins = [
    'https://moovmoney-souscripteur-web.vercel.app',
];

if (process.env.NODE_ENV !== 'production') {
    defaultOrigins.push(
        'http://localhost:3000',
        'http://localhost:5173',
        'http://127.0.0.1:3000',
        'http://127.0.0.1:5173'
    );
}
const allowedOrigins = String(process.env.CORS_ORIGINS || defaultOrigins.join(','))
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

app.use(cors({
    origin(origin, callback) {
        // Outils serveur / mobile natif sans header Origin
        if (!origin) return callback(null, true);
        if (allowedOrigins.includes('*')) return callback(null, true);
        if (allowedOrigins.includes(origin)) return callback(null, true);
        // Dev: Flutter web / ports dynamiques (localhost:xxxxx)
        if (process.env.NODE_ENV !== 'production' &&
            /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin)) {
            return callback(null, true);
        }
        return callback(new Error(`CORS bloque pour l'origine: ${origin}`));
    },
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'x-auth-token'],
}));

// Erreurs CORS → 403 JSON (sinon 500 via errorHandler)
app.use((err, req, res, next) => {
    if (err && /CORS bloque/i.test(err.message || '')) {
        return res.status(403).json({ message: err.message });
    }
    return next(err);
});

app.use(logMiddleware);

const jsonLimit = process.env.JSON_BODY_LIMIT || '1mb';
app.use(express.json({ limit: jsonLimit }));
app.use(express.urlencoded({ extended: true, limit: jsonLimit }));

if (images.storageMode() === 'disk') {
    try {
        const dir = images.ensureUploadDir();
        console.log(`Images sur disque : ${dir}`);
        console.log(`URL publique des images : ${images.publicUploadBase()}`);
    } catch (err) {
        console.error('Dossier images inaccessible. Verifiez UPLOAD_DIR et le partage de la machine donnees.', err.message);
        process.exit(1);
    }
} else {
    console.log('Images : Cloudinary');
}

app.use('/uploads', express.static(images.uploadDirectory(), {
    index: false,
    dotfiles: 'deny',
    fallthrough: true,
    maxAge: '7d',
}));

app.use('/api/agents', agentRoutes);
app.use('/api/merchants', merchantRoutes);
app.use('/api/logs', logRoutes);
app.use('/api/export', exportRoutes);
app.use('/api/app', appRoutes);
app.use('/api/organization', require('./routes/organizationRoutes'));
app.use('/api/notifications', require('./routes/notificationRoutes'));
app.use('/api/tournees', require('./routes/tourneeRoutes'));
app.use('/api/positions', require('./routes/positionRoutes'));
app.use('/api/materiels', require('./routes/materielRoutes'));
app.use('/api/alertes-fraude', require('./routes/fraudeRoutes'));
app.use('/api/portal-users', require('./routes/portalUserRoutes'));

app.get('/api/performance/export', (req, res) => {
    const queryString = new URLSearchParams(req.query).toString();
    res.redirect(301, `/api/export/performance?${queryString}`);
});

app.get('/api/suivi/export', (req, res) => {
    const queryString = new URLSearchParams(req.query).toString();
    res.redirect(301, `/api/export/suivi?${queryString}`);
});

app.get('/api/health', (_req, res) => {
    const db = mongoose.connection.readyState === 1;
    res.status(db ? 200 : 503).json({
        ok: db,
        mongo: db ? 'connecte' : 'indisponible',
        stockage: images.storageMode(),
    });
});

app.get('/', (req, res) => {
    res.send('API Moov Money est en cours d\'execution.');
});

if (/^(1|true|oui|yes)$/i.test(String(process.env.SERVE_FRONTEND || ''))) {
    const front = process.env.FRONTEND_BUILD_DIR
        ? path.resolve(process.env.FRONTEND_BUILD_DIR)
        : path.join(__dirname, '..', 'admin-dashboard', 'build');
    const indexFile = path.join(front, 'index.html');
    if (fs.existsSync(indexFile)) {
        app.use(express.static(front, { index: false }));
        app.use((req, res, next) => {
            if (req.method !== 'GET' && req.method !== 'HEAD') return next();
            if (req.path.startsWith('/api') || req.path.startsWith('/uploads')) return next();
            res.sendFile(indexFile, (err) => {
                if (err) next(err);
            });
        });
        console.log(`Portail web servi depuis ${front}`);
    } else {
        console.error(`Build du portail introuvable : ${indexFile}`);
    }
}

app.use(errorHandler);

function mongoTarget(uri) {
    const text = String(uri || '');
    const withUser = text.match(/@([^/?]+)/);
    if (withUser) return withUser[1];
    const plain = text.match(/\/\/([^/?]+)/);
    return plain ? plain[1] : 'mongo';
}

const mongoHost = mongoTarget(process.env.MONGO_URI);
mongoose.connect(process.env.MONGO_URI)
    .then(() => {
        console.log(`Connexion a MongoDB reussie (${mongoHost}).`);
    })
    .catch((err) => {
        console.error(`Erreur de connexion a MongoDB (${mongoHost})`, err);
    });

const HOST = process.env.HOST || '0.0.0.0';
app.listen(PORT, HOST, () => {
    console.log(`Serveur en cours d'execution sur http://${HOST}:${PORT}`);
});
