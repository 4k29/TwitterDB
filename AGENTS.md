## Code Review Rules

### Keep private data private
The public repository and published site must never contain tweet archive contents, analytics data, classifications, deleted-state data, credentials, or other data that belongs in the private `4k29/TwitterDB-data` repository.

### Keep credentials client-local
Fine-grained GitHub access tokens must remain stored only in the user's local browser storage. Never commit, log, transmit to unrelated services, or embed tokens in generated files or public code.

### Preserve the public/private repository boundary
The public UI may retrieve private data only through the intended authenticated GitHub API flow. Changes must not accidentally move private data into the public repository or make unauthenticated private-data access possible.
