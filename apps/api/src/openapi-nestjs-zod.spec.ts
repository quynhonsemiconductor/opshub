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
 * Pins the OpenAPI output shape under zod 4.6.6 with the vendored nestjs-zod patch
 * (`patches/nestjs-zod@5.5.0.patch`, rova#793's, adopted for opshub on the zod bump PR).
 *
 * zod 4.6.6's JSON Schema emission changed in ways nestjs-zod 5.5.0 mishandles WITHOUT the
 * patch: every `queryBoolean()` query parameter drifted `boolean | string` -> `boolean[]`
 * (what opshub's `codegen:check` surfaced first), and nullable fields carried raw 2020-12
 * type lists that are invalid in an OpenAPI 3.0 document.
 *
 * The patch makes nestjs-zod call zod's `toJSONSchema` with `target: "openapi-3.0"`, which
 * is the whole fix: with that target zod itself skips compactTypeUnion's type-array rewrite
 * (the rewrite is 3.0-excluded), so zod needs NO patch of its own — rova#793's zod patch was
 * abandoned for exactly that reason. These specs boot real Swagger documents and fail if
 * either regression returns. They do NOT weaken GHSA-mrhx-c7xc-m3w5 — that is in zod's
 * validation path, not its JSON Schema emitter.
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
