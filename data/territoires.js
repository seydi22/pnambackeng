/**
 * Fonctions pures sur un découpage déjà chargé.
 * La liste officielle vit en base (GeoReferentiel), pas dans l'application.
 */

function slug(value) {
    return String(value || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^A-Za-z0-9]+/g, '')
        .toUpperCase();
}

function findMoughataa(tree, region, moughataa) {
    const found = (tree || []).find((item) => item.region === region);
    if (!found) {
        const error = new Error('REGION');
        throw error;
    }
    const zone = (found.moughataas || []).find((item) => item.nom === moughataa);
    if (!zone) {
        const error = new Error('MOUGHATAA');
        throw error;
    }
    return { region: found, moughataa: zone };
}

function territoryStem(tree, region, moughataa) {
    const found = findMoughataa(tree, region, moughataa).region;
    return [found.code, slug(moughataa)].join('-');
}

const NOUAKCHOTT = ['Nouakchott-Nord', 'Nouakchott-Ouest', 'Nouakchott-Sud'];

function isNouakchott(name) {
    return NOUAKCHOTT.includes(String(name || '').trim());
}

function scopeSlice(tree, region, moughataa) {
    const zone = findMoughataa(tree, region, moughataa).moughataa;
    return {
        verrouille: true,
        mode: 'moughataa',
        region,
        moughataa,
        communes: zone.communes || [],
    };
}

function scopeZone(tree, wilayas) {
    const wanted = new Set(wilayas || []);
    const territoires = (tree || [])
        .filter((item) => wanted.has(item.region))
        .map((item) => ({
            region: item.region,
            moughataas: (item.moughataas || []).map((moughataa) => ({
                nom: moughataa.nom,
                communes: moughataa.communes || [],
            })),
        }));
    return {
        verrouille: false,
        mode: 'zone',
        territoires,
    };
}

module.exports = {
    NOUAKCHOTT,
    isNouakchott,
    slug,
    territoryStem,
    scopeSlice,
    scopeZone,
};
