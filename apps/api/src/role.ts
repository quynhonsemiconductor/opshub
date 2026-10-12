// Declares this process as the API. MUST be the first import after load-env: the config module validates
// the environment as soon as `@platform` is imported, against the schema of the role declared here. The
// API holds the sign-in secret and refuses to start with any GRAPH_* variable set. This file imports only
// the role module, so nothing that validates the environment runs before it.
import { setProcessRole } from '@platform/config/process-role';

setProcessRole('api');
