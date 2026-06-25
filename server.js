const WebSocket = require('ws');
const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');

const port = process.env.PORT || 8080;

// ========== Skin Storage Setup ==========
const SKINS_DIR = path.join(__dirname, 'skins');
if (!fs.existsSync(SKINS_DIR)) {
    fs.mkdirSync(SKINS_DIR, { recursive: true });
}

// ========== HTTP Server (For Skins & API) ==========
const server = http.createServer((req, res) => {
    // السماح بالوصول من أي مكان (CORS) لدعم اللانشر
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
    }

    // 1. رفع السكنات (Upload Skin API)
    if (req.method === 'POST' && req.url === '/api/skin/upload') {
        let body = '';
        req.on('data', chunk => { body += chunk.toString(); });
        req.on('end', () => {
            try {
                const data = JSON.parse(body);
                if (!data.uuid || !data.skinBase64) {
                    res.writeHead(400);
                    res.end(JSON.stringify({ error: 'Missing uuid or skinBase64' }));
                    return;
                }
                
                // تنظيف وإعداد كود Base64 للصورة
                const base64Data = data.skinBase64.replace(/^data:image\/png;base64,/, "");
                const filePath = path.join(SKINS_DIR, `${data.uuid}.png`);
                
                fs.writeFile(filePath, base64Data, 'base64', (err) => {
                    if (err) {
                        console.error('Error saving skin:', err);
                        res.writeHead(500);
                        res.end(JSON.stringify({ error: 'Failed to save skin' }));
                    } else {
                        console.log(`[SKINS] Custom skin uploaded for UUID: ${data.uuid}`);
                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ success: true, message: 'Skin uploaded successfully' }));
                    }
                });
            } catch (e) {
                res.writeHead(400);
                res.end(JSON.stringify({ error: 'Invalid JSON body' }));
            }
        });
        return;
    }

    // 2. طلب السكنات (Get Skin API)
    if (req.method === 'GET' && req.url.startsWith('/api/skin/')) {
        const fileName = req.url.split('/').pop();
        
        // حماية من محاولات اختراق المسارات (Directory Traversal)
        if (!fileName.endsWith('.png') || fileName.includes('..')) {
            res.writeHead(403);
            res.end('Forbidden');
            return;
        }

        const filePath = path.join(SKINS_DIR, fileName);
        fs.readFile(filePath, (err, data) => {
            if (err) {
                res.writeHead(404);
                res.end('Skin not found');
            } else {
                res.writeHead(200, { 'Content-Type': 'image/png' });
                res.end(data);
            }
        });
        return;
    }

    // للروابط غير المعروفة
    res.writeHead(404);
    res.end('Nexus Backend Server is running.');
});

// ========== WebSocket Server ==========
// الآن نربط WebSocket بنفس سيرفر الـ HTTP لتوفير المنفذ
const wss = new WebSocket.Server({ server });

// ========== AI Configuration ==========
const AI_ENDPOINT = process.env.AI_ENDPOINT || 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions';
const AI_KEY      = process.env.AI_KEY      || 'AQ.Ab8RN6JKnke-ohnhlNkK-hB3-3A-Nxoj7HhQjIEg32pkKv-bGg';
const AI_MODEL    = process.env.AI_MODEL    || 'gemini-2.0-flash';
// =======================================

// Track connected users
const users = new Map(); 

wss.on('connection', (ws) => {
    console.log('Client connected');
    ws.on('message', (messageAsString) => {
        try {
            const data = JSON.parse(messageAsString);
            if (data.type === 'AUTH') {
                users.set(ws, {
                    username: data.username, uuid: data.uuid, cosmetics: [],
                    voiceCount: 0, voiceWindowStart: 0,
                    aiCount: 0, aiWindowStart: 0
                });
                console.log(`User authenticated: ${data.username}`);
                broadcastPresence();
            } else if (data.type === 'CHAT') {
                const user = users.get(ws);
                if (user) {
                    console.log(`[CHAT] ${user.username}: ${data.message}`);
                    broadcast({
                        type: 'CHAT',
                        username: user.username,
                        message: data.message,
                        timestamp: Date.now()
                    });
                }
            } else if (data.type === 'VOICE') {
                const user = users.get(ws);
                if (!user) return;
                if (typeof data.data !== 'string' || data.data.length > 4096) return;
                const now = Date.now();
                if (now - user.voiceWindowStart > 1000) { user.voiceWindowStart = now; user.voiceCount = 0; }
                if (++user.voiceCount > 60) return;
                broadcastExcept({
                    type: 'VOICE',
                    username: user.username,
                    data: data.data,
                    seq: data.seq
                }, ws);
            } else if (data.type === 'AI_CHAT') {
                const user = users.get(ws);
                if (!user) return;
                const now = Date.now();
                if (now - user.aiWindowStart > 60000) { user.aiWindowStart = now; user.aiCount = 0; }
                if (++user.aiCount > 10) {
                    ws.send(JSON.stringify({ type: 'AI_ERROR', message: 'Rate limit: max 10 AI requests per minute. Wait a moment.' }));
                    return;
                }
                if (!AI_KEY) {
                    ws.send(JSON.stringify({ type: 'AI_ERROR', message: 'AI is not configured on the server. Set AI_KEY env variable.' }));
                    return;
                }
                console.log(`[AI] ${user.username}: ${data.prompt}`);
                const messages = data.messages || [
                    { role: 'system', content: 'You are Nexus AI, a helpful assistant in a Minecraft client.' },
                    { role: 'user', content: data.prompt }
                ];
                const body = JSON.stringify({
                    model: AI_MODEL,
                    stream: false,
                    messages: messages
                });
                const url = new URL(AI_ENDPOINT);
                const isHttps = url.protocol === 'https:';
                const options = {
                    hostname: url.hostname,
                    port: url.port || (isHttps ? 443 : 80),
                    path: url.pathname + url.search,
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Accept': 'application/json',
                        'Authorization': `Bearer ${AI_KEY}`,
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
                        'Content-Length': Buffer.byteLength(body)
                    }
                };
                const lib = isHttps ? https : http;
                const req = lib.request(options, (res) => {
                    let responseData = '';
                    res.on('data', (chunk) => { responseData += chunk; });
                    res.on('end', () => {
                        try {
                            if (res.statusCode >= 200 && res.statusCode < 300) {
                                const parsed = JSON.parse(responseData);
                                const reply = parsed.choices[0].message.content.trim();
                                console.log(`[AI] Response to ${user.username}: ${reply.substring(0, 80)}...`);
                                if (ws.readyState === WebSocket.OPEN) {
                                    ws.send(JSON.stringify({ type: 'AI_RESPONSE', reply: reply }));
                                }
                            } else {
                                let errMsg = `AI error (HTTP ${res.statusCode})`;
                                try {
                                    const parsed = JSON.parse(responseData);
                                    if (parsed.error && parsed.error.message) errMsg = parsed.error.message;
                                } catch (e) {}
                                console.error(`[AI] Error for ${user.username}: ${errMsg}`);
                                if (ws.readyState === WebSocket.OPEN) {
                                    ws.send(JSON.stringify({ type: 'AI_ERROR', message: errMsg }));
                                }
                            }
                        } catch (e) {
                            console.error('[AI] Parse error:', e.message);
                            if (ws.readyState === WebSocket.OPEN) {
                                ws.send(JSON.stringify({ type: 'AI_ERROR', message: 'Failed to parse AI response.' }));
                            }
                        }
                    });
                });
                req.on('error', (e) => {
                    console.error('[AI] Request error:', e.message);
                    if (ws.readyState === WebSocket.OPEN) {
                        ws.send(JSON.stringify({ type: 'AI_ERROR', message: 'Could not reach AI service: ' + e.message }));
                    }
                });
                req.setTimeout(30000, () => {
                    req.destroy();
                    if (ws.readyState === WebSocket.OPEN) {
                        ws.send(JSON.stringify({ type: 'AI_ERROR', message: 'AI request timed out. Try again.' }));
                    }
                });
                req.write(body);
                req.end();
            } else if (['FRIEND_REQUEST', 'FRIEND_ACCEPT', 'FRIEND_REJECT', 'PRIVATE_CHAT'].includes(data.type)) {
                const sender = users.get(ws);
                console.log(`[DEBUG] ${data.type} from ${sender ? sender.username : 'UNKNOWN'} to ${data.target}`);
                if (sender) {
                    const targetUsername = data.target;
                    let targetWs = null;
                    for (const [client, info] of users.entries()) {
                        if (info.username.toLowerCase() === targetUsername.toLowerCase()) {
                            targetWs = client;
                        }
                    }
                    if (targetWs && targetWs.readyState === WebSocket.OPEN) {
                        data.sender = sender.username;
                        data.timestamp = Date.now();
                        targetWs.send(JSON.stringify(data));
                    } else {
                        ws.send(JSON.stringify({
                            type: 'ERROR',
                            message: `User ${targetUsername} is offline or not found.`
                        }));
                    }
                }
            } else if (data.type === 'COSMETICS_SYNC') {
                const user = users.get(ws);
                if (user) {
                    user.cosmetics = data.cosmetics || [];
                    console.log(`[COSMETICS] ${user.username} synced cosmetics:`, user.cosmetics);
                    broadcastPresence();
                }
            }
        } catch (e) {
            console.error('Invalid message format', e);
        }
    });
    ws.on('close', () => {
        const user = users.get(ws);
        if (user) {
            console.log(`User disconnected: ${user.username}`);
            users.delete(ws);
            broadcastPresence();
        }
    });
});

function broadcast(obj) {
    const data = JSON.stringify(obj);
    for (const client of wss.clients) {
        if (client.readyState === WebSocket.OPEN) {
            client.send(data);
        }
    }
}

function broadcastExcept(obj, exceptWs) {
    const data = JSON.stringify(obj);
    for (const client of wss.clients) {
        if (client !== exceptWs && client.readyState === WebSocket.OPEN) {
            client.send(data);
        }
    }
}

function broadcastPresence() {
    const onlineUsers = Array.from(users.values()).map(u => ({
        username: u.username, uuid: u.uuid, cosmetics: u.cosmetics
    }));
    broadcast({
        type: 'PRESENCE',
        users: onlineUsers
    });
}

// تشغيل الخادم بالكامل
server.listen(port, () => {
    console.log(`Nexus Backend Server running on port ${port}`);
    console.log(`AI Provider: ${AI_ENDPOINT}`);
    console.log(`AI Model: ${AI_MODEL}`);
    console.log(`AI Key: ${AI_KEY ? '***' + AI_KEY.slice(-4) : 'NOT SET — AI chat will not work!'}`);
});
