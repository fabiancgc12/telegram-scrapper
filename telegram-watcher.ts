import fs from 'fs';
import path from 'path';
import { exec } from 'child_process';
import { z } from 'zod';
import notifier from 'node-notifier';

interface TelegramMessage {
  id: number;
  text: string;
  date: string | null;
}

type AppConfig = z.infer<typeof ConfigSchema>;

const ConfigSchema = z.object({
  channel: z.string().regex(/^\w+$/, 'El canal solo acepta letras, numeros y guion bajo'),
  keywords: z.array(z.string().min(1)).min(1, 'Debe haber al menos una palabra clave'),
  intervalSec: z.number().min(3, 'El intervalo minimo es 3 segundos'),
});

function showErrorNotification(title: string, message: string): void {
  console.error(`\n  ERROR: ${title} - ${message}`);
  try {
    notifier.notify({
      title: `Error: ${title}`,
      message: Array.from(message).slice(0, 200).join(''),
      sound: true,
      appID: 'TelegramWatcher',
    });
  } catch (e) {
    console.error('  Error al enviar notificacion de error:', e);
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
  const loaded = loadConfig();
  if (!loaded) process.exit(1);
  config = loaded;
} catch (err) {
  showErrorNotification('Error de lectura', `No se pudo leer config.json: ${(err as Error).message}`);
  process.exit(1);
}

TELEGRAM_URL = `https://t.me/s/${config.channel}`;

const knownMessageIds = new Set<number>();
const MAX_KNOWN_IDS = 5000;
let firstRun = true;
let pollTimer: ReturnType<typeof setTimeout> | null = null;
let watchTimeout: ReturnType<typeof setTimeout> | null = null;
let polling = false;

function pruneKnownIds(): void {
  if (knownMessageIds.size <= MAX_KNOWN_IDS) return;
  const toRemove = Array.from(knownMessageIds).slice(0, knownMessageIds.size - MAX_KNOWN_IDS);
  for (const id of toRemove) knownMessageIds.delete(id);
}

async function fetchPage(): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch(TELEGRAM_URL, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8',
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timeout);
  }
}

function decodeEntities(text: string): string {
  return text.replace(/&#?(\w+);/g, (_, code: string) => {
    if (code === 'amp') return '&';
    if (code === 'lt') return '<';
    if (code === 'gt') return '>';
    if (code === 'quot') return '"';
    if (code === '#39') return "'";
    if (code.startsWith('x')) return String.fromCharCode(parseInt(code.slice(1), 16));
    const n = parseInt(code, 10);
    return isNaN(n) ? `&${code};` : String.fromCharCode(n);
  });
}

function parseMessages(html: string): TelegramMessage[] {
  const messages: TelegramMessage[] = [];
  const parts = html.split('<div class="tgme_widget_message_wrap');
  for (let i = 1; i < parts.length; i++) {
    const block = parts[i];
    const idMatch = block.match(/data-post="[^"]+\/(\d+)"/);
    if (!idMatch) {
      if (process.env.DEBUG) console.warn('  parseMessages: no match data-post en bloque', i);
      continue;
    }
    const id = parseInt(idMatch[1], 10);
    const textMatch = block.match(/<div class="tgme_widget_message_text[^>]*>([\s\S]*?)<\/div>/);
    if (!textMatch) {
      if (process.env.DEBUG) console.warn('  parseMessages: no match message_text en msg', id);
      continue;
    }
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

function escapeCmd(text: string): string {
  return text
    .replace(/\^/g, '^^')
    .replace(/&/g, '^&')
    .replace(/\|/g, '^|')
    .replace(/</g, '^<')
    .replace(/>/g, '^>')
    .replace(/%/g, '^%')
    .replace(/"/g, '^"');
}

function showMessageWindow(message: TelegramMessage): void {
  const dateStr = message.date
    ? new Date(message.date).toLocaleString('es-ES')
    : new Date().toLocaleString('es-ES');

  const lines = message.text.split('\n');
  const header = [
    'echo ========================================',
    `echo   MENSAJE DETECTADO - @${config.channel}`,
    `echo   ${escapeCmd(dateStr)}`,
    'echo ========================================',
    'echo.',
  ];

  const body: string[] = [];
  let totalChars = 0;
  const MAX_CMD_CHARS = 6000;
  for (const line of lines) {
    const escaped = escapeCmd(line);
    totalChars += escaped.length;
    if (totalChars > 800) break;
    body.push(escaped ? `echo ${escaped}` : 'echo.');
  }
  const fullCmd = [...header, ...body, ...footer].join(' & ');
  if (fullCmd.length > MAX_CMD_CHARS) {
    body.length = 0;
    let safe = 0;
    for (const line of lines) {
      const escaped = escapeCmd(line);
      safe += escaped.length;
      if (safe > 300) break;
      body.push(escaped ? `echo ${escaped}` : 'echo.');
    }
    body.push('echo ... [mensaje truncado]');
  }

  const all = [...header, ...body, ...footer].join(' & ');
  const title = escapeCmd(`Mensaje de @${config.channel}`);
  const cmd = `start cmd /c "title ${title} & color 0B & cls & ${all}"`;

  exec(cmd, (err) => {
    if (err) console.error('  Error abriendo ventana de mensaje:', err.message);
  });
}

const footer = [
  'echo.',
  'echo ========================================',
  'echo.',
  'echo Presione una tecla para cerrar...',
  'pause > nul',
];

function openBrowser(): void {
  const url = `https://t.me/s/${encodeURIComponent(config.channel)}`;
  const cmd = `start chrome "${url}"`;
  exec(cmd, (err) => {
    if (err) {
      exec(`start "" "${url}"`);
    }
  });
}

function truncateText(text: string, max: number): string {
  return Array.from(text).slice(0, max).join('');
}

function sendNotification(message: TelegramMessage): void {
  notifier.notify({
    title: `Alerta en @${config.channel}`,
    message: truncateText(message.text, 180),
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
  if (polling) {
    console.log('  Saltando poll anterior aun en ejecucion...');
    return;
  }
  polling = true;
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
      const preview = truncateText(msg.text, 90);
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
  } finally {
    polling = false;
    pruneKnownIds();
    scheduleNext();
  }
}

function scheduleNext(): void {
  pollTimer = setTimeout(poll, config.intervalSec * 1000);
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

    if (config.intervalSec !== oldInterval && !polling) {
      if (pollTimer) clearTimeout(pollTimer);
      scheduleNext();
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

poll();

process.on('SIGINT', () => {
  console.log('\nDeteniendo watcher...');
  if (pollTimer) clearTimeout(pollTimer);
  process.exit(0);
});
