// Declares this process as the worker. MUST be the first import after load-env: the config module
// validates the environment as soon as `@platform` is imported, against the schema of the role declared
// here. The worker holds the Graph credential and refuses to start with ENTRA_CLIENT_SECRET set. This
// file imports only the role module, so nothing that validates the environment runs before it.
import { setProcessRole } from '@platform/config/process-role';

setProcessRole('worker');
