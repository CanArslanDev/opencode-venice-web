# PROGRESS

## 2026-11-15: ruta no-agéntica y clientTools, medido contra el navegador

## Hecho

- Ruta "de chat clásico": **no existe una distinta**. El chat web usa `POST /api/inference/chat/agents/venice?paidImagesMode=block` con `{clientTools, input:{messages}}`; en `outerface` no hay `…/chat/completions` (404 JSON), `/api/v1/chat/completions` es la API de pago (402 x402 / 401).
- `clientTools` con `{name, description, inputSchema}` se acepta (200 text/event-stream) pero el agente la ignora: el modelo dice que no tiene `read_file` y no emite `veniceai:client_function_call`.
- Un `function_call` de clientTool en el historial sí se respeta: con `function_call` + `function_call_output` el modelo leyó el resultado y contestó bien (también con dos llamadas encadenadas). En un turno nuevo sin ese historial vuelve a decir que no la tiene.
- Los argumentos sí llegan cuando la tool se reconoce: `detected_tools:[{"type":"Recognized","tool":…}]` y después `veniceai:server_function_call` con `arguments`. El `Unrecognized` sin argumentos es solo para nombres desconocidos.
- `src/lib/config.mjs:35`: `middlefaceVersion` por defecto pasa de `0.1.1128` a `0.1.1249` (lo que manda el navegador).
- `src/lib/venice.mjs:230`: `upstreamChat()` manda `accept: text/event-stream`, como el navegador.
- Verificado: 3 de 3 peticiones seguidas con JWT fresco devuelven 200 text/event-stream tras el cambio. `src/lib/venice.mjs` carga sin error.

- Escrito `docs/ADAPTING.md`: qué server tools pueden sustituir a tools del cliente (`web_scrape`←`webfetch`, `context_grep`←`grep`, `calculator`←`bash` aritmético), qué no tiene equivalente (`read` local, `write`, `edit`, `glob`, `shell`, `task`, MCP) y dos opciones (delegar por tabla estática / reducir la superficie de tools sirviendo el árbol por HTTP local).
- Medido que el bucle del servidor ejecuta server tools con argumentos y encadena pasos: `calculator` 1 paso `391`, 2 pasos `391`→`400`, `failed: 0`. `client_function_call` sigue en 0 tras 7 variantes y 3 sintaxis de recordatorio.
- Delegación por tabla implementada: `VENICE_WEB_DELEGATE` (`0` lo apaga, por defecto `['webfetch','grep']`), `DELEGATED_TOOLS` en `emulate.mjs`, `toVeniceRequest({ delegate })` los saca del prompt y los manda en `tools[]` como tipos de servidor, `server.mjs` pasa `delegateTools`. 3 tests nuevos; `npm test` 111/111. **Medido en turno real:** la tool delegada se usa y el turno cierra con la respuesta. Con `webfetch` sola, 3/3 el servidor ejecutó `web_scrape` y no hubo tool call al cliente. Con `webfetch` + `read` el modelo seguía eligiendo `read`, así que el proxy reescribe un `read` con URL a `web_scrape` (`delegatedCallTarget`, `src/lib/server.mjs`) y `read` entra en la lista por defecto: 3/3 con el título y `finish_reason: stop`. Un `read` de ruta local sigue yendo al cliente. 112 tests.

## Falta

- Prueba de dos turnos con `clientTools` real (declarar, recibir `function_call`, devolver `function_call_output`) para ver si el bucle se cierra sin sobre y sin juez. **Hecha: no emite `client_function_call`; el hermano de nivel superior sí se acepta.**
- `npm test` tras el cambio de cabeceras.
- El 403 "Attention Required!" de Cloudflare es intermitente también con JWT fresco y en la ruta que el proxy ya usa; no se ha aislado la causa.

- Nombres de tools revisados: `SERVER_TOOLS` y `SERVER_TOOL_DEFS` coincidían, pero sin nada que lo garantizara.
- `src/lib/server.mjs`: `SERVER_TOOLS` ahora se deriva de `SERVER_TOOL_DEFS` (importado); renombrar en un sitio ya no deja el filtro atrás.
- `src/lib/server.mjs`: un resultado de edición ya no se envía como llamada `view_media` (OpenCode no tiene esa tool). Se emite markdown con `GET /v1/media/<id>`, `finish_reason: stop`, y el id se sirve desde la caché local (`handleMedia`, `mediaUrl`).
- `src/lib/server.mjs`: los data URLs subidos se guardan en la caché bajo el id upstream (antes el comentario decía que se cacheaban y no se hacía), así un turno posterior que solo lleve el id puede hidratar.
- `test/emulate.test.mjs`: dos tests nuevos (las listas atadas, la URL de media y su escapado).
- `README.md` y `docs/PROTOCOL.md`: documentan la ruta y el cambio de entrega.

## Verificado

- `npm test`: 105 pasan, 0 fallan (incluye smoke contra el proxy).
- `GET /v1/media/<id>` devuelve 200 image/png con los bytes; id desconocido devuelve 404.
- Servicio reiniciado y `active`.

## Segunda tanda

- `src/lib/emulate.mjs`: un part `file` (OpenCode v2) con solo `media_id` se convierte en `[image: <id>]` en el texto, no en el literal `[image]`; `textOf` lee también `output_text`.
- `src/lib/emulate.mjs`: `skipServer` quita de la lista las copias del cliente de `view_media`/`edit_image`, para que no se intercepten sin ejecutarse.
- `src/lib/server.mjs`: el limite de `view_media` solo se aplica con tools emuladas (`toolsBound`); sin ellas `tools: []` no desactiva nada en Venice.
- Tests: 108 pasan, 0 fallan.

## Tercera tanda

- `src/lib/server.mjs`: si la hidratacion no tiene bytes (adjunto que el cliente guarda por id y entrega en el turno siguiente), el texto del turno recibe `[image: <id>]` en vez de quedarse con la respuesta sobre el id desconocido. Log de hidratacion reducido a text/hydration/terminal.
- `src/lib/image.mjs`: `content_failed` se lanza con su motivo y el `failed` cita `error` (antes `requests`, casi siempre vacio).
- `src/lib/server.mjs`: `handleEdits` acepta JSON, formulario y multipart (`readFormOrJson`, `fileAsDataUrl`).
- Tests: 108 pasan, 0 fallan.

## Cuarta tanda: medido con Chrome/CDP

Medición en vivo con Chrome headless (puerto 9222) y su consola, sin adivinar:

- Visión por ruta directa: 200 en 3,2 s y describe bien la imagen. Funciona.
- Edición: de 4 intentos idénticos, 3 fallan con `(empty reply)` y 1 edita. El fallo es intermitente.
- Causa: `carriesImage = JSON.stringify(body.messages).includes('image')` deja el turno con **2 tools `[view_media,edit_image]`**, sin las del cliente, y `hydration=no`.
- Segundo fallo, capturado con el log de argumentos: cuando el modelo pide solo `view_media` (o antes de editar), el turno se cierra con "Voy a ver la imagen..." y sin edición. El reintento tampoco edita.
- `runServerTool` sale por un `return` temprano en esos casos: no llega a `edit_image <id> on firered-image-edit`.
- `src/lib/server.mjs`: añadido log temporal `edit_image args ... • ids ...` para ver los argumentos crudos.

## Falta

- Falta una edición real de punta a punta desde OpenCode (subir imagen, pedir el cambio) para ver la imagen renderizada; aquí solo se probó la ruta y los tests.
- `edit_image` anunciado en cada turno con imagen: sin medir en esta sesión.

## Siguiente

- Hacer una edición real desde OpenCode y mirar el journal por si el modelo devuelve texto sin markdown.
