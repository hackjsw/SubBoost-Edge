// Inline icons (lucide-style strokes) and a decorative QR placeholder.
const PATHS = {
  copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/>',
  qr: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><path d="M14 14h3v3h-3zM20 14v.01M14 20h.01M17 20h4v-3"/>',
  more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
  refresh: '<path d="M21 12a9 9 0 0 1-15.5 6.3L3 16M3 12a9 9 0 0 1 15.5-6.3L21 8"/><path d="M21 3v5h-5M3 21v-5h5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  alert: '<path d="M12 9v4M12 17h.01"/><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  download: '<path d="M12 3v12M7 10l5 5 5-5M4 21h16"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/>',
  edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>',
  settings: '<path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0"/><circle cx="16" cy="6" r="2"/><circle cx="10" cy="12" r="2"/><circle cx="18" cy="18" r="2"/>',
  trash: '<path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14"/>',
  chevron: '<path d="m6 9 6 6 6-6"/>',
  link: '<path d="M10 13a5 5 0 0 0 7.1 0l3-3a5 5 0 0 0-7.1-7.1l-1.7 1.7"/><path d="M14 11a5 5 0 0 0-7.1 0l-3 3a5 5 0 0 0 7.1 7.1l1.7-1.7"/>',
  wand: '<path d="m15 4 5 5L9 20H4v-5z"/><path d="M13 6l5 5"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
  db: '<ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  cal: '<rect x="3" y="4" width="18" height="17" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>',
  layers: '<path d="m12 2 10 5-10 5L2 7z"/><path d="m2 17 10 5 10-5M2 12l10 5 10-5"/>',
  eye: '<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  grip: '<circle cx="9" cy="6" r="1"/><circle cx="15" cy="6" r="1"/><circle cx="9" cy="12" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="9" cy="18" r="1"/><circle cx="15" cy="18" r="1"/>',
  file: '<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>',
};
const MARK = '<svg viewBox="0 0 64 64" aria-hidden="true"><path d="M13 17h25c7.2 0 13 5.8 13 13s-5.8 13-13 13H26c-7.2 0-13 5.8-13 13" fill="none" stroke="#ea580c" stroke-linecap="round" stroke-width="7"/><circle cx="13" cy="17" r="6" fill="#172321"/><circle cx="51" cy="30" r="6" fill="#dc654f"/><circle cx="13" cy="56" r="6" fill="#315fcb"/></svg>';

for (const el of document.querySelectorAll("i[data-i]")) {
  const cls = el.className ? ` ${el.className}` : "";
  el.outerHTML = `<svg class="i${cls}" viewBox="0 0 24 24" aria-hidden="true">${PATHS[el.dataset.i] || ""}</svg>`;
}
for (const el of document.querySelectorAll("[data-mark]")) el.innerHTML = MARK;

// Decorative QR: finder patterns plus a seeded pseudo-random module grid.
for (const el of document.querySelectorAll("[data-qr]")) {
  const n = 29, s = 6;
  let seed = 1234567;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  const finder = (x, y) =>
    `<rect x="${x * s}" y="${y * s}" width="${7 * s}" height="${7 * s}" fill="#172321"/>` +
    `<rect x="${(x + 1) * s}" y="${(y + 1) * s}" width="${5 * s}" height="${5 * s}" fill="#fff"/>` +
    `<rect x="${(x + 2) * s}" y="${(y + 2) * s}" width="${3 * s}" height="${3 * s}" fill="#172321"/>`;
  const inFinder = (x, y) => (x < 8 && y < 8) || (x > n - 9 && y < 8) || (x < 8 && y > n - 9);
  let cells = "";
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    if (!inFinder(x, y) && rnd() > 0.52) cells += `<rect x="${x * s}" y="${y * s}" width="${s}" height="${s}" fill="#172321"/>`;
  }
  el.innerHTML = `<svg viewBox="0 0 ${n * s} ${n * s}" width="100%" height="100%">${cells}${finder(0, 0)}${finder(n - 7, 0)}${finder(0, n - 7)}</svg>`;
}

// Mockups default to the tech theme; add ?light to compare with the light theme.
if (!/[?&]light/.test(location.search)) document.documentElement.dataset.theme = "tech";
