const KycReferentiel = require('../models/KycReferentiel');
const { KYC_SEED, TAILLES } = require('../data/kycSeed');

class KycError extends Error {
    constructor(message, statusCode = 400) {
        super(message);
        this.statusCode = statusCode;
    }
}

function clean(value) {
    if (value == null) return '';
    return String(value).trim();
}

function normalizeTree(secteurs) {
    if (!Array.isArray(secteurs) || secteurs.length === 0) {
        throw new KycError('Au moins un secteur est requis.');
    }
    const seenSecteurs = new Set();
    return secteurs.map((secteur) => {
        const nom = clean(secteur && secteur.nom);
        if (!nom) throw new KycError('Chaque secteur doit avoir un nom.');
        const key = nom.toLowerCase();
        if (seenSecteurs.has(key)) throw new KycError(`Secteur en double : ${nom}.`);
        seenSecteurs.add(key);

        const categories = Array.isArray(secteur.categories) ? secteur.categories : [];
        if (categories.length === 0) {
            throw new KycError(`Le secteur ${nom} doit avoir au moins une categorie.`);
        }
        const seenCategories = new Set();
        const normalizedCategories = categories.map((categorie) => {
            const categorieNom = clean(categorie && categorie.nom);
            if (!categorieNom) throw new KycError(`Categorie sans nom dans ${nom}.`);
            const categorieKey = categorieNom.toLowerCase();
            if (seenCategories.has(categorieKey)) {
                throw new KycError(`Categorie en double dans ${nom} : ${categorieNom}.`);
            }
            seenCategories.add(categorieKey);
            const naturesRaw = Array.isArray(categorie.natures) ? categorie.natures : [];
            const natures = [];
            const seenNatures = new Set();
            naturesRaw.forEach((nature) => {
                const natureNom = clean(nature);
                if (!natureNom) return;
                const natureKey = natureNom.toLowerCase();
                if (seenNatures.has(natureKey)) return;
                seenNatures.add(natureKey);
                natures.push(natureNom);
            });
            if (natures.length === 0) {
                throw new KycError(`La categorie ${categorieNom} doit avoir au moins une nature.`);
            }
            return { nom: categorieNom, natures };
        });
        return { nom, categories: normalizedCategories };
    });
}

async function getReferentiel() {
    let doc = await KycReferentiel.findOne({ key: 'default' });
    if (!doc) {
        doc = await KycReferentiel.create({ key: 'default', secteurs: KYC_SEED });
    }
    return doc;
}

async function updateReferentiel(secteurs) {
    const tree = normalizeTree(secteurs);
    const doc = await KycReferentiel.findOneAndUpdate(
        { key: 'default' },
        { $set: { secteurs: tree } },
        { new: true, upsert: true }
    );
    return doc;
}

function selectionMatches(doc, { secteur, categorie, typeCommerce }) {
    const secteurNom = clean(secteur);
    const categorieNom = clean(categorie);
    const natureNom = clean(typeCommerce);
    const foundSecteur = (doc.secteurs || []).find((item) => item.nom === secteurNom);
    if (!foundSecteur) return false;
    const foundCategorie = (foundSecteur.categories || []).find((item) => item.nom === categorieNom);
    if (!foundCategorie) return false;
    return (foundCategorie.natures || []).includes(natureNom);
}

async function assertSelection(values) {
    const taille = clean(values.taille);
    const localite = clean(values.localite);
    const secteur = clean(values.secteur);
    const categorie = clean(values.categorie);
    const typeCommerce = clean(values.typeCommerce);

    if (!TAILLES.includes(taille)) {
        throw new KycError('Taille invalide. Valeurs autorisees : Gros, Moyen, Petit.');
    }
    if (!localite) throw new KycError('La localite est requise.');
    if (!secteur || !categorie || !typeCommerce) {
        throw new KycError('Secteur, categorie et nature sont requis.');
    }

    const doc = await getReferentiel();
    if (!selectionMatches(doc, { secteur, categorie, typeCommerce })) {
        throw new KycError('Secteur, categorie ou nature hors referentiel.');
    }

    return { taille, localite, secteur, categorie, typeCommerce };
}

module.exports = {
    KycError,
    TAILLES,
    getReferentiel,
    updateReferentiel,
    assertSelection,
};
