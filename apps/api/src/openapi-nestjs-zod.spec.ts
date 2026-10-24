import 'reflect-metadata';
import { Body, Controller, Get, Module, Post, Query } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { z } from 'zod';
import { createZodDto } from 'nestjs-zod';
import { beforeAll, describe, expect, it } from 'vitest';
import { queryBoolean } from '@platform/http/query-boolean';

/**
 * Pins the OpenAPI output shape under zod 4.6.6 with the two vendored patches (rova#793,
 * adopted for opshub on the zod bump PR).
 *
 * zod >= 4.5 changed OpenAPI-relevant emission in two ways:
 *   1. `compactTypeUnion` rewrites `anyOf: [{type: "a"}, {type: "b"}]` into 2020-12 style
 *      `type: ["a","b"]` lists, which nestjs-zod 5.5.0's OpenAPI 3.0 conversion mishandles —
 *      nullable string fields rendered as STRING ARRAYS, and (what actually surfaced first,
 *      opshub's `codegen:check`) every `queryBoolean()` query parameter drifted from
 *      `boolean | string` to `boolean[]`.
 *   2. nullable fields carried raw type lists that are invalid in an OpenAPI 3.0 document.
 *
 * The fix is the vendored pair `patches/zod@4.6.6.patch` (disable compactTypeUnion in zod's
 * JSON-SCHEMA EMISSION — the GHSA-mrhx-c7xc-m3w5 fix is in the parse path, not here) and
 * `patches/nestjs-zod@5.5.0.patch` (call zod's `toJSONSchema` with `target: "openapi-3.0"`).
 * These specs boot real Swagger documents and fail if either regression returns. They do NOT
 * weaken GHSA-mrhx-c7xc-m3w5 — that is in zod's validation path, not its JSON Schema emitter.
 */

// ── 1. queryBoolean renders as anyOf [boolean, string], never boolean[] ─────

const QueryDtoSchema = z.object({ openOnly: queryBoolean() });
class QueryDto extends createZodDto(QueryDtoSchema) {}

@Controller('query-boolean-probe')
class QueryBooleanProbeController {
  @Get()
  probe(@Query() _query: QueryDto) {
    return { ok: true };
  }
}

// ── 2. nullable fields render as { type, nullable: true } ────────────────────

const NullableStringSchema = z.object({
  actorName: z.string().nullable(),
  avatarUrl: z.string().url().nullable(),
});
class NullableStringDto extends createZodDto(NullableStringSchema) {}

@Controller('nullable-probe')
class NullableProbeController {
  @Post()
  create(@Body() _body: NullableStringDto) {
    return { ok: true };
  }
}

@Module({ controllers: [QueryBooleanProbeController, NullableProbeController] })
class ProbeModule {}

interface ParamSchema {
  parameters?: { name: string; schema: Record<string, unknown> }[];
}
interface OpenApiDoc {
  paths: Record<string, Record<string, ParamSchema>>;
  components: { schemas: Record<string, { properties?: Record<string, Record<string, unknown>> }> };
}

let doc: OpenApiDoc;

describe('OpenAPI output under zod 4.6.6 + vendored patches', () => {
  beforeAll(async () => {
    const probeApp = await NestFactory.create(ProbeModule, new FastifyAdapter());
    await probeApp.init();
    const config = new DocumentBuilder().setTitle('spec').setVersion('1.0').build();
    doc = SwaggerModule.createDocument(probeApp, config) as unknown as OpenApiDoc;
    await probeApp.close();
  });

  it('renders queryBoolean parameters as anyOf [boolean, string] — never boolean[]', () => {
    const op = doc.paths?.['/query-boolean-probe']?.get;
    const param = op?.parameters?.find((p) => p.name === 'openOnly')?.schema;
    expect(param).toBeTruthy();
    expect(Array.isArray(param!.type)).toBe(false);
    expect(param!.type).toBeUndefined();
    expect(param!.anyOf).toEqual([{ type: 'boolean' }, { type: 'string' }]);
  });

  it('renders nullable fields as { type, nullable: true } — never a type list, never a wrong array', () => {
    const dtoSchema = Object.values(doc.components.schemas).find((s) => s.properties?.actorName);
    expect(dtoSchema?.properties).toBeTruthy();
    for (const field of ['actorName', 'avatarUrl']) {
      const prop = dtoSchema!.properties![field];
      expect(prop).toBeTruthy();
      expect(Array.isArray(prop.type), `${field}: raw type list leaked into the spec`).toBe(false);
      expect(prop.type, `${field}: wrong array type leaked into the spec`).not.toBe('array');
      expect(prop.nullable).toBe(true);
    }
  });

  it('no schema in the whole document carries a 2020-12 style type list', () => {
    const typeLists: string[] = [];
    const walk = (node: unknown) => {
      if (Array.isArray(node)) return node.forEach(walk);
      if (node && typeof node === 'object') {
        const t = (node as { type?: unknown }).type;
        if (Array.isArray(t)) typeLists.push(JSON.stringify(t));
        Object.values(node as Record<string, unknown>).forEach(walk);
      }
    };
    walk(doc);
    expect(typeLists).toEqual([]);
  });
});
