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

// ─── TRANSCRIBE ───
function transcribeAudio(audioBase64, lang) {
  const tmpDir = '/tmp/balie-transcribe';
  if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
  
  const inputFile = path.join(tmpDir, 'input.webm');
  const outputBase = path.join(tmpDir, 'input');
  
  // Decodificar base64 a archivo
  const buf = Buffer.from(audioBase64, 'base64');
  fs.writeFileSync(inputFile, buf);
  
  // Mapa de códigos de idioma
  const langMap = { es: 'es', nl: 'nl', en: 'en', pt: 'pt' };
  const whisperLang = langMap[lang] || 'es';
  
  try {
    const out = execSync(
      `whisper --model tiny --language ${whisperLang} --output_format txt --output_dir "${tmpDir}" "${inputFile}"`,
      { encoding: 'utf8', timeout: 30000 }
    );
    
    // Leer el resultado
    const txtPath = outputBase + '.txt';
    if (fs.existsSync(txtPath)) {
      const text = fs.readFileSync(txtPath, 'utf8').trim();
      // Limpiar temp
      try { fs.unlinkSync(inputFile); fs.unlinkSync(txtPath); } catch(e) {}
      return text || null;
    }
    return null;
  } catch (e) {
    log(`⚠️ Whisper error: ${(e.message || '').slice(0, 150)}`);
    // Limpiar temp
    try { fs.unlinkSync(inputFile); } catch(e2) {}
    return null;
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
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // Telegram webhook endpoint
  if (req.method === 'POST' && req.url === '/telegram') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const update = JSON.parse(body);
        log(`📱 Telegram: ${update.message?.chat?.id} → ${update.message?.text?.slice(0,100)}`);
        // Store incoming message for processing
        const home = process.env.HOME || '/home/sacharuna';
        const tDir = home + '/.balie/telegram-inbox/';
        if (!fs.existsSync(tDir)) fs.mkdirSync(tDir, { recursive: true });
        fs.writeFileSync(tDir + Date.now() + '.json', JSON.stringify({
          chat_id: update.message?.chat?.id,
          text: update.message?.text,
          date: update.message?.date,
          from: update.message?.from
        }, null, 2));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok' }));
      } catch(e) {
        res.writeHead(200);
        res.end('ok');
      }
    });
    return;
  }

  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', uptime: process.uptime() }));
    return;
  }

  if (req.method === 'POST' && req.url === '/') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
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
    });
    return;
  }

  if (req.method === 'POST' && req.url === '/transcribe') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const payload = JSON.parse(body);
        const audioBase64 = payload.audio;
        const lang = payload.lang || 'es';
        
        if (!audioBase64) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'error', message: 'No audio data' }));
          return;
        }
        
        log(`🎤 Transcribiendo audio (${Math.round(audioBase64.length * 3/4 / 1024)} KB, lang: ${lang})...`);
        const text = transcribeAudio(audioBase64, lang);
        
        if (text) {
          log(`✅ Transcripción: "${text.slice(0, 100)}${text.length > 100 ? '...' : ''}"`);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'ok', text: text }));
        } else {
          log(`⚠️ Transcripción vacía`);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'ok', text: '' }));
        }
      } catch (e) {
        log(`❌ Error en transcripción: ${e.message}`);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'error', message: e.message }));
      }
    });
    return;
  }

  if (req.method === 'POST' && req.url === '/homogenize') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const payload = JSON.parse(body);
        const home = process.env.HOME || '/home/sacharuna';
        const queueDir = home + '/.balie/homogenize-queue/';
        if (!fs.existsSync(queueDir)) fs.mkdirSync(queueDir, { recursive: true });
        const file = queueDir + 'req-' + Date.now() + '.json';
        fs.writeFileSync(file, JSON.stringify(payload, null, 2));
        log(`🤖 Homogenize request: ${payload.title} - ${payload.field} (${(payload.text || '').length} chars)`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', id: path.basename(file) }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'error', message: e.message }));
      }
    });
    return;
  }

  // 404
  res.writeHead(404);
  res.end('Not Found');
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
