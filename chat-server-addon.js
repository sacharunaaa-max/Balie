/**
 * Chat Addon for BALIE Sync Server
 * Añade endpoints de chat al servidor existente.
 * 
 * Endpoints:
 *   GET  /chat/poll?after=ID  → devuelve mensajes nuevos desde ID
 *   POST /chat/send           → envía un mensaje
 *   GET  /chat/status         → info del chat
 */

const fs = require('fs');
const path = require('path');

const CHAT_FILE = path.resolve(process.env.HOME || '/home/sacharuna', '.balie', 'chat-data.json');
const UPLOAD_DIR = path.resolve(process.env.HOME || '/home/sacharuna', '.balie', 'chat-uploads');
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024; // 10 MB

// Asegurar directorio de uploads
function ensureUploadDir() {
  if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

// Inicializar archivo de chat si no existe
function initChatFile() {
  if (!fs.existsSync(CHAT_FILE)) {
    fs.writeFileSync(CHAT_FILE, JSON.stringify({ messages: [], nextId: 1, lastBotReply: 0 }), 'utf8');
  }
}

function readChatData() {
  initChatFile();
  try {
    return JSON.parse(fs.readFileSync(CHAT_FILE, 'utf8'));
  } catch (e) {
    return { messages: [], nextId: 1, lastBotReply: 0 };
  }
}

function saveChatData(data) {
  fs.writeFileSync(CHAT_FILE, JSON.stringify(data, null, 2), 'utf8');
}

function handleChat(req, res, body) {
  const url = new URL(req.url, 'http://localhost');

  // GET /chat/poll?after=0  → devuelve mensajes después de ese ID
  if (req.method === 'GET' && url.pathname === '/chat/poll') {
    const after = parseInt(url.searchParams.get('after') || '0', 10);
    const data = readChatData();
    const newMessages = data.messages.filter(m => m.id > after);
    
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      messages: newMessages,
      nextId: data.nextId,
      lastBotReply: data.lastBotReply || 0,
      serverTime: new Date().toISOString()
    }));
    return true;
  }

  // POST /chat/send
  if (req.method === 'POST' && url.pathname === '/chat/send') {
    try {
      const payload = JSON.parse(body);
      const text = (payload.text || '').trim();
      if (!text) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'text vacío' }));
        return true;
      }

      const data = readChatData();
      const msg = {
        id: data.nextId,
        from: 'user',
        text: text,
        ts: new Date().toISOString()
      };
      data.nextId++;
      data.messages.push(msg);

      // Mantener máximo 500 mensajes para no crecer infinito
      if (data.messages.length > 500) {
        data.messages = data.messages.slice(-400);
      }

      saveChatData(data);

      console.log(`[💬] usuario → "${text.slice(0, 80)}" (id:${msg.id})`);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', id: msg.id, ts: msg.ts }));
      return true;
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
      return true;
    }
  }

  // POST /chat/upload  → subir archivo
  if (req.method === 'POST' && url.pathname === '/chat/upload') {
    try {
      const payload = JSON.parse(body);
      const fileName = (payload.name || 'archivo').replace(/[^a-zA-Z0-9._\-]/g, '_').slice(0, 100);
      const mimeType = payload.mimeType || 'application/octet-stream';
      const fileData = payload.data; // base64

      if (!fileData) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'No file data' }));
        return true;
      }

      const buf = Buffer.from(fileData, 'base64');
      if (buf.length > MAX_UPLOAD_BYTES) {
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `File too large (max ${Math.round(MAX_UPLOAD_BYTES/1024/1024)} MB)` }));
        return true;
      }

      ensureUploadDir();
      const ts = new Date().toISOString().replace(/[:-]/g, '').replace('T', '-').slice(0, 19);
      const safeName = `${ts}-${fileName}`;
      const filePath = path.join(UPLOAD_DIR, safeName);
      fs.writeFileSync(filePath, buf);

      const data = readChatData();
      const msg = {
        id: data.nextId,
        from: 'user',
        type: 'file',
        text: `📎 ${fileName}`,
        file: {
          name: fileName,
          mimeType: mimeType,
          size: buf.length,
          path: safeName
        },
        ts: new Date().toISOString()
      };
      data.nextId++;
      data.messages.push(msg);
      if (data.messages.length > 500) data.messages = data.messages.slice(-400);
      saveChatData(data);

      console.log(`[📎] Archivo: ${fileName} (${Math.round(buf.length/1024)} KB, id:${msg.id})`);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', id: msg.id, fileName, size: buf.length }));
      return true;
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
      return true;
    }
  }

  // GET /chat/files/:name  → descargar archivo subido
  if (req.method === 'GET' && url.pathname.startsWith('/chat/files/')) {
    const fileName = decodeURIComponent(url.pathname.slice('/chat/files/'.length));
    // Sanitizar para evitar path traversal
    const safeName = path.basename(fileName);
    const filePath = path.join(UPLOAD_DIR, safeName);
    
    if (!fs.existsSync(filePath)) {
      res.writeHead(404);
      res.end('File not found');
      return true;
    }

    const stat = fs.statSync(filePath);
    const ext = path.extname(safeName).toLowerCase();
    const mimeMap = {
      '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
      '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
      '.pdf': 'application/pdf', '.doc': 'application/msword',
      '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      '.xls': 'application/vnd.ms-excel',
      '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      '.txt': 'text/plain', '.csv': 'text/csv', '.json': 'application/json',
      '.zip': 'application/zip', '.mp4': 'video/mp4', '.mp3': 'audio/mpeg'
    };
    const contentType = mimeMap[ext] || 'application/octet-stream';

    res.writeHead(200, {
      'Content-Type': contentType,
      'Content-Length': stat.size,
      'Content-Disposition': `inline; filename="${safeName}"`
    });
    fs.createReadStream(filePath).pipe(res);
    return true;
  }

  // POST /chat/reply  → el bot escribe una respuesta
  if (req.method === 'POST' && url.pathname === '/chat/reply') {
    try {
      const payload = JSON.parse(body);
      const text = (payload.text || '').trim();
      if (!text) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'text vacío' }));
        return true;
      }

      const data = readChatData();
      const msg = {
        id: data.nextId,
        from: 'bot',
        text: text,
        ts: new Date().toISOString()
      };
      data.nextId++;
      data.messages.push(msg);
      data.lastBotReply = msg.id;

      if (data.messages.length > 500) {
        data.messages = data.messages.slice(-400);
      }

      saveChatData(data);
      console.log(`[💬] bot → "${text.slice(0, 80)}" (id:${msg.id})`);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', id: msg.id, ts: msg.ts }));
      return true;
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
      return true;
    }
  }

  // GET /chat/status
  if (req.method === 'GET' && url.pathname === '/chat/status') {
    const data = readChatData();
    const lastMsg = data.messages.length > 0 ? data.messages[data.messages.length - 1] : null;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      totalMessages: data.messages.length,
      nextId: data.nextId,
      lastBotReply: data.lastBotReply || 0,
      lastMessage: lastMsg,
      serverTime: new Date().toISOString()
    }));
    return true;
  }

  return false;
}

// Exportar para usar desde sync-server.js
module.exports = { handleChat, readChatData, saveChatData, CHAT_FILE };

// Si se ejecuta standalone, mostrar ayuda
if (require.main === module) {
  console.log('📋 Chat Addon para BALIE Sync Server');
  console.log('  Importa este módulo desde sync-server.js');
}
