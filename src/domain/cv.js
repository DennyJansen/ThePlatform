/**
 * Reading a CV into profile fields. Pure functions over already-extracted text.
 *
 * BE CLEAR ABOUT WHAT THIS IS. It is a set of regexes and a fixed vocabulary.
 * It is not language understanding, and it cannot become language
 * understanding in this build: that would need a model behind an API key, and
 * an API key in a public repository is a leaked API key.
 *
 * So the contract is: extract what can be extracted with confidence, say which
 * fields came from the CV, and hand the result to the freelancer to correct.
 * Nothing here is ever saved without someone looking at it. A profile that
 * quietly contains a wrong rate or a skill the person does not have is worse
 * than an empty one, because they will not know to fix it.
 *
 * `extractProfile` therefore returns `{ fields, found }` and never a profile.
 * The screen prefills, marks what it filled, and waits.
 */

/**
 * The skills vocabulary. Matching against a fixed list is the only reliable
 * option without a model: free-form noun extraction from a CV produces
 * "Ervaring", "Projecten" and "Microsoft Word".
 *
 * It is deliberately weighted to the trades this platform is placing into.
 * Add to it as you learn what people actually write; do not try to make it
 * general, because a general list matches everything and means nothing.
 */
export const SKILL_VOCABULARY = Object.freeze([
  // Bouw en infra
  'Werkvoorbereiding', 'Calculatie', 'Uitvoering', 'Projectleiding',
  'Utiliteitsbouw', 'Woningbouw', 'Renovatie', 'Transformatie', 'Nieuwbouw',
  'Infra', 'Ondergrondse infra', 'Kabels en leidingen', 'Wegenbouw',
  'Grondwerk', 'Betonbouw', 'Staalbouw', 'Sloopwerk',
  // Techniek
  'Installatietechniek', 'W-installaties', 'E-installaties', 'Elektrotechniek',
  'Werktuigbouwkunde', 'Constructie', 'Bouwkunde', 'Civiele techniek',
  'Duurzaamheid', 'Verduurzaming', 'BENG', 'Bouwbesluit', 'CROW',
  // Methoden en systemen
  'BIM', 'Revit', 'AutoCAD', 'Bouw7', 'Navisworks', 'Tekla', 'MS Project',
  'Primavera', 'Lean planning', 'Scrum', 'Prince2', 'IPMA',
  // Contract en beheer
  'UAV-GC', 'Aanbesteding', 'Contractmanagement', 'Inkoop', 'Kostenbewaking',
  'Planning', 'Risicomanagement', 'Kwaliteitsborging', 'VCA', 'Veiligheid',
  'Toezicht', 'Directievoering', 'Vergunningen',
]);

/** Languages worth recognising in a Dutch CV. */
export const LANGUAGE_VOCABULARY = Object.freeze([
  'Nederlands', 'Engels', 'Duits', 'Frans', 'Spaans', 'Pools', 'Turks',
  'Arabisch', 'Portugees', 'Italiaans', 'Roemeens', 'Bulgaars',
]);

/** Enough Dutch cities to catch most CVs without shipping a gazetteer. */
export const CITY_VOCABULARY = Object.freeze([
  'Amsterdam', 'Rotterdam', 'Den Haag', "'s-Gravenhage", 'Utrecht', 'Eindhoven',
  'Groningen', 'Tilburg', 'Almere', 'Breda', 'Nijmegen', 'Apeldoorn',
  'Haarlem', 'Arnhem', 'Enschede', 'Amersfoort', 'Zaanstad', 'Zwolle',
  'Leiden', 'Leeuwarden', 'Maastricht', 'Dordrecht', 'Ede', 'Alphen aan den Rijn',
  'Delft', 'Venlo', 'Deventer', 'Sittard', 'Helmond', 'Oss', 'Hilversum',
  'Heerlen', 'Amstelveen', 'Roosendaal', 'Purmerend', 'Schiedam', 'Spijkenisse',
  'Vlaardingen', 'Almelo', 'Gouda', 'Zoetermeer', 'Lelystad', 'Hoorn',
  'Alkmaar', 'Emmen', 'Assen', 'Middelburg', 'Sneek', 'Veenendaal',
]);

const EMAIL_RE = /[\w.+-]+@[\w-]+(\.[\w-]+)+/;
// Dutch mobile and landline, with or without country code and separators.
const PHONE_RE = /(?:\+31|0031|0)\s?6[\s.-]?\d{2}[\s.-]?\d{2}[\s.-]?\d{2}[\s.-]?\d{2}|(?:\+31|0031|0)\s?\d{2,3}[\s.-]?\d{3}[\s.-]?\d{3,4}/;
const URL_RE = /\b(?:https?:\/\/)?(?:www\.)?(?:linkedin\.com\/in\/[\w-]+|[\w-]+\.(?:nl|com|eu|dev|io)(?:\/[\w\-./]*)?)/i;

/** Collapse the whitespace a PDF extractor leaves behind. */
export function normaliseText(raw) {
  return String(raw || '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t ]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function lines(text) {
  return text.split('\n').map((l) => l.trim()).filter(Boolean);
}

/**
 * "12 jaar ervaring" / "12 years of experience" / "sinds 2013".
 * A stated number wins over one derived from a date, because someone who
 * writes "12 jaar ervaring" has already done the arithmetic for their own
 * career, including the gaps.
 */
export function extractYearsExperience(text, now = new Date()) {
  const stated = text.match(/(\d{1,2})\+?\s*(?:jaar|jr\.?|years?)\s*(?:werk)?\s*ervaring|(\d{1,2})\+?\s*years?\s+of\s+experience/i);
  if (stated) {
    const value = Number(stated[1] || stated[2]);
    if (value > 0 && value <= 60) return value;
  }

  const since = text.match(/(?:sinds|since|werkzaam vanaf)\s+(19|20)(\d{2})/i);
  if (since) {
    const year = Number(since[1] + since[2]);
    const span = now.getUTCFullYear() - year;
    if (span > 0 && span <= 60) return span;
  }

  return null;
}

/**
 * Skills present in the text, matched against the vocabulary.
 *
 * Whole-word matching, case-insensitive. Without the word boundaries "BIM"
 * matches "combineren" and every CV comes back claiming BIM experience.
 */
export function extractSkills(text, vocabulary = SKILL_VOCABULARY, limit = 12) {
  const found = [];
  for (const skill of vocabulary) {
    const escaped = skill.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp('(^|[^\\p{L}])' + escaped + '($|[^\\p{L}])', 'iu');
    if (re.test(text)) found.push(skill);
    if (found.length >= limit) break;
  }
  return found;
}

export function extractLanguages(text) {
  return extractSkills(text, LANGUAGE_VOCABULARY, 6);
}

export function extractCity(text) {
  // An explicit label wins over a city mentioned in a job history.
  const labelled = text.match(/(?:woonplaats|woonachtig in|standplaats|locatie)\s*[:\-]?\s*([A-Z][\w'\- ]{2,40})/i);
  if (labelled) {
    const candidate = labelled[1].trim().split(/\s{2,}|\n/)[0];
    const known = CITY_VOCABULARY.find((c) => c.toLowerCase() === candidate.toLowerCase());
    if (known) return known;
  }
  const head = text.slice(0, 1200);
  return CITY_VOCABULARY.find((c) => {
    const re = new RegExp('(^|[^\\p{L}])' + c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '($|[^\\p{L}])', 'iu');
    return re.test(head);
  }) || null;
}

/**
 * A name is two to four capitalised words on one of the first few lines, with
 * no digits and no "CV" in it. This is the least reliable thing here, which is
 * why the field it fills is the one the freelancer is most likely to notice is
 * wrong.
 */
export function extractName(text) {
  for (const line of lines(text).slice(0, 6)) {
    if (line.length > 60 || /\d/.test(line)) continue;
    if (/curriculum|vitae|\bcv\b|resume/i.test(line)) continue;
    const words = line.split(' ').filter(Boolean);
    if (words.length < 2 || words.length > 4) continue;
    if (words.every((w) => /^[\p{Lu}]/u.test(w) || /^(van|de|der|den|het|te|ten|ter)$/i.test(w))) {
      return line;
    }
  }
  return null;
}

/**
 * A headline: the first short line after the name that reads like a job title.
 * Falls back to null rather than guessing from prose.
 */
export function extractHeadline(text, name) {
  const all = lines(text);
  const start = name ? all.findIndex((l) => l === name) + 1 : 0;
  for (const line of all.slice(start, start + 5)) {
    if (line.length < 8 || line.length > 90) continue;
    if (EMAIL_RE.test(line) || PHONE_RE.test(line)) continue;
    if (/curriculum|vitae|\bcv\b|resume|profiel|personalia/i.test(line)) continue;
    if (/^\W+$/.test(line)) continue;
    return line;
  }
  return null;
}

/**
 * The opening prose block: the "profiel" or "over mij" section if the CV has
 * one, otherwise the longest paragraph in the first part of the document.
 */
export function extractBio(text) {
  const section = text.match(/(?:^|\n)\s*(?:profiel|persoonlijk profiel|over mij|samenvatting|profile|summary|about me)\s*:?\s*\n+([\s\S]{60,1200}?)(?:\n\s*\n|$)/i);
  if (section) return normaliseText(section[1]).replace(/\n/g, ' ');

  const paragraphs = text.slice(0, 4000).split(/\n\s*\n/)
    .map((p) => normaliseText(p).replace(/\n/g, ' '))
    .filter((p) => p.length >= 120 && p.length <= 1200)
    .filter((p) => !EMAIL_RE.test(p) && !PHONE_RE.test(p));

  return paragraphs.sort((a, b) => b.length - a.length)[0] || null;
}

export function extractEmail(text) {
  const match = text.match(EMAIL_RE);
  return match ? match[0].toLowerCase() : null;
}

export function extractPhone(text) {
  const match = text.match(PHONE_RE);
  return match ? match[0].replace(/[\s.-]/g, '') : null;
}

export function extractWebsite(text) {
  const match = text.match(URL_RE);
  if (!match) return null;
  const raw = match[0];
  return /^https?:\/\//i.test(raw) ? raw : 'https://' + raw;
}

/**
 * Read a CV into profile fields.
 *
 * Returns `{ fields, found, chars }`:
 *   fields — only the keys that were actually extracted
 *   found  — the same keys, for marking them in the form as "from your CV"
 *   chars  — how much text came out, so the caller can tell an image-only
 *            PDF (which yields almost nothing) from a genuine miss
 *
 * Never returns a profile and never fills a rate: what someone charges is not
 * something to guess from a document.
 */
export function extractProfile(rawText, options = {}) {
  const text = normaliseText(rawText);
  const fields = {};

  const name = extractName(text);
  if (name) fields.name = name;

  const headline = extractHeadline(text, name);
  if (headline) fields.headline = headline;

  const bio = extractBio(text);
  if (bio) fields.bio = bio;

  const skills = extractSkills(text);
  if (skills.length) fields.skills = skills;

  const languages = extractLanguages(text);
  if (languages.length) fields.languages = languages;

  const years = extractYearsExperience(text, options.now);
  if (years !== null) fields.years_experience = years;

  const city = extractCity(text);
  if (city) fields.location = city;

  const website = extractWebsite(text);
  if (website) fields.website_url = website;

  const email = extractEmail(text);
  if (email) fields.email = email;

  const phone = extractPhone(text);
  if (phone) fields.phone = phone;

  return { fields, found: Object.keys(fields), chars: text.length };
}

/**
 * True when a document produced so little text that it is almost certainly a
 * scan rather than a real miss. Worth telling someone: "we found nothing"
 * and "this file is a photograph of a CV" call for different responses, and
 * OCR is not in this build.
 */
export function looksLikeScannedDocument(chars) {
  return chars < 200;
}
