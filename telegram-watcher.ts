import https from 'https';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { exec } from 'child_process';
import { z } from 'zod';

interface TelegramMessage {
  id: number;
  text: string;
  date: string | null;
}

type AppConfig = z.infer<typeof ConfigSchema>;

const ConfigSchema = z.object({
  channel: z.string().min(1, 'El nombre del canal no puede estar vacio'),
  keywords: z.array(z.string().min(1)).min(1, 'Debe haber al menos una palabra clave'),
  intervalSec: z.number().min(3, 'El intervalo minimo es 3 segundos'),
});

import notifier from 'node-notifier';

function showErrorNotification(title: string, message: string): void {
  console.error(`\n  ERROR: ${title} - ${message}`);
  try {
    notifier.notify({
      title: `Error: ${title}`,
      message: message.substring(0, 200),
      sound: true,
      appID: 'TelegramWatcher',
    });
  } catch {
  }
}

let config: AppConfig;
let TELEGRAM_URL: string;

const configPath = path.join(__dirname, 'config.json');

function loadConfig(): AppConfig | null {
  if (!fs.existsSync(configPath)) {
    showErrorNotification('Archivo no encontrado', `No se encontro config.json en ${configPath}`);
    process.exit(1);
  }
  const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const result = ConfigSchema.safeParse(raw);
  if (!result.success) {
    const errors = result.error.issues.map(e => `  ${e.path.join('.')}: ${e.message}`).join('\n');
    showErrorNotification('Configuracion invalida', `Errores en config.json:\n${errors}`);
    console.error(errors);
    return null;
  }
  return result.data;
}

try {
  config = loadConfig()!;
  if (!config) process.exit(1);
} catch (err) {
  showErrorNotification('Error de lectura', `No se pudo leer config.json: ${(err as Error).message}`);
  process.exit(1);
}

TELEGRAM_URL = `https://t.me/s/${config.channel}`;

const knownMessageIds = new Set<number>();
let firstRun = true;
let pollTimer: ReturnType<typeof setInterval> | null = null;
let watchTimeout: ReturnType<typeof setTimeout> | null = null;

function fetchPage(): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = https.get(TELEGRAM_URL, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8',
      },
    }, (res) => {
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      res.setEncoding('utf8');
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.setTimeout(15000, () => {
      req.destroy();
      reject(new Error('Timeout'));
    });
  });
}

function decodeEntities(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCharCode(parseInt(code, 10)));
}

function parseMessages(html: string): TelegramMessage[] {
  const messages: TelegramMessage[] = [];
  const parts = html.split('<div class="tgme_widget_message_wrap');
  for (let i = 1; i < parts.length; i++) {
    const block = parts[i];
    const idMatch = block.match(/data-post="[^"]+\/(\d+)"/);
    if (!idMatch) continue;
    const id = parseInt(idMatch[1], 10);
    const textMatch = block.match(/<div class="tgme_widget_message_text[^>]*>([\s\S]*?)<\/div>/);
    if (!textMatch) continue;
    const text = decodeEntities(textMatch[1])
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    if (!text) continue;
    const dateMatch = block.match(/datetime="([^"]+)"/);
    const date = dateMatch ? dateMatch[1] : null;
    messages.push({ id, text, date });
  }
  return messages;
}

function checkKeywords(text: string): boolean {
  const lower = text.toLowerCase();
  return config.keywords.some(kw => lower.includes(kw.toLowerCase()));
}

function showMessageWindow(message: TelegramMessage): void {
  const safeMsg = message.text
    .replace(/"/g, '\\"')
    .replace(/[\x00-\x08\x0E-\x1F]/g, '')
    .substring(0, 1000);

  const dateStr = message.date
    ? new Date(message.date).toLocaleString('es-ES')
    : new Date().toLocaleString('es-ES');

  const batContent = [
    '@echo off',
    'title Mensaje de @' + config.channel,
    'color 0B',
    'cls',
    'echo ========================================',
    'echo   MENSAJE DETECTADO',
    'echo   @' + config.channel + ' - ' + dateStr,
    'echo ========================================',
    'echo.',
    'echo ' + safeMsg,
    'echo.',
    'echo ========================================',
    'echo.',
    'echo Presione una tecla para cerrar esta ventana...',
    'pause > nul',
  ].join('\r\n');

  const tmpFile = path.join(os.tmpdir(), `tg_msg_${Date.now()}_${message.id}.bat`);
  fs.writeFileSync(tmpFile, batContent, 'utf8');
  exec(`start "" "${tmpFile}"`, (err) => {
    if (err) console.error('  Error abriendo ventana de mensaje:', err.message);
  });
}

function openBrowser(): void {
  const cmd = `start chrome "${TELEGRAM_URL}"`;
  exec(cmd, (err) => {
    if (err) {
      exec(`start "" "${TELEGRAM_URL}"`);
    }
  });
}

function sendNotification(message: TelegramMessage): void {
  notifier.notify({
    title: `Alerta en @${config.channel}`,
    message: message.text.substring(0, 180),
    sound: true,
    wait: true,
    appID: 'TelegramWatcher',
  }, (err, response) => {
    if (err) {
      console.error('  Error en notificacion:', err.message);
      return;
    }
    if (response === 'activate') {
      openBrowser();
      showMessageWindow(message);
    }
  });
}

async function poll(): Promise<void> {
  try {
    const now = new Date().toLocaleTimeString('es-ES');
    console.log(`\n[${now}] Consultando @${config.channel}...`);

    const html = await fetchPage();
    const messages = parseMessages(html);

    if (messages.length === 0) {
      console.log('  Sin mensajes.');
      return;
    }

    let nuevos = 0;
    for (const msg of messages) {
      if (knownMessageIds.has(msg.id)) continue;
      knownMessageIds.add(msg.id);
      nuevos++;
      const preview = msg.text.length > 90 ? msg.text.substring(0, 90) + '...' : msg.text;
      console.log(`  [${msg.id}] ${preview}`);

      if (firstRun) continue;

      if (checkKeywords(msg.text)) {
        console.log('  Palabra clave detectada! Enviando notificacion...');
        sendNotification(msg);
      }
    }

    if (firstRun) {
      firstRun = false;
      console.log(`  Cargados ${messages.length} mensajes. Monitoreando...`);
    } else if (nuevos > 0) {
      console.log(`  ${nuevos} mensaje(s) nuevo(s).`);
    } else {
      console.log('  Sin novedades.');
    }
  } catch (err) {
    console.error(`  Error: ${(err as Error).message}`);
  }
}

function reloadConfig(): void {
  try {
    const newConfig = loadConfig();
    if (!newConfig) return;

    const oldChannel = config.channel;
    const oldInterval = config.intervalSec;

    config = newConfig;

    if (config.channel !== oldChannel) {
      TELEGRAM_URL = `https://t.me/s/${config.channel}`;
    }

    console.log(`\n[${new Date().toLocaleTimeString()}] Config recargada:`);
    console.log(`  Canal:     @${config.channel}`);
    console.log(`  Intervalo: ${config.intervalSec}s`);
    console.log(`  Keywords:  ${config.keywords.join(', ')}`);

    if (config.intervalSec !== oldInterval) {
      if (pollTimer) clearInterval(pollTimer);
      pollTimer = setInterval(poll, config.intervalSec * 1000);
    }
  } catch (err) {
    showErrorNotification('Error recargando config', (err as Error).message);
  }
}

fs.watch(configPath, (eventType) => {
  if (eventType !== 'change') return;
  if (watchTimeout) clearTimeout(watchTimeout);
  watchTimeout = setTimeout(reloadConfig, 400);
});

console.log('');
console.log('============================================');
console.log('  Telegram Watcher - @' + config.channel);
console.log('============================================');
console.log('  Intervalo:  ' + config.intervalSec + 's');
console.log('  Keywords:   ' + config.keywords.join(', '));
console.log('  Ctrl+C para detener');
console.log('  Watch config.json para recarga automatica');
console.log('============================================');
console.log('');

poll().then(() => {
  pollTimer = setInterval(poll, config.intervalSec * 1000);
});

process.on('SIGINT', () => {
  console.log('\nDeteniendo watcher...');
  if (pollTimer) clearInterval(pollTimer);
  process.exit(0);
});
