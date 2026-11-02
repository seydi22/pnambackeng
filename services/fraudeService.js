const sharp = require('sharp');
const Merchant = require('../models/Merchant');
const EmpreinteImage = require('../models/EmpreinteImage');
const AlerteFraude = require('../models/AlerteFraude');

const SEUIL = 85;
const KIND_LABEL = {
    enseigne: 'Enseigne',
    piece: 'Pièce d\'identité',
};

function pieceUrl(merchant) {
    const piece = merchant.pieceIdentite || {};
    return piece.cniRectoUrl || piece.passeportUrl || '';
}

function scoreBits(a, b) {
    if (!a || !b || a.length !== b.length) return 0;
    let distance = 0;
    for (let i = 0; i < a.length; i += 1) {
        if (a[i] !== b[i]) distance += 1;
    }
    return Math.round((1 - distance / a.length) * 100);
}

async function hashBuffer(buffer, portrait) {
    let pipeline = sharp(buffer).rotate();
    if (portrait) {
        const meta = await sharp(buffer).rotate().metadata();
        const width = Math.max(8, Math.round((meta.width || 8) * 0.42));
        const height = meta.height || 8;
        pipeline = sharp(buffer).rotate().extract({ left: 0, top: 0, width, height });
    }
    const { data, info } = await pipeline.resize(17, 16, { fit: 'fill' }).greyscale().raw().toBuffer({ resolveWithObject: true });
    const cols = info.width;
    let bits = '';
    for (let y = 0; y < info.height; y += 1) {
        for (let x = 0; x < cols - 1; x += 1) {
            const index = y * cols + x;
            bits += data[index] > data[index + 1] ? '1' : '0';
        }
    }
    return bits;
}

async function download(url) {
    const response = await fetch(url, { signal: AbortSignal.timeout(20000) });
    if (!response.ok) throw new Error(`Image inaccessible (${response.status})`);
    return Buffer.from(await response.arrayBuffer());
}

async function sauverEmpreinte(merchantId, kind, url, bits) {
    await EmpreinteImage.findOneAndUpdate(
        { merchantId, kind },
        { url, bits },
        { upsert: true, new: true, setDefaultsOnInsert: true }
    );
}

async function empreindre(merchant) {
    const jobs = [];
    if (merchant.photoEnseigneUrl) jobs.push(['enseigne', merchant.photoEnseigneUrl, false]);
    const piece = pieceUrl(merchant);
    if (piece) {
        jobs.push(['piece', piece, false]);
        jobs.push(['portrait', piece, true]);
    }
    const bufferCache = new Map();
    for (const [kind, url, portrait] of jobs) {
        const existing = await EmpreinteImage.findOne({ merchantId: merchant._id, kind, url }).select('_id');
        if (existing) continue;
        try {
            if (!bufferCache.has(url)) bufferCache.set(url, await download(url));
            const bits = await hashBuffer(bufferCache.get(url), portrait);
            if (bits) await sauverEmpreinte(merchant._id, kind, url, bits);
        } catch (err) {
            console.error(`Empreinte ${kind} ${merchant._id}:`, err.message);
        }
    }
}

async function completerManquantes(limit) {
    const deja = await EmpreinteImage.distinct('merchantId', { kind: 'enseigne' });
    const merchants = await Merchant.find({
        _id: { $nin: deja },
        photoEnseigneUrl: { $exists: true, $ne: '' },
    }).select('nom photoEnseigneUrl pieceIdentite').limit(limit);
    for (const merchant of merchants) {
        await empreindre(merchant);
    }
}

function pairIds(a, b) {
    return [String(a), String(b)].sort();
}

async function poserAlerte(merchantId, autreId, kind, score, bitsA, bitsB) {
    const [gauche, droite] = pairIds(merchantId, autreId);
    const actuelle = await AlerteFraude.findOne({ merchantId: gauche, autreMerchantId: droite, kind });
    if (score < SEUIL) {
        if (actuelle && actuelle.statut === 'ouverte') {
            actuelle.statut = 'ecartee';
            actuelle.score = score;
            actuelle.ecarteeAt = new Date();
            await actuelle.save();
        }
        return;
    }
    if (actuelle && actuelle.statut === 'ecartee' && actuelle.bitsA === bitsA && actuelle.bitsB === bitsB) return;
    await AlerteFraude.findOneAndUpdate(
        { merchantId: gauche, autreMerchantId: droite, kind },
        {
            score,
            statut: 'ouverte',
            bitsA,
            bitsB,
            ecarteeAt: null,
        },
        { upsert: true, setDefaultsOnInsert: true }
    );
}

async function comparer(merchantId, kind) {
    const mine = await EmpreinteImage.findOne({ merchantId, kind }).lean();
    if (!mine) return;
    const autres = await EmpreinteImage.find({ kind, merchantId: { $ne: merchantId } }).lean();
    const portraits = kind === 'piece'
        ? await EmpreinteImage.find({ kind: 'portrait' }).lean()
        : [];
    const portraitParMerchant = new Map(portraits.map((item) => [String(item.merchantId), item.bits]));
    const monPortrait = portraitParMerchant.get(String(merchantId)) || '';
    for (const autre of autres) {
        let valeur = scoreBits(mine.bits, autre.bits);
        if (kind === 'piece') {
            valeur = Math.max(valeur, scoreBits(monPortrait, portraitParMerchant.get(String(autre.merchantId)) || ''));
        }
        const [bitsA, bitsB] = [mine.bits, autre.bits].sort();
        await poserAlerte(merchantId, autre.merchantId, kind, valeur, bitsA, bitsB);
    }
}

async function examiner(merchantId) {
    try {
        const merchant = await Merchant.findById(merchantId).select('nom photoEnseigneUrl pieceIdentite');
        if (!merchant) return;
        await empreindre(merchant);
        await completerManquantes(8);
        await comparer(merchantId, 'enseigne');
        await comparer(merchantId, 'piece');
    } catch (err) {
        console.error('Anti-fraude:', err.message);
    }
}

const DOSSIER_FIELDS = 'nom statut photoEnseigneUrl pieceIdentite region ville commune localite adresse nomGerant prenomGerant contact secteur categorie typeCommerce taille createdAt operators agentRecruteurId';

function personne(agent) {
    if (!agent || !agent.nom) return '';
    const nom = [agent.prenom, agent.nom].filter(Boolean).join(' ');
    return agent.matricule ? `${nom} (${agent.matricule})` : nom;
}

function resume(merchant) {
    if (!merchant) return null;
    const piece = merchant.pieceIdentite || {};
    const gerant = [merchant.prenomGerant, merchant.nomGerant].filter(Boolean).join(' ');
    const operators = (merchant.operators || []).map((item) => ({
        nom: [item.prenom, item.nom].filter(Boolean).join(' '),
        nni: item.nni || '',
        telephone: item.telephone || '',
    }));
    return {
        _id: merchant._id,
        nom: merchant.nom,
        statut: merchant.statut,
        secteur: merchant.secteur || '',
        categorie: merchant.categorie || '',
        typeCommerce: merchant.typeCommerce || '',
        taille: merchant.taille || '',
        region: merchant.region || '',
        ville: merchant.ville || '',
        commune: merchant.commune || '',
        localite: merchant.localite || '',
        adresse: merchant.adresse || '',
        gerant,
        contact: merchant.contact || '',
        typePiece: piece.type || '',
        photoEnseigneUrl: merchant.photoEnseigneUrl || '',
        pieceUrl: pieceUrl(merchant),
        pieceVersoUrl: piece.cniVersoUrl || '',
        createdAt: merchant.createdAt || null,
        equipe: personne(merchant.agentRecruteurId),
        operators,
    };
}

async function list(statut) {
    const filter = statut === 'toutes' ? {} : { statut: statut || 'ouverte' };
    const alertes = await AlerteFraude.find(filter)
        .sort({ score: -1, updatedAt: -1 })
        .limit(200)
        .populate('merchantId', 'nom region ville')
        .populate('autreMerchantId', 'nom region ville')
        .lean();
    return alertes.map((alerte) => ({
        _id: alerte._id,
        kind: alerte.kind,
        kindLabel: KIND_LABEL[alerte.kind] || alerte.kind,
        score: alerte.score,
        statut: alerte.statut,
        createdAt: alerte.createdAt,
        merchantId: alerte.merchantId && alerte.merchantId._id,
        merchantNom: alerte.merchantId && alerte.merchantId.nom ? alerte.merchantId.nom : '—',
        merchantLieu: alerte.merchantId ? [alerte.merchantId.ville, alerte.merchantId.region].filter(Boolean).join(', ') : '',
        autreMerchantId: alerte.autreMerchantId && alerte.autreMerchantId._id,
        autreMerchantNom: alerte.autreMerchantId && alerte.autreMerchantId.nom ? alerte.autreMerchantId.nom : '—',
        autreMerchantLieu: alerte.autreMerchantId ? [alerte.autreMerchantId.ville, alerte.autreMerchantId.region].filter(Boolean).join(', ') : '',
    }));
}

async function detail(id) {
    const alerte = await AlerteFraude.findById(id).lean();
    if (!alerte) {
        const error = new Error('Alerte introuvable.');
        error.statusCode = 404;
        throw error;
    }
    const [gauche, droite] = await Promise.all([
        Merchant.findById(alerte.merchantId).select(DOSSIER_FIELDS).populate('agentRecruteurId', 'matricule nom prenom').lean(),
        Merchant.findById(alerte.autreMerchantId).select(DOSSIER_FIELDS).populate('agentRecruteurId', 'matricule nom prenom').lean(),
    ]);
    return {
        _id: alerte._id,
        kind: alerte.kind,
        kindLabel: KIND_LABEL[alerte.kind] || alerte.kind,
        score: alerte.score,
        statut: alerte.statut,
        seuil: SEUIL,
        createdAt: alerte.createdAt,
        motif: alerte.kind === 'piece'
            ? 'La pièce d’identité, y compris la zone du portrait, ressemble à celle d’un autre dossier.'
            : 'La photo de l’enseigne ressemble à celle d’un autre dossier.',
        gauche: resume(gauche),
        droite: resume(droite),
    };
}

async function ecarter(id) {
    const alerte = await AlerteFraude.findById(id);
    if (!alerte) {
        const error = new Error('Alerte introuvable.');
        error.statusCode = 404;
        throw error;
    }
    alerte.statut = 'ecartee';
    alerte.ecarteeAt = new Date();
    await alerte.save();
    return { ok: true };
}

setImmediate(() => {
    completerManquantes(20).catch((err) => console.error('Anti-fraude:', err.message));
});

module.exports = {
    SEUIL,
    examiner,
    list,
    detail,
    ecarter,
};
