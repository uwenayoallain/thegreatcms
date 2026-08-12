import { describe, expect, it } from 'vitest';
import { parseSchema } from './schema.js';
import { validateFields, validateRegion } from './validate.js';

const schema = parseSchema(`
version: 1
blocks:
  hero:
    fields:
      heading: { type: text, required: true, max: 10 }
  text:
    fields:
      body: { type: richtext }
regions:
  home.hero:
    fields:
      heading: { type: text, required: true, max: 10 }
      count: { type: number, integer: true, min: 1 }
      tone: { type: select, options: [calm, loud] }
      image: { type: image }
      decor: { type: image, alt: decorative-allowed }
      when: { type: date }
      cta: { type: link }
      tags: { type: list, of: { type: text }, max: 2 }
      seo:
        type: group
        fields:
          title: { type: text, required: true }
  home.body:
    type: blocks
    allow: [hero, text]
    max: 2
`);

const fields = (schema.regions['home.hero'] as { fields: never }).fields;

describe('validateFields', () => {
  it('accepts a valid document', () => {
    const result = validateFields(fields, {
      heading: 'Hi',
      count: 3,
      tone: 'calm',
      image: { src: '/m/a.webp', alt: 'A cat' },
      decor: { src: '/m/b.webp', alt: '' },
      when: '2026-08-12',
      cta: { href: '/about' },
      tags: ['a'],
      seo: { title: 'Home' },
    });
    expect(result.ok).toBe(true);
  });

  it('reports a missing required field', () => {
    const result = validateFields(fields, { seo: { title: 'x' } });
    expect(result.ok).toBe(false);
    expect(result.issues.map((i) => `${i.path}:${i.code}`)).toContain('heading:required');
  });

  it('enforces max length', () => {
    const result = validateFields(fields, { heading: 'x'.repeat(11), seo: { title: 'x' } });
    expect(result.issues.map((i) => i.code)).toContain('too_long');
  });

  it('rejects an image with no alt text and explains why', () => {
    const result = validateFields(fields, {
      heading: 'Hi',
      seo: { title: 'x' },
      image: { src: '/m/a.webp' },
    });
    const issue = result.issues.find((i) => i.code === 'missing_alt');
    expect(issue?.path).toBe('image.alt');
    expect(issue?.fix).toContain('screen readers');
  });

  it('rejects empty alt on a required-alt field but allows it on a decorative field', () => {
    const bad = validateFields(fields, {
      heading: 'Hi',
      seo: { title: 'x' },
      image: { src: '/m/a.webp', alt: '' },
    });
    expect(bad.issues.map((i) => i.code)).toContain('empty_alt');

    const good = validateFields(fields, {
      heading: 'Hi',
      seo: { title: 'x' },
      decor: { src: '/m/b.webp', alt: '' },
    });
    expect(good.ok).toBe(true);
  });

  it('validates nested groups and lists with a path', () => {
    const result = validateFields(fields, {
      heading: 'Hi',
      seo: {},
      tags: ['a', 'b', 'c'],
    });
    const codes = result.issues.map((i) => `${i.path}:${i.code}`);
    expect(codes).toContain('seo.title:required');
    expect(codes).toContain('tags:too_many');
  });

  it('rejects values outside a select', () => {
    const result = validateFields(fields, { heading: 'Hi', seo: { title: 'x' }, tone: 'shouty' });
    const issue = result.issues.find((i) => i.code === 'not_an_option');
    expect(issue?.fix).toContain('calm, loud');
  });

  it('ignores unknown keys by default and reports them in strict mode', () => {
    const doc = { heading: 'Hi', seo: { title: 'x' }, leftover: 'old value' };
    expect(validateFields(fields, doc).ok).toBe(true);
    const strict = validateFields(fields, doc, { strict: true });
    expect(strict.issues.map((i) => i.code)).toContain('unknown_field');
  });

  it('never treats machinery keys as unknown', () => {
    const doc = { heading: 'Hi', seo: { title: 'x' }, _meta: { updatedAt: 'now' } };
    expect(validateFields(fields, doc, { strict: true }).ok).toBe(true);
  });
});

describe('validateRegion', () => {
  it('validates blocks and their allowed types', () => {
    const ok = validateRegion(schema, 'home.body', {
      blocks: [{ _type: 'hero', heading: 'Hi' }],
    });
    expect(ok.ok).toBe(true);

    const bad = validateRegion(schema, 'home.body', {
      blocks: [{ _type: 'nope' }, { heading: 'x' }],
    });
    const codes = bad.issues.map((i) => i.code);
    expect(codes).toContain('block_not_allowed');
    expect(codes).toContain('missing_block_type');
  });

  it('enforces block count limits', () => {
    const result = validateRegion(schema, 'home.body', {
      blocks: [
        { _type: 'hero', heading: 'a' },
        { _type: 'hero', heading: 'b' },
        { _type: 'hero', heading: 'c' },
      ],
    });
    expect(result.issues.map((i) => i.code)).toContain('too_many');
  });

  it('reports an unknown region rather than silently passing', () => {
    const result = validateRegion(schema, 'nope.missing', {});
    expect(result.ok).toBe(false);
    expect(result.issues[0]?.code).toBe('unknown_region');
  });
});
