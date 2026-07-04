# Polymarket BTC 5-Min Trading Bot

Bot automatizado para operar mercados **Bitcoin Up/Down 5-min** en [Polymarket](https://polymarket.com) usando el SDK oficial `@polymarket/client` v3.

## ¿Qué hace?

Cada 5 minutos, cuando se abre un nuevo mercado BTC Up/Down:
1. Busca el mercado activo vía Gamma API
2. Lee el order book para ver bid/ask
3. Coloca una orden **BUY UP** de $1.00 FOK (Fill-or-Kill)
4. Registra todo en `btc_bot.log`

## Requisitos

- Node.js v24+
- Cuenta de Polymarket con API key y wallet fondeada (mínimo recomendado: $20 USDC en Polygon)
- Archivo de credenciales en `~/.hermes/polymarket.env`

### Formato del archivo `.env`

```
PM_PRIVATE_KEY=0x...       # private key de la EOA signer
PM_API_KEY=...             # API key de Polymarket
PM_API_SECRET=...          # API secret (base64url)
PM_API_PASSPHRASE=...      # passphrase
PM_FUNDER=0x...            # dirección de la wallet fondeada (Polygon)
```

## Instalación

```bash
cd polymarket-wrapper
npm install
```

## Uso

```bash
# Orden única manual
node btc_bot.mjs                    # BUY $1 FOK
node btc_bot.mjs --amount 5         # BUY $5
node btc_bot.mjs --dry-run          # Simulación (no gasta)

# Loop automático
node btc_loop.mjs                   # Corre cada 5 min, BUY $1
node btc_loop.mjs --amount 5        # Corre cada 5 min, BUY $5
node btc_loop.mjs --dry-run         # Simulación continua

# Ver log en vivo
tail -f btc_bot.log
```

## Arquitectura

```
polymarket-wrapper/
├── btc_loop.mjs        ← Loop automático (producción)
├── btc_bot.mjs         ← Orden única manual
├── dns_patch.js        ← Módulo DNS para Argentina (https.request)
├── package.json
├── .gitignore
├── README.md
├── btc_bot.log         ← Historial de ejecuciones (gitignored)
└── debug/              ← Scripts de desarrollo (gitignored)
```

### APIs utilizadas

| API | URL | Uso |
|-----|-----|-----|
| Gamma API | `gamma-api.polymarket.com` | Descubrir mercados, obtener `clobTokenIds` |
| CLOB API | `clob.polymarket.com` | Order book, colocar/cancelar órdenes |
| Relayer | `relayer-v2.polymarket.com` | Transacciones gasless (usado por el SDK internamente) |

### Flujo de una orden

1. `createSecureClient({signer, credentials, wallet})` — autentica contra CLOB
2. `gammaGet("/events?slug=btc-updown-5m-{bucket}")` — obtiene el mercado
3. `JSON.parse(event.markets[0].clobTokenIds)[0]` — extrae token ID (UP)
4. `client.fetchOrderBook({tokenId})` — lee precios
5. `client.placeMarketOrder({tokenId, side:"BUY", amount, orderType:"FOK"})` — ejecuta

## Key technical details

### DNS desde Argentina

Polymarket bloquea DNS de `*.polymarket.com` desde Argentina. El bot lo resuelve con dos monkey-patches:

1. **`dns.lookup`** — para `fetch()` (usado por ky/SDK internamente). Undici pasa `{all: true, hints: 32}` y espera `[{address, family}]`.
2. **`https.request`/`https.get`** — para llamadas REST directas (Gamma API). Se reemplaza `hostname` por la IP y se setea `servername` para TLS SNI.

IP de Cloudflare: `104.18.34.205` (todos los subdominios resuelven a la misma).

### Lecciones aprendidas

- **`dns.lookup` callback es polimórfico**: `(hostname, callback)` y `(hostname, options, callback)`. Undici usa la segunda forma con `all: true`.
- **El SDK nuevo (`@polymarket/client`) reconoce wallets viejas**: `0xe6ff9F...` fue reconocida como Type 3 (POLY_PROXY) sin migración.
- **Gamma API sigue siendo necesaria**: `listEvents()` del SDK no expone `clobTokenIds`.
- **camelCase en el SDK**: `tokenId` (no `tokenID`), `orderType` (no `order_type`).
- **Mínimo $1.00 USDC** por orden. Intentos con $0.50 dan error.
- **`listEvents`/`listMarkets` son async iterables**: usar `for await (const page of result) { page.items }`.
- **HMAC mantiene padding `=`**: El viejo SDK no lo quita; quitarlo causa 401.
- **Exchange v3**: dominio EIP-712 `version: "2"`, campos `timestamp`/`metadata`/`builder` reemplazan `taker`/`nonce`/`feeRateBps` del v2.
- **El HMAC del viejo SDK usa Web Crypto API** (`globalThis.crypto.subtle`), no `crypto.createHmac`. El resultado es equivalente pero el path de debugging es distinto.

### Errores comunes y soluciones

| Error | Causa | Solución |
|-------|-------|----------|
| `ENOTFOUND clob.polymarket.com` | DNS bloqueado | DNS patch (dns.lookup + https.request) |
| `fetch failed` | DNS patch no cubre fetch | Asegurar `dns.lookup` con `all: true` |
| `Invalid IP address: undefined` | dns.lookup callback sin `all` | Devolver `[{address, family}]` cuando `opts.all` |
| `maker address not allowed` | REST directo con estructura v3 incorrecta | Usar el SDK (no REST) |
| `invalid order version` | Exchange v1/v2 deprecado | Solo v3 compatible |
| `min size: 1` | Orden < $1.00 | Usar amount ≥ 1 |
| `tokenId: expected string, received undefined` | PascalCase en vez de camelCase | Usar `tokenId` |

## Verificación

El bot fue testeado con éxito el 2026-07-04:
- DNS patch funcionando desde Argentina ✅
- SDK `@polymarket/client` v0.1.0-beta.12 ✅
- 2 órdenes BUY $1 FOK ejecutadas y matcheadas ✅
- Loop automático corriendo en vivo ✅
- Posiciones abiertas con PnL positivo ✅
