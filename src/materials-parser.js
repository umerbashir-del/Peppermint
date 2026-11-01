const UNITS = new Map(Object.entries({ each: 'each', ea: 'each', piece: 'each', pieces: 'each', pc: 'each', pcs: 'each', sheet: 'sheet', sheets: 'sheet', box: 'box', boxes: 'box', bag: 'bag', bags: 'bag', roll: 'roll', rolls: 'roll', pack: 'pack', packs: 'pack', bundle: 'bundle', bundles: 'bundle', ft: 'foot', foot: 'foot', feet: 'foot', m: 'meter', meter: 'meter', meters: 'meter', lb: 'pound', lbs: 'pound', pound: 'pound', pounds: 'pound' }));
const NUMBER = '[+-]?(?:\\d{1,3}(?:,\\d{3})+|\\d+)(?:\\.\\d+)?';
const clean = text => text.replace(/\s+/g, ' ').trim();
const quantityValue = text => new RegExp(`^${NUMBER}$`).test(text) ? Number(text.replaceAll(',', '')) : null;

export const PARSE_MATERIALS_LIST_TOOL = {
  type: 'function', name: 'parse_materials_list',
  description: 'Parse pasted materials, CSV, or already-extracted PDF text. Preserve all records and flag missing quantities, units, and unclear specifications.',
  strict: true,
  parameters: { type: 'object', properties: { text: { type: 'string' }, format: { type: 'string', enum: ['text', 'csv', 'pdf_text'] } }, required: ['text', 'format'], additionalProperties: false },
};

// Quoted fields, escaped quotes, CRLF, and embedded newlines are supported.
function csvRecords(text) {
  const records = [];
  let fields = [], field = '', quoted = false, afterQuote = false, start = 0;
  for (let i = 0; i <= text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === undefined) throw new Error('CSV has an unclosed quoted field.');
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') { quoted = false; afterQuote = true; }
      else field += ch;
    } else if (ch === ',' || ch === '\n' || ch === undefined) {
      fields.push(field.replace(/\r$/, ''));
      field = ''; afterQuote = false;
      if (ch !== ',') {
        const raw = text.slice(start, i).replace(/\r$/, '');
        if (raw.trim()) records.push({ fields, raw });
        fields = []; start = i + 1;
      }
    } else if (ch === '"') {
      if (field.trim() || afterQuote) throw new Error('CSV contains an unexpected quote.');
      field = ''; quoted = true;
    } else {
      if (afterQuote && !/\s/.test(ch)) throw new Error('CSV contains text after a closing quote.');
      if (!afterQuote) field += ch;
    }
  }
  if (!records.length) throw new Error('CSV is empty.');
  const names = records[0].fields.map(value => clean(value).toLowerCase());
  const column = aliases => names.findIndex(name => aliases.includes(name));
  const item = column(['item', 'description', 'material', 'normalized_name']);
  const quantity = column(['quantity', 'qty']);
  const unit = column(['unit', 'uom']);
  if ([item, quantity, unit].some(index => index < 0)) throw new Error('CSV needs item, quantity (or qty), and unit headers.');
  if (new Set(names).size !== names.length) throw new Error('CSV header names must be unique.');
  return records.slice(1).map(record => ({ raw: record.raw, item: clean(record.fields[item] ?? ''), quantity: clean(record.fields[quantity] ?? ''), unit: clean(record.fields[unit] ?? ''), malformed: record.fields.length !== names.length }));
}

function parseText(raw) {
  let item = clean(raw).replace(/^(?:[-*•]\s+|\d+[.)]\s+)/, '');
  let quantity = null, unit = null;
  const leading = item.match(new RegExp(`^(${NUMBER})\\s+(?:of\\s+)?(.+)$`, 'i'));
  const trailing = !leading && item.match(new RegExp(`^(.+),\\s*(${NUMBER})$`, 'i'));
  if (leading) { quantity = quantityValue(leading[1]); item = leading[2]; }
  else if (trailing) { quantity = quantityValue(trailing[2]); item = trailing[1]; }
  const first = item.match(/^(\S+)\s+(?:of\s+)?(.+)$/i);
  if (first && UNITS.has(first[1].toLowerCase())) { unit = UNITS.get(first[1].toLowerCase()); item = first[2]; }
  else if (UNITS.has(item.toLowerCase())) { unit = UNITS.get(item.toLowerCase()); item = ''; }
  if (!unit && /\b(studs?|joists?|boards?|pieces?)\b/i.test(item)) unit = 'each';
  return { item, quantity, unit };
}

export function parseMaterialsList(input) {
  const { text, format = 'text' } = typeof input === 'string' ? { text: input } : input ?? {};
  if (typeof text !== 'string' || !text.trim()) throw new Error('Provide a nonempty materials list.');
  if (text.length > 100000 || text.includes('\0')) throw new Error('Provide readable text of at most 100,000 characters.');
  if (!['text', 'csv', 'pdf_text'].includes(format)) throw new Error('Supported formats: text, csv, pdf_text (already extracted text, not a PDF file).');
  const source = text.replace(/^\uFEFF/, '');
  const records = format === 'csv' ? csvRecords(source) : source.split(/\r?\n|;|,(?=\s*\d+(?:\.\d+)?\s+(?:of|sheets?|boxes?|bags?|rolls?|each|ea)\b)|,(?=\s*(?:delivery|deliver|pickup|pick up|no delivery)\b)/i).filter(raw => raw.trim()).map(raw => ({ raw }));
  if (!records.length || records.length > 100) throw new Error('Provide between 1 and 100 material/note records.');
  const lines = records.map((record, index) => {
    const raw_text = record.raw;
    const instructions = /\b(ignore\s+(?:all\s+)?(?:previous|prior|system)|system\s*prompt|email\s+me|customer\s+list)\b/i.test(raw_text);
    const note = /^(?:delivery\b|deliver\b|no delivery\b|pickup\b|pick up\b)/i.test(clean(raw_text));
    const kind = instructions ? 'non_material' : note ? 'note' : 'material';
    const parsed = format === 'csv' ? { item: record.item, quantity: quantityValue(record.quantity), unit: UNITS.get(record.unit.toLowerCase()) ?? null } : parseText(raw_text);
    const reasons = [];
    if (kind !== 'material') reasons.push(instructions ? 'Instruction-like text retained as data; not a material line.' : 'Delivery/pickup note retained for review; no booking or date inferred.');
    else {
      if (!parsed.item || /^(stuff|things?|materials?|misc(?:ellaneous)?|supplies?)(?:\b.*)?$/i.test(parsed.item)) reasons.push('Item description needs clarification.');
      if (parsed.quantity === null) reasons.push('Quantity is missing or unreadable.');
      else if (!Number.isFinite(parsed.quantity) || parsed.quantity <= 0 || parsed.quantity > 100000) reasons.push('Quantity must be greater than zero and at most 100000.');
      if (!parsed.unit) reasons.push('Unit is missing or unsupported; do not assume pack size.');
      if (/\b(studs?|joists?|boards?)\b/i.test(parsed.item) && !/\d+(?:\.\d+)?\s*[x×]\s*\d+(?:\.\d+)?\s*[x×]\s*\d+(?:\.\d+)?/i.test(parsed.item)) reasons.push('Lumber dimensions/length need clarification.');
      if (/\bscrews?\b/i.test(parsed.item) && !/\d+(?:\.\d+)?\s*(?:-?inch|in\b|["″])/i.test(parsed.item)) reasons.push('Screw length needs clarification.');
    }
    if (record.malformed) reasons.push('CSV row has a different number of columns than the header.');
    return { line_id: String(index + 1), raw_text, normalized_name: parsed.item || null, item: parsed.item || null, quantity: kind === 'material' ? parsed.quantity : null, unit: kind === 'material' ? parsed.unit : null, kind, ambiguity_flag: reasons.length > 0, reasons };
  });
  const materials = lines.filter(line => line.kind === 'material');
  return { status: lines.some(line => line.ambiguity_flag) ? 'needs_human_review' : 'parsed', format, lines, needs_human_review: lines.filter(line => line.ambiguity_flag).map(line => ({ line_id: line.line_id, reasons: line.reasons })), escalation: !materials.length ? 'No material lines found.' : materials.every(line => line.quantity === null) ? 'No readable quantities found.' : null };
}

export const parse_materials_list = parseMaterialsList;

// Reject partial handoffs so unresolved or non-material rows cannot disappear silently.
export function toSupplierRequest(parsed, { account_id, branch, delivery = null } = {}) {
  if (!parsed?.lines?.length || parsed.lines.some(line => line.kind !== 'material' || line.ambiguity_flag || !Number.isSafeInteger(line.quantity))) throw new Error('Resolve all flagged lines/notes and whole-unit quantities before handing the list to the supplier agent.');
  if (typeof account_id !== 'string' || !account_id.trim() || typeof branch !== 'string' || !branch.trim()) throw new Error('Account and branch are required.');
  return { account_id, branch, delivery, lines: parsed.lines.map(({ line_id, item, quantity, unit }) => ({ line_id, item, quantity, unit })) };
}
