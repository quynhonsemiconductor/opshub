import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { McpPrincipalGuard } from './principal.guard';

/**
 * The MCP module: the principal bridge and (via the bootstrap, not a controller) the raw `/mcp`
 * route. No controllers, no services, no repositories — tools compose the app's own REST routes
 * in-process, so there is nothing here to authorize with directly (that is the ratchet's point).
 *
 * Imported BEFORE `AuthModule`: global guard order is module order, and `McpPrincipalGuard` must
 * run before identity's `SessionGuard` so `markPreAuthenticated` makes it stand aside — but still
 * run its ban check — for an MCP principal. Pinned by principal.guard.spec.ts.
 */
@Module({
  providers: [{ provide: APP_GUARD, useClass: McpPrincipalGuard }],
})
export class McpModule {}
