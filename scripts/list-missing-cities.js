/**
 * Find all ORAS/MUNICIPIU entries that are completely missing from uat_data.js
 */
const fs = require('fs');
const path = require('path');
const base = '/Users/visoro/Antigravity projektek/Cartinspect calculator';

const uatSrc = fs.readFileSync(path.join(base, 'romania_uat.js'), 'utf-8');
const ROMANIA_UAT = new Function('return ' + uatSrc.match(/const\s+ROMANIA_UAT\s*=\s*(\{[\s\S]*\});/)[1])();

const dataSrc = fs.readFileSync(path.join(base, 'uat_data.js'), 'utf-8');
const UAT_DATA = JSON.parse(dataSrc.match(/const\s+UAT_DATA\s*=\s*(\{[\s\S]*\});/)[1]);

const missing = [];
for (const county of Object.keys(ROMANIA_UAT)) {
    for (const [name, info] of Object.entries(ROMANIA_UAT[county])) {
        if (info.tip !== 'oraș' && info.tip !== 'municipiu') continue;
        const d = UAT_DATA[county] && UAT_DATA[county][name];
        if (!d) {
            missing.push({ county, name, tip: info.tip, reason: 'MISSING' });
        } else if (d.houses === 0 || !d.houses) {
            missing.push({ county, name, tip: info.tip, reason: 'houses=0' });
        }
    }
}

console.log('Cities/municipii NOT properly in uat_data.js: ' + missing.length);
missing.forEach(m => console.log('  [' + m.tip + '] ' + m.county + ' -> ' + m.name + ' (' + m.reason + ')'));
