const WebSocket = require('ws');

const port = process.env.PORT || 8080;
const wss = new WebSocket.Server({ port: port });

// Track connected users
const users = new Map(); // ws -> { username, uuid, cosmetics, voiceCount, voiceWindowStart }

wss.on('connection', (ws) => {
    console.log('Client connected');

    ws.on('message', (messageAsString) => {
        try {
            const data = JSON.parse(messageAsString);

            if (data.type === 'AUTH') {
                users.set(ws, {
                    username: data.username, uuid: data.uuid, cosmetics: [],
                    voiceCount: 0, voiceWindowStart: 0   // ★ VOICE rate-limit state
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
                // ★ VOICE — relay audio frames to everyone EXCEPT the sender
                const user = users.get(ws);
                if (!user) return;
                // size guard: drop oversized/garbage payloads
                if (typeof data.data !== 'string' || data.data.length > 4096) return;
                // rate limit: max 60 frames/sec per connection (PTT @ 20ms = 50/s)
                const now = Date.now();
                if (now - user.voiceWindowStart > 1000) { user.voiceWindowStart = now; user.voiceCount = 0; }
                if (++user.voiceCount > 60) return;
                // forward-and-forget, stamp sender, EXCLUDE sender (no self-echo)
                broadcastExcept({
                    type: 'VOICE',
                    username: user.username,
                    data: data.data,
                    seq: data.seq
                }, ws);
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

// ★ VOICE — broadcast to all clients except one (the sender)
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
        username: u.username, uuid: u.uuid, cosmetics: u.cosmetics   // don't leak rate-limit fields
    }));
    broadcast({
        type: 'PRESENCE',
        users: onlineUsers
    });
}

console.log(`Nexus Backend Server running on port ${port}`);
