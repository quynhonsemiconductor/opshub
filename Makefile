# The local stack for OpsHub. Prerequisites: Docker, Node 22+, pnpm, and NODE_AUTH_TOKEN (see README "Local stack").
.PHONY: local check down

local:
	./scripts/local/up.sh

check:
	pnpm local:check

down:
	./scripts/local/down.sh
