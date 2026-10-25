import { Global, Module } from '@nestjs/common';
import { DATABASE_POOL_TOKEN } from '@quynhonsemiconductor/platform-db';
import { DRIZZLE, DrizzleProvider } from './drizzle.provider';

@Global()
@Module({
  providers: [
    DrizzleProvider,
    { provide: DRIZZLE, useFactory: (p: DrizzleProvider) => p.instance, inject: [DrizzleProvider] },
    /*
     * TODO(app-platform): WORKAROUND. Keep until platform-runtime's `enableHealth` stops exiting the process when no
     * provider holds the pool (fix in progress upstream); then re-check whether this provider is still wanted.
     *
     * The pool under platform-db's token, so platform-runtime's `enableHealth` finds it and checks `database` in
     * `/readyz` itself. NOT optional decoration: with no provider for that token, `enableHealth` looks it up through
     * Nest's `app.get`, whose exception zone calls `process.exit(1)` on a miss even though platform-runtime catches
     * the error (verified: the built API exits at boot with "Nest could not find Symbol(@quynhonsemiconductor/platform-db:pool)").
     */
    {
      provide: DATABASE_POOL_TOKEN,
      useFactory: (p: DrizzleProvider) => p.rawPool,
      inject: [DrizzleProvider],
    },
  ],
  exports: [DRIZZLE, DrizzleProvider, DATABASE_POOL_TOKEN],
})
export class DatabaseModule {}
