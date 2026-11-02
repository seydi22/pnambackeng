const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');

const FIELD_PREFIX = {
    pieceIdentiteRecto: 'piece_recto',
    pieceIdentiteVerso: 'piece_verso',
    photoPasseport: 'passeport',
    photoEnseigne: 'enseigne',
    qrCodePhoto: 'qr',
    paymentTestPhoto: 'paiement',
};

function storageMode() {
    const explicit = String(process.env.STORAGE_DRIVER || '').trim().toLowerCase();
    if (explicit === 'disk' || explicit === 'local' || explicit === 'vm') return 'disk';
    if (explicit === 'cloudinary') return 'cloudinary';
    if (!process.env.CLOUDINARY_CLOUD_NAME && (process.env.UPLOAD_DIR || process.env.PUBLIC_UPLOAD_BASE)) {
        return 'disk';
    }
    return 'cloudinary';
}

function uploadDirectory() {
    if (process.env.UPLOAD_DIR) return path.resolve(process.env.UPLOAD_DIR);
    return path.join(__dirname, '..', 'uploads');
}

function publicUploadBase() {
    const explicit = String(process.env.PUBLIC_UPLOAD_BASE || '').trim().replace(/\/$/, '');
    if (explicit) return explicit;
    const origin = String(process.env.PUBLIC_BASE_URL || '').trim().replace(/\/$/, '');
    if (origin) return `${origin}/uploads`;
    const port = process.env.PORT || 5000;
    return `http://localhost:${port}/uploads`;
}

function ensureUploadDir() {
    const dir = uploadDirectory();
    fs.mkdirSync(dir, { recursive: true });
    fs.accessSync(dir, fs.constants.W_OK);
    return dir;
}

function extensionFor(file) {
    const mime = String(file.mimetype || '').toLowerCase();
    if (mime === 'image/png') return '.png';
    if (mime === 'image/webp') return '.webp';
    const name = String(file.originalname || '').toLowerCase();
    if (name.endsWith('.png')) return '.png';
    if (name.endsWith('.webp')) return '.webp';
    return '.jpg';
}

function diskEngine() {
    const dir = uploadDirectory();
    const base = publicUploadBase();
    return {
        _handleFile(_req, file, cb) {
            try {
                ensureUploadDir();
            } catch (err) {
                return cb(err);
            }
            const prefix = FIELD_PREFIX[file.fieldname] || 'fichier';
            const filename = `${prefix}_${Date.now()}_${crypto.randomBytes(4).toString('hex')}${extensionFor(file)}`;
            const full = path.join(dir, filename);
            const out = fs.createWriteStream(full);
            file.stream.pipe(out);
            out.on('error', (err) => cb(err));
            out.on('finish', () => {
                cb(null, {
                    path: `${base}/${filename}`,
                    filename,
                    destination: dir,
                    size: out.bytesWritten,
                });
            });
        },
        _removeFile(_req, file, cb) {
            if (!file.filename) return cb(null);
            fs.unlink(path.join(dir, file.filename), () => cb(null));
        },
    };
}

function cloudinaryEngine() {
    const cloudinary = require('cloudinary').v2;
    const { CloudinaryStorage } = require('multer-storage-cloudinary');
    cloudinary.config({
        cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
        api_key: process.env.CLOUDINARY_API_KEY,
        api_secret: process.env.CLOUDINARY_API_SECRET,
    });
    return new CloudinaryStorage({
        cloudinary,
        params: (_req, file) => {
            const prefix = FIELD_PREFIX[file.fieldname] || 'fichier';
            return {
                folder: 'enrolement_marchand',
                format: 'jpg',
                public_id: `${prefix}_${Date.now()}`,
            };
        },
    });
}

function imageFileFilter(_req, file, cb) {
    const allowed = new Set(['image/jpeg', 'image/jpg', 'image/png', 'image/webp']);
    const mime = String(file.mimetype || '').toLowerCase();
    const name = String(file.originalname || '').toLowerCase();
    const looksLikeImage =
        /\.(jpe?g|png|webp)$/i.test(name) ||
        mime === 'application/octet-stream' ||
        mime === '' ||
        mime === 'binary/octet-stream';
    if (allowed.has(mime) || looksLikeImage) return cb(null, true);
    return cb(new Error('Type de fichier non autorise. Images JPEG, PNG ou WebP uniquement.'));
}

function createMerchantUpload() {
    const storage = storageMode() === 'disk' ? diskEngine() : cloudinaryEngine();
    return multer({
        storage,
        limits: {
            fileSize: 5 * 1024 * 1024,
            files: 6,
        },
        fileFilter: imageFileFilter,
    });
}

module.exports = {
    storageMode,
    uploadDirectory,
    publicUploadBase,
    ensureUploadDir,
    createMerchantUpload,
};
