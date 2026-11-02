// backend/test/agent.test.js

const { expect } = require('chai');
const mongoose = require('mongoose');
const Agent = require('../models/Agent');
const dotenv = require('dotenv');

dotenv.config();

describe('Agent Model', () => {
  // Connect to the database once before all tests
  before(async () => {
    await mongoose.connect(process.env.MONGO_URI, {
      useNewUrlParser: true,
      useUnifiedTopology: true,
    });
  });

  // Clean the Agent collection before each test
  beforeEach(async () => {
    await Agent.deleteMany({});
  });

  // Disconnect from the database once after all tests
  after(async () => {
    await mongoose.connection.close();
  });

  // Test 1: L'agent est créé avec les champs requis
  it('should create an agent with required fields', async () => {
    const agent = new Agent({
      matricule: 'T001',
      motDePasse: 'testpassword',
      affiliation: 'Moov Money'
    });
    const savedAgent = await agent.save();
    expect(savedAgent.matricule).to.equal('T001');
    expect(savedAgent.role).to.equal('agent'); // Vérifie le rôle par défaut
  });

  // Test 2: Un agent ne peut pas être créé sans matricule
  it('should not save an agent without a matricule', async () => {
    const agent = new Agent({
      motDePasse: 'testpassword',
      affiliation: 'Moov Money'
    });
    try {
      await agent.save();
      // If save succeeds, force a failure as it should not save
      expect.fail('Agent was saved without a matricule');
    } catch (err) {
      expect(err.name).to.equal('ValidationError');
      expect(err.errors.matricule.kind).to.equal('required');
    }
  });

  // Test 3: Un agent ne peut pas avoir un matricule en double
  it('should not save an agent with a duplicate matricule', async () => {
    const agent1 = new Agent({
      matricule: 'T002',
      motDePasse: 'testpassword',
      affiliation: 'Moov Money'
    });
    await agent1.save(); // Save the first agent successfully

    const agent2 = new Agent({
      matricule: 'T002', // This is the duplicate
      motDePasse: 'testpassword',
      affiliation: 'Moov Money'
    });
    try {
      await agent2.save();
      // If save succeeds, force a failure as it should not save
      expect.fail('Duplicate agent was saved');
    } catch (err) {
      expect(err.name).to.equal('MongoServerError'); // Updated error name
      expect(err.code).to.equal(11000); // Code d'erreur pour les doublons
    }
  });
});