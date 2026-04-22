const express = require('express');
const cors = require('cors');
const axios = require('axios');
const crypto = require('crypto');
const https = require('https');

const app = express();
app.use(cors());
app.use(express.json());

// Создаем агент с игнорированием SSL ошибок
const agent = new https.Agent({
    rejectUnauthorized: false
});

const CLIENT_ID = "019d9baa-1f12-7893-8b49-90d8f41eb17c";
const CLIENT_SECRET = "296bbeeb-0eeb-4e82-a6d3-7710d2904ccb";

let cachedToken = null;
let tokenExpiry = null;

async function getToken() {
    if (cachedToken && Date.now() < tokenExpiry) {
        return cachedToken;
    }
    
    const authString = `${CLIENT_ID}:${CLIENT_SECRET}`;
    const encodedAuth = Buffer.from(authString).toString('base64');
    
    try {
        const response = await axios.post(
            'https://ngw.devices.sberbank.ru:9443/api/v2/oauth',
            'scope=GIGACHAT_API_PERS',
            {
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'Accept': 'application/json',
                    'RqUID': crypto.randomUUID(),
                    'Authorization': `Basic ${encodedAuth}`
                },
                httpsAgent: agent,  // Игнорируем SSL
                timeout: 10000
            }
        );
        
        cachedToken = response.data.access_token;
        tokenExpiry = Date.now() + 25 * 60 * 1000;
        return cachedToken;
    } catch (error) {
        console.error('Token error:', error.message);
        throw error;
    }
}

app.post('/chat', async (req, res) => {
    try {
        const token = await getToken();
        const userMessage = req.body.message;
        
        if (!userMessage) {
            return res.status(400).json({ 
                success: false, 
                error: 'Message is required' 
            });
        }
        
        const response = await axios.post(
            'https://gigachat.devices.sberbank.ru/api/v1/chat/completions',
            {
                model: "GigaChat",
                messages: [{ role: "user", content: userMessage }],
                temperature: 0.7,
                max_tokens: 500
            },
            {
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json'
                },
                httpsAgent: agent,  // Игнорируем SSL
                timeout: 15000
            }
        );
        
        const reply = response.data.choices?.[0]?.message?.content || "Нет ответа";
        res.json({ success: true, reply });
    } catch (error) {
        console.error('Error:', error.response?.data || error.message);
        res.status(500).json({ 
            success: false, 
            error: error.response?.data?.message || error.message 
        });
    }
});

app.get('/health', (req, res) => {
    res.json({ status: 'ok', time: new Date().toISOString() });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ Server running on port ${PORT}`);
});
