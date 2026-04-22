const express = require('express');
const cors = require('cors');
const axios = require('axios');
const crypto = require('crypto');
const https = require('https');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const { Pool } = require('pg');

const app = express();
app.use(cors());
app.use(express.json());

// Конфигурация
const JWT_SECRET = process.env.JWT_SECRET || 'your-super-secret-key-change-it';
const CLIENT_ID = "019d9baa-1f12-7893-8b49-90d8f41eb17c";
const CLIENT_SECRET = "296bbeeb-0eeb-4e82-a6d3-7710d2904ccb";

// Подключение к PostgreSQL (настройки для Render)
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: {
        rejectUnauthorized: false // Для Render PostgreSQL
    }
});

// Создание таблиц при запуске
const initDatabase = async () => {
    try {
        // Таблица пользователей
        await pool.query(`
            CREATE TABLE IF NOT EXISTS users (
                id SERIAL PRIMARY KEY,
                email TEXT UNIQUE NOT NULL,
                password_hash TEXT NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        
        // Таблица сообщений
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
        
        // Таблица памяти пользователя
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

// 3. Синхронизация чата (сохраняем сообщения на сервер)
app.post('/api/sync', authenticate, async (req, res) => {
    const { messages, memory } = req.body;
    const userId = req.userId;
    
    try {
        // Сохраняем сообщения
        if (messages && messages.length > 0) {
            // Сначала удаляем старые сообщения
            await pool.query('DELETE FROM messages WHERE user_id = $1', [userId]);
            
            // Сохраняем новые
            for (const msg of messages) {
                await pool.query(
                    'INSERT INTO messages (user_id, role, content, timestamp) VALUES ($1, $2, $3, $4)',
                    [userId, msg.author, msg.text, msg.timestamp]
                );
            }
        }
        
        // Сохраняем память
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

// 5. Чат с психологом (с учётом пользователя)
app.post('/api/chat', authenticate, async (req, res) => {
    const { message, memory } = req.body;
    const userId = req.userId;
    
    if (!message) {
        return res.status(400).json({ error: 'Message required' });
    }
    
    try {
        // Сохраняем сообщение пользователя
        await pool.query(
            'INSERT INTO messages (user_id, role, content, timestamp) VALUES ($1, $2, $3, $4)',
            [userId, 'user', message, Date.now()]
        );
        
        // Получаем историю чата для контекста
        const historyResult = await pool.query(
            'SELECT role, content FROM messages WHERE user_id = $1 ORDER BY timestamp DESC LIMIT 10',
            [userId]
        );
        
        const history = historyResult.rows.reverse();
        
        // Получаем токен GigaChat
        const token = await getGigaToken();
        
        // Формируем промпт с учётом истории и памяти
        let prompt = memory && memory.length > 0 
            ? `Информация о пользователе: ${memory.map(m => m.text).join('; ')}\n\nИстория диалога:\n`
            : 'История диалога:\n';
        
        for (const msg of history) {
            prompt += `${msg.role === 'user' ? 'Пользователь' : 'Психолог'}: ${msg.content}\n`;
        }
        prompt += `\nПользователь: ${message}\nПсихолог:`;
        
        const response = await axios.post(
            'https://gigachat.devices.sberbank.ru/api/v1/chat/completions',
            {
                model: "GigaChat",
                messages: [{ role: "user", content: prompt }],
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
        
        // Сохраняем ответ психолога
        await pool.query(
            'INSERT INTO messages (user_id, role, content, timestamp) VALUES ($1, $2, $3, $4)',
            [userId, 'ai', reply, Date.now()]
        );
        
        res.json({ success: true, reply });
    } catch (error) {
        console.error('Chat error:', error);
        res.status(500).json({ error: 'Chat failed' });
    }
});

// 6. Health check
app.get('/health', (req, res) => {
    res.json({ status: 'ok', time: new Date().toISOString() });
});

// Запуск сервера
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ Server running on port ${PORT}`);
    console.log(`📍 Health check: http://localhost:${PORT}/health`);
    console.log(`🔐 Auth endpoints: /api/register, /api/login`);
    console.log(`💬 Chat endpoint: /api/chat (requires JWT)`);
});
