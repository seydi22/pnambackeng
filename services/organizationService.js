const bcrypt = require('bcryptjs');
const Agent = require('../models/Agent');
const Pam = require('../models/Pam');
const Eam = require('../models/Eam');
const Zone = require('../models/Zone');
const { listZones } = require('./zoneService');
const { ORG_ROLES } = require('../utils/roles');
const { isNouakchott } = require('../data/territoires');
const geo = require('./geoReferentielService');
const { normalizeMoovMsisdn, isValidMoovMsisdn } = require('../utils/normalizeMsisdn');

class OrgError extends Error {
    constructor(message, statusCode = 400) {
        super(message);
        this.statusCode = statusCode;
    }
}

function clean(value) {
    if (value == null) return '';
    return String(value).trim();
}

function assertNni(nni) {
    const value = clean(nni);
    if (!/^\d{10}$/.test(value)) {
        throw new OrgError('NNI invalide : 10 chiffres.');
    }
    return value;
}

async function assertNniFree(nni, exceptId) {
    const query = { nni };
    if (exceptId) query._id = { $ne: exceptId };
    const taken = await Agent.findOne(query).select('_id');
    if (taken) throw new OrgError('Ce NNI est deja utilise.');
}

async function assertMsisdn(raw, exceptId) {
    if (!isValidMoovMsisdn(raw)) {
        throw new OrgError('Numero Moov Money invalide : 8 chiffres commencant par 4.');
    }
    const normalized = normalizeMoovMsisdn(raw);
    const query = { moovMoneyMsisdn: normalized };
    if (exceptId) query._id = { $ne: exceptId };
    const taken = await Agent.findOne(query).select('_id');
    if (taken) throw new OrgError('Ce numero Moov Money est deja utilise.');
    return normalized;
}

async function loadPam(pamId, { allowInactive = false } = {}) {
    const pam = await Pam.findById(pamId);
    if (!pam) throw new OrgError('PAM introuvable.');
    if (!allowInactive && pam.actif === false) throw new OrgError('Ce PAM est desactive.');
    return pam;
}

async function loadEam(eamId, { allowInactive = false } = {}) {
    const eam = await Eam.findById(eamId);
    if (!eam) throw new OrgError('EAM introuvable.');
    if (!allowInactive && eam.actif === false) throw new OrgError('Cette EAM est desactivee.');
    return eam;
}

async function activeTeamAccount(eamId, exceptId) {
    const query = { eamId, role: 'aam', actif: { $ne: false } };
    if (exceptId) query._id = { $ne: exceptId };
    return Agent.findOne(query).select('_id matricule nom prenom');
}

async function syncEamSupervisors(eamId) {
    const eam = await Eam.findById(eamId).select('samId');
    if (!eam) return;
    if (eam.samId) {
        await Agent.updateMany(
            { eamId: eam._id, role: 'aam' },
            { $set: { superviseurId: eam.samId } }
        );
        return;
    }
    await Agent.updateMany(
        { eamId: eam._id, role: 'aam' },
        { $unset: { superviseurId: 1 } }
    );
}

async function releaseExclusiveSeats(user) {
    if (user.role === 'sam') {
        const eams = await Eam.find({ samId: user._id }).select('_id');
        await Eam.updateMany({ samId: user._id }, { $unset: { samId: 1 } });
        for (const eam of eams) {
            await syncEamSupervisors(eam._id);
        }
    }
}

/**
 * PAM au sommet. SAM et CAM sont rattaches au PAM.
 * L'EAM est rattachee a un SAM. Elle a un seul compte de connexion.
 */
async function placeUser(user, { role, pamId, eamId }) {
    if (!ORG_ROLES.includes(role)) {
        throw new OrgError('Role invalide. Roles autorises : pam, cam, sam, aam.');
    }

    let pam;
    let eam;

    if (role === 'pam' || role === 'cam' || role === 'sam') {
        pam = await loadPam(pamId);
        if (role === 'pam' && user.actif !== false) {
            const holder = await Agent.findOne({
                pamId: pam._id,
                role: 'pam',
                actif: { $ne: false },
                _id: { $ne: user._id },
            }).select('_id');
            if (holder) throw new OrgError('Ce PAM a deja un compte.');
        }
    } else {
        eam = await loadEam(eamId);
        if (!eam.pamId) throw new OrgError('Cette EAM n est pas rattachee a un PAM.');
        pam = await loadPam(eam.pamId, { allowInactive: true });
        const existing = await activeTeamAccount(eam._id, user._id);
        if (user.actif !== false && existing) {
            throw new OrgError('Cette equipe a deja un compte de connexion.');
        }
    }

    const leavesSam = user.role === 'sam' && (role !== 'sam' || String(user.pamId || '') !== String(pam._id));
    if (leavesSam) await releaseExclusiveSeats(user);

    user.role = role;
    user.pamId = pam._id;
    user.uamId = undefined;
    user.eamId = undefined;
    user.superviseurId = undefined;
    user.affiliation = pam.nom;

    if (role === 'aam') {
        user.eamId = eam._id;
        user.affiliation = eam.nom;
        if (eam.samId) user.superviseurId = eam.samId;
    }

    await user.save();
    return user;
}

async function readStem(region, moughataa) {
    try {
        return await geo.stem(region, moughataa);
    } catch (err) {
        if (err && err.message === 'REGION') throw new OrgError('Region inconnue.');
        if (err && err.message === 'MOUGHATAA') throw new OrgError('Cette moughataa ne fait pas partie de la region.');
        throw new OrgError('La wilaya et la moughataa sont requises.');
    }
}

const SHORT_PREFIX = { PAM: 'P', SAM: 'S', CAM: 'C', EAM: 'E' };

async function nextCode(rolePrefix) {
    const letter = SHORT_PREFIX[rolePrefix];
    if (!letter) throw new OrgError('Role de code invalide.');
    const pattern = new RegExp(`^${letter}(\\d+)$`);
    const [agents, eams, pams] = await Promise.all([
        Agent.find({ matricule: pattern }).select('matricule').lean(),
        Eam.find({ nom: pattern }).select('nom').lean(),
        Pam.find({ nom: pattern }).select('nom').lean(),
    ]);
    let max = 0;
    [...agents, ...eams, ...pams].forEach((row) => {
        const value = row.matricule || row.nom || '';
        const match = pattern.exec(value);
        if (match) max = Math.max(max, Number(match[1]));
    });
    return `${letter}${String(max + 1).padStart(2, '0')}`;
}

function hasTerritory(pam) {
    return Boolean(pam && (pam.zoneId || (pam.region && pam.moughataa)));
}

async function assertZone(zoneId) {
    const zone = await Zone.findById(zoneId);
    if (!zone || zone.actif === false) throw new OrgError('Choisissez une zone active.');
    if (!(zone.wilayas || []).length) throw new OrgError('Cette zone ne contient encore aucune wilaya.');
    return zone;
}

async function previewCode({ role, region, moughataa, pamId, zoneId }) {
    const kind = clean(role).toLowerCase();
    const prefix = { pam: 'PAM', sam: 'SAM', cam: 'CAM', eam: 'EAM' }[kind];
    if (!prefix) throw new OrgError('Role de code invalide.');
    if (pamId) {
        const pam = await loadPam(pamId, { allowInactive: true });
        if (!hasTerritory(pam)) throw new OrgError('Rattachez ce PAM a une zone ou a une moughataa.');
        return nextCode(prefix);
    }
    if (zoneId) {
        await assertZone(zoneId);
        return nextCode(prefix);
    }
    const wilaya = clean(region);
    const mough = clean(moughataa);
    if (!isNouakchott(wilaya)) {
        throw new OrgError('Hors Nouakchott, creez le PAM dans une zone.');
    }
    await readStem(wilaya, mough);
    return nextCode(prefix);
}

async function createPam({ region, moughataa, zoneId, compte }) {
    if (!assertIdentity(compte, 'Compte PAM')) {
        throw new OrgError('Le compte du PAM est requis.');
    }
    const code = await nextCode('PAM');
    const payload = { nom: code };
    if (zoneId) {
        const zone = await assertZone(zoneId);
        payload.zoneId = zone._id;
    } else {
        const wilaya = clean(region);
        const mough = clean(moughataa);
        if (!isNouakchott(wilaya)) {
            throw new OrgError('Hors Nouakchott, le PAM se rattache a une zone.');
        }
        await readStem(wilaya, mough);
        payload.region = wilaya;
        payload.moughataa = mough;
    }
    const pam = await Pam.create(payload);
    try {
        await createOrgUser({ ...compte, matricule: code, role: 'pam', pamId: pam._id });
    } catch (err) {
        await Pam.deleteOne({ _id: pam._id });
        throw err;
    }
    return Pam.findById(pam._id);
}

async function updatePam(id, { nom, actif, region, moughataa, zoneId }) {
    const pam = await Pam.findById(id);
    if (!pam) throw new OrgError('PAM introuvable.', 404);
    if (nom != null) {
        const name = clean(nom);
        if (!name) throw new OrgError('Le nom du PAM est requis.');
        pam.nom = name;
        await Agent.updateMany({ pamId: pam._id, role: 'pam' }, { $set: { affiliation: name } });
    }
    if (zoneId) {
        const zone = await assertZone(zoneId);
        pam.zoneId = zone._id;
        pam.region = '';
        pam.moughataa = '';
    } else if (region != null || moughataa != null) {
        const nextRegion = clean(region);
        const nextMoughataa = clean(moughataa);
        if (!isNouakchott(nextRegion)) {
            throw new OrgError('Hors Nouakchott, affectez le PAM a une zone.');
        }
        await readStem(nextRegion, nextMoughataa);
        pam.region = nextRegion;
        pam.moughataa = nextMoughataa;
        pam.zoneId = null;
    }
    if (typeof actif === 'boolean') pam.actif = actif;
    await pam.save();
    return pam;
}

const SEAT_FIELDS = ['matricule', 'nom', 'prenom', 'nni', 'moovMoneyMsisdn', 'motDePasse'];

function seatStarted(seat) {
    if (!seat || typeof seat !== 'object') return false;
    return SEAT_FIELDS.some((key) => clean(seat[key]));
}

function assertSeat(seat, label) {
    if (!seatStarted(seat)) return false;
    const missing = SEAT_FIELDS.some((key) => !clean(seat[key]));
    if (missing) {
        throw new OrgError(`${label} : renseignez le bloc en entier, ou laissez-le vide.`);
    }
    return true;
}

const IDENTITY_FIELDS = ['nom', 'prenom', 'nni', 'moovMoneyMsisdn', 'motDePasse'];

function identityStarted(seat) {
    if (!seat || typeof seat !== 'object') return false;
    return IDENTITY_FIELDS.some((key) => clean(seat[key]));
}

function assertIdentity(seat, label) {
    if (!identityStarted(seat)) return false;
    const missing = ['nom', 'prenom', 'nni', 'moovMoneyMsisdn'].some((key) => !clean(seat[key]))
        || !String(seat.motDePasse || '');
    if (missing) {
        throw new OrgError(`${label} : renseignez le nom, le prenom, le NNI, le MSISDN et le mot de passe.`);
    }
    if (String(seat.motDePasse).length < 6) {
        throw new OrgError('Le mot de passe doit contenir au moins 6 caracteres.');
    }
    assertNni(seat.nni);
    return true;
}

async function assertMemberMsisdn(raw, exceptEamId) {
    if (!isValidMoovMsisdn(raw)) {
        throw new OrgError('Numero Moov Money invalide : 8 chiffres commencant par 4.');
    }
    const normalized = normalizeMoovMsisdn(raw);
    const agentTaken = await Agent.findOne({ moovMoneyMsisdn: normalized }).select('_id');
    if (agentTaken) throw new OrgError('Ce numero Moov Money est deja utilise.');
    const query = { 'membres.msisdn': normalized };
    if (exceptEamId) query._id = { $ne: exceptEamId };
    const eamTaken = await Eam.findOne(query).select('_id');
    if (eamTaken) throw new OrgError('Ce numero Moov Money est deja utilise.');
    return normalized;
}

async function normalizeMembers(raw, exceptEamId) {
    if (!Array.isArray(raw) || raw.length !== 2) {
        throw new OrgError('L equipe doit avoir deux membres.');
    }
    const membres = [];
    for (let index = 0; index < 2; index += 1) {
        const source = raw[index] || {};
        const nom = clean(source.nom);
        const prenom = clean(source.prenom);
        if (!nom || !prenom) {
            throw new OrgError(`Membre ${index + 1} : nom et prenom requis.`);
        }
        const nni = assertNni(source.nni);
        await assertNniFree(nni);
        const nniQuery = { 'membres.nni': nni };
        if (exceptEamId) nniQuery._id = { $ne: exceptEamId };
        const nniTaken = await Eam.findOne(nniQuery).select('_id');
        if (nniTaken || membres.some((member) => member.nni === nni)) {
            throw new OrgError('Ce NNI est deja utilise.');
        }
        const msisdn = await assertMemberMsisdn(source.msisdn, exceptEamId);
        if (membres.some((member) => member.msisdn === msisdn)) {
            throw new OrgError('Les deux membres doivent avoir des numeros differents.');
        }
        membres.push({ nom, prenom, nni, msisdn });
    }
    return membres;
}

function assertTeamLogin(equipe) {
    const matricule = clean(equipe && equipe.matricule);
    const motDePasse = equipe && equipe.motDePasse != null ? String(equipe.motDePasse) : '';
    if (!matricule || !motDePasse) return false;
    if (motDePasse.length < 6) {
        throw new OrgError('Le mot de passe du compte equipe doit contenir au moins 6 caracteres.');
    }
    return true;
}

async function createTeamLogin(eam, equipe) {
    const matricule = clean(equipe.matricule);
    const motDePasse = String(equipe.motDePasse);
    const exists = await Agent.findOne({ matricule }).select('_id');
    if (exists) throw new OrgError('Ce matricule existe deja.');
    const salt = await bcrypt.genSalt(10);
    const user = new Agent({
        matricule,
        nom: eam.nom,
        prenom: 'Equipe',
        motDePasse: await bcrypt.hash(motDePasse, salt),
        role: 'aam',
        affiliation: eam.nom,
        actif: true,
    });
    await user.save();
    try {
        await placeUser(user, { role: 'aam', eamId: eam._id });
    } catch (err) {
        await Agent.deleteOne({ _id: user._id });
        throw err;
    }
    return user;
}

async function attachTeamAccount(eam, equipe, createdIds) {
    if (!assertTeamLogin(equipe)) return;
    const existing = await activeTeamAccount(eam._id);
    if (existing) throw new OrgError('Cette equipe a deja un compte de connexion.');
    const user = await createTeamLogin(eam, equipe);
    createdIds.push(user._id);
}

async function createEam({ pamId, samId, sam, equipe, membres }) {
    if (samId && identityStarted(sam)) {
        throw new OrgError('Choisis un SAM existant ou cree-en un nouveau.');
    }
    const creatingSam = assertIdentity(sam, 'SAM');
    if (!samId && !creatingSam) {
        throw new OrgError('Un SAM est requis pour l equipe.');
    }
    const motDePasse = equipe && equipe.motDePasse != null ? String(equipe.motDePasse) : '';
    if (motDePasse.length < 6) {
        throw new OrgError('Le mot de passe du compte equipe doit contenir au moins 6 caracteres.');
    }
    const normalizedMembers = await normalizeMembers(membres);
    const pam = await loadPam(pamId);
    if (!hasTerritory(pam)) {
        throw new OrgError('Rattachez ce PAM a une zone ou a une moughataa.');
    }
    const code = await nextCode('EAM');
    const eam = await Eam.create({
        nom: code,
        pamId: pam._id,
        membres: normalizedMembers,
    });
    const createdIds = [];
    try {
        if (creatingSam) {
            const user = await createOrgUser({ ...sam, role: 'sam', pamId: pam._id });
            createdIds.push(user._id);
            await assignSam(await Eam.findById(eam._id), user._id);
        } else {
            await assignSam(eam, samId);
        }
        await attachTeamAccount(eam, { matricule: code, motDePasse }, createdIds);
    } catch (err) {
        if (createdIds.length) await Agent.deleteMany({ _id: { $in: createdIds } });
        await Eam.deleteOne({ _id: eam._id });
        throw err;
    }
    return Eam.findById(eam._id).populate('pamId', 'nom').populate('samId', 'matricule nom prenom');
}

async function assignSam(eam, samId) {
    if (!samId) {
        eam.samId = undefined;
        await eam.save();
        await syncEamSupervisors(eam._id);
        return;
    }
    const sam = await Agent.findById(samId);
    if (!sam || sam.role !== 'sam' || sam.actif === false) {
        throw new OrgError('Le SAM selectionne est introuvable ou inactif.');
    }
    if (!sam.pamId || !eam.pamId || String(sam.pamId) !== String(eam.pamId)) {
        throw new OrgError('Le SAM doit etre rattache au meme PAM que l EAM.');
    }
    eam.samId = sam._id;
    await eam.save();
    await syncEamSupervisors(eam._id);
}

async function updateEam(id, { nom, pamId, samId, actif, sam, equipe, membres }) {
    const eam = await Eam.findById(id);
    if (!eam) throw new OrgError('EAM introuvable.', 404);

    if (nom != null) {
        const name = clean(nom);
        if (!name) throw new OrgError('Le nom de l EAM est requis.');
        eam.nom = name;
        await Agent.updateMany({ eamId: eam._id, role: 'aam' }, { $set: { affiliation: name } });
    }
    if (typeof actif === 'boolean') eam.actif = actif;
    if (membres !== undefined) {
        eam.membres = await normalizeMembers(membres, eam._id);
    }

    if (pamId && String(pamId) !== String(eam.pamId || '')) {
        const pam = await loadPam(pamId);
        eam.pamId = pam._id;
        if (eam.samId) {
            const currentSam = await Agent.findById(eam.samId).select('pamId');
            if (!currentSam || String(currentSam.pamId) !== String(pam._id)) {
                eam.samId = undefined;
            }
        }
        await Agent.updateMany(
            { eamId: eam._id, role: 'aam' },
            { $set: { pamId: pam._id }, $unset: { uamId: 1 } }
        );
    }

    await eam.save();

    if (samId !== undefined) {
        await assignSam(eam, samId || null);
    } else if (assertIdentity(sam, 'SAM')) {
        const user = await createOrgUser({ ...sam, role: 'sam', pamId: eam.pamId });
        await assignSam(await Eam.findById(eam._id), user._id);
    } else {
        await syncEamSupervisors(eam._id);
    }

    await attachTeamAccount(eam, equipe, []);

    return Eam.findById(eam._id).populate('pamId', 'nom').populate('samId', 'matricule nom prenom');
}

async function createOrgUser(body) {
    let matricule = clean(body.matricule);
    const nom = clean(body.nom);
    const prenom = clean(body.prenom);
    const motDePasse = body.motDePasse == null ? '' : String(body.motDePasse);
    const role = clean(body.role);

    if (!matricule && (role === 'pam' || role === 'sam' || role === 'cam')) {
        const pam = await loadPam(body.pamId);
        if (!hasTerritory(pam)) {
            throw new OrgError('Rattachez ce PAM a une zone ou a une moughataa.');
        }
        if (role === 'pam') {
            const same = await Agent.findOne({ matricule: pam.nom }).select('_id');
            matricule = same ? await nextCode('PAM') : pam.nom;
        } else {
            matricule = await nextCode(role === 'sam' ? 'SAM' : 'CAM');
        }
    }

    if (!matricule || !nom || !prenom || !motDePasse) {
        throw new OrgError('Matricule, nom, prenom et mot de passe sont requis.');
    }
    if (motDePasse.length < 6) {
        throw new OrgError('Le mot de passe doit contenir au moins 6 caracteres.');
    }
    if (!ORG_ROLES.includes(role)) {
        throw new OrgError('Role invalide. Roles autorises : pam, cam, sam, aam.');
    }

    const exists = await Agent.findOne({ matricule }).select('_id');
    if (exists) throw new OrgError('Ce matricule existe deja.');

    const nni = assertNni(body.nni);
    await assertNniFree(nni);
    const moovMoneyMsisdn = await assertMsisdn(body.moovMoneyMsisdn);

    const salt = await bcrypt.genSalt(10);
    const user = new Agent({
        matricule,
        nom,
        prenom,
        nni,
        moovMoneyMsisdn,
        motDePasse: await bcrypt.hash(motDePasse, salt),
        role,
        affiliation: nom,
        actif: true,
    });
    await user.save();

    try {
        await placeUser(user, {
            role,
            pamId: body.pamId,
            eamId: body.eamId,
        });
    } catch (err) {
        await Agent.deleteOne({ _id: user._id });
        throw err;
    }

    return Agent.findById(user._id).select('-motDePasse');
}

async function updateOrgUser(id, body) {
    const user = await Agent.findById(id).select('+motDePasse');
    if (!user || !ORG_ROLES.includes(user.role)) {
        throw new OrgError('Compte introuvable.', 404);
    }

    if (body.nom != null) {
        const nom = clean(body.nom);
        if (!nom) throw new OrgError('Le nom est requis.');
        user.nom = nom;
    }
    if (body.prenom != null) {
        const prenom = clean(body.prenom);
        if (!prenom) throw new OrgError('Le prenom est requis.');
        user.prenom = prenom;
    }
    if (body.nni != null && clean(body.nni)) {
        const nni = assertNni(body.nni);
        await assertNniFree(nni, user._id);
        user.nni = nni;
    }
    if (body.moovMoneyMsisdn != null && clean(body.moovMoneyMsisdn)) {
        user.moovMoneyMsisdn = await assertMsisdn(body.moovMoneyMsisdn, user._id);
    }
    if (body.motDePasse) {
        const motDePasse = String(body.motDePasse);
        if (motDePasse.length < 6) {
            throw new OrgError('Le mot de passe doit contenir au moins 6 caracteres.');
        }
        const salt = await bcrypt.genSalt(10);
        user.motDePasse = await bcrypt.hash(motDePasse, salt);
    }

    const nextRole = body.role ? clean(body.role) : user.role;
    const placementRequested = body.role || body.pamId || body.eamId;

    if (placementRequested) {
        await placeUser(user, {
            role: nextRole,
            pamId: body.pamId || user.pamId,
            eamId: body.eamId || user.eamId,
        });
    } else {
        await user.save();
    }

    if (typeof body.actif === 'boolean') {
        return setUserActif(user._id, body.actif);
    }

    return Agent.findById(user._id).select('-motDePasse');
}

async function setUserActif(id, actif) {
    const user = await Agent.findById(id);
    if (!user || !ORG_ROLES.includes(user.role)) {
        throw new OrgError('Compte introuvable.', 404);
    }
    user.actif = Boolean(actif);
    await user.save();

    if (!user.actif) {
        await releaseExclusiveSeats(user);
        if (user.role === 'aam') {
            user.superviseurId = undefined;
            await user.save();
        }
    }

    return Agent.findById(user._id).select('-motDePasse');
}

async function getOverview() {
    const [pams, eams, users, zones] = await Promise.all([
        Pam.find().sort({ nom: 1 }).lean(),
        Eam.find().populate('pamId', 'nom actif').populate('samId', 'matricule nom prenom actif').sort({ nom: 1 }).lean(),
        Agent.find({ role: { $in: ORG_ROLES } })
            .select('matricule nom prenom nni moovMoneyMsisdn role actif pamId eamId affiliation')
            .sort({ role: 1, nom: 1, prenom: 1 })
            .lean(),
        listZones(),
    ]);

    const eamCountByPam = {};
    const eamCountBySam = {};
    const teamByEam = {};

    eams.forEach((eam) => {
        const pamKey = String(eam.pamId && eam.pamId._id ? eam.pamId._id : eam.pamId);
        eamCountByPam[pamKey] = (eamCountByPam[pamKey] || 0) + 1;
        if (eam.samId) {
            const samKey = String(eam.samId._id || eam.samId);
            eamCountBySam[samKey] = (eamCountBySam[samKey] || 0) + 1;
        }
    });
    users.forEach((user) => {
        if (user.role === 'aam' && user.eamId && user.actif !== false) {
            teamByEam[String(user.eamId)] = user;
        }
    });

    return {
        pams: pams.map((pam) => ({ ...pam, eamCount: eamCountByPam[String(pam._id)] || 0 })),
        eams: eams.map((eam) => ({ ...eam, equipe: teamByEam[String(eam._id)] || null })),
        users: users.map((user) => (
            user.role === 'sam' ? { ...user, eamCount: eamCountBySam[String(user._id)] || 0 } : user
        )),
        zones,
    };
}

module.exports = {
    OrgError,
    ORG_ROLES,
    getOverview,
    previewCode,
    createPam,
    updatePam,
    createEam,
    updateEam,
    createOrgUser,
    updateOrgUser,
    setUserActif,
};
