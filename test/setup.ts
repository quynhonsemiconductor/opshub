// Per-suite setup file (vitest setupFiles).
// Runs before each test file. Clears all vi.fn() mocks between suites.
import { afterEach, vi } from 'vitest';
// Every suite validates the environment as the API does, unless it declares otherwise.
import { setProcessRole } from '@platform/config/process-role';

setProcessRole('api');

afterEach(() => {
  vi.clearAllMocks();
});
