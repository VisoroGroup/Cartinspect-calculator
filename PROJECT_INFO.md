# CartInspect Calculator — Impact Bugetar

## Összefoglaló
Költségvetési hatáselemző kalkulátor romániai önkormányzatok számára. A felhasználó választ egy települést, és a rendszer kiszámolja az ingatlanellenőrzés költség/megtérülés hatását. API proxy-n keresztül lekéri a helyi költségvetési adatokat (Transparenta.eu).

## Tech Stack
- **Frontend:** Vanilla HTML + CSS + JavaScript (nincs framework!)
- **Backend / Proxy:** Node.js + Express (API proxy a Transparenta.eu-hoz)
- **Data:** `romania_uat.js` — település adatok, `uat_data.js` — UAT statisztikák
- **PDF:** Puppeteer-alapú PDF generálás (kalkulátor eredmény export)
- **Deploy:** Railway (auto-deploy from GitHub)

## Repository
- **GitHub:** https://github.com/VisoroGroup/Cartinspect-calculator.git
- **Branch:** `main`

## Fontos Fájlok
| Fájl | Leírás |
|------|--------|
| `index.html` | Fő kalkulátor oldal (single page) |
| `proxy/server.js` | Express API proxy → Transparenta.eu |
| `romania_uat.js` | Romániai település adatbázis |
| `uat_data.js` | UAT statisztikai adatok |
| `scripts/` | Segéd script-ek (PDF, tesztek) |
| `test_math.js` | Számítási logika tesztek |

## Scripts
```bash
npm start            # Proxy server indítás
```

## Dependencies
- `express` ^4.18.2
- `cors` ^2.8.5
- `node-fetch` ^2.7.0

## Fontos Jellemzők
- Proxy entity keresés: commune prioritás (nem iskola/intézmény)
- `financial: null` fallback → minimum base kalkuláció
- Favicon: több méret (16, 32, 48, ico, apple-touch-icon)
- Teljes kiszámított PDF letöltés
- Visoro logó branding
