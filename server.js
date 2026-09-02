require('dotenv').config();
const express = require('express');
const path = require('path');
const { GeminiGenerator } = require('./lib/generator');

const app = express();
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.GRIZZLY_API_KEY;

// Initialize generator
const generator = new GeminiGenerator(API_KEY);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// API Routes
app.get('/api/status', (req, res) => {
    res.json(generator.getStatus());
});

app.get('/api/links', (req, res) => {
    res.json(generator.getLinks());
});

app.get('/api/logs', (req, res) => {
    res.json(generator.getLogs());
});

app.post('/api/start', (req, res) => {
    const result = generator.start();
    res.json(result);
});

app.post('/api/stop', (req, res) => {
    const result = generator.stop();
    res.json(result);
});

// Start Server
app.listen(PORT, () => {
    console.log(`Gemini Generator Server running on port ${PORT}`);
    
    // Auto-start the generator on boot so it runs continuously on Railway
    generator.start();
});
