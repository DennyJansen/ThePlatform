/**
 * Sign-up and CV import.
 *
 * The two tests worth reading first:
 *
 *  - "does not reveal whether an address already has an account". Sign-up is a
 *    public form, and a form that answers "that address is taken" answers a
 *    question anyone can ask about anyone.
 *  - "never fills in a rate". A CV parser that guesses what someone charges
 *    will eventually guess low, into a field they did not check.
 */

import { describe, it, assert } from './runner.js';

import { ROLE } from '../domain/model.js';
import {
  SIGNUP_ERROR, SELF_SERVICE_ROLES,
  assertEmail, assertKvk, assertName, assertVatNumber, assertWebsite,
  assertSelfServiceRole, findOrganizationByKvk, normaliseCompanySignup,
  normaliseFreelancerSignup, normaliseKvk, resolveExistingAccount,
} from '../domain/signup.js';
import {
  SKILL_VOCABULARY, extractBio, extractCity, extractHeadline, extractLanguages,
  extractName, extractProfile, extractSkills, extractYearsExperience,
  looksLikeScannedDocument, normaliseText,
} from '../domain/cv.js';
import { enrichFromWebsite, enrichmentIsAvailable, ENRICHMENT_ERROR } from '../data/enrichment.js';
import { readDocument, READ_ERROR, MAX_FILE_BYTES } from '../ui/lib/readDocument.js';
import { createMockAdapter } from '../data/mock/mockAdapter.js';
import { load, save, __testing } from '../data/mock/store.js';
import { buildSeed } from '../data/mock/seed.js';

/* ------------------------------------------------------------------ */

const CV_TEXT = `
Sanne de Vries
Werkvoorbereider utiliteitsbouw

sanne.devries@example.com
06 12 34 56 78
Amersfoort
linkedin.com/in/sannedevries

Profiel
Twaalf jaar in de utiliteitsbouw, waarvan de laatste zes als zelfstandige. Ik werk
het liefst aan renovatie- en transformatieprojecten waar de tekening en de
werkelijkheid niet op elkaar aansluiten. Ik lever werkpakketten op die de uitvoering
zonder navraag kan gebruiken.

Werkervaring
2019 - heden   Zelfstandig werkvoorbereider
               Calculatie, werkvoorbereiding en inkoop voor renovatieprojecten.
               Werken met BIM en Revit, toetsing aan het Bouwbesluit.

Vaardigheden
Werkvoorbereiding, Calculatie, Utiliteitsbouw, Renovatie, BIM, Revit, Bouwbesluit, VCA

Talen
Nederlands (moedertaal), Engels (vloeiend), Duits (basis)

12 jaar ervaring
`;

/* ------------------------------------------------------------------ */

describe('Sign-up — field validation', () => {
  it('accepts the addresses people actually have', () => {
    assert.equal(assertEmail('  Sanne.De-Vries+werk@voorbeeld.co.uk '),
      'sanne.de-vries+werk@voorbeeld.co.uk', 'trimmed and lowercased');
    assert.equal(assertEmail('a@b.nl'), 'a@b.nl');
  });

  it('refuses what is plainly not an address', async () => {
    await assert.throws(() => assertEmail(''), SIGNUP_ERROR.EMAIL_REQUIRED);
    await assert.throws(() => assertEmail('nope'), SIGNUP_ERROR.EMAIL_INVALID);
    await assert.throws(() => assertEmail('a@b'), SIGNUP_ERROR.EMAIL_INVALID);
    await assert.throws(() => assertEmail('a b@c.nl'), SIGNUP_ERROR.EMAIL_INVALID);
  });

  it('collapses whitespace in a name', () => {
    assert.equal(assertName('  Sanne   de   Vries '), 'Sanne de Vries');
  });

  it('requires eight digits for a KvK number, however it is typed', () => {
    assert.equal(assertKvk('87654321'), '87654321');
    assert.equal(assertKvk('87 65 43 21'), '87654321');
    assert.equal(assertKvk('87.65.43.21'), '87654321');
    assert.equal(normaliseKvk('87-65-43-21'), '87654321');
  });

  it('refuses a KvK number that is not eight digits', async () => {
    await assert.throws(() => assertKvk(''), SIGNUP_ERROR.KVK_REQUIRED);
    await assert.throws(() => assertKvk('1234567'), SIGNUP_ERROR.KVK_INVALID);
    await assert.throws(() => assertKvk('123456789'), SIGNUP_ERROR.KVK_INVALID);
    await assert.throws(() => assertKvk('abcdefgh'), SIGNUP_ERROR.KVK_INVALID);
  });

  it('treats the VAT number as optional and checks its shape', async () => {
    assert.equal(assertVatNumber(''), null);
    assert.equal(assertVatNumber('nl863412955b01'), 'NL863412955B01');
    await assert.throws(() => assertVatNumber('DE123456789'), SIGNUP_ERROR.VAT_INVALID);
  });

  it('adds the scheme people leave off a website', () => {
    assert.equal(assertWebsite('meridiaanbouw.nl'), 'https://meridiaanbouw.nl');
    assert.equal(assertWebsite('http://meridiaanbouw.nl/'), 'http://meridiaanbouw.nl');
    assert.equal(assertWebsite(''), null, 'optional by default');
  });

  it('refuses something that is not a public web address', async () => {
    await assert.throws(() => assertWebsite('localhost'), SIGNUP_ERROR.WEBSITE_INVALID);
    await assert.throws(() => assertWebsite('not a url'), SIGNUP_ERROR.WEBSITE_INVALID);
    await assert.throws(() => assertWebsite('javascript:alert(1)'), SIGNUP_ERROR.WEBSITE_INVALID);
    await assert.throws(() => assertWebsite('', { required: true }), SIGNUP_ERROR.WEBSITE_INVALID);
  });

  it('builds a freelancer sign-up with consent off unless asked for', () => {
    const a = normaliseFreelancerSignup({ name: 'Sanne de Vries', email: 'S@Example.NL' });
    assert.equal(a.role, ROLE.FREELANCER);
    assert.equal(a.email, 's@example.nl');
    assert.equal(a.outreach_consent, false, 'spec section 6: opt-in, not opt-out');

    const b = normaliseFreelancerSignup({
      name: 'Sanne', email: 's@example.nl', outreach_consent: true,
    });
    assert.equal(b.outreach_consent, true);
    assert.equal(normaliseFreelancerSignup({
      name: 'Sanne', email: 's@example.nl', outreach_consent: 'yes',
    }).outreach_consent, false, 'only a real true counts as consent');
  });

  it('defaults the billing address to the person signing up', () => {
    const c = normaliseCompanySignup({
      name: 'Marieke Vos',
      email: 'marieke@meridiaanbouw.nl',
      company_name: 'Meridiaan Bouwgroep B.V.',
      kvk_number: '84213977',
    });
    assert.equal(c.role, ROLE.COMPANY_ADMIN);
    assert.equal(c.organization.billing_email, 'marieke@meridiaanbouw.nl');
    assert.equal(c.organization.payment_terms_days, 30);
    assert.equal(c.organization.website, null);
  });

  it('does not let anyone sign up as ops or as an approver', async () => {
    assert.deepEqual(SELF_SERVICE_ROLES.slice().sort(), ['company_admin', 'freelancer']);
    await assert.throws(() => assertSelfServiceRole(ROLE.OPS),
      SIGNUP_ERROR.ROLE_NOT_SELF_SERVICE);
    await assert.throws(() => assertSelfServiceRole(ROLE.APPROVER),
      SIGNUP_ERROR.ROLE_NOT_SELF_SERVICE, 'an approver is named by ops on an assignment');
  });

  it('matches an organisation on KvK regardless of formatting', () => {
    const orgs = [{ id: 'org_1', kvk_number: '84213977' }];
    assert.equal(findOrganizationByKvk(orgs, '84 21 39 77').id, 'org_1');
    assert.equal(findOrganizationByKvk(orgs, '11111111'), null);
  });

  it('finds an existing account case-insensitively', () => {
    const users = [{ id: 'u1', email: 'Sanne@Example.nl' }];
    assert.equal(resolveExistingAccount(users, 'sanne@example.nl').id, 'u1');
    assert.equal(resolveExistingAccount(users, 'other@example.nl'), null);
  });
});

/* ------------------------------------------------------------------ */

describe('CV import — what it can read', () => {
  it('finds the name at the top', () => {
    assert.equal(extractName(normaliseText(CV_TEXT)), 'Sanne de Vries');
  });

  it('takes the line under the name as a headline', () => {
    assert.equal(
      extractHeadline(normaliseText(CV_TEXT), 'Sanne de Vries'),
      'Werkvoorbereider utiliteitsbouw',
    );
  });

  it('prefers a labelled profile section for the bio', () => {
    const bio = extractBio(normaliseText(CV_TEXT));
    assert.ok(bio.startsWith('Twaalf jaar in de utiliteitsbouw'), 'got: ' + bio);
    assert.ok(!bio.includes('@'), 'contact details must not end up in the bio');
  });

  it('matches skills against the vocabulary, whole words only', () => {
    const skills = extractSkills(normaliseText(CV_TEXT));
    for (const expected of ['Werkvoorbereiding', 'Calculatie', 'Utiliteitsbouw', 'BIM', 'Revit']) {
      assert.ok(skills.includes(expected), 'missed ' + expected);
    }
    // "BIM" inside "combineren" would match without word boundaries, and then
    // every CV claims BIM experience.
    assert.deepEqual(extractSkills('Wij combineren disciplines.'), []);
  });

  it('caps the number of skills it will claim', () => {
    const everything = SKILL_VOCABULARY.join(', ');
    assert.equal(extractSkills(everything).length, 12);
  });

  it('reads languages and a city', () => {
    const text = normaliseText(CV_TEXT);
    assert.deepEqual(extractLanguages(text), ['Nederlands', 'Engels', 'Duits']);
    assert.equal(extractCity(text), 'Amersfoort');
  });

  it('believes a stated number of years over a derived one', () => {
    assert.equal(extractYearsExperience('12 jaar ervaring'), 12);
    assert.equal(extractYearsExperience('8+ years of experience'), 8);
    assert.equal(
      extractYearsExperience('Werkzaam vanaf 2016', new Date('2026-01-01T00:00:00Z')),
      10,
    );
    assert.equal(extractYearsExperience('geen getallen hier'), null);
    assert.equal(extractYearsExperience('99 jaar ervaring'), null, 'implausible is not a value');
  });

  it('pulls a full profile out of a plausible CV', () => {
    const { fields, found } = extractProfile(CV_TEXT);
    assert.equal(fields.headline, 'Werkvoorbereider utiliteitsbouw');
    assert.equal(fields.years_experience, 12);
    assert.equal(fields.location, 'Amersfoort');
    assert.equal(fields.email, 'sanne.devries@example.com');
    assert.ok(fields.skills.length >= 5);
    assert.ok(found.includes('bio'));
  });

  it('never fills in a rate', () => {
    const { fields } = extractProfile(CV_TEXT + '\nUurtarief: 95 euro per uur\n');
    assert.equal(fields.rate_expectation_per_hour, undefined,
      'what someone charges is not something to guess from a document');
  });

  it('returns nothing rather than nonsense for an empty document', () => {
    const { fields, found, chars } = extractProfile('');
    assert.deepEqual(fields, {});
    assert.deepEqual(found, []);
    assert.equal(chars, 0);
  });

  it('recognises a scan by how little text came out', () => {
    assert.ok(looksLikeScannedDocument(0));
    assert.ok(looksLikeScannedDocument(120));
    assert.ok(!looksLikeScannedDocument(2000));
  });
});

/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ *
 * The .docx reader
 *
 * readDocument's ZIP handling is sixty lines of byte offsets, written rather
 * than installed. Building a real (uncompressed) .docx here is the only way to
 * know it works, and .docx is the format most Dutch CVs arrive in.
 * ------------------------------------------------------------------ */

function crc32(bytes) {
  const table = [];
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  let crc = -1;
  for (let i = 0; i < bytes.length; i += 1) crc = (crc >>> 8) ^ table[(crc ^ bytes[i]) & 0xFF];
  return (crc ^ -1) >>> 0;
}

/** A ZIP with stored (method 0) entries — no compression, same structure. */
function buildZip(files) {
  const encoder = new TextEncoder();
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const file of files) {
    const name = encoder.encode(file.name);
    const data = encoder.encode(file.content);
    const crc = crc32(data);

    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, data.length, true);
    local.setUint32(22, data.length, true);
    local.setUint16(26, name.length, true);
    locals.push(new Uint8Array(local.buffer), name, data);

    const central = new DataView(new ArrayBuffer(46));
    central.setUint32(0, 0x02014b50, true);
    central.setUint16(4, 20, true);
    central.setUint16(6, 20, true);
    central.setUint32(16, crc, true);
    central.setUint32(20, data.length, true);
    central.setUint32(24, data.length, true);
    central.setUint16(28, name.length, true);
    central.setUint32(42, offset, true);
    centrals.push(new Uint8Array(central.buffer), name);

    offset += 30 + name.length + data.length;
  }

  const centralSize = centrals.reduce((sum, part) => sum + part.length, 0);
  const eocd = new DataView(new ArrayBuffer(22));
  eocd.setUint32(0, 0x06054b50, true);
  eocd.setUint16(8, files.length, true);
  eocd.setUint16(10, files.length, true);
  eocd.setUint32(12, centralSize, true);
  eocd.setUint32(16, offset, true);

  return new Blob([...locals, ...centrals, new Uint8Array(eocd.buffer)]);
}

function paragraph(text) {
  return '<w:p><w:r><w:t>' + text + '</w:t></w:r></w:p>';
}

function buildDocx(paragraphs) {
  const xml = '<?xml version="1.0"?><w:document><w:body>'
    + paragraphs.map(paragraph).join('')
    + '</w:body></w:document>';
  const blob = buildZip([
    { name: '[Content_Types].xml', content: '<?xml version="1.0"?><Types/>' },
    { name: 'word/document.xml', content: xml },
  ]);
  return new File([blob], 'cv.docx', {
    type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  });
}

describe('CV import — reading the file', () => {
  it('reads a plain text file', async () => {
    const file = new File([CV_TEXT], 'cv.txt', { type: 'text/plain' });
    const text = await readDocument(file);
    assert.ok(text.includes('Werkvoorbereider utiliteitsbouw'));
  });

  it('unpacks a .docx and turns paragraphs into lines', async () => {
    const file = buildDocx([
      'Sanne de Vries',
      'Werkvoorbereider utiliteitsbouw',
      'Amersfoort',
      'Werkvoorbereiding, Calculatie, BIM, Revit',
      '12 jaar ervaring',
    ]);
    const text = await readDocument(file);
    assert.ok(text.includes('Sanne de Vries'), 'no text came out of the docx');
    assert.ok(!text.includes('<w:t>'), 'xml tags leaked into the text');

    const { fields } = extractProfile(text);
    assert.equal(fields.headline, 'Werkvoorbereider utiliteitsbouw');
    assert.equal(fields.years_experience, 12);
    assert.equal(fields.location, 'Amersfoort');
  });

  it('decodes the entities Word writes', async () => {
    const file = buildDocx(['Bouw &amp; Infra', 'Ontwerp &lt;-&gt; uitvoering']);
    const text = await readDocument(file);
    assert.ok(text.includes('Bouw & Infra'), 'got: ' + text);
    assert.ok(text.includes('Ontwerp <-> uitvoering'));
  });

  it('refuses a file type it cannot read', async () => {
    const file = new File(['...'], 'cv.pages', { type: 'application/octet-stream' });
    await assert.throws(() => readDocument(file), READ_ERROR.UNSUPPORTED);
  });

  it('refuses a file that is too large before reading it', async () => {
    const big = new File([new Uint8Array(MAX_FILE_BYTES + 1)], 'cv.pdf', {
      type: 'application/pdf',
    });
    await assert.throws(() => readDocument(big), READ_ERROR.TOO_LARGE);
  });

  it('refuses a .docx that is not a zip', async () => {
    const file = new File(['not a zip at all'], 'cv.docx', { type: 'application/octet-stream' });
    await assert.throws(() => readDocument(file), READ_ERROR.UNREADABLE);
  });
});

describe('Company enrichment — honest about doing nothing', () => {
  it('reports itself unavailable rather than pretending', async () => {
    assert.equal(enrichmentIsAvailable(), false);
    const result = await enrichFromWebsite('https://meridiaanbouw.nl');
    assert.equal(result.available, false);
    assert.equal(result.reason, ENRICHMENT_ERROR.NOT_AVAILABLE);
    assert.equal(result.url, 'https://meridiaanbouw.nl', 'the url is kept for later');
  });

  it('invents no fields', async () => {
    const result = await enrichFromWebsite('https://meridiaanbouw.nl');
    assert.equal(result.name, undefined);
    assert.equal(result.description, undefined,
      'a guessed company description is worse than an empty one');
  });
});

/* ------------------------------------------------------------------ *
 * End to end
 * ------------------------------------------------------------------ */

let snapshot = null;
function saveSnapshot() {
  try { snapshot = window.localStorage.getItem(__testing.STORAGE_KEY); } catch (e) { snapshot = null; }
}
function restoreSnapshot() {
  try {
    if (snapshot === null) window.localStorage.removeItem(__testing.STORAGE_KEY);
    else window.localStorage.setItem(__testing.STORAGE_KEY, snapshot);
  } catch (e) { /* private mode */ }
}
function freshAdapter() {
  save(buildSeed());
  return createMockAdapter();
}

describe('Sign-up — end to end', () => {
  it('creates a freelancer who can sign in with the link', async () => {
    saveSnapshot();
    const a = freshAdapter();

    const before = load().users.length;
    const result = await a.signUpFreelancer({
      name: 'Nieuwe Freelancer', email: 'nieuw@example.com',
    });
    assert.equal(load().users.length, before + 1);

    const session = await a.consumeMagicLink(result.token);
    assert.equal(session.role, ROLE.FREELANCER);
    assert.equal(session.email, 'nieuw@example.com');
    assert.equal(session.organization_id, null);

    restoreSnapshot();
  });

  it('does not reveal whether an address already has an account', async () => {
    saveSnapshot();
    const a = freshAdapter();

    const fresh = await a.signUpFreelancer({ name: 'Iemand Nieuw', email: 'nieuw@example.com' });
    const taken = await a.signUpFreelancer({ name: 'Iemand Anders', email: 'freelancer@example.com' });

    assert.deepEqual(
      Object.keys(fresh).sort(),
      Object.keys(taken).sort(),
      'the two responses must have the same shape',
    );
    assert.equal(taken.delivery, fresh.delivery);
    assert.ok(taken.token, 'an existing account still gets a sign-in link');
    assert.equal(taken.email, 'freelancer@example.com');

    // Nothing in the payload says which of the two happened.
    assert.equal(fresh.outcome, undefined);
    assert.equal(taken.outcome, undefined);

    restoreSnapshot();
  });

  it('does not create a second account for an address that has one', async () => {
    saveSnapshot();
    const a = freshAdapter();
    const before = load().users.length;
    await a.signUpFreelancer({ name: 'Iemand Anders', email: 'freelancer@example.com' });
    assert.equal(load().users.length, before, 'no duplicate account');
    restoreSnapshot();
  });

  it('sends the existing account its own link, not the impostor’s', async () => {
    saveSnapshot();
    const a = freshAdapter();
    const result = await a.signUpFreelancer({
      name: 'Niet Sanne', email: 'freelancer@example.com',
    });
    const session = await a.consumeMagicLink(result.token);
    assert.equal(session.name, 'Sanne de Vries',
      'signing up with someone else’s address must not rename their account');
    restoreSnapshot();
  });

  it('creates an organisation for a company, and joins the next person to it', async () => {
    saveSnapshot();
    const a = freshAdapter();

    const orgsBefore = load().organizations.length;
    const first = await a.signUpCompany({
      name: 'Eerste Persoon',
      email: 'een@nieuwbedrijf.nl',
      company_name: 'Nieuw Bedrijf B.V.',
      kvk_number: '87654321',
      website: 'nieuwbedrijf.nl',
    });
    assert.equal(load().organizations.length, orgsBefore + 1);
    assert.equal(first.joined_existing, false);

    // Same company, typed differently, by someone on a different domain.
    const second = await a.signUpCompany({
      name: 'Tweede Persoon',
      email: 'tweede@gmail.com',
      company_name: 'Nieuw Bedrijf BV',
      kvk_number: '87 65 43 21',
    });
    assert.equal(load().organizations.length, orgsBefore + 1, 'no duplicate organisation');
    assert.equal(second.joined_existing, true);
    assert.equal(second.organization_name, 'Nieuw Bedrijf B.V.');

    const s1 = await a.consumeMagicLink(first.token);
    await a.signOut();
    const s2 = await a.consumeMagicLink(second.token);
    assert.equal(s1.organization_id, s2.organization_id, 'both are in the same organisation');
    assert.equal(s2.role, ROLE.COMPANY_ADMIN);

    restoreSnapshot();
  });

  it('stores the website and fetches nothing from it', async () => {
    saveSnapshot();
    const a = freshAdapter();
    await a.signUpCompany({
      name: 'Eerste Persoon',
      email: 'een@nieuwbedrijf.nl',
      company_name: 'Nieuw Bedrijf B.V.',
      kvk_number: '87654321',
      website: 'nieuwbedrijf.nl',
    });
    const org = load().organizations.find((o) => o.kvk_number === '87654321');
    assert.equal(org.website, 'https://nieuwbedrijf.nl', 'scheme added, value stored');
    restoreSnapshot();
  });

  it('lands a new company admin on their own project list with nothing on it', async () => {
    saveSnapshot();
    const a = freshAdapter();
    const result = await a.signUpCompany({
      name: 'Eerste Persoon',
      email: 'een@nieuwbedrijf.nl',
      company_name: 'Nieuw Bedrijf B.V.',
      kvk_number: '87654321',
    });
    await a.consumeMagicLink(result.token);
    assert.deepEqual(await a.listCompanyProjects(), [],
      'a new organisation starts empty and sees nobody else’s work');
    restoreSnapshot();
  });

  it('writes an audit row for the account and the organisation', async () => {
    saveSnapshot();
    const a = freshAdapter();
    const before = load().audit_events.length;
    await a.signUpCompany({
      name: 'Eerste Persoon',
      email: 'een@nieuwbedrijf.nl',
      company_name: 'Nieuw Bedrijf B.V.',
      kvk_number: '87654321',
    });
    const actions = load().audit_events.slice(before).map((e) => e.action);
    assert.ok(actions.includes('account.created'));
    assert.ok(actions.includes('organization.created'));
    restoreSnapshot();
  });
});
