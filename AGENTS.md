# AGENTS.md

## Stack

- **Runtime**: Node.js 18+ (usa `fetch` nativo)
- **Ejecución**: `tsx` corre TypeScript directamente — no hace falta `tsc`
- **Notificaciones**: `node-notifier` (solo Windows, usa toasts nativos)
- **Validación config**: Zod v4 (API: `issues` en vez de `errors`)

## Comandos

| Acción | Comando |
|---|---|
| Iniciar | `npm start` |
| Instalar | `npm install` |

## Arquitectura

- `telegram-watcher.ts` — entrypoint único, todo en un archivo
- `config.json` — se recarga en caliente con `fs.watch` (debounce 400ms)
- Scrapea `https://t.me/s/{channel}`, parsea HTML con regex
- Notificación al click: abre Chrome + ventana CMD temporal con el mensaje

## Puntos clave

- `config.json` usa `intervalSec` en segundos (no ms), admite decimales
- Zod v4: `result.error.issues` (no `errors`), `ZodError` no tiene `.errors`
- Sin tests, sin lint, sin typecheck configurados en package.json
- `__dirname` funciona porque tsconfig usa `module: "commonjs"`
- Solamente corre en Windows (depende de `start chrome` y CMD `.bat`)
- `.gitignore` solo tiene `/node_modules` — `dist/` no está ignorado (irrelevante porque no se compila)
