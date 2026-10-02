# mycontent-google-ads-mcp

Servidor MCP remoto (Cloudflare Workers) para **leer y modificar** cuentas de Google Ads desde Claude (claude.ai, Cowork y Claude Code), con barreras de seguridad pensadas para cuentas de clientes en producción.

- Endpoint MCP: `https://googleads-mcp.mycontent.academy/mcp` (Streamable HTTP) y `https://googleads-mcp.mycontent.academy/sse` (legacy SSE).
- Google Ads API **v25** por REST (`fetch`), fijada en `GOOGLE_ADS_API_VERSION` (`src/config.ts`).
- Login OAuth 2.1 con Google; solo entran los emails de `ALLOWED_EMAILS`.
- Toda escritura en dos fases: `plan_*` (lee estado + `validateOnly`) → `apply_plan` (confirmación literal + verificación de que nada ha cambiado + auditoría).

## Arquitectura

```
Claude ──OAuth 2.1 (DCR/PKCE)──► Worker mycontent-google-ads-mcp
                                   ├─ @cloudflare/workers-oauth-provider  (/authorize, /token, /register, /.well-known/*)
                                   │    └─ src/auth/google-handler.ts → login con Google + ALLOWED_EMAILS (403 si no)
                                   ├─ /mcp, /sse → GoogleAdsMCP (McpAgent, Durable Object)
                                   │    ├─ src/tools/read.ts        herramientas de lectura
                                   │    ├─ src/plans/*.ts           constructores de planes (operaciones de mutate)
                                   │    ├─ src/guards.ts            barreras (allowlist, prohibiciones, límites)
                                   │    └─ src/plans/engine.ts      plan → validateOnly → KV (30 min) → apply → auditoría
                                   ├─ KV OAUTH_KV   estado OAuth (clientes, grants, tokens)
                                   └─ KV STATE_KV   planes pendientes (TTL 30 min) y registro de auditoría
                                          │
                                          ▼  fetch REST + login-customer-id + Bearer (sin developer token)
                                 https://googleads.googleapis.com/v25/customers/{id}/googleAds:search|mutate
```

- **Quién usa el conector**: el usuario que hace login con Google (email verificado y en `ALLOWED_EMAILS`). Se re-comprueba en cada llamada a herramienta, así que quitar un email corta el acceso aunque tenga un token vigente.
- **En nombre de quién actúa**: una cuenta con acceso a la MCC, mediante `GOOGLE_ADS_REFRESH_TOKEN` (scope `https://www.googleapis.com/auth/adwords`). El access token se cachea en memoria del isolate hasta 1 min antes de caducar.
- **Por qué REST**: la librería `google-ads-api` usa gRPC, que no funciona en Workers.
- `agents@0.24` marca `McpAgent` como *feature-frozen* (recomienda `createMcpHandler`). Se usa `McpAgent` porque lo exige el diseño y es lo que da `/sse`; migrar es un cambio local en `src/index.ts`.

## Herramientas

Importes de entrada siempre en **moneda de la cuenta** (p. ej. `10` = 10,00 EUR/día), nunca en micros.

| Lectura (sin plan) | Qué hace |
|---|---|
| `list_accessible_customers` | Cuentas bajo la MCC: nombre, moneda, zona horaria, si se puede escribir |
| `gaql_search(customer_id, query, max_rows?)` | GAQL libre con paginación propia (por defecto 1.000 filas, máx. 10.000) |
| `get_campaign_overview(customer_id, date_from, date_to)` | Estado, tipo, presupuesto, puja, `geo_target_type`, gasto, clics, conversiones |
| `get_campaign_detail(customer_id, campaign_id)` | Presupuesto (y si es compartido), ubicaciones incl./excl., idiomas, listas de marca, grupos (canales Demand Gen, geo/audiencias por grupo) o asset groups |
| `get_network_breakdown(customer_id, date_from, date_to, campaign_ids?)` | Métricas por `segments.ad_network_type` |
| `get_change_history(customer_id, days≤30)` | `change_event` |
| `get_asset_group_assets(customer_id, campaign_id)` | Assets de un PMax por `field_type`, incluidos logos/nombre de empresa a nivel de campaña (Brand Guidelines) |
| `get_audit_log(limit)` | Registro de `apply_plan` |
| `describe_api_method(method?, filter?)` | Catálogo de los 175 métodos de la API v25 (lectura y escritura), con ruta, si admiten `validateOnly`, herramienta a usar y campos del body |
| `api_read(method, path_params, body_json)` | Cualquier método de solo lectura que no es GAQL: Keyword Planner (ideas, históricos, previsiones), reach forecast, audience insights, benchmarks, previsualizaciones, generación de textos/imágenes, facturas… |
| `describe_mutate_operation(operation?, filter?)` | Esquema oficial de la v25: lista de operaciones de mutate con su estado en las barreras y campos modificables de cada recurso, para usar `plan_generic_mutate` en cualquier tipo de campaña sin inventar campos |

| Escritura (plan → `apply_plan`) | Qué hace |
|---|---|
| `plan_update_campaign_status` | PAUSED / ENABLED. Única vía para activar campañas |
| `plan_update_campaign_budget` | Presupuesto diario; detecta presupuesto compartido y exige `allow_shared_budget=true` |
| `plan_update_bidding_strategy` | Estrategia estándar (Max. conversiones ± tCPA, Max. valor ± tROAS, Max. clics, CPC manual); elige la representación que acepta la API según el tipo de campaña |
| `plan_set_geo_targeting` | Incluir/excluir países (ISO → `geoTargetConstants` vía API), `PRESENCE` / `PRESENCE_OR_INTEREST`, `replace_includes` |
| `plan_add_negative_keywords` | Negativas de campaña (omite duplicadas) |
| `plan_exclude_placements` | Dominios, canales y vídeos de YouTube; campaña o cuenta |
| `plan_create_custom_audience` | Segmento personalizado por búsquedas (`SEARCH`) o URLs (`AUTO`) |
| `plan_create_demand_gen_campaign` | Campaña Demand Gen completa en un mutate atómico (ver abajo) |
| `plan_generic_mutate` | Cualquiera de los 64 tipos de operación de `GoogleAdsService.Mutate` (create/update/remove, IDs temporales, todo o nada), en cualquier tipo de campaña |
| `plan_api_call(customer_id, method, path_params, body_json, state_queries?)` | Cualquier método de escritura fuera del mutate general: recomendaciones, experimentos, Customer Match, conversiones offline, accesos, vínculos, facturación, subcuentas, assets autogenerados de PMax… |
| `apply_plan(plan_id, confirm)` | `confirm` = el `confirm_with` del plan: `APPLY <plan_id>` o `APPLY-ELEVATED <plan_id>` |
| `cancel_plan(plan_id)` | Descarta el plan |

### Demand Gen: cómo está implementado (verificado en el discovery doc v25)

- `campaign.advertisingChannelType = DEMAND_GEN`, `status = PAUSED`, `containsEuPoliticalAdvertising = DOES_NOT_CONTAIN…`.
- **Control de canales** = nivel de **grupo de anuncios**: `adGroup.demandGenAdGroupSettings.channelControls.selectedChannels` con booleanos `discover`, `gmail`, `display`, `youtubeInFeed`, `youtubeInStream`, `youtubeShorts`, `maps`. La herramienta pone `true` solo en los canales pedidos y `false` en el resto. Si la API rechaza la combinación, `validateOnly` falla y **no se crea nada**.
- **Geo e idioma por grupo**: `campaign.demandGenCampaignSettings.upgradedTargeting = true` (inmutable; según la API es el valor por defecto) y criterios `location`/`language` en `adGroupCriterion`. Por eso cada grupo puede tener países distintos dentro de la misma campaña.
- **Puja**: `MAXIMIZE_CONVERSIONS` (`maximizeConversions`, `targetCpaMicros` opcional) o `MAXIMIZE_CLICKS` (`targetSpend`). La compatibilidad de MAXIMIZE_CLICKS con Demand Gen **no la he podido confirmar en la documentación** (developers.google.com estaba bloqueado desde el entorno); la decide `validateOnly`.
- **Objetivo de conversión**: se leen los `customer_conversion_goal` (por defecto `SUBMIT_LEAD_FORM`). Por defecto (`restrict_to_conversion_goal=true`) la campaña optimiza **solo** hacia esa categoría mediante `campaignConversionGoal`, sin heredar otros objetivos de cuenta como interacciones o visualizaciones de YouTube (probado en real). Con `false` usa los objetivos de cuenta y avisa de los que hereda. Nunca se crean acciones de conversión.
- **Segmentación optimizada**: `optimized_targeting` (por defecto `false`) se fija explícitamente en cada grupo y aparece en el resumen del plan.
- **Parámetros de URL**: si la plantilla de seguimiento o el sufijo de URL de la cuenta usan `{_clave}`, la campaña debe definirla. `{_campaignname}` se rellena con el nombre de la campaña; cualquier otra clave hay que pasarla en `url_custom_parameters` o el plan se rechaza (si no, ese dato llegaría vacío al CRM).
- **Audiencias** (verificado contra la API real): Demand Gen exige un recurso `Audience` (segmento del custom audience) + `adGroupCriterion.audience`; el criterio directo `customAudience` devuelve `CANNOT_ADD_AUDIENCE_SEGMENT_CRITERION_WHEN_AUDIENCE_GROUPED_IS_SET`.
- **Segmentos nuevos**: `CustomAudienceService` no forma parte de `GoogleAdsService.Mutate`, así que van como *paso previo* del plan (`customAudiences:mutate`). En el plan se validan en su servicio y la campaña se valida sustituyendo el segmento por uno existente de la cuenta; en `apply_plan` se crea primero el segmento y la campaña usa su resource name real. Si la campaña fallara después, el segmento queda creado (se indica en la respuesta y en la auditoría).
- **Anuncio**: `ad.demandGenMultiAssetAd` con titulares, descripciones, `businessName`, `logoImages`, `marketingImages` (1,91:1), `squareMarketingImages`, `portraitMarketingImages`, `tallPortraitMarketingImages`, `callToActionText`. Con `reuse_assets_from_campaign_id` rellena lo que falte desde un PMax (titulares ≤30 caracteres, descripciones ≤90, logos y nombre de empresa a nivel de campaña), descartando imágenes que no cumplan la proporción o el tamaño mínimo de Demand Gen (p. ej. logos no cuadrados). `image_urls` sube imágenes nuevas como assets en el mismo mutate.

## Cobertura

Matriz de cambios verificados con `validateOnly` contra la cuenta real por tipo de campaña: [COVERAGE.md](COVERAGE.md).

## Barreras de seguridad

Política (decidida por Iván el 02-10-2026): **todo lo que permite la API se puede hacer por el MCP**, con dos niveles de control.

1. **Dos fases siempre**. Ningún `plan_*` escribe. El plan comprueba barreras → lee el estado de lo que toca (GAQL guardadas en el plan) y calcula su SHA-256 → valida con `validateOnly: true` (si el método lo admite) → guarda en `STATE_KV` 30 min. `apply_plan` re-evalúa barreras, re-lee el estado y **aborta si el hash cambió**, ejecuta exactamente lo guardado (`partialFailure: false`, todo o nada) y borra el plan (un solo uso).
2. **Bloqueo duro (sin excepciones)**: escribir en cuentas fuera de `ALLOWED_CUSTOMER_IDS` (con `*`, cuentas que no cuelgan de la MCC), operaciones que referencian otra cuenta y operaciones mal formadas. La lectura se limita a la MCC y sus hijas.
3. **Confirmación reforzada (`APPLY-ELEVATED <plan_id>`)**: el plan se crea y valida igual, pero lista los motivos y exige la frase reforzada. Aplica a:
   - borrados de campañas, grupos, anuncios, presupuestos, asset groups, listas, etiquetas, audiencias… y `status: REMOVED`;
   - activar campañas por el genérico y campañas nuevas que no se crean en `PAUSED`;
   - presupuestos por encima de `MAX_DAILY_BUDGET`, subidas por encima de `MAX_BUDGET_INCREASE_PCT`, presupuestos compartidos o totales;
   - conversiones (acciones, reglas, objetivos de cuenta, subida de conversiones), configuración de cuenta, estrategias de puja de cartera, exclusiones/estacionalidad de puja, experimentos y borradores, campañas inteligentes, reservas;
   - por `plan_api_call`: facturación, accesos de usuarios, vínculos y estructura de cuentas, Customer Match (PII), aplicar recomendaciones, batch jobs, vídeos de YouTube, Local Services.
4. **Confirmación normal (`APPLY`)**: todo lo demás, incluido quitar criterios, vínculos de assets (sitelinks, titulares/imágenes de asset groups), señales de PMax (search themes, audiencias), ajustes de puja, listas compartidas vinculadas y etiquetas: quitar un vínculo no borra el objeto. También descartar recomendaciones y borrar assets autogenerados de PMax.
5. **Auditoría** en `STATE_KV` (`audit:*`): fecha UTC, email, cuenta, plan, operaciones o llamada exactas, motivos de refuerzo aceptados, respuesta de la API, resource names y resultado (`APPLIED`, `FAILED`, `ABORTED_STATE_CHANGED`).
6. **Errores completos**: código (`campaignBudgetError.X`), campo, índice de operación, valor, mensaje y `request-id`.

Detalles adicionales:

- **Aplicación de un plan**: se re-comprueba que la cuenta sigue siendo escribible (allowlist o pertenencia a la MCC); un cerrojo global (Durable Object `PlanLock`) impide que dos `apply_plan` simultáneos del mismo plan se ejecuten ambos; si la auditoría falla después de aplicar, la respuesta sigue diciendo que se aplicó (con aviso). Un plan cuya lectura de estado supera 10.000 filas se rechaza en lugar de comparar un subconjunto.
- **Otras comprobaciones**: reasignar el presupuesto de una campaña pasa los mismos límites que cambiar su importe; en `plan_api_call`, borrar o editar custom audiences/interests exige `APPLY-ELEVATED` y los parámetros de ruta no admiten segmentos vacíos ni relativos (`..`). Con `ALLOWED_CUSTOMER_IDS="*"` la propia MCC también es escribible (vínculos y estructura de cuentas exigen `APPLY-ELEVATED`).

Para volver a bloquear del todo una categoría: añádela a `HARD_BLOCKED_OPERATIONS` en `src/guards.ts` o a `HARD_BLOCKED_METHODS` en `src/plans/apicall.ts` (vacías por defecto).

## Puesta en marcha

### 1. Credenciales de Google

- **Acceso a la API (sin developer token)**: Google retiró los developer tokens el 09-09-2026. El nivel de acceso (test / Basic / Standard) lo tiene ahora el **proyecto de Google Cloud que emite el cliente OAuth** (Cloud Console → Google Ads API). Si la API devuelve `CLOUD_PROJECT_NOT_APPROVED_FOR_PRODUCTION`, ese proyecto solo tiene acceso de prueba y hay que solicitar Basic Access desde la consola. Si existe `GOOGLE_ADS_DEVELOPER_TOKEN` se envía como cabecera opcional (la API la ignora).
- **Cliente OAuth para la API de Google Ads** (Google Cloud → APIs & Services → Credentials → *Web application*). Añade `https://developers.google.com/oauthplayground` como redirect URI. En [OAuth Playground](https://developers.google.com/oauthplayground) → ⚙ *Use your own OAuth credentials* → scope `https://www.googleapis.com/auth/adwords` → autoriza con la cuenta que tiene acceso a la MCC 2567236642 → *Exchange authorization code for tokens* → copia el **refresh token**. Si el proyecto OAuth está en modo *Testing*, el refresh token caduca a los 7 días: publícalo (*In production*).
- **Cliente OAuth para el login del MCP** (puede ser el mismo): redirect URI `https://googleads-mcp.mycontent.academy.workers.dev/callback` (y `http://localhost:8788/callback` para `wrangler dev`). Scopes: `openid email profile`.

### Despliegue continuo con GitHub Actions (recomendado)

`.github/workflows/deploy.yml`: en cada PR pasa type-check y tests; en cada push a `main` despliega el Worker y sincroniza sus secretos; con *Run workflow* (manual) además ejecuta la integración contra la cuenta real (solo lectura + `validateOnly`). `integration_scope=smoke` (por defecto) ejecuta solo `integration/real-account.test.ts` (unas decenas de operaciones); `full` añade la cobertura completa por tipo de campaña, que consume cientos de operaciones de la cuota diaria de la API (Basic Access: 15.000/día compartidas con el uso real). Lanza `full` solo cuando cambien los constructores de planes o las barreras.

Secretos en GitHub → Settings → Environments → `production` (o Settings → Secrets and variables → Actions):
`GOOGLE_ADS_CLIENT_ID`, `GOOGLE_ADS_CLIENT_SECRET`, `GOOGLE_ADS_REFRESH_TOKEN`, `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, `COOKIE_ENCRYPTION_KEY`, `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`.
Rotar un secreto = actualizarlo en GitHub y relanzar el workflow.

`CLOUDFLARE_API_TOKEN`: plantilla *Edit Cloudflare Workers*, cuenta MyContent y, en *Zone Resources*, la zona `mycontent.academy` (hace falta para el dominio propio `googleads-mcp.mycontent.academy`).

### 2. Cloudflare (manual)

Desde Windows, con tu cargador DPAPI de credenciales, todo el despliegue (tests, `wrangler login`, deploy, secretos, comprobación e integración) se hace con:

```powershell
.\scripts\deploy.ps1 -CredentialLoader C:\ruta\cargar-credenciales.ps1
```

Manualmente:

```bash
npm ci
export CLOUDFLARE_API_TOKEN=...   # permisos: Workers Scripts, Workers KV Storage, (Durable Objects)
export CLOUDFLARE_ACCOUNT_ID=...

# KV ya creados y configurados en wrangler.jsonc (OAUTH_KV, STATE_KV)

# Secretos: se piden por stdin, no quedan en el historial ni en el repo
for s in GOOGLE_ADS_CLIENT_ID GOOGLE_ADS_CLIENT_SECRET GOOGLE_ADS_REFRESH_TOKEN \
         GOOGLE_OAUTH_CLIENT_ID GOOGLE_OAUTH_CLIENT_SECRET; do npx wrangler secret put $s; done
openssl rand -hex 32 | npx wrangler secret put COOKIE_ENCRYPTION_KEY

npx wrangler deploy
```

Tras el primer deploy, pon la URL en `PUBLIC_BASE_URL` (`wrangler.jsonc`, sin barra final) y vuelve a desplegar: es la audiencia de los tokens OAuth. Si está vacía se usa el origen de la petición.

### 3. Comprobar

```bash
npm test                 # unitarias (fetch y KV simulados)
npm run type-check
npm run integration      # cuenta real: solo lectura + validateOnly (necesita los 4 secretos de Ads en el entorno)
curl -i https://googleads-mcp.mycontent.academy/mcp   # 401 con WWW-Authenticate → resource_metadata
npx @modelcontextprotocol/inspector   # Transport: Streamable HTTP, URL https://googleads-mcp.mycontent.academy/mcp → OAuth → tools/list
```

### 4. Añadir el conector en claude.ai

Settings → Connectors → *Add custom connector* → URL `https://googleads-mcp.mycontent.academy/mcp` → *Connect* → pantalla de consentimiento del servidor → login con Google (`ivan@mycontent.agency`). Cualquier otro email recibe **403**. El conector queda disponible en claude.ai, Cowork y Claude Code (`claude mcp add --transport http google-ads https://googleads-mcp.mycontent.academy/mcp`).

## Operación

### Rotar secretos
```bash
npx wrangler secret put GOOGLE_ADS_REFRESH_TOKEN   # o el que toque; efecto inmediato en el siguiente isolate
```
- Refresh token de Ads: genera uno nuevo (paso 1), súbelo y revoca el antiguo en https://myaccount.google.com/permissions.
- `COOKIE_ENCRYPTION_KEY`: rotarlo invalida las cookies de "cliente aprobado" (los usuarios vuelven a ver el consentimiento). No invalida tokens MCP ya emitidos.

### Añadir cuentas a la allowlist
Configuración actual: `ALLOWED_CUSTOMER_IDS="*"`, es decir, se puede escribir en **cualquier cuenta que cuelgue de la MCC** `GOOGLE_ADS_LOGIN_CUSTOMER_ID`, incluidas las que se vinculen en el futuro (sin redesplegar). Antes de crear cada plan el servidor comprueba contra la API (`customer_client`, caché de 10 min) que la cuenta pertenece a la MCC; si no, la escritura se rechaza.

Para restringir a una lista concreta, sustituye `*` por los IDs separados por comas, sin guiones (p. ej. `"8460514008,1234567890"`), y despliega. Se pueden combinar (`"*,8460514008"`), aunque con `*` la lista no añade nada.

### Añadir o quitar usuarios
Edita `ALLOWED_EMAILS` y despliega. Quitar un email bloquea sus llamadas a herramientas de inmediato (se comprueba en cada llamada).

### Revocar el acceso
- Un usuario: quítalo de `ALLOWED_EMAILS` y despliega.
- Todos los tokens MCP emitidos: borra los grants/tokens del proveedor OAuth:
  ```bash
  npx wrangler kv key list --binding OAUTH_KV --remote | jq -r '.[].name' | grep -E '^(grant|token):' \
    | xargs -I{} npx wrangler kv key delete --binding OAUTH_KV --remote {}
  ```
- La cuenta de servicio de Ads: revoca el refresh token en https://myaccount.google.com/permissions (corta toda escritura y lectura).
- En claude.ai: Settings → Connectors → desconectar.

### Auditoría
`get_audit_log` desde Claude, o `npx wrangler kv key list --binding STATE_KV --remote --prefix audit:`.

## Supuestos y límites conocidos

- `developers.google.com` no era accesible desde el entorno de desarrollo; los nombres de campos y enums se han verificado contra el **discovery doc oficial v25** (`googleads.googleapis.com/$discovery/rest?version=v25`, revisión 2026-09-29). Lo que el discovery no dice (qué canales/pujas/audiencias acepta Demand Gen) lo decide `validateOnly`, y por eso todo plan pasa por él antes de guardarse.
- `MAX_DAILY_BUDGET` se aplica a cada presupuesto, no a la suma de la cuenta.
- La detección de cambios cubre lo que el plan lee; en `plan_generic_mutate` las operaciones `create` (y tipos sin recurso GAQL mapeado) no entran en el hash y se avisa en `warnings`.
