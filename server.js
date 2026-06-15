const WebSocket = require('ws');

const port = process.env.PORT || 8080;
const wss = new WebSocket.Server({ port: port });

// Track connected users
const users = new Map(); // ws -> { username, uuid }

wss.on('connection', (ws) => {
    console.log('Client connected');

    ws.on('message', (messageAsString) => {
        try {
            const data = JSON.parse(messageAsString);
            
            if (data.type === 'AUTH') {
                users.set(ws, { username: data.username, uuid: data.uuid, cosmetics: [] });
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
            } else if (['FRIEND_REQUEST', 'FRIEND_ACCEPT', 'FRIEND_REJECT', 'PRIVATE_CHAT'].includes(data.type)) {
                const sender = users.get(ws);
                console.log(`[DEBUG] ${data.type} from ${sender ? sender.username : 'UNKNOWN'} to ${data.target}`);
                if (sender) {
                    const targetUsername = data.target;
                    let targetWs = null;
                    // Log all connected users for debugging
                    console.log(`[DEBUG] All connected users:`);
                    for (const [client, info] of users.entries()) {
                        console.log(`[DEBUG]   - ${info.username} (readyState: ${client.readyState})`);
                        if (info.username.toLowerCase() === targetUsername.toLowerCase()) {
                            targetWs = client;
                        }
                    }
                    if (targetWs && targetWs.readyState === WebSocket.OPEN) {
                        data.sender = sender.username;
                        data.timestamp = Date.now();
                        const payload = JSON.stringify(data);
                        console.log(`[DEBUG] FORWARDING to ${targetUsername}: ${payload}`);
                        targetWs.send(payload);
                        console.log(`[DEBUG] SENT successfully!`);
                    } else {
                        console.log(`[DEBUG] TARGET NOT FOUND or OFFLINE: ${targetUsername}`);
                        ws.send(JSON.stringify({
                            type: 'ERROR',
                            message: `User ${targetUsername} is offline or not found.`
                        }));
                    }
                } else {
                    console.log(`[DEBUG] SENDER NOT AUTHENTICATED!`);
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

function broadcastPresence() {
    const onlineUsers = Array.from(users.values());
    broadcast({
        type: 'PRESENCE',
        users: onlineUsers
    });
}

console.log(`Nexus Backend Server running on port ${port}`);
