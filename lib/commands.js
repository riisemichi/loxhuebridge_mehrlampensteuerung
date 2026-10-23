// Explizite Loxone-Befehlstypen für /{name}/{typ}/<v>. Gemeinsam genutzt von hue.js (Auswertung)
// und auth.js (Steuerpfade ohne Login), damit beide Listen nicht auseinanderlaufen.
const LOXONE_COMMAND_TYPES = ['dim', 'rgb', 'ct', 'rgbw', 'switch'];

module.exports = { LOXONE_COMMAND_TYPES };
