const express = require('express');
const cors = require('cors');
const axios = require('axios');
const crypto = require('crypto');
const https = require('https');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const { Pool } = require('pg');

// ИНИЦИАЛИЗАЦИЯ APP - ДО ВСЕХ МАРШРУТОВ!
const app = express();
app.use(cors());
app.use(express.json());

// Конфигурация
const JWT_SECRET = process.env.JWT_SECRET || 'your-super-secret-key-change-it';
const CLIENT_ID = "019d9baa-1f12-7893-8b49-90d8f41eb17c";
const CLIENT_SECRET = "296bbeeb-0eeb-4e82-a6d3-7710d2904ccb";

// Подключение к PostgreSQL
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: {
        rejectUnauthorized: false
    }
});

// Создание таблиц
const initDatabase = async () => {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS users (
                id SERIAL PRIMARY KEY,
                email TEXT UNIQUE NOT NULL,
                password_hash TEXT NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        
        await pool.query(`
            CREATE TABLE IF NOT EXISTS messages (
                id SERIAL PRIMARY KEY,
                user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
                role TEXT NOT NULL,
                content TEXT NOT NULL,
                timestamp BIGINT NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        
        await pool.query(`
            CREATE TABLE IF NOT EXISTS user_memory (
                id SERIAL PRIMARY KEY,
                user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
                content TEXT NOT NULL,
                timestamp BIGINT NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        
        console.log('✅ Database initialized');
    } catch (error) {
        console.error('Database init error:', error);
    }
};

initDatabase();

// SSL агент для GigaChat
const agent = new https.Agent({
    rejectUnauthorized: false
});

// Кэш токена GigaChat
let cachedToken = null;
let tokenExpiry = null;

async function getGigaToken() {
    if (cachedToken && Date.now() < tokenExpiry) {
        return cachedToken;
    }
    
    const authString = `${CLIENT_ID}:${CLIENT_SECRET}`;
    const encodedAuth = Buffer.from(authString).toString('base64');
    
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
            httpsAgent: agent
        }
    );
    
    cachedToken = response.data.access_token;
    tokenExpiry = Date.now() + 25 * 60 * 1000;
    return cachedToken;
}

// Middleware для проверки JWT
const authenticate = async (req, res, next) => {
    const token = req.headers.authorization?.split(' ')[1];
    
    if (!token) {
        return res.status(401).json({ error: 'No token provided' });
    }
    
    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        req.userId = decoded.userId;
        next();
    } catch (err) {
        res.status(401).json({ error: 'Invalid token' });
    }
};

// ============ API ENDPOINTS ============

// 1. Регистрация
app.post('/api/register', async (req, res) => {
    const { email, password } = req.body;
    
    if (!email || !password) {
        return res.status(400).json({ error: 'Email and password required' });
    }
    
    try {
        const password_hash = await bcrypt.hash(password, 10);
        
        const result = await pool.query(
            'INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id',
            [email, password_hash]
        );
        
        const token = jwt.sign({ userId: result.rows[0].id }, JWT_SECRET);
        
        res.json({ success: true, token, userId: result.rows[0].id });
    } catch (error) {
        if (error.code === '23505') {
            res.status(400).json({ error: 'Email already exists' });
        } else {
            console.error('Register error:', error);
            res.status(500).json({ error: 'Registration failed' });
        }
    }
});

// 2. Вход
app.post('/api/login', async (req, res) => {
    const { email, password } = req.body;
    
    if (!email || !password) {
        return res.status(400).json({ error: 'Email and password required' });
    }
    
    try {
        const result = await pool.query(
            'SELECT * FROM users WHERE email = $1',
            [email]
        );
        
        if (result.rows.length === 0) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }
        
        const user = result.rows[0];
        const valid = await bcrypt.compare(password, user.password_hash);
        
        if (!valid) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }
        
        const token = jwt.sign({ userId: user.id }, JWT_SECRET);
        
        res.json({ success: true, token, userId: user.id });
    } catch (error) {
        console.error('Login error:', error);
        res.status(500).json({ error: 'Login failed' });
    }
});

// 3. Синхронизация чата
app.post('/api/sync', authenticate, async (req, res) => {
    const { messages, memory } = req.body;
    const userId = req.userId;
    
    try {
        if (messages && messages.length > 0) {
            await pool.query('DELETE FROM messages WHERE user_id = $1', [userId]);
            
            for (const msg of messages) {
                await pool.query(
                    'INSERT INTO messages (user_id, role, content, timestamp) VALUES ($1, $2, $3, $4)',
                    [userId, msg.author, msg.text, msg.timestamp]
                );
            }
        }
        
        if (memory && memory.length > 0) {
            await pool.query('DELETE FROM user_memory WHERE user_id = $1', [userId]);
            
            for (const mem of memory) {
                await pool.query(
                    'INSERT INTO user_memory (user_id, content, timestamp) VALUES ($1, $2, $3)',
                    [userId, mem.text, mem.timestamp]
                );
            }
        }
        
        res.json({ success: true });
    } catch (error) {
        console.error('Sync error:', error);
        res.status(500).json({ error: 'Sync failed' });
    }
});

// 4. Загрузка чата пользователя
app.get('/api/chat', authenticate, async (req, res) => {
    const userId = req.userId;
    
    try {
        const messagesResult = await pool.query(
            'SELECT * FROM messages WHERE user_id = $1 ORDER BY timestamp ASC',
            [userId]
        );
        
        const memoryResult = await pool.query(
            'SELECT * FROM user_memory WHERE user_id = $1 ORDER BY timestamp ASC',
            [userId]
        );
        
        const messages = messagesResult.rows.map(row => ({
            id: row.id,
            author: row.role,
            text: row.content,
            timestamp: row.timestamp
        }));
        
        const memory = memoryResult.rows.map(row => ({
            id: row.id,
            text: row.content,
            timestamp: row.timestamp
        }));
        
        res.json({ success: true, messages, memory });
    } catch (error) {
        console.error('Load chat error:', error);
        res.status(500).json({ error: 'Load failed' });
    }
});

// 5. Чат с психологом
app.post('/api/chat', authenticate, async (req, res) => {
    const { message, memory } = req.body;
    const userId = req.userId;
    
    if (!message) {
        return res.status(400).json({ error: 'Message required' });
    }
    
    try {
        await pool.query(
            'INSERT INTO messages (user_id, role, content, timestamp) VALUES ($1, $2, $3, $4)',
            [userId, 'user', message, Date.now()]
        );
        
        const memoryResult = await pool.query(
            'SELECT content FROM user_memory WHERE user_id = $1 ORDER BY timestamp DESC',
            [userId]
        );
        const userMemory = memoryResult.rows.map(row => row.content);
        
        const historyResult = await pool.query(
            'SELECT role, content FROM messages WHERE user_id = $1 ORDER BY timestamp DESC LIMIT 10',
            [userId]
        );
        const history = historyResult.rows.reverse();
        
        const prompt = `Ты - психолог. Твои задачи:
1. Отвечать на сообщение пользователя
2. Анализировать и запоминать важную информацию о пользователе

Информация о пользователе:
${userMemory.length > 0 ? userMemory.map(m => `- ${m}`).join('\n') : 'Пока ничего не известно'}

История диалога:
${history.map(msg => `${msg.role === 'user' ? 'Пользователь' : 'Психолог'}: ${msg.content}`).join('\n')}

Пользователь: ${message}

ОТВЕТЬ В ФОРМАТЕ JSON:
{
  "reply": "твой ответ пользователю",
  "newMemory": ["новая информация 1", "новая информация 2"]
}`;

        const token = await getGigaToken();
        const response = await axios.post(
            'https://gigachat.devices.sberbank.ru/api/v1/chat/completions',
            {
                model: "GigaChat",
                messages: [{ role: "user", content: prompt }],
                temperature: 0.7,
                max_tokens: 1000
            },
            {
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json'
                },
                httpsAgent: agent
            }
        );
        
        const aiResponse = response.data.choices?.[0]?.message?.content || "{}";
        
        let parsed;
        try {
            parsed = JSON.parse(aiResponse);
        } catch (e) {
            parsed = { reply: aiResponse, newMemory: [] };
        }
        
        const reply = parsed.reply || aiResponse;
        const newMemory = parsed.newMemory || [];
        
        for (const memText of newMemory) {
            if (memText && memText.trim()) {
                await pool.query(
                    'INSERT INTO user_memory (user_id, content, timestamp) VALUES ($1, $2, $3)',
                    [userId, memText, Date.now()]
                );
            }
        }
        
        await pool.query(
            'INSERT INTO messages (user_id, role, content, timestamp) VALUES ($1, $2, $3, $4)',
            [userId, 'ai', reply, Date.now()]
        );
        
        res.json({ success: true, reply, newMemory });
    } catch (error) {
        console.error('Chat error:', error);
        res.status(500).json({ error: 'Chat failed' });
    }
});

// 6. Health check
app.get('/health', (req, res) => {
    res.json({ status: 'ok', time: new Date().toISOString() });
});

// 7. Запуск сервера
const PORT = process.env.PORT || 3000;

// 7. Обновление памяти пользователя (ДОБАВИТЬ ЭТОТ ЭНДПОИНТ)
app.post('/api/memory', authenticate, async (req, res) => {
    const { memory } = req.body;
    const userId = req.userId;
    
    try {
        // Очищаем старую память
        await pool.query('DELETE FROM user_memory WHERE user_id = $1', [userId]);
        
        // Сохраняем новую
        for (const mem of memory) {
            await pool.query(
                'INSERT INTO user_memory (user_id, content, timestamp) VALUES ($1, $2, $3)',
                [userId, mem.text, mem.timestamp]
            );
        }
        
        res.json({ success: true });
    } catch (error) {
        console.error('Memory update error:', error);
        res.status(500).json({ error: 'Failed to update memory' });
    }
});
// Публичный эндпоинт для чата (без авторизации)
app.post('/chat', async (req, res) => {
    const { message } = req.body;
    
    if (!message) {
        return res.status(400).json({ error: 'Message required' });
    }
    
    try {
        const token = await getGigaToken();
        
        const response = await axios.post(
            'https://gigachat.devices.sberbank.ru/api/v1/chat/completions',
            {
                model: "GigaChat",
                messages: [{ role: "user", content: message }],
                temperature: 0.7,
                max_tokens: 500
            },
            {
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json'
                },
                httpsAgent: agent
            }
        );
        
        const reply = response.data.choices?.[0]?.message?.content || "Нет ответа";
        res.json({ success: true, reply });
    } catch (error) {
        console.error('Chat error:', error.message);
        res.status(500).json({ error: 'Chat failed' });
    }
});
app.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ Server running on port ${PORT}`);
});
