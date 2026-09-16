# Wealthfolio bunq addon

Lokale addon voor Wealthfolio 3.8+: alle bunq monetary accounts (waaronder bank-, spaar-, joint- en externe accounts) ophalen als `CASH` accounts en bunq payments synchroniseren als Wealthfolio activities. Hetzelfde account of payment wordt niet opnieuw aangemaakt dankzij provider-ID's en payment-ID's.

## Starten

```bash
pnpm install
pnpm type-check
pnpm dev:server
```

Start Wealthfolio in addon-dev mode en open **bunq Accounts**.

## Authenticatie

De pagina verwacht alleen een bunq API-key. De addon voert de installatie-, device- en session-bootstrap uit, bewaart de benodigde sleutels in Wealthfolio Secrets en gebruikt daarna ondertekende requests. De knop synchroniseert accounts en payments.

De addon gebruikt de brokered `ctx.api.network.request`; directe `fetch` vanuit de sandbox is bewust niet gebruikt. Waar bunq een categorie of MCC in de payment-response levert, wordt die als metadata/marker opgeslagen en via Wealthfolio-regels gecategoriseerd. De publieke Payment API levert niet altijd de handmatig gekozen bunq-appcategorie; in dat geval kan de addon die categorie niet exact reproduceren.

## Accountinstellingen

Per bunq-account zijn in de addon drie instellingen beschikbaar: `Syncen`, `Fallback expense` en `Fallback income`. Een uitgeschakeld account wordt niet nieuw aangemaakt en haalt geen payments op. Een fallbackcategorie wordt alleen gebruikt wanneer de payment geen bunq-categorie of herkenbare MCC heeft; expliciete categorieën en MCC-mapping hebben voorrang. De instellingen worden in Wealthfolio addon storage opgeslagen per bunq-account-ID.

## Bronnen

- Wealthfolio Addons: https://wealthfolio.app/docs/addons/
- bunq API authentication: https://doc.bunq.com/basics/authentication/api-keys
- bunq monetary accounts: https://doc.bunq.com/monetary-account/monetary-account-bank
