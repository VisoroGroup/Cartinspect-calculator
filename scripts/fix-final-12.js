const fs = require('fs');
const path = require('path');

const PROXY = 'http://localhost:3001';
const PUBLIC_UAT_FILE = path.join(__dirname, '..', 'public', 'uat_data.js');
const ROOT_UAT_FILE = path.join(__dirname, '..', 'uat_data.js');

const src = fs.readFileSync(PUBLIC_UAT_FILE, 'utf-8');
const m = src.match(/const\s+UAT_DATA\s*=\s*(\{[\s\S]*\});/);
const UAT_DATA = new Function('return ' + m[1])();

const missing = [
    ['Alba','Blaj'], ['Hunedoara','Petroșani'], ['Prahova','Ploiești'],
    ['Vrancea','Focșani'], ['Constanța','Ovidiu'], ['Călărași','Fundulea'],
    ['Prahova','Bușteni'], ['Satu Mare','Negrești-Oaș'], ['Vrancea','Odobești'],
    ['Caraș-Severin','Mehadia'], ['Timiș','Șag'], ['Vrancea','Movilița']
];

async function run() {
    let ok = 0;
    for (const [county, name] of missing) {
        const url = `${PROXY}/api/entity-data?county=${encodeURIComponent(county)}&name=${encodeURIComponent(name)}`;
        try {
            const res = await fetch(url);
            const data = await res.json();
            if (data.financial && data.financial.total > 0) {
                if (!UAT_DATA[county]) UAT_DATA[county] = {};
                const existing = UAT_DATA[county][name] || {};
                UAT_DATA[county][name] = {
                    tax: data.financial.impozitCladiriFizice || 0,
                    landTax: data.financial.impozitTerenuri || 0,
                    taxYear: data.financial.year || null,
                    houses: data.housing?.count || existing.houses || 0,
                    housesYear: data.housing?.year || existing.housesYear || null
                };
                ok++;
                console.log(`✓ ${county} → ${name}: ${data.financial.total.toLocaleString()} RON`);
            } else {
                console.log(`✗ ${county} → ${name}: no financial`);
            }
        } catch (err) {
            console.log(`✗ ${county} → ${name}: ${err.message}`);
        }
        await new Promise(r => setTimeout(r, 1500));
    }

    const timestamp = new Date().toISOString().split('T')[0];
    const totalWithData = Object.values(UAT_DATA).reduce((sum, c) =>
        sum + Object.values(c).filter(e => e.tax > 0 || e.landTax > 0 || e.houses > 0).length, 0);
    const header = `// Auto-generated UAT data from transparenta.eu\n// Generated: ${timestamp} (final fix: +${ok} records)\n// Total: ${totalWithData} UATs with data\n`;
    const content = header + `const UAT_DATA = ${JSON.stringify(UAT_DATA, null, 0)};\n`;
    fs.writeFileSync(PUBLIC_UAT_FILE, content, 'utf-8');
    fs.writeFileSync(ROOT_UAT_FILE, content, 'utf-8');
    console.log(`\nDone! ${ok}/12 updated. Total: ${totalWithData} UATs with data.`);
}

run();
