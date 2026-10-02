# Cobertura verificada contra la API real

Generado por `npm run integration -- coverage` el 2026-10-02 contra la cuenta 8460514008 (Neurored), Google Ads API v25. **Todo con `validateOnly`: no se ha aplicado ningún cambio.**

Leyenda: ✓ validado por la API · ✗ API = restricción de Google para ese tipo de campaña (el MCP lo explica antes de llamar) · — no aplica / no probado.

| Cambio | Herramienta | SEARCH | PERFORMANCE_MAX | DISPLAY |
|---|---|---|---|---|
| estado de campaña | `plan_update_campaign_status` | ✓ | ✓ | ✓ |
| presupuesto (bajada) | `plan_update_campaign_budget` | ✓ | ✓ | ✓ |
| geo: excluir país + PRESENCE | `plan_set_geo_targeting` | ✓ | ✓ | ✓ |
| geo: opción de ubicación | `plan_set_geo_targeting` | ✓ | ✓ | ✓ |
| keyword negativa | `plan_add_negative_keywords` | ✓ | ✓ | ✓ |
| placement excluido (campaña) | `plan_exclude_placements` | ✓ | ✗ API | ✓ |
| nombre | `plan_generic_mutate` | ✓ | ✓ | ✓ |
| fecha de fin | `plan_generic_mutate` | ✓ | ✓ | ✓ |
| final_url_suffix | `plan_generic_mutate` | ✓ | ✓ | ✓ |
| puja: MAXIMIZE_CONVERSIONS + tCPA | `plan_update_bidding_strategy` | ✓ | ✓ | ✓ |
| puja: MAXIMIZE_CONVERSIONS | `plan_update_bidding_strategy` | ✓ | ✓ | ✓ |
| puja: MAXIMIZE_CONVERSION_VALUE + tROAS | `plan_update_bidding_strategy` | ✓ | ✓ | ✓ |
| puja: MAXIMIZE_CLICKS + CPC máx. | `plan_update_bidding_strategy` | ✓ | ✗ API | ✓ |
| puja: MANUAL_CPC | `plan_update_bidding_strategy` | ✓ | ✗ API | ✓ |
| idioma (criterio de campaña) | `plan_generic_mutate` | ✓ | ✓ | ✓ |
| ad schedule | `plan_generic_mutate` | ✓ | ✓ | ✓ |
| bid modifier dispositivo | `plan_generic_mutate` | ✓ | ✗ API | ✓ |
| sitelink (asset + campaign_asset) | `plan_generic_mutate` | ✓ | ✓ | ✓ |
| network: sin search partners | `plan_generic_mutate` | ✓ | — | — |
| estado de grupo | `plan_generic_mutate` | ✓ | — | ✓ |
| nuevo grupo | `plan_generic_mutate` | ✓ | — | ✓ |
| keyword nueva | `plan_generic_mutate` | ✓ | — | — |
| estado de keyword | `plan_generic_mutate` | ✓ | — | — |
| negativa de grupo | `plan_generic_mutate` | ✓ | — | — |
| estado de anuncio | `plan_generic_mutate` | ✓ | — | ✓ |
| anuncio RSA nuevo | `plan_generic_mutate` | ✓ | — | — |
| estado de asset group | `plan_generic_mutate` | — | ✓ | — |
| search theme (asset group signal) | `plan_generic_mutate` | — | ✓ | — |
| titular nuevo (asset + asset_group_asset) | `plan_generic_mutate` | — | ✓ | — |
| pausar asset de asset group | `plan_generic_mutate` | — | ✓ | — |
| final URL de asset group | `plan_generic_mutate` | — | ✓ | — |
| crear campaña (budget+campaña+grupo+keyword+RSA) | `plan_generic_mutate` | ✓ | — | — |

Cuenta y creación:

| Cambio | Herramienta | Resultado |
|---|---|---|
| placement excluido (cuenta) | `plan_exclude_placements` | ✓  |
| custom audience | `plan_create_custom_audience` | ✓  |
| crear campaña (budget+campaña+grupo+keyword+RSA) | `plan_generic_mutate` | ✓  |
| activar campaña por genérico | `plan_generic_mutate` | ✓ bloqueado (correcto) |

Demand Gen (creación completa: presupuesto, campaña PAUSED, canales Discover+Gmail, geo/idioma por grupo, custom audience, anuncio multi-imagen con assets del PMax): ✓ validado en `integration/real-account.test.ts`.

## Restricciones de la API detectadas

- **Performance Max**: sin exclusiones de placement a nivel de campaña (usar nivel cuenta), sin ajustes de puja por dispositivo, y solo pujas MAXIMIZE_CONVERSIONS / MAXIMIZE_CONVERSION_VALUE.
- **Display antigua**: el CPA objetivo solo se acepta como estrategia `target_cpa` (no dentro de `maximize_conversions`); `plan_update_bidding_strategy` elige la representación válida automáticamente.
- **Demand Gen**: las audiencias van con un recurso `Audience`; los logos deben ser cuadrados ≥128 px.
- **Custom audiences**: servicio propio (`customAudiences:mutate`), no forman parte del mutate general.

## Qué no se ha podido verificar y por qué

- **Demand Gen existente, Video, Shopping, App, Hotel, Local Services, Smart**: Neurored no tiene campañas de esos tipos y la escritura está limitada a esa cuenta. Para ellos el camino es `describe_mutate_operation` (esquema oficial de la v25) + `plan_generic_mutate`, que pasan por las mismas barreras y por `validateOnly`.
- **Cualquier otro campo**: `describe_mutate_operation` lista las 65 operaciones de mutate de la v25 y sus campos modificables; `plan_generic_mutate` valida cualquiera de ellas antes de guardarla.

Para regenerar este documento con otra cuenta permitida: añade su ID a `ALLOWED_CUSTOMER_IDS` y ajusta `CID` en `integration/coverage.test.ts`.
