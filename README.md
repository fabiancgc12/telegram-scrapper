# Telegram Watcher — @el_Canal

Monitorea un canal público de Telegram, detecta palabras clave y envía notificaciones al escritorio.

## Requisitos

- Node.js 18+
- npm

## Instalación

```bash
npm install
```

## Configuración

Editar `config.json`:

```json
{
  "channel": "el canal",
  "keywords": ["alguna keyword"],
  "intervalSec": 12
}
```

| Campo | Tipo | Descripción |
|---|---|---|
| `channel` | `string` | Nombre del canal (sin @) |
| `keywords` | `string[]` | Palabras clave a detectar |
| `intervalSec` | `number` | Segundos entre cada consulta (mín. 3) |

## Ejecución

```bash
npm start
```

El script corre en primer plano. Cerrar la terminal o presionar `Ctrl+C` lo detiene.

## Comportamiento

- Al iniciar carga los mensajes existentes sin notificar
- Cada `intervalSec` segundos consulta el canal
- Los mensajes nuevos aparecen en la consola
- Si un mensaje contiene alguna palabra clave:
  - Envía una **notificación de escritorio**
  - Al hacer clic en la notificación:
    - Abre **Chrome** con el canal
    - Abre una **ventana CMD** con el mensaje completo

## Recarga automática

Si se modifica `config.json` mientras el script corre, la configuración se actualiza en caliente (sin reiniciar).
