/** Referentiel de depart. L'admin peut l'enrichir ensuite. */
const KYC_SEED = [
    {
        nom: 'Commerce',
        categories: [
            { nom: 'Alimentation', natures: ['Epicerie', 'Boulangerie', 'Boucherie', 'Fruits et legumes'] },
            { nom: 'Habillement', natures: ['Pret-a-porter', 'Chaussures', 'Tissus'] },
            { nom: 'Electronique', natures: ['Telephonie', 'Electromenager'] },
            { nom: 'Maison', natures: ['Quincaillerie', 'Meubles', 'Materiaux de construction'] },
        ],
    },
    {
        nom: 'Restauration',
        categories: [
            { nom: 'Restauration', natures: ['Restaurant', 'Snack', 'Cafe'] },
        ],
    },
    {
        nom: 'Services',
        categories: [
            { nom: 'Services a la personne', natures: ['Coiffure', 'Pressing', 'Couture'] },
            { nom: 'Transport', natures: ['Station-service', 'Garage'] },
            { nom: 'Sante', natures: ['Pharmacie', 'Cabinet'] },
        ],
    },
    {
        nom: 'Artisanat',
        categories: [
            { nom: 'Production', natures: ['Atelier', 'Menuiserie'] },
        ],
    },
    {
        nom: 'Autre',
        categories: [
            { nom: 'Autre', natures: ['Autre'] },
        ],
    },
];

const TAILLES = ['Gros', 'Moyen', 'Petit'];

module.exports = { KYC_SEED, TAILLES };
