#!/usr/bin/env node
/**
 * BALIE Sync Server
 * Recibe datos desde la webapp (botón ☁️ Subir / Sync all)
 * y los commitea al repositorio GitHub automáticamente.
 *
 * Puerto: 18999
 * Ruta: POST / → recibe { name, data }
 */

const http = require('http');
const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

// Chat addon
const chatAddon = require('./chat-server-addon.js');

const PORT = 18999;
const REPO_DIR = path.resolve(__dirname);
const DATA_DIR = path.join(REPO_DIR, 'balie-data');

// Asegurar que balie-data existe
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

function log(msg) {
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
  console.log(`[${ts}] ${msg}`);
}

function runGit(args) {
  // Escapar cada argumento para shell (comillas simples escapadas)
  const escaped = args.map(a => `'${a.replace(/'/g, "'\\''")}'`).join(' ');
  return execSync('git ' + escaped, { cwd: REPO_DIR, encoding: 'utf8' }).trim();
}

function saveAndCommit(name, rawData) {
  // Parsear data si viene como string JSON
  let parsed;
  try {
    parsed = typeof rawData === 'string' ? JSON.parse(rawData) : rawData;
  } catch (e) {
    parsed = rawData; // si no se puede parsear, usarlo como viene
  }

  // Generar nombre de archivo con timestamp
  const ts = new Date().toISOString()
    .replace(/[:-]/g, '')
    .replace('T', '-')
    .slice(0, 19);
  
  // Sanitizar nombre para filename
  const safeName = (name || 'actividad')
    .replace(/[^a-zA-Z0-9_\-]/g, '_')
    .toLowerCase()
    .slice(0, 50);

  const filename = `${ts}-${safeName}.json`;
  const filepath = path.join(DATA_DIR, filename);

  // Guardar archivo
  const jsonContent = typeof parsed === 'object' && parsed !== null
    ? JSON.stringify(parsed, null, 2)
    : String(parsed);
  
  fs.writeFileSync(filepath, jsonContent, 'utf8');
  log(`📝 Guardado: ${filename}`);

  // Generar markdown de procesos desde los datos
  if (parsed.activities && Array.isArray(parsed.activities)) {
    generateProcessMarkdown(parsed.activities);
  } else if (parsed.title) {
    generateProcessMarkdown([parsed]);
  }

  // Commit y push
  try {
    runGit(['add', 'balie-data/' + filename]);
    runGit(['add', 'balie-procesos.md']); // por si se actualizó
    
    const commitMsg = `BALIE sync: ${safeName}`;
    runGit(['commit', '-m', commitMsg.replace(/:/g, '')]);
    log(`💾 Commit: ${commitMsg}`);

    runGit(['push', 'origin', 'main']);
    log(`🚀 Push exitoso → GitHub`);
    return { ok: true, file: filename };
  } catch (e) {
    const errMsg = e.message || String(e);
    // Si no hay nada que commitear (datos duplicados), no es error
    if (errMsg.includes('nothing to commit') || errMsg.includes('nothing added')) {
      log(`ℹ️ Sin cambios nuevos que commitear`);
      return { ok: true, file: filename, noChanges: true };
    }
    log(`❌ Error git: ${errMsg.slice(0, 200)}`);
    return { ok: false, error: errMsg.slice(0, 200) };
  }
}

function generateProcessMarkdown(activities) {
  let md = '# BALIE — Procesos Documentados\n\n';
  md += `> Sincronizado: ${new Date().toLocaleString('es-ES', { timeZone: 'Europe/Amsterdam' })}\n\n`;

  activities.forEach((a, idx) => {
    const title = a.title || `Proceso ${idx + 1}`;
    md += `---\n\n## 📋 ${title}\n\n`;
    
    if (a.objective) md += `**Objetivo:** ${a.objective}\n\n`;
    
    if (a.routes && a.routes.length > 0) {
      md += `**Rutas del sistema:**\n`;
      a.routes.forEach(r => md += `- \`${r}\`\n`);
      md += '\n';
    }

    if (a.steps && a.steps.length > 0) {
      md += '**Pasos:**\n\n';
      a.steps.forEach((s, i) => {
        md += `${i + 1}. ${s.text || '(sin descripción)'}\n`;
        if (s.audios && s.audios.length > 0) md += `   *(🎤 ${s.audios.length} audio(s))*\n`;
        if (s.photos && s.photos.length > 0) md += `   *(📸 ${s.photos.length} foto(s))*\n`;
      });
      md += '\n';
    }

    if (a.errors) md += `**⚠️ Errores comunes:**\n${a.errors}\n\n`;
    if (a.emails) md += `**📧 Emails:**\n${a.emails}\n\n`;
  });

  fs.writeFileSync(path.join(REPO_DIR, 'balie-procesos.md'), md, 'utf8');
  log(`📝 Procesos markdown actualizado`);
}

// ─── Servidor HTTP ───
const server = http.createServer((req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // Colectar body para cualquier ruta
  function collectBody(cb) {
    if (req.method === 'GET') return cb('');
    let data = '';
    req.on('data', chunk => data += chunk);
    req.on('end', () => cb(data));
  }

  collectBody((body) => {
    const url = req.url;

    // Health
    if (req.method === 'GET' && url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', uptime: process.uptime() }));
      return;
    }

    // POST / → BALIE sync (guardar actividades)
    if (req.method === 'POST' && url === '/') {
      try {
        const payload = JSON.parse(body);
        const name = payload.name || 'actividad';
        const rawData = payload.data || payload;

        log(`📩 Recibido: "${name}" (${body.length} bytes)`);
        
        const result = saveAndCommit(name, rawData);

        if (result.ok) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'ok', file: result.file }));
        } else {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'error', message: result.error }));
        }
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'error', message: e.message }));
      }
      return;
    }

        // Chat endpoints
    if (chatAddon.handleChat(req, res, body)) {
      return;
    }

    // POST /transcribe  → transcripción vía Whisper
    if (req.method === 'POST' && url === '/transcribe') {
      try {
        const payload = JSON.parse(body);
        const audioBase64 = payload.audio;
        const lang = payload.lang || 'es';

        if (!audioBase64 || audioBase64.length < 100) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'error', message: 'Audio demasiado corto o vacío' }));
          return;
        }

        // Decodificar base64 a archivo temporal
        const tmpDir = '/tmp/balie-transcribe';
        if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
        const ts = Date.now();
        const tmpFile = path.join(tmpDir, `audio-${ts}.webm`);
        const wavFile = path.join(tmpDir, `audio-${ts}.wav`);
        const audioBuffer = Buffer.from(audioBase64, 'base64');
        fs.writeFileSync(tmpFile, audioBuffer);

        log(`🎤 Transcribiendo audio (${(audioBuffer.length / 1024).toFixed(0)} KB, lang: ${lang})`);

        const { execSync } = require('child_process');
        let text = '';

        // Convertir a WAV con ffmpeg (maneja cualquier codec: webm, 3gpp, mp4, ogg)
        try {
          execSync(
            `ffmpeg -y -i "${tmpFile}" -ar 16000 -ac 1 -sample_fmt s16 "${wavFile}" 2>/dev/null`,
            { encoding: 'utf8', timeout: 30000 }
          );
        } catch (convErr) {
          log(`⚠️ ffmpeg conversion failed: ${convErr.message.slice(0, 100)}, trying raw`);
        }

        const inputFile = fs.existsSync(wavFile) ? wavFile : tmpFile;

        // Ejecutar Whisper
        try {
          const output = execSync(
            `whisper --model tiny --language ${lang} --task transcribe --output_format txt "${inputFile}" 2>/dev/null`,
            { encoding: 'utf8', timeout: 120000, cwd: tmpDir }
          );
          // Whisper guarda un .txt al lado del archivo
          const txtFile = inputFile.replace(/\.\w+$/, '.txt');
          if (fs.existsSync(txtFile)) {
            text = fs.readFileSync(txtFile, 'utf8').trim();
            fs.unlinkSync(txtFile);
          } else {
            text = output.trim();
          }
        } catch (whisperErr) {
          log(`❌ Whisper error: ${whisperErr.message.slice(0, 200)}`);
        }

        // Limpiar temporales
        try { fs.unlinkSync(tmpFile); } catch(e) {}
        try { fs.unlinkSync(wavFile); } catch(e) {}

        if (text) {
          log(`✅ Transcripción: "${text.slice(0, 80)}${text.length > 80 ? '...' : ''}"`);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'ok', text }));
        } else {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'error', message: 'No se pudo transcribir el audio' }));
        }
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'error', message: e.message }));
      }
      return;
    }

    // POST /homogenize  → guardar texto para que OpenClaw lo corrija
    if (req.method === 'POST' && url === '/homogenize') {
      try {
        const payload = JSON.parse(body);
        const { title, field, text, reqId, ts } = payload;

        if (!text) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'error', message: 'No text provided' }));
          return;
        }

        // Guardar en la cola de homogenización
        const queueDir = path.resolve(process.env.HOME || '/home/sacharuna', '.balie', 'homogenize-queue');
        if (!fs.existsSync(queueDir)) fs.mkdirSync(queueDir, { recursive: true });

        const filename = `hom-${Date.now()}-${Math.random().toString(36).slice(2,6)}.json`;
        const filepath = path.join(queueDir, filename);

        const entry = {
          reqId: reqId || 0,
          title: title || 'Sin título',
          field: field || 'text',
          text: text,
          ts: ts || new Date().toISOString(),
          receivedAt: new Date().toISOString()
        };

        fs.writeFileSync(filepath, JSON.stringify(entry, null, 2), 'utf8');
        log(`🤖 Homogenize queue: [${title}] ${field} → ${filename}`);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', file: filename }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'error', message: e.message }));
      }
      return;
    }

    // 404
    res.writeHead(404);
    res.end('Not Found');
  });
});

server.listen(PORT, '0.0.0.0', () => {
  log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  log(`  🟢 BALIE Sync Server corriendo`);
  log(`  📡 Puerto: ${PORT}`);
  log(`  🌐 http://0.0.0.0:${PORT}`);
  log(`  🏡 LAN: http://192.168.178.38:${PORT}`);
  log(`  🩺 Health: http://localhost:${PORT}/health`);
  log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
});
