"use strict";
// Gera public/js/data/brazil-map.js a partir de @svg-maps/brazil (CC BY 4.0).
// Uso: npm i --no-save @svg-maps/brazil && node scripts/build-map.js
const fs = require("node:fs");
const path = require("node:path");
const src = fs.readFileSync(require.resolve("@svg-maps/brazil"), "utf8").replace(/^export default /, "").replace(/;\s*$/, "");
const map = JSON.parse(src);
const out = { viewBox: map.viewBox, locations: map.locations.map((l) => ({ id: l.id.toUpperCase(), name: l.name, path: l.path })) };
const file = path.join(__dirname, "..", "public", "js", "data", "brazil-map.js");
fs.writeFileSync(file, "/* Mapa SVG do Brasil — @svg-maps/brazil (Victor Cazanave), licença CC BY 4.0. */\n(function(){var ML=window.ML=window.ML||{};ML.mapData=" + JSON.stringify(out) + ";})();\n");
console.log("OK", out.locations.length, "UFs");
