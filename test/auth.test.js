// backend/test/auth.test.js

const request = require('supertest');
const { expect } = require('chai');
const mongoose = require('mongoose');
const app = require('../server');
const Agent = require('../models/Agent');
const dotenv = require('dotenv');

dotenv.config();

describe('Authentication Routes', () => {
    let adminToken;
    let agentToken;

    before(async () => {
        // Connexion à la base de données
        await mongoose.connect(process.env.MONGO_URI, {
            useNewUrlParser: true,
            useUnifiedTopology: true,
        });

        // Nettoyer la collection Agents avant le hook pour un environnement propre
        await Agent.deleteMany({});
        
        // Créer un utilisateur administrateur pour les tests
        await request(app)
            .post('/api/agents/register')
            .send({
                matricule: 'ADMIN01',
                motDePasse: 'adminpassword',
                role: 'admin',
                affiliation: 'Moov Money'
            });

        // Connexion de l'administrateur pour récupérer le token
        const loginResponse = await request(app)
            .post('/api/agents/login')
            .send({
                matricule: 'ADMIN001',
                motDePasse: 'admin123'
            });
        
        adminToken = loginResponse.body.token;
    });

    after(async () => {
        // Déconnexion après tous les tests
        await mongoose.connection.close();
    });

    beforeEach(async () => {
        // Nettoyer la collection Agents avant chaque test
        // C'est déjà fait dans le hook 'before', mais c'est une bonne pratique
    });

    // Test: L'enregistrement d'un agent par un admin
    it('should register a new agent (by admin)', async () => {
        const response = await request(app)
            .post('/api/agents/register')
            .set('x-auth-token', adminToken)
            .send({
                matricule: 'NEWAGENT',
                motDePasse: 'newagentpassword',
                role: 'agent',
                affiliation: 'Moov Money'
            });

        expect(response.status).to.equal(201);
        expect(response.body).to.have.property('token');
    });

    // Test: La connexion d'un agent enregistré fonctionne
    it('should login a registered agent', async () => {
        // Enregistrer un agent avec le token de l'admin
        await request(app)
            .post('/api/agents/register')
            .set('x-auth-token', adminToken)
            .send({
                matricule: 'AGENT01',
                motDePasse: 'agentpassword',
                role: 'agent',
                affiliation: 'Moov Money'
            });

        // Tenter de se connecter avec l'agent nouvellement créé
        const response = await request(app)
            .post('/api/agents/login')
            .send({
                matricule: 'AGENT01',
                motDePasse: 'agentpassword'
            });
            
        expect(response.status).to.equal(200);
        expect(response.body).to.have.property('token');
    });

    // Test: La connexion échoue avec un mauvais mot de passe
    it('should not login with an incorrect password', async () => {
        // Enregistrer un agent avec le token de l'admin
        await request(app)
            .post('/api/agents/register')
            .set('x-auth-token', adminToken)
            .send({
                matricule: 'AGENT02',
                motDePasse: 'agentpassword',
                role: 'agent',
                affiliation: 'Moov Money'
            });
            
        // Tenter de se connecter avec un mauvais mot de passe
        const response = await request(app)
            .post('/api/agents/login')
            .send({
                matricule: 'AGENT02',
                motDePasse: 'wrongpassword'
            });

        expect(response.status).to.equal(400);
        expect(response.body.msg).to.equal('Matricule ou mot de passe incorrect.');
    });
});