'use strict';
// Builds demo-data/: ~10 sample folders with synthetic, non-sensitive documents for the online demo
// (see app.js loadDemo()). Run once and commit the output: node tools/build-demo-data.js
const fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..'), OUT = path.join(ROOT, 'demo-data');

// A minimal, valid single-page PDF with one or more lines of text (same technique as tests/e2e-edge.js).
function pdfBytes(lines){
  const body = lines.map((t, i) => `BT /F1 14 Tf 72 ${740 - i * 20} Td (${t.replace(/[()\\]/g, '')}) Tj ET`).join('\n');
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    null,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  objs[3] = `<< /Length ${body.length} >>\nstream\n${body}\nendstream`;
  let out = '%PDF-1.4\n'; const offs = [];
  objs.forEach((o, i) => { offs.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offs.map((o) => String(o).padStart(10, '0') + ' 00000 n \n').join('');
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

const html = (title, lines) => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body><h1>${title}</h1>${lines.map((l) => `<p>${l}</p>`).join('\n')}</body></html>`;

// Each folder: a mix of .txt / .html / .pdf. "Weekly status update" appears twice (Project Nimbus and
// Project Atlas) with identical text, to show off duplicate detection in the demo.
const FOLDERS = [
  { name: 'Recipes', files: [
    { name: 'pasta-notes.txt', kind: 'txt', lines: ['Weeknight pasta', 'Boil salted water, cook pasta 9 minutes.', 'Toss with olive oil, garlic, chili flakes and parmesan.', 'Finish with fresh basil and black pepper.'] },
    { name: 'bread-starter.html', kind: 'html', title: 'Sourdough starter log', lines: ['Day 1: flour and water, 1:1 ratio, room temperature.', 'Day 3: first bubbles appear, feed twice daily.', 'Day 7: starter doubles in 4 hours, ready to bake.'] },
    { name: 'soup-ideas.pdf', kind: 'pdf', lines: ['Soup ideas for the week', 'Lentil and carrot, with cumin.', 'Roasted tomato and red pepper.', 'Miso broth with mushrooms and scallion.'] },
  ] },
  { name: 'Project Nimbus', files: [
    { name: 'weekly-status.txt', kind: 'txt', lines: ['Weekly status update', 'Migration to the new queue is on track for Friday.', 'Two open bugs in the retry logic, owner: backend team.', 'Next milestone: load test at 2x current traffic.'] },
    { name: 'architecture-notes.html', kind: 'html', title: 'Architecture notes', lines: ['The queue consumer scales horizontally behind a load balancer.', 'Retries use exponential backoff with a dead-letter queue.', 'Metrics are exported to the shared dashboard.'] },
  ] },
  { name: 'Project Atlas', files: [
    { name: 'weekly-status.txt', kind: 'txt', lines: ['Weekly status update', 'Migration to the new queue is on track for Friday.', 'Two open bugs in the retry logic, owner: backend team.', 'Next milestone: load test at 2x current traffic.'] },
    { name: 'budget.pdf', kind: 'pdf', lines: ['Project Atlas budget', 'Design: 3200', 'Engineering: 18500', 'Contingency: 2100'] },
  ] },
  { name: 'Meeting notes', files: [
    { name: '2026-02-03-standup.txt', kind: 'txt', lines: ['Standup notes', 'Maria: finished the onboarding flow, starting QA.', 'Diego: blocked on the vendor API, filed a support ticket.', 'Action: follow up with vendor by Thursday.'] },
    { name: 'quarterly-review.html', kind: 'html', title: 'Quarterly review', lines: ['Revenue grew 8% over the previous quarter.', 'Support tickets dropped after the new onboarding flow.', 'Next quarter: focus on the mobile app rewrite.'] },
  ] },
  { name: 'Travel planning', files: [
    { name: 'lisbon-itinerary.txt', kind: 'txt', lines: ['Lisbon, 4 days', 'Day 1: Alfama neighborhood, tram 28, miradouro at sunset.', 'Day 2: Belem tower, Jeronimos monastery, pastel de nata.', 'Day 3: day trip to Sintra, Pena palace.', 'Day 4: LX Factory, river cruise.'] },
    { name: 'packing-list.txt', kind: 'txt', lines: ['Packing list', 'Passport, charger, adapter, rain jacket.', 'Comfortable walking shoes, one pair of sandals.', 'Phrasebook, offline maps downloaded.'] },
  ] },
  { name: 'Book notes', files: [
    { name: 'dune-notes.html', kind: 'html', title: 'Dune - reading notes', lines: ['Themes: ecology, power, prophecy, and the cost of messianism.', 'The Fremen water discipline mirrors the planet\'s scarcity.', 'Paul\'s arc questions whether a chosen one is ever truly free.'] },
    { name: 'reading-list.txt', kind: 'txt', lines: ['Reading list', 'Project Hail Mary - Andy Weir', 'The Three-Body Problem - Liu Cixin', 'Piranesi - Susanna Clarke'] },
  ] },
  { name: 'Home maintenance', files: [
    { name: 'furnace-filter.txt', kind: 'txt', lines: ['Furnace filter log', 'Replaced filter on March 3, size 16x25x1.', 'Next replacement due in 90 days.', 'Supplier: hardware store on 5th street.'] },
    { name: 'paint-colors.txt', kind: 'txt', lines: ['Paint colors used', 'Living room: warm white, eggshell finish.', 'Kitchen cabinets: sage green, satin finish.', 'Front door: deep navy, gloss finish.'] },
  ] },
  { name: 'Garden log', files: [
    { name: 'spring-planting.pdf', kind: 'pdf', lines: ['Spring planting plan', 'Tomatoes and basil in the south bed, full sun.', 'Lettuce and spinach in the shaded north bed.', 'Marigolds along the border to deter pests.'] },
    { name: 'watering-schedule.txt', kind: 'txt', lines: ['Watering schedule', 'Raised beds: every other day, early morning.', 'Potted herbs: daily in summer, every 3 days otherwise.', 'Check soil moisture before watering in cooler weeks.'] },
  ] },
  { name: 'Budget planning', files: [
    { name: 'monthly-budget.txt', kind: 'txt', lines: ['Monthly budget', 'Rent 1450, groceries 420, transport 90.', 'Savings target: 15% of take-home pay.', 'Review subscriptions every quarter.'] },
    { name: 'emergency-fund.html', kind: 'html', title: 'Emergency fund plan', lines: ['Target: three months of essential expenses.', 'Automatic transfer of 200 on the 1st of each month.', 'Kept in a separate high-yield savings account.'] },
  ] },
  { name: 'Workout log', files: [
    { name: 'week-12.txt', kind: 'txt', lines: ['Week 12', 'Monday: 5k run, easy pace.', 'Wednesday: full body strength, 3 sets each.', 'Saturday: long run, 10k, steady effort.'] },
    { name: 'stretching-routine.txt', kind: 'txt', lines: ['Stretching routine', 'Hamstrings and calves, 30 seconds each side.', 'Hip flexors, especially after long runs.', 'Shoulders and upper back before strength work.'] },
  ] },
];

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
const manifest = { folders: [] };
for (const folder of FOLDERS){
  const dir = path.join(OUT, folder.name);
  fs.mkdirSync(dir, { recursive: true });
  const fileList = [];
  for (const f of folder.files){
    let buf;
    if (f.kind === 'txt') buf = Buffer.from(f.lines.join('\n') + '\n', 'utf8');
    else if (f.kind === 'html') buf = Buffer.from(html(f.title, f.lines), 'utf8');
    else buf = pdfBytes(f.lines);
    fs.writeFileSync(path.join(dir, f.name), buf);
    fileList.push({ name: f.name });
  }
  manifest.folders.push({ name: folder.name, files: fileList });
}
fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(`Wrote ${FOLDERS.length} demo folders, ${FOLDERS.reduce((n, f) => n + f.files.length, 0)} files, to ${OUT}`);
