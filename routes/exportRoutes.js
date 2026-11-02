// backend/routes/exportRoutes.js

const express = require('express');
const router = express.Router();
const ExcelJS = require('exceljs');
const moment = require('moment');
const Merchant = require('../models/Merchant');
const Agent = require('../models/Agent');
const Eam = require('../models/Eam');
const authMiddleware = require('../middleware/authMiddleware');
const roleMiddleware = require('../middleware/roleMiddleware');
const crypto = require('crypto');
const archiver = require('archiver');
const { REJETE_DEFINITIF, STATUT_CREE, STATUTS_REUSSITE, isStatutReussi } = require('../utils/merchantStatus');
const { FIELD_AGENT_ROLES } = require('../utils/roles');

function personName(user) {
    if (!user || typeof user !== 'object') return '—';
    const name = [user.prenom, user.nom].filter(Boolean).join(' ').trim();
    return name || user.matricule || '—';
}

function teamOf(agent) {
    if (agent && agent.eamId && typeof agent.eamId === 'object' && agent.eamId.nom) {
        return { key: agent.eamId.nom, sam: personName(agent.eamId.samId) };
    }
    if (agent && agent.superviseurId && typeof agent.superviseurId === 'object') {
        return { key: agent.superviseurId.matricule || 'Sans équipe', sam: personName(agent.superviseurId) };
    }
    return { key: 'Sans équipe', sam: '—' };
}

function isSuccess(statut) {
    return isStatutReussi(statut) || statut === 'validé';
}

function statutLabel(merchant) {
    if (!merchant) return '';
    if (merchant.statut === 'en attente') {
        if (merchant.validationEtape === 'cam') return 'En attente du CAM';
        if (merchant.validationEtape === 'pam') return 'En attente du PAM';
        return 'En attente du SAM';
    }
    if (merchant.statut === 'rejeté') return 'À corriger';
    if (merchant.statut === 'validé_par_superviseur') return 'Validé par superviseur';
    if (merchant.statut === 'cree' || merchant.statut === 'validé') return 'Créé';
    if (merchant.statut === 'livré') return 'Livré';
    if (merchant.statut === REJETE_DEFINITIF) return 'Rejeté définitivement';
    return merchant.statut || '';
}

async function recruiterIdsForScope({ agentId, eamId, teamId, pamId }) {
    if (agentId) return [agentId];

    const roles = { role: { $in: FIELD_AGENT_ROLES } };
    if (eamId) {
        const agents = await Agent.find({ ...roles, eamId }).select('_id');
        return agents.map((agent) => agent._id);
    }
    if (teamId) {
        const eams = await Eam.find({ samId: teamId }).select('_id');
        const agents = await Agent.find({
            ...roles,
            $or: [
                { eamId: { $in: eams.map((eam) => eam._id) } },
                { superviseurId: teamId },
            ],
        }).select('_id');
        return agents.map((agent) => agent._id);
    }
    if (pamId) {
        const sams = await Agent.find({ role: 'sam', pamId }).select('_id');
        const eams = await Eam.find({
            $or: [
                { pamId },
                { samId: { $in: sams.map((sam) => sam._id) } },
            ],
        }).select('_id');
        const agents = await Agent.find({
            ...roles,
            eamId: { $in: eams.map((eam) => eam._id) },
        }).select('_id');
        return agents.map((agent) => agent._id);
    }
    return null;
}

// @route   GET /api/export/performance
// @desc    Export agent and team performance to Excel
// @access  Private (Admin)
router.get(
    '/performance',
    [authMiddleware, roleMiddleware(['admin'])],
    async (req, res) => {
        try {
            const { startDate, endDate, teamId, agentId, pamId, eamId } = req.query;

            // 1. Data Fetching and Filtering
            let merchantFilter = {};
            if (startDate || endDate) {
                merchantFilter.createdAt = {};
                if (startDate) merchantFilter.createdAt.$gte = new Date(startDate);
                if (endDate) merchantFilter.createdAt.$lte = new Date(endDate);
            }

            const scopedIds = await recruiterIdsForScope({ agentId, eamId, teamId, pamId });
            if (scopedIds) merchantFilter.agentRecruteurId = { $in: scopedIds };

            const recruiterPopulate = {
                path: 'agentRecruteurId',
                select: 'matricule nom prenom superviseurId eamId',
                populate: [
                    { path: 'superviseurId', select: 'matricule nom prenom' },
                    { path: 'eamId', select: 'nom samId', populate: { path: 'samId', select: 'matricule nom prenom' } },
                ],
            };

            const enrollments = await Merchant.find(merchantFilter)
                .populate(recruiterPopulate)
                .sort({ createdAt: -1 });

            const agentQuery = { role: { $in: FIELD_AGENT_ROLES } };
            if (scopedIds) agentQuery._id = { $in: scopedIds };
            const allAgents = await Agent.find(agentQuery)
                .populate('superviseurId', 'matricule nom prenom')
                .populate({ path: 'eamId', select: 'nom samId', populate: { path: 'samId', select: 'matricule nom prenom' } });

            // 2. Data Processing
            const agentPerformance = {};
            const teamPerformance = {};

            allAgents.forEach(agent => {
                const team = teamOf(agent);

                if (team.key !== 'Sans équipe') {
                    if (!teamPerformance[team.key]) {
                        teamPerformance[team.key] = {
                            supervisor: team.sam,
                            agents: new Set(),
                            totalEnrollments: 0,
                            valid: 0,
                            rejected: 0,
                            dailyActivity: {}
                        };
                    }
                    teamPerformance[team.key].agents.add(agent._id.toString());
                }

                agentPerformance[agent._id] = {
                    team: team.key,
                    agentName: personName(agent),
                    agentId: agent.matricule,
                    total: 0,
                    valid: 0,
                    rejected: 0,
                    pending: 0,
                    lastEnrollment: null,
                    activeDays: new Set()
                };
            });

            enrollments.forEach(e => {
                if (e.agentRecruteurId) { // Check if agentRecruteurId exists
                    const agent = agentPerformance[e.agentRecruteurId._id];
                    if (agent) {
                        agent.total++;
                        if (isSuccess(e.statut)) agent.valid++;
                        else if (e.statut === 'rejeté' || e.statut === REJETE_DEFINITIF) agent.rejected++;
                        else agent.pending++;

                        const enrollmentDate = moment(e.createdAt);
                        if (!agent.lastEnrollment || enrollmentDate.isAfter(agent.lastEnrollment)) {
                            agent.lastEnrollment = enrollmentDate;
                        }
                        agent.activeDays.add(enrollmentDate.format('YYYY-MM-DD'));
                    }

                    const teamName = teamOf(e.agentRecruteurId).key !== 'Sans équipe' ? teamOf(e.agentRecruteurId).key : null;
                    if (teamName) {
                        const team = teamPerformance[teamName];
                        if (team) {
                            team.totalEnrollments++;
                            if (isSuccess(e.statut)) team.valid++;
                            if (e.statut === 'rejeté' || e.statut === REJETE_DEFINITIF) team.rejected++;
                            const day = moment(e.createdAt).format('YYYY-MM-DD');
                            team.dailyActivity[day] = (team.dailyActivity[day] || 0) + 1;
                        }
                    }
                }
            });

            // 3. Excel Generation
            const workbook = new ExcelJS.Workbook();
            workbook.creator = 'Moov Africa';
            workbook.created = new Date();

            // --- Summary Sheet ---
            const summarySheet = workbook.addWorksheet('Résumé');
            summarySheet.addRow(['Export généré le', new Date().toLocaleString()]);
            summarySheet.addRow([]);
            summarySheet.addRow(['Statistiques Globales']);
            summarySheet.getCell('A3').font = { bold: true, size: 14 };
            const totalEquipes = scopedIds
                ? new Set(allAgents.map((agent) => (agent.eamId && agent.eamId.nom) || '').filter(Boolean)).size
                : await Eam.countDocuments({ actif: { $ne: false } });
            summarySheet.addRow(['Total Enrôlements', enrollments.length]);
            summarySheet.addRow(['Total équipes', totalEquipes]);
            summarySheet.addRow(['Total comptes équipe', allAgents.length]);
            const totalValid = enrollments.filter(e => isSuccess(e.statut)).length;
            const totalRate = enrollments.length > 0 ? (totalValid / enrollments.length) * 100 : 0;
            summarySheet.addRow(['Taux de Réussite Général', `${totalRate.toFixed(2)}%`]);


            // --- Agent Performance Sheet ---
            const agentSheet = workbook.addWorksheet('Performances comptes');
            agentSheet.addRow(['Export généré le', new Date().toLocaleString()]);
            agentSheet.getRow(1).getCell(1).font = { italic: true };
            agentSheet.addRow([]);
            const agentHeaders = ['Équipe', 'Compte', 'Matricule', 'Total', 'Créés', 'Rejetés', 'En cours', 'Taux (%)', 'Dernier enrôlement', 'Moy. journalière'];
            const agentHeaderRow = agentSheet.addRow(agentHeaders);
            agentHeaderRow.eachCell(cell => {
                cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
                cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0070C0' } };
                cell.border = { top: { style: 'thin' }, left: { style: 'thin' }, bottom: { style: 'thin' }, right: { style: 'thin' } };
            });

            Object.values(agentPerformance).forEach(data => {
                const rate = data.total > 0 ? (data.valid / data.total) * 100 : 0;
                const dailyAvg = data.activeDays.size > 0 ? data.total / data.activeDays.size : 0;
                agentSheet.addRow([
                    data.team,
                    data.agentName,
                    data.agentId,
                    data.total,
                    data.valid,
                    data.rejected,
                    data.pending,
                    `${rate.toFixed(2)}%`,
                    data.lastEnrollment ? data.lastEnrollment.format('YYYY-MM-DD HH:mm') : 'N/A',
                    dailyAvg.toFixed(2)
                ]);
            });
            agentSheet.columns.forEach(column => {
                let maxLength = 0;
                column.eachCell({ includeEmpty: true }, cell => {
                    let columnLength = cell.value ? cell.value.toString().length : 10;
                    if (columnLength > maxLength) {
                        maxLength = columnLength;
                    }
                });
                column.width = maxLength < 10 ? 10 : maxLength + 2;
            });
            agentSheet.views = [{ state: 'frozen', ySplit: 3 }];

            // --- Team Performance Sheet ---
            const teamSheet = workbook.addWorksheet('Performances équipes');
            teamSheet.addRow(['Export généré le', new Date().toLocaleString()]);
            teamSheet.getRow(1).getCell(1).font = { italic: true };
            teamSheet.addRow([]);
            const teamHeaders = ['Équipe', 'SAM', 'Comptes', 'Total Enrôlements', 'Moyenne par compte', 'Créés', 'Rejetés', 'Taux (%)', 'Jour le plus actif'];
            const teamHeaderRow = teamSheet.addRow(teamHeaders);
            teamHeaderRow.eachCell(cell => {
                cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
                cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0070C0' } };
            });

            Object.entries(teamPerformance).forEach(([teamName, data]) => {
                const rate = data.totalEnrollments > 0 ? (data.valid / data.totalEnrollments) * 100 : 0;
                const avgPerAgent = data.agents.size > 0 ? data.totalEnrollments / data.agents.size : 0;
                const mostActiveDay = Object.keys(data.dailyActivity).reduce((a, b) => data.dailyActivity[a] > data.dailyActivity[b] ? a : b, null);
                teamSheet.addRow([
                    teamName,
                    data.supervisor,
                    data.agents.size,
                    data.totalEnrollments,
                    avgPerAgent.toFixed(2),
                    data.valid,
                    data.rejected,
                    `${rate.toFixed(2)}%`,
                    mostActiveDay || 'N/A'
                ]);
            });
            teamSheet.columns.forEach(column => {
                let maxLength = 0;
                column.eachCell({ includeEmpty: true }, cell => {
                    let columnLength = cell.value ? cell.value.toString().length : 10;
                    if (columnLength > maxLength) {
                        maxLength = columnLength;
                    }
                });
                column.width = maxLength < 10 ? 10 : maxLength + 2;
            });
            teamSheet.views = [{ state: 'frozen', ySplit: 3 }];

            // --- Enrollments Detail Sheet ---
            const detailSheet = workbook.addWorksheet('Détails Enrôlements');
            detailSheet.addRow(['Export généré le', new Date().toLocaleString()]);
            detailSheet.getRow(1).getCell(1).font = { italic: true };
            detailSheet.addRow([]);
            const detailHeaders = [
                'Short Code', 'Équipe', 'Compte', 'Date Création', 'Statut', 'Nom Marchand', 'Secteur', 'Type Commerce',
                'Région', 'Ville', 'Commune', 'Adresse', 'Longitude', 'Latitude', 'Nom Gérant', 'Prénom Gérant',
                'Contact Gérant', 'NIF', 'RC', 'Type Pièce', 'URL CNI Recto', 'URL CNI Verso', 'URL Passeport',
                'URL Photo Enseigne', 'Date Validation', 'Raison Rejet', 'Fin validation terrain'
            ];
            const detailHeaderRow = detailSheet.addRow(detailHeaders);
            detailHeaderRow.eachCell(cell => {
                cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
                cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0070C0' } };
            });

            enrollments.forEach(e => {
                detailSheet.addRow([
                    e.shortCode,
                    teamOf(e.agentRecruteurId).key,
                    e.agentRecruteurId ? personName(e.agentRecruteurId) : 'N/A',
                    moment(e.createdAt).format('YYYY-MM-DD HH:mm:ss'),
                    statutLabel(e),
                    e.nom,
                    e.secteur,
                    e.typeCommerce,
                    e.region,
                    e.ville,
                    e.commune,
                    e.adresse,
                    e.longitude,
                    e.latitude,
                    e.nomGerant,
                    e.prenomGerant,
                    e.contact,
                    e.nif,
                    e.rc,
                    e.pieceIdentite ? e.pieceIdentite.type : '',
                    e.pieceIdentite ? e.pieceIdentite.cniRectoUrl : '',
                    e.pieceIdentite ? e.pieceIdentite.cniVersoUrl : '',
                    e.pieceIdentite ? e.pieceIdentite.passeportUrl : '',
                    e.photoEnseigneUrl,
                    e.validatedAt ? moment(e.validatedAt).format('YYYY-MM-DD HH:mm:ss') : '',
                    e.rejectionReason,
                    e.validatedBySupervisorAt ? moment(e.validatedBySupervisorAt).format('YYYY-MM-DD HH:mm:ss') : ''
                ]);
            });
            detailSheet.columns.forEach(column => {
                let maxLength = 0;
                column.eachCell({ includeEmpty: true }, cell => {
                    let columnLength = cell.value ? cell.value.toString().length : 10;
                    if (columnLength > maxLength) {
                        maxLength = columnLength;
                    }
                });
                column.width = maxLength < 10 ? 10 : maxLength + 2;
            });
            detailSheet.views = [{ state: 'frozen', ySplit: 3 }];
            detailSheet.autoFilter = {
                from: 'A3',
                to: {
                    row: 3,
                    column: detailHeaders.length
                }
            };

            // --- Operator Detail Sheet ---
            const operatorSheet = workbook.addWorksheet('Détails Opérateurs');
            operatorSheet.addRow(['Export généré le', new Date().toLocaleString()]);
            operatorSheet.getRow(1).getCell(1).font = { italic: true };
            operatorSheet.addRow([]);
            const operatorHeaders = [
                'Short Code Marchand', 'Nom Opérateur', 'Prénom Opérateur', 'NNI Opérateur',
                'Téléphone Opérateur', 'Date Création Opérateur'
            ];
            const operatorHeaderRow = operatorSheet.addRow(operatorHeaders);
            operatorHeaderRow.eachCell(cell => {
                cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
                cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0070C0' } };
            });

            enrollments.forEach(e => {
                if (e.operators && e.operators.length > 0) {
                    e.operators.forEach(op => {
                        operatorSheet.addRow([
                            e.shortCode,
                            op.nom,
                            op.prenom,
                            op.nni,
                            op.telephone,
                            op.createdAt ? moment(op.createdAt).format('YYYY-MM-DD HH:mm:ss') : ''
                        ]);
                    });
                }
            });
            operatorSheet.columns.forEach(column => {
                let maxLength = 0;
                column.eachCell({ includeEmpty: true }, cell => {
                    let columnLength = cell.value ? cell.value.toString().length : 10;
                    if (columnLength > maxLength) {
                        maxLength = columnLength;
                    }
                });
                column.width = maxLength < 10 ? 10 : maxLength + 2;
            });
            operatorSheet.views = [{ state: 'frozen', ySplit: 3 }];
            operatorSheet.autoFilter = {
                from: 'A3',
                to: {
                    row: 3,
                    column: operatorHeaders.length
                }
            };

            // 4. HTTP Response
            const date = moment().format('YYYYMMDD');
            const time = moment().format('HHmm');
            const uniqueID = crypto.randomBytes(3).toString('hex');
            const filename = `export_performances_${date}_${time}_${uniqueID}.xlsx`;
            res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
            res.setHeader('Content-Disposition', `attachment; filename=${filename}`);

            await workbook.xlsx.write(res);
            res.end();

        } catch (err) {
            console.error(err.message);
            res.status(500).send('Erreur du serveur lors de la génération du fichier Excel.');
        }
    }
);

// @route   GET /api/export/suivi
// @desc    Export tracking report for merchants
// @access  Private (Admin)
router.get(
    '/suivi',
    [authMiddleware, roleMiddleware(['admin'])],
    async (req, res) => {
        try {
            const { startDate, endDate, statut } = req.query;

            const merchantFilter = {};
            if (statut === 'cree') {
                merchantFilter.statut = { $in: ['cree', 'validé'] };
            } else if (statut) {
                merchantFilter.statut = statut;
            }
            if (startDate || endDate) {
                merchantFilter.createdAt = {};
                if (startDate) merchantFilter.createdAt.$gte = new Date(startDate);
                if (endDate) merchantFilter.createdAt.$lte = new Date(endDate);
            }

            const merchants = await Merchant.find(merchantFilter)
                .populate({
                    path: 'agentRecruteurId',
                    select: 'matricule nom prenom eamId',
                    populate: {
                        path: 'eamId',
                        select: 'nom samId pamId membres',
                        populate: [
                            { path: 'samId', select: 'matricule nom prenom' },
                            { path: 'pamId', select: 'nom' },
                        ],
                    },
                })
                .sort({ createdAt: -1 });

            if (!merchants.length) {
                return res.status(404).json({ msg: 'Aucun dossier a exporter.' });
            }

            const holders = await Agent.find({ role: { $in: ['pam', 'cam'] }, actif: { $ne: false } })
                .select('nom prenom matricule pamId role')
                .lean();
            const pamByOrg = new Map();
            const camsByOrg = new Map();
            holders.forEach((user) => {
                const key = String(user.pamId || '');
                if (!key) return;
                if (user.role === 'pam' && !pamByOrg.has(key)) pamByOrg.set(key, user);
                if (user.role === 'cam') {
                    const list = camsByOrg.get(key) || [];
                    list.push(personName(user));
                    camsByOrg.set(key, list);
                }
            });

            const memberName = (member) => {
                if (!member) return '';
                return [member.prenom, member.nom].filter(Boolean).join(' ').trim();
            };

            const workbook = new ExcelJS.Workbook();
            workbook.creator = 'Moov Africa';
            workbook.created = new Date();
            const worksheet = workbook.addWorksheet('Rapport de Suivi');

            const headers = [
                'Shortcode',
                'Nom Marchand',
                'Statut',
                'Équipe',
                'Compte',
                'Membre 1',
                'Membre 2',
                'SAM',
                'CAM',
                'PAM',
                'Secteur',
                'Catégorie',
                'Nature',
                'Taille',
                'Région',
                'Moughataa',
                'Commune',
                'Localité',
                'Date d\'enrôlement',
                'Fin validation terrain',
                'Date de validation finale',
                'Date de livraison',
                'Numéro de téléphone',
                'Latitude',
                'Longitude',
            ];

            const headerRow = worksheet.addRow(headers);
            headerRow.eachCell(cell => {
                cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
                cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0070C0' } };
            });

            merchants.forEach(m => {
                const recruiter = m.agentRecruteurId;
                const eam = recruiter && recruiter.eamId && typeof recruiter.eamId === 'object' ? recruiter.eamId : null;
                const pamOrg = eam && eam.pamId && typeof eam.pamId === 'object' ? eam.pamId : null;
                const pamOrgId = pamOrg ? pamOrg._id : (eam && eam.pamId);
                const pamUser = pamOrgId ? pamByOrg.get(String(pamOrgId)) : null;
                const cams = pamOrgId ? (camsByOrg.get(String(pamOrgId)) || []) : [];
                const members = eam && Array.isArray(eam.membres) ? eam.membres : [];
                worksheet.addRow([
                    m.shortCode,
                    m.nom,
                    statutLabel(m),
                    eam ? eam.nom : 'Sans équipe',
                    personName(recruiter),
                    memberName(members[0]),
                    memberName(members[1]),
                    personName(eam && eam.samId),
                    cams.join(', ') || '—',
                    pamUser ? personName(pamUser) : (pamOrg && pamOrg.nom) || '—',
                    m.secteur || '',
                    m.categorie || '',
                    m.typeCommerce || '',
                    m.taille || '',
                    m.region || '',
                    m.ville || '',
                    m.commune || '',
                    m.localite || '',
                    m.createdAt ? moment(m.createdAt).format('YYYY-MM-DD HH:mm:ss') : '',
                    m.validatedBySupervisorAt ? moment(m.validatedBySupervisorAt).format('YYYY-MM-DD HH:mm:ss') : '',
                    m.validatedAt ? moment(m.validatedAt).format('YYYY-MM-DD HH:mm:ss') : '',
                    m.deliveredAt ? moment(m.deliveredAt).format('YYYY-MM-DD HH:mm:ss') : '',
                    m.contact,
                    m.latitude,
                    m.longitude,
                ]);
            });

            worksheet.columns.forEach(column => {
                column.width = 25;
            });

            const date = moment().format('YYYYMMDD');
            const time = moment().format('HHmm');
            const uniqueID = crypto.randomBytes(3).toString('hex');
            const filename = `rapport_de_suivi_${date}_${time}_${uniqueID}.xlsx`;

            res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
            res.setHeader('Content-Disposition', `attachment; filename=${filename}`);

            await workbook.xlsx.write(res);
            res.end();

        } catch (err) {
            console.error(err.message);
            res.status(500).send('Erreur du serveur lors de la génération du rapport de suivi.');
        }
    }
);

// @route   GET /api/export/nearby
// @desc    Export nearby items for merchants
// @access  Private (Admin)
router.get(
    '/nearby',
    [authMiddleware, roleMiddleware(['admin'])],
    async (req, res) => {
        try {
            const { startDate, endDate } = req.query;
            
            // 1. Données de Location Map (hardcodées)
            const locationMapData = [
                {
                    provinceName: '湖南省',
                    provinceCode: 'HUNAN',
                    cityName: '长沙市',
                    cityCode: 'CHANGSHA',
                    zoneName: '岳麓区',
                    zoneCode: 'YUELU'
                },
                {
                    provinceName: '湖南省',
                    provinceCode: 'HUNAN',
                    cityName: '长沙市',
                    cityCode: 'CHANGSHA',
                    zoneName: '开福区',
                    zoneCode: 'KAIFU'
                },
                {
                    provinceName: '湖南省',
                    provinceCode: 'HUNAN',
                    cityName: '湘潭市',
                    cityCode: 'XIANGRAN',
                    zoneName: '雨湖区',
                    zoneCode: 'YUHU'
                },
                {
                    provinceName: '湖南省',
                    provinceCode: 'HUNAN',
                    cityName: '湘潭市',
                    cityCode: 'XIANGRAN',
                    zoneName: '岳塘区',
                    zoneCode: 'YUETANG'
                },
                {
                    provinceName: '湖北省',
                    provinceCode: 'HUBEI',
                    cityName: '武汉市',
                    cityCode: 'WUHAN',
                    zoneName: '江岸区',
                    zoneCode: 'JIANGAN'
                },
                {
                    provinceName: '湖北省',
                    provinceCode: 'HUBEI',
                    cityName: '武汉市',
                    cityCode: 'WUHAN',
                    zoneName: '洪山区',
                    zoneCode: 'HONGSHAN'
                },
                {
                    provinceName: '湖北省',
                    provinceCode: 'HUBEI',
                    cityName: '黄石市',
                    cityCode: 'HUANGSHI',
                    zoneName: '鄂城区',
                    zoneCode: 'ECHENG'
                },
                {
                    provinceName: '湖北省',
                    provinceCode: 'HUBEI',
                    cityName: '黄石市',
                    cityCode: 'HUANGSHI',
                    zoneName: '江夏区',
                    zoneCode: 'JIANGXIA'
                }
            ];
            
            // Utiliser les valeurs par défaut spécifiées
            const defaultProvinceCode = 'hunansheng';
            const defaultCityCode = 'changshashi';
            const defaultZoneCode = 'yueluqu';
            
            // 2. Recuperer les marchands crees (validation finale) avec filtres par date
            let merchantFilter = { statut: STATUT_CREE };
            if (startDate && endDate) {
                merchantFilter.validatedAt = {
                    $gte: new Date(startDate),
                    $lte: new Date(endDate),
                };
            } else if (startDate) {
                merchantFilter.validatedAt = { ...merchantFilter.validatedAt, $gte: new Date(startDate) };
            } else if (endDate) {
                merchantFilter.validatedAt = { ...merchantFilter.validatedAt, $lte: new Date(endDate) };
            }
            
            const merchants = await Merchant.find(merchantFilter).sort({ createdAt: -1 });
            
            if (!merchants || merchants.length === 0) {
                return res.status(404).json({ msg: 'Aucun marchand cree a exporter.' });
            }
            
            // Fonction helper pour créer un workbook Excel avec un lot de marchands
            const createWorkbookForLot = async (merchantsLot, lotNumber) => {
                const workbook = new ExcelJS.Workbook();
                workbook.creator = 'Moov Africa';
                workbook.created = new Date();
                
                // Créer la feuille "Nearby Item"
                const nearbyItemSheet = workbook.addWorksheet('Nearby Item');
                
                // En-têtes de la première feuille
                const nearbyItemHeaders = [
                    'Item Name',
                    'Nearby Type ID',
                    'Province Code',
                    'City Code',
                    'Zone Code',
                    'Longitude',
                    'Latitude',
                    'Phone Number',
                    'Title',
                    'Detailed Address'
                ];
                
                const headerRow = nearbyItemSheet.addRow(nearbyItemHeaders);
                headerRow.eachCell(cell => {
                    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
                    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0070C0' } };
                    cell.border = { top: { style: 'thin' }, left: { style: 'thin' }, bottom: { style: 'thin' }, right: { style: 'thin' } };
                });
                
                // Ajouter les données des marchands
                merchantsLot.forEach(merchant => {
                    // Item Name : nom de l'enseigne suivi du shortcode séparé par un "-"
                    const itemName = merchant.shortCode 
                        ? `${merchant.nom}-${merchant.shortCode}` 
                        : merchant.nom;
                    
                    // Nearby Type ID : fixe, toujours 40001
                    const nearbyTypeId = 40001;
                    
                    // Province Code, City Code, Zone Code : valeurs fixes
                    const provinceCode = defaultProvinceCode;
                    const cityCode = defaultCityCode;
                    const zoneCode = defaultZoneCode;
                    
                    // Longitude et Latitude du marchand
                    const longitude = merchant.longitude || '';
                    const latitude = merchant.latitude || '';
                    
                    // Numéro de téléphone du marchand
                    const phoneNumber = merchant.contact || '';
                    
                    // Title : nom de l'enseigne
                    const title = merchant.nom || '';
                    
                    // Detailed Address : adresse du marchand
                    const detailedAddress = merchant.adresse || '';
                    
                    nearbyItemSheet.addRow([
                        itemName,
                        nearbyTypeId,
                        provinceCode,
                        cityCode,
                        zoneCode,
                        longitude,
                        latitude,
                        phoneNumber,
                        title,
                        detailedAddress
                    ]);
                });
                
                // Ajuster la largeur des colonnes
                nearbyItemSheet.columns.forEach(column => {
                    let maxLength = 0;
                    column.eachCell({ includeEmpty: true }, cell => {
                        let columnLength = cell.value ? cell.value.toString().length : 10;
                        if (columnLength > maxLength) {
                            maxLength = columnLength;
                        }
                    });
                    column.width = maxLength < 10 ? 10 : maxLength + 2;
                });
                
                nearbyItemSheet.views = [{ state: 'frozen', ySplit: 1 }];
                
                // Créer la feuille "Location Map"
                const locationMapSheetNew = workbook.addWorksheet('Location Map');
                
                // Copier les en-têtes
                const locationMapHeaders = ['Province', 'Province', 'City', 'City', 'Zone', 'Zone'];
                const locationMapSubHeaders = ['Name', 'Code', 'Name', 'Code', 'Name', 'Code'];
                
                const headerRow1 = locationMapSheetNew.addRow(locationMapHeaders);
                headerRow1.eachCell(cell => {
                    cell.font = { bold: true };
                });
                
                const headerRow2 = locationMapSheetNew.addRow(locationMapSubHeaders);
                headerRow2.eachCell(cell => {
                    cell.font = { bold: true };
                });
                
                // Copier les données
                locationMapData.forEach(location => {
                    locationMapSheetNew.addRow([
                        location.provinceName,
                        location.provinceCode,
                        location.cityName,
                        location.cityCode,
                        location.zoneName,
                        location.zoneCode
                    ]);
                });
                
                // Ajuster la largeur des colonnes
                locationMapSheetNew.columns.forEach(column => {
                    let maxLength = 0;
                    column.eachCell({ includeEmpty: true }, cell => {
                        let columnLength = cell.value ? cell.value.toString().length : 10;
                        if (columnLength > maxLength) {
                            maxLength = columnLength;
                        }
                    });
                    column.width = maxLength < 10 ? 10 : maxLength + 2;
                });
                
                locationMapSheetNew.views = [{ state: 'frozen', ySplit: 2 }];
                
                return workbook;
            };
            
            const LOT_SIZE = 100;
            const totalMerchants = merchants.length;

            // Si le nombre de marchands dépasse 100, créer un ZIP avec plusieurs fichiers Excel (lots de 100)
            if (totalMerchants > LOT_SIZE) {
                const date = moment().format('YYYYMMDD');
                const time = moment().format('HHmm');
                const uniqueID = crypto.randomBytes(3).toString('hex');
                const zipFilename = `export_nearby_${date}_${time}_${uniqueID}.zip`;

                // Headers pour un fichier ZIP
                res.setHeader('Content-Type', 'application/zip');
                res.setHeader('Content-Disposition', `attachment; filename=${zipFilename}`);

                const archive = archiver('zip', { zlib: { level: 9 } });

                archive.on('error', (err) => {
                    console.error('Erreur archive ZIP nearby:', err);
                    // Important: fermer la réponse en cas d'erreur
                    if (!res.headersSent) {
                        res.status(500).send('Erreur lors de la génération de l’archive ZIP.');
                    } else {
                        res.end();
                    }
                });

                // On pipe l'archive vers la réponse HTTP
                archive.pipe(res);

                const totalLots = Math.ceil(totalMerchants / LOT_SIZE);

                for (let i = 0; i < totalLots; i++) {
                    const start = i * LOT_SIZE;
                    const end = Math.min(start + LOT_SIZE, totalMerchants);
                    const merchantsLot = merchants.slice(start, end);
                    const lotNumber = i + 1;

                    const workbook = await createWorkbookForLot(merchantsLot, lotNumber);
                    const buffer = await workbook.xlsx.writeBuffer();

                    const excelFilename = `export_nearby_lot_${lotNumber}_${merchantsLot.length}_merchants.xlsx`;
                    archive.append(buffer, { name: excelFilename });
                }

                // Finaliser le ZIP (en streaming vers le client)
                archive.finalize();

            } else {
                // Si ≤ 100 marchands : un seul fichier Excel direct (pas de ZIP)
                const workbook = await createWorkbookForLot(merchants, 1);

                const date = moment().format('YYYYMMDD');
                const time = moment().format('HHmm');
                const uniqueID = crypto.randomBytes(3).toString('hex');
                const filename = `export_nearby_${date}_${time}_${uniqueID}.xlsx`;

                res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
                res.setHeader('Content-Disposition', `attachment; filename=${filename}`);

                await workbook.xlsx.write(res);
                res.end();
            }
            
        } catch (err) {
            console.error('Erreur export nearby:', err.message);
            res.status(500).send('Erreur du serveur lors de la génération de l\'export nearby.');
        }
    }
);

module.exports = router;