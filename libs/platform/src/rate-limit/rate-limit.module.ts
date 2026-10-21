import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { UserRateLimitGuard } from './rate-limit.guard';

/**
 * Registers the per-user bucket. Import this module AFTER the identity module: Nest runs global guards in module
 * import order, and the per-user bucket must run after identity's `SessionGuard` has recorded the principal.
 * (The pre-auth bucket is `RateLimitGuard`, registered in AppModule's own providers, which run first.)
 */
@Module({
  providers: [{ provide: APP_GUARD, useClass: UserRateLimitGuard }],
})
export class UserRateLimitModule {}
