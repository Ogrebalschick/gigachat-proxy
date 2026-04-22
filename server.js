// Добавьте после других эндпоинтов

// 7. Обновление памяти пользователя
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

// Обновите эндпоинт /api/chat для анализа и сохранения памяти
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
        
        // Получаем текущую память пользователя из БД
        const memoryResult = await pool.query(
            'SELECT content FROM user_memory WHERE user_id = $1 ORDER BY timestamp DESC',
            [userId]
        );
        const userMemory = memoryResult.rows.map(row => row.content);
        
        // Получаем историю чата
        const historyResult = await pool.query(
            'SELECT role, content FROM messages WHERE user_id = $1 ORDER BY timestamp DESC LIMIT 10',
            [userId]
        );
        const history = historyResult.rows.reverse();
        
        // Формируем промпт для AI с инструкцией извлекать информацию
        const prompt = `Ты - психолог. Твои задачи:
1. Отвечать на сообщение пользователя
2. Анализировать и запоминать важную информацию о пользователе (имя, возраст, проблемы, факты из жизни)

Информация, которая уже известна о пользователе:
${userMemory.length > 0 ? userMemory.map(m => `- ${m}`).join('\n') : 'Пока ничего не известно'}

История диалога:
${history.map(msg => `${msg.role === 'user' ? 'Пользователь' : 'Психолог'}: ${msg.content}`).join('\n')}

Пользователь: ${message}

ОТВЕТЬ В ФОРМАТЕ JSON:
{
  "reply": "твой ответ пользователю",
  "newMemory": ["новая информация для запоминания", "ещё факт"]
}

Если новая информация не обнаружена, newMemory должен быть пустым массивом.`;

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
        
        // Парсим JSON ответ
        let parsed;
        try {
            parsed = JSON.parse(aiResponse);
        } catch (e) {
            parsed = { reply: aiResponse, newMemory: [] };
        }
        
        const reply = parsed.reply || aiResponse;
        const newMemory = parsed.newMemory || [];
        
        // Сохраняем новую информацию в память
        for (const memText of newMemory) {
            if (memText && memText.trim()) {
                await pool.query(
                    'INSERT INTO user_memory (user_id, content, timestamp) VALUES ($1, $2, $3)',
                    [userId, memText, Date.now()]
                );
            }
        }
        
        // Сохраняем ответ AI
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
