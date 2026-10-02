# mycontent-google-ads-mcp

Servidor MCP remoto (Cloudflare Workers) para **leer y modificar** cuentas de Google Ads desde Claude (claude.ai, Cowork y Claude Code), con barreras de seguridad pensadas para cuentas de clientes en producción.

- Endpoint MCP: `https://mycontent-google-ads-mcp.mycontent-ivan.workers.dev/mcp` (Streamable HTTP) y `https://mycontent-google-ads-mcp.mycontent-ivan.workers.dev/sse` (legacy SSE).
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
                                          ▼  fetch REST + developer-token + login-customer-id + Bearer
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

| Escritura (plan → `apply_plan`) | Qué hace |
|---|---|
| `plan_update_campaign_status` | PAUSED / ENABLED. Única vía para activar campañas |
| `plan_update_campaign_budget` | Presupuesto diario; detecta presupuesto compartido y exige `allow_shared_budget=true` |
| `plan_set_geo_targeting` | Incluir/excluir países (ISO → `geoTargetConstants` vía API), `PRESENCE` / `PRESENCE_OR_INTEREST`, `replace_includes` |
| `plan_add_negative_keywords` | Negativas de campaña (omite duplicadas) |
| `plan_exclude_placements` | Dominios, canales y vídeos de YouTube; campaña o cuenta |
| `plan_create_custom_audience` | Segmento personalizado por búsquedas (`SEARCH`) o URLs (`AUTO`) |
| `plan_create_demand_gen_campaign` | Campaña Demand Gen completa en un mutate atómico (ver abajo) |
| `plan_generic_mutate` | Vía de escape: array de `MutateOperation` (REST camelCase) con las mismas barreras |
| `apply_plan(plan_id, confirm)` | `confirm` debe ser exactamente `APPLY <plan_id>` |
| `cancel_plan(plan_id)` | Descarta el plan |

### Demand Gen: cómo está implementado (verificado en el discovery doc v25)

- `campaign.advertisingChannelType = DEMAND_GEN`, `status = PAUSED`, `containsEuPoliticalAdvertising = DOES_NOT_CONTAIN…`.
- **Control de canales** = nivel de **grupo de anuncios**: `adGroup.demandGenAdGroupSettings.channelControls.selectedChannels` con booleanos `discover`, `gmail`, `display`, `youtubeInFeed`, `youtubeInStream`, `youtubeShorts`, `maps`. La herramienta pone `true` solo en los canales pedidos y `false` en el resto. Si la API rechaza la combinación, `validateOnly` falla y **no se crea nada**.
- **Geo e idioma por grupo**: `campaign.demandGenCampaignSettings.upgradedTargeting = true` (inmutable; según la API es el valor por defecto) y criterios `location`/`language` en `adGroupCriterion`. Por eso cada grupo puede tener países distintos dentro de la misma campaña.
- **Puja**: `MAXIMIZE_CONVERSIONS` (`maximizeConversions`, `targetCpaMicros` opcional) o `MAXIMIZE_CLICKS` (`targetSpend`). La compatibilidad de MAXIMIZE_CLICKS con Demand Gen **no la he podido confirmar en la documentación** (developers.google.com estaba bloqueado desde el entorno); la decide `validateOnly`.
- **Objetivo de conversión**: se leen los `customer_conversion_goal`. Por defecto exige que `SUBMIT_LEAD_FORM` exista y sea biddable a nivel de cuenta, y avisa de otros objetivos biddable que la campaña heredará. `restrict_to_conversion_goal=true` (experimental) añade `campaignConversionGoal` con el ID temporal de la campaña para dejar solo esa categoría. Nunca se crean acciones de conversión.
- **Audiencias**: primero intenta el criterio `adGroupCriterion.customAudience`; si `validateOnly` lo rechaza, reintenta automáticamente con un recurso `Audience` (segmento del custom audience) + `adGroupCriterion.audience`, y devuelve los errores del primer intento.
- **Anuncio**: `ad.demandGenMultiAssetAd` con titulares, descripciones, `businessName`, `logoImages`, `marketingImages` (1,91:1), `squareMarketingImages`, `portraitMarketingImages`, `tallPortraitMarketingImages`, `callToActionText`. Con `reuse_assets_from_campaign_id` rellena lo que falte desde un PMax (titulares ≤30 caracteres, descripciones ≤90, logos y nombre de empresa a nivel de campaña). `image_urls` sube imágenes nuevas como assets en el mismo mutate.

## Barreras de seguridad

1. **Dos fases**. Ningún `plan_*` escribe. El plan: comprueba barreras → lee el estado de lo que toca (GAQL guardadas en el plan) y calcula su SHA-256 → valida con `validateOnly: true` → guarda en `STATE_KV` 30 min. `apply_plan` re-evalúa barreras, re-lee el estado y **aborta si el hash cambió**, ejecuta exactamente las operaciones guardadas (`partialFailure: false`, todo o nada) y borra el plan (un solo uso).
2. **Allowlist de cuentas**: escritura solo en `ALLOWED_CUSTOMER_IDS`; además, ningún resource name de una operación puede apuntar a otra cuenta. Lectura solo en la MCC y sus hijas.
3. **Campañas nuevas en PAUSED**. Activar una campaña solo es posible con `plan_update_campaign_status` (el genérico lo bloquea).
4. **Presupuesto**: máximo `MAX_DAILY_BUDGET` por presupuesto diario y subida máxima `MAX_BUDGET_INCREASE_PCT` por plan. Bajadas siempre permitidas. Presupuesto compartido → flag explícito.
5. **Sin borrados**: `remove` solo en `campaignCriterion`, `adGroupCriterion`, `customerNegativeCriterion`, `sharedCriterion`. `status: REMOVED` también se bloquea.
6. **Prohibido**: acciones/variables/reglas/objetivos de conversión de cuenta, configuración de cuenta, estrategias de puja de cartera (crear o asignar `bidding_strategy`), listas de usuarios, experimentos… Facturación, accesos de usuario y vínculos de cuenta usan servicios que este servidor nunca llama. Cualquier tipo de operación fuera de la allowlist se rechaza.
7. **Auditoría** en `STATE_KV` (`audit:*`): fecha UTC, email, cuenta, plan, operaciones exactas, respuesta de la API, resource names y resultado (`APPLIED`, `FAILED`, `ABORTED_STATE_CHANGED`).
8. **Errores completos**: código (`campaignBudgetError.X`), campo, índice de operación, valor, mensaje y `request-id`.

## Puesta en marcha

### 1. Credenciales de Google

- **Developer token** (MCC → Admin → API Center). Debe tener *Basic* o *Standard access* para tocar cuentas reales; con *Test account access* solo funciona contra cuentas de prueba.
- **Cliente OAuth para la API de Google Ads** (Google Cloud → APIs & Services → Credentials → *Web application*). Añade `https://developers.google.com/oauthplayground` como redirect URI. En [OAuth Playground](https://developers.google.com/oauthplayground) → ⚙ *Use your own OAuth credentials* → scope `https://www.googleapis.com/auth/adwords` → autoriza con la cuenta que tiene acceso a la MCC 2567236642 → *Exchange authorization code for tokens* → copia el **refresh token**. Si el proyecto OAuth está en modo *Testing*, el refresh token caduca a los 7 días: publícalo (*In production*).
- **Cliente OAuth para el login del MCP** (puede ser el mismo): redirect URI `https://mycontent-google-ads-mcp.mycontent-ivan.workers.dev.workers.dev/callback` (y `http://localhost:8788/callback` para `wrangler dev`). Scopes: `openid email profile`.

### 2. Cloudflare

```bash
npm ci
export CLOUDFLARE_API_TOKEN=...   # permisos: Workers Scripts, Workers KV Storage, (Durable Objects)
export CLOUDFLARE_ACCOUNT_ID=...

# KV ya creados y configurados en wrangler.jsonc (OAUTH_KV, STATE_KV)

# Secretos: se piden por stdin, no quedan en el historial ni en el repo
for s in GOOGLE_ADS_DEVELOPER_TOKEN GOOGLE_ADS_CLIENT_ID GOOGLE_ADS_CLIENT_SECRET GOOGLE_ADS_REFRESH_TOKEN \
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
curl -i https://mycontent-google-ads-mcp.mycontent-ivan.workers.dev/mcp   # 401 con WWW-Authenticate → resource_metadata
npx @modelcontextprotocol/inspector   # Transport: Streamable HTTP, URL https://mycontent-google-ads-mcp.mycontent-ivan.workers.dev/mcp → OAuth → tools/list
```

### 4. Añadir el conector en claude.ai

Settings → Connectors → *Add custom connector* → URL `https://mycontent-google-ads-mcp.mycontent-ivan.workers.dev/mcp` → *Connect* → pantalla de consentimiento del servidor → login con Google (`ivan@mycontent.agency`). Cualquier otro email recibe **403**. El conector queda disponible en claude.ai, Cowork y Claude Code (`claude mcp add --transport http google-ads https://mycontent-google-ads-mcp.mycontent-ivan.workers.dev/mcp`).

## Operación

### Rotar secretos
```bash
npx wrangler secret put GOOGLE_ADS_REFRESH_TOKEN   # o el que toque; efecto inmediato en el siguiente isolate
```
- Refresh token de Ads: genera uno nuevo (paso 1), súbelo y revoca el antiguo en https://myaccount.google.com/permissions.
- `COOKIE_ENCRYPTION_KEY`: rotarlo invalida las cookies de "cliente aprobado" (los usuarios vuelven a ver el consentimiento). No invalida tokens MCP ya emitidos.

### Añadir cuentas a la allowlist
Edita `ALLOWED_CUSTOMER_IDS` en `wrangler.jsonc` (separadas por comas, sin guiones) y `npx wrangler deploy`. La cuenta debe colgar de la MCC `GOOGLE_ADS_LOGIN_CUSTOMER_ID`. Para lectura no hace falta: basta con que esté bajo la MCC.

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
